import { db } from '../supabase-client.js';
import { requireAuth } from '../auth.js';
import { renderNavbar, showToast, esc, openModal, closeModal } from '../ui.js';
import {
  EXAM_QUESTION_TYPES, EXAM_TYPE_INFO, EXAM_BULK_IMPORT_TYPES,
  generateQuestionId, generateSectionId, makeQuestionStub, makeSectionStub,
  validateExamQuestion
} from '../question-engine.js';

const STORAGE_BUCKET = 'exam-images';
const DEFAULT_PROCTORING = { fullscreen_lock: true, tab_switch_tracking: true, window_blur_tracking: true };

// ===== STATE =====
let currentUser = null;
let currentProfile = null;
let currentExam = null;
let allClasses = [];
let allLevels = [];
let allTeachers = [];
let examDef = null;
let pendingImageContext = null;
let editingQuestion = null;
let editingSectionIdx = null;
let bulkParsedQuestions = [];
let bankEntries = [];

// ===== DIRTY STATE =====
let isDirty = false;
function markDirty() {
  isDirty = true;
  document.getElementById('dirtyIndicator').classList.add('show');
}
function clearDirty() {
  isDirty = false;
  document.getElementById('dirtyIndicator').classList.remove('show');
}
window.addEventListener('beforeunload', (e) => {
  if (isDirty) { e.preventDefault(); e.returnValue = ''; }
});

// ===== CONVERSION PROMPT (paste with exam document into Claude) =====
const CONVERSION_PROMPT = `You are an exam-conversion assistant for the Approach International Student Center online examination platform. Your task is to read the attached exam document and convert it into a structured JSON file that follows our exact schema.

# CRITICAL RULES

1. Output ONLY a single valid JSON object. No commentary before, no commentary after, no markdown code fences, no explanations. The first character of your response must be \`{\` and the last must be \`}\`.
2. Every question must have an \`id\`, \`type\`, \`grading\`, \`points\`, and \`prompt\`.
3. If you cannot determine a correct answer for an auto-gradable question, set \`grading\` to \`"manual"\` and add a note in the \`rubric\` field.
4. For images: NEVER attempt to extract or describe image data. Use placeholder filenames like \`q5_picture.png\` and set \`"url": null\`. The teacher will upload images separately through the platform.
5. Preserve the exam's original section structure (Article 1, Article 2, Section A, Section B, etc.) using the \`sections\` array.
6. If the document contains reading passages or articles, place the full text in the section's \`passage\` field as plain text (no markdown).

# JSON SCHEMA

The output must conform to this exact structure:

{
  "schema_version": "1.0",
  "exam_metadata": {
    "title": "<exam title from the document>",
    "instructions": "<top-level instructions, or null>"
  },
  "sections": [
    {
      "id": "section_1",
      "title": "<section title or null>",
      "instructions": "<section instructions or null>",
      "passage": { "type": "text", "content": "<reading content>" } | null,
      "questions": [ /* questions */ ]
    }
  ]
}

# QUESTION TYPES (use the exact \`type\` string)

## "multiple_choice" — auto, single correct answer from 2+ options
{
  "id": "q1", "type": "multiple_choice", "grading": "auto", "points": 1,
  "prompt": "Question text",
  "options": [{"key": "a", "text": "..."}, {"key": "b", "text": "..."}],
  "answer": "b"
}

## "true_false" — auto, T or F
{
  "id": "q2", "type": "true_false", "grading": "auto", "points": 1,
  "prompt": "Statement to evaluate",
  "answer": "T"
}

## "inline_choice" — auto, choose one of two options inside a sentence
Use {choice} where the choice appears in the sentence.
{
  "id": "q3", "type": "inline_choice", "grading": "auto", "points": 1,
  "prompt": "The {choice} is where you eat.",
  "options": ["arm", "mouth"],
  "answer": "mouth"
}

## "fill_blank" — auto, one text blank in a sentence
Use {blank} for the blank position.
{
  "id": "q4", "type": "fill_blank", "grading": "auto", "points": 1,
  "prompt": "I {blank} speak three languages.",
  "answer": "can",
  "accepted_answers": ["can"],
  "case_sensitive": false
}

## "fill_blank_multi" — auto, multiple blanks in one sentence
Use {blank} for each position; provide one entry in \`blanks\` per blank.
{
  "id": "q5", "type": "fill_blank_multi", "grading": "auto", "points": 1,
  "prompt": "{blank} you {blank} on the phone?",
  "blanks": [
    {"id": "5a", "answer": "Are", "accepted_answers": ["Are", "are"], "points": 0.5},
    {"id": "5b", "answer": "talking", "accepted_answers": ["talking"], "points": 0.5}
  ],
  "case_sensitive": false
}

## "matching" — auto, match left items to right items
{
  "id": "q6", "type": "matching", "grading": "auto", "points": 8,
  "prompt": "Match each phrase with the correct ending.",
  "left_items": [{"id": "1", "text": "..."}, {"id": "2", "text": "..."}],
  "right_items": [{"key": "A", "text": "..."}, {"key": "B", "text": "..."}],
  "answers": {"1": "E", "2": "G"}
}

## "categorization" — auto, sort words into category buckets
{
  "id": "q7", "type": "categorization", "grading": "auto", "points": 20,
  "prompt": "Put the words in the correct category.",
  "items": ["word1", "word2"],
  "categories": [{"id": "cat1", "label": "Category 1"}],
  "answers": {"word1": "cat1", "word2": "cat1"}
}

## "sentence_order" — manual, scrambled words to reorder
{
  "id": "q8", "type": "sentence_order", "grading": "manual", "points": 2,
  "prompt": "Put the words in order.",
  "words": ["are", "these", "students"],
  "expected": "These are students.",
  "rubric": "Full marks for correct word order."
}

## "short_answer" — manual, brief open-ended response
{
  "id": "q9", "type": "short_answer", "grading": "manual", "points": 2,
  "prompt": "What are the two drinks?",
  "expected_answer": "Coffee and tea",
  "rubric": "Full marks for identifying both drinks."
}

## "writing_prompt" — manual, longer open-ended writing
{
  "id": "q10", "type": "writing_prompt", "grading": "manual", "points": 2,
  "prompt": "Write a sentence using Simple Present.",
  "rubric": "Full marks for a grammatically correct sentence."
}

## "pool_writing" — manual, write N sentences from a pool of words
{
  "id": "q11", "type": "pool_writing", "grading": "manual", "points": 20,
  "prompt": "Choose 10 of the words below and write sentences.",
  "word_pool": ["word1", "word2"],
  "required_count": 10,
  "points_per_sentence": 2,
  "rubric": "Each grammatically correct sentence earns full marks."
}

## "image_label" — auto, multiple text labels for parts of an image
{
  "id": "q12", "type": "image_label", "grading": "auto", "points": 7,
  "prompt": "Write the verb for each action.",
  "image": {"placeholder": "q12_image.png", "alt": "description", "url": null},
  "labels": [
    {"id": "label1", "label": "John", "answer": "eat",
     "accepted_answers": ["eat", "eats", "eating"]}
  ],
  "case_sensitive": false
}

## "image_match" — auto, match items to numbered regions of an image
{
  "id": "q13", "type": "image_match", "grading": "auto", "points": 6,
  "prompt": "Match the words with the pictures.",
  "image": {"placeholder": "q13_image.png", "alt": "description", "url": null},
  "items": ["item1", "item2"],
  "image_regions": ["1", "2", "3", "4", "5", "6"],
  "answers": {"item1": "1", "item2": "2"}
}

# RULES FOR DETERMINING POINTS

1. If the source document specifies points (e.g. "(8 points)"), use that exact value on the question.
2. For matching, categorization, and image_label questions where the document gives a total (e.g. "8 points" for 8 pairs), put that total in \`points\`. The platform will divide it among items automatically.
3. For pool_writing where the document says "Each correct sentence 2 points", set \`points_per_sentence: 2\` and \`points\` to \`points_per_sentence × required_count\`.
4. If no points are specified anywhere, default to 1 point per question.
5. For multi-blank questions, distribute the question's total points evenly across blanks unless the document specifies otherwise.

# RULES FOR DETERMINING ANSWERS

1. If the document does not contain answer keys, set \`grading\` to \`"manual"\` for that question and leave \`answer\`/\`expected_answer\` empty or use your best guess based on the question content.
2. If you can confidently determine an answer from the question content (e.g. a matching question's "definition" makes the pairing obvious), provide it.
3. For \`accepted_answers\` on fill_blank questions, include common variations: contractions, capitalizations, alternate spellings.
4. ALWAYS set \`case_sensitive: false\` unless the question explicitly tests capitalization (proper nouns, sentence-initial caps in writing).

# RULES FOR IMAGES

1. When the document has an image, generate a descriptive placeholder filename: \`q<question_number>_<short_descriptor>.png\`. Examples: \`q12_actions.png\`, \`q9_fruits.png\`.
2. Always set \`url\` to null. Always include \`alt\` text describing what the image shows.
3. If a single question has multiple images, use a question type that supports them or split into sub-questions.

# IDs

- Use \`q1\`, \`q2\`, \`q3\`, ... for question IDs in document order, regardless of how the document numbers them.
- Use \`section_1\`, \`section_2\`, ... for section IDs.
- Sub-IDs (in matching, fill_blank_multi, etc.) can be \`1a\`, \`1b\` or \`5a\`, \`5b\`, matching the structure of the question.

# REMEMBER

- Output a single valid JSON object only.
- No markdown code fences (\`\`\`).
- No explanatory text before or after.
- Verify the JSON is syntactically valid before returning it.
- If you are uncertain about a question's correct answer, mark it \`grading: "manual"\` rather than guessing.
- Do not write the output in the chat, put it in a downloadable file.`;

// ===== HELPERS =====
function showError(title, message) {
  document.getElementById('authLoading').style.display = 'none';
  document.getElementById('content').style.display = 'none';
  document.getElementById('errorTitle').textContent = title;
  document.getElementById('errorMessage').textContent = message;
  document.getElementById('errorScreen').style.display = 'block';
}

// ===== LOAD EXAM =====
async function loadExam() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  const isNew = params.get('new') === 'true';

  if (!id) {
    showError('Missing exam ID', 'No exam ID was provided in the URL.');
    return;
  }

  try {
    const [examRes, classesRes, levelsRes, teachersRes] = await Promise.all([
      db.from('exams').select('*').eq('id', id).single(),
      db.from('classes').select('*').order('name'),
      db.from('levels').select('*').order('display_order'),
      db.from('profiles').select('id, full_name, email, role, is_active').order('full_name')
    ]);

    if (examRes.error) throw examRes.error;
    if (classesRes.error) throw classesRes.error;
    if (levelsRes.error) throw levelsRes.error;

    currentExam = examRes.data;
    allClasses = classesRes.data || [];
    allLevels = levelsRes.data || [];
    allTeachers = (teachersRes.data || []).filter(t => t.is_active);

    const cls = allClasses.find(c => c.id === currentExam.class_id);
    const lvl = allLevels.find(l => l.id === currentExam.level_id);
    const tch = allTeachers.find(t => t.id === currentExam.teacher_id);
    currentExam._class_name = cls?.name || '—';
    currentExam._level_name = lvl?.name || '—';
    currentExam._teacher_name = tch?.full_name || tch?.email || '—';

    if (!currentExam.proctoring_settings) currentExam.proctoring_settings = { ...DEFAULT_PROCTORING };

    const loadedDef = currentExam.exam_definition;
    examDef = (loadedDef && Array.isArray(loadedDef.sections) && loadedDef.sections.length > 0) ? loadedDef : null;
    document.getElementById('sharedToggle').checked = !!currentExam.shared;
    renderMetadata();
    renderProctoring();
    renderContent();
    updateSidebar();

    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('content').style.display = 'block';

    if (isNew) {
      showToast('Exam created. Build from scratch or upload a JSON file.', 'success');
    }
  } catch (err) {
    console.error(err);
    showError('Could not load exam', err.message || 'Unknown error');
  }
}

function renderMetadata() {
  const e = currentExam;
  document.getElementById('metaCode').textContent = e.code;
  document.getElementById('metaClass').textContent = e._class_name;
  document.getElementById('metaLevel').textContent = e._level_name;
  document.getElementById('metaType').textContent = e.type;
  document.getElementById('metaTeacher').textContent = e._teacher_name;

  const from = new Date(e.available_from);
  const until = new Date(e.available_until);
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  document.getElementById('metaWindow').textContent = `${fmt(from)} → ${fmt(until)}`;

  document.getElementById('metaBadges').innerHTML = `<span class="chip ${esc(e.status)}">${esc(e.status)}</span>`;
  document.getElementById('archiveBtn').style.display =
    (e.status === 'active' || e.status === 'draft') ? 'inline-flex' : 'none';
}

function renderProctoring() {
  const p = currentExam.proctoring_settings || DEFAULT_PROCTORING;
  document.getElementById('proctorFullscreen').checked = p.fullscreen_lock !== false;
  document.getElementById('proctorTabSwitch').checked = p.tab_switch_tracking !== false;
  document.getElementById('proctorWindowBlur').checked = p.window_blur_tracking !== false;
}

document.getElementById('sharedToggle').addEventListener('change', () => {
  currentExam.shared = document.getElementById('sharedToggle').checked;
  markDirty();
});

['proctorFullscreen', 'proctorTabSwitch', 'proctorWindowBlur'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    currentExam.proctoring_settings = {
      fullscreen_lock: document.getElementById('proctorFullscreen').checked,
      tab_switch_tracking: document.getElementById('proctorTabSwitch').checked,
      window_blur_tracking: document.getElementById('proctorWindowBlur').checked
    };
    markDirty();
  });
});

// ===== RENDER CONTENT =====
function renderContent() {
  const startOptions = document.getElementById('startOptions');
  const contentArea = document.getElementById('contentArea');
  const jsonActions = document.getElementById('jsonActions');

  if (!examDef) {
    startOptions.style.display = 'grid';
    contentArea.style.display = 'none';
    jsonActions.style.display = 'none';
    return;
  }

  startOptions.style.display = 'none';
  contentArea.style.display = 'block';
  jsonActions.style.display = 'flex';

  const container = contentArea;
  container.innerHTML = '';

  if (examDef.exam_metadata?.title) {
    const titleEl = document.createElement('div');
    titleEl.style.marginBottom = '1.25rem';
    titleEl.innerHTML = `
      <div class="exam-def-stamp">Exam Title</div>
      <div class="exam-def-title">${esc(examDef.exam_metadata.title)}</div>
      ${examDef.exam_metadata.instructions ? `<div class="exam-def-instructions">${esc(examDef.exam_metadata.instructions)}</div>` : ''}
    `;
    container.appendChild(titleEl);
  }

  const imageList = collectImagePlaceholders();
  if (imageList.length > 0) {
    const imgSection = document.createElement('div');
    imgSection.className = 'section-block';
    imgSection.innerHTML = `
      <div class="section-header">
        <div class="section-label">Images Inventory</div>
        <div class="section-title-text">Required Images (${imageList.filter(i => i.url).length} / ${imageList.length} uploaded)</div>
      </div>
      <div id="imageList"></div>
    `;
    container.appendChild(imgSection);
    const imgListEl = imgSection.querySelector('#imageList');
    imageList.forEach(img => imgListEl.appendChild(renderImageItem(img)));
  }

  const sections = examDef.sections || [];
  sections.forEach((section, sIdx) => {
    const sectionEl = document.createElement('div');
    sectionEl.className = 'section-block';

    let passageHtml = '';
    if (section.passage?.content) {
      passageHtml = `
        <div class="section-passage" data-passage="${sIdx}">
          ${esc(section.passage.content)}
          <span class="passage-toggle" data-passage-toggle="${sIdx}">Show more</span>
        </div>`;
    }

    const isFirstSection = sIdx === 0;
    const isLastSection = sIdx === sections.length - 1;

    sectionEl.innerHTML = `
      <div class="section-header">
        <div class="section-header-row">
          <div class="flex-min">
            <div class="section-label">Section ${sIdx + 1} of ${sections.length}</div>
            <div class="section-title-text">${esc(section.title || 'Untitled section')}</div>
            ${section.instructions ? `<div class="section-instructions">${esc(section.instructions)}</div>` : ''}
          </div>
          <div class="section-actions">
            <button class="section-action-btn" title="Move section up" data-section-action="up" data-section-idx="${sIdx}" ${isFirstSection ? 'disabled' : ''}>↑</button>
            <button class="section-action-btn" title="Move section down" data-section-action="down" data-section-idx="${sIdx}" ${isLastSection ? 'disabled' : ''}>↓</button>
            <button class="section-action-btn" title="Edit section" data-section-action="edit" data-section-idx="${sIdx}">✎</button>
            <button class="section-action-btn delete" title="Delete section" data-section-action="delete" data-section-idx="${sIdx}">⌫</button>
          </div>
        </div>
        ${passageHtml}
      </div>
      <div class="section-questions"></div>
    `;
    container.appendChild(sectionEl);

    const qContainer = sectionEl.querySelector('.section-questions');
    const questions = section.questions || [];

    qContainer.appendChild(renderInsertBar(sIdx, 0));

    questions.forEach((q, qIdx) => {
      const isFirst = qIdx === 0;
      const isLast = qIdx === questions.length - 1;
      qContainer.appendChild(renderQuestionRow(q, sIdx, qIdx, isFirst, isLast));
      qContainer.appendChild(renderInsertBar(sIdx, qIdx + 1));
    });
  });

  const addSectionBtn = document.createElement('button');
  addSectionBtn.className = 'add-section-bar';
  addSectionBtn.textContent = '+ Add Section';
  addSectionBtn.addEventListener('click', addSection);
  container.appendChild(addSectionBtn);
}

// ===== INSERT BAR =====
function renderInsertBar(sectionIdx, position) {
  const bar = document.createElement('div');
  bar.className = 'insert-bar';
  bar.dataset.section = sectionIdx;
  bar.dataset.position = position;
  bar.innerHTML = `<span class="insert-label">+ Add question here</span>`;
  bar.addEventListener('click', () => expandInsertBar(bar, sectionIdx, position));
  return bar;
}

function expandInsertBar(bar, sectionIdx, position) {
  if (bar.classList.contains('expanded')) return;
  bar.classList.add('expanded');

  const picker = document.createElement('div');
  picker.className = 'type-picker';
  picker.innerHTML = `
    <div class="type-picker-header">
      <span class="type-picker-title">Choose a question type</span>
      <button class="type-picker-close" title="Cancel">×</button>
    </div>
    <div class="type-grid">
      ${EXAM_QUESTION_TYPES.map(t => `
        <button class="type-pill" data-type="${t}">
          <span class="type-name">${esc(EXAM_TYPE_INFO[t].label)}</span>
          <span class="type-desc">${esc(EXAM_TYPE_INFO[t].desc)}</span>
        </button>
      `).join('')}
    </div>
  `;
  bar.innerHTML = '';
  bar.appendChild(picker);

  picker.querySelector('.type-picker-close').addEventListener('click', (e) => {
    e.stopPropagation();
    bar.classList.remove('expanded');
    bar.innerHTML = `<span class="insert-label">+ Add question here</span>`;
  });

  picker.querySelectorAll('.type-pill').forEach(pill => {
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      insertQuestion(sectionIdx, position, pill.dataset.type);
    });
  });
}

// ===== INSERT / DELETE / MOVE QUESTION =====
function insertQuestion(sectionIdx, position, type) {
  const stub = makeQuestionStub(type, examDef);
  examDef.sections[sectionIdx].questions.splice(position, 0, stub);
  markDirty();
  renderContent();
  updateSidebar();
  openQuestionEdit(sectionIdx, position);
}

function deleteQuestion(sectionIdx, questionIdx) {
  const q = examDef.sections[sectionIdx].questions[questionIdx];
  if (!confirm(`Delete question ${q.id}?\n\nThis cannot be undone (until you save, you can refresh the page to recover).`)) return;
  examDef.sections[sectionIdx].questions.splice(questionIdx, 1);
  markDirty();
  renderContent();
  updateSidebar();
}

function moveQuestion(sectionIdx, questionIdx, direction) {
  const questions = examDef.sections[sectionIdx].questions;
  const newIdx = questionIdx + direction;
  if (newIdx < 0 || newIdx >= questions.length) return;
  const [removed] = questions.splice(questionIdx, 1);
  questions.splice(newIdx, 0, removed);
  markDirty();
  renderContent();
  updateSidebar();
}

// ===== SECTIONS =====
function addSection() {
  const newSection = makeSectionStub(examDef);
  examDef.sections = examDef.sections || [];
  examDef.sections.push(newSection);
  markDirty();
  renderContent();
  updateSidebar();
  openSectionEdit(examDef.sections.length - 1);
}

function moveSection(sectionIdx, direction) {
  const newIdx = sectionIdx + direction;
  if (newIdx < 0 || newIdx >= examDef.sections.length) return;
  const [removed] = examDef.sections.splice(sectionIdx, 1);
  examDef.sections.splice(newIdx, 0, removed);
  markDirty();
  renderContent();
  updateSidebar();
}

function deleteSection(sectionIdx) {
  const section = examDef.sections[sectionIdx];
  const qCount = (section.questions || []).length;
  let msg = `Delete section "${section.title || 'Untitled'}"?`;
  if (qCount > 0) {
    msg += `\n\nThis will also delete ${qCount} question${qCount === 1 ? '' : 's'} in this section. This cannot be undone (until you save, you can refresh the page to recover).`;
  }
  if (!confirm(msg)) return;
  examDef.sections.splice(sectionIdx, 1);
  markDirty();
  renderContent();
  updateSidebar();
}

function collectImagePlaceholders() {
  const list = [];
  (examDef.sections || []).forEach((section, sIdx) => {
    (section.questions || []).forEach((q, qIdx) => {
      if (q.image && q.image.placeholder) {
        list.push({
          section: sIdx, question: qIdx, qId: q.id,
          placeholder: q.image.placeholder, alt: q.image.alt || '',
          url: q.image.url || null, ref: q.image
        });
      }
    });
  });
  return list;
}

function renderImageItem(img) {
  const div = document.createElement('div');
  div.className = 'image-item ' + (img.url ? 'uploaded' : 'missing');
  const thumbHtml = img.url
    ? `<img src="${esc(img.url)}" alt="${esc(img.alt)}">`
    : `<span class="placeholder">⊞</span>`;
  div.innerHTML = `
    <div class="image-item-thumb">${thumbHtml}</div>
    <div class="image-item-info">
      <div class="image-item-name">${esc(img.placeholder)}</div>
      <div class="image-item-meta">
        ${img.url ? '✓ Uploaded' : '✗ Not uploaded'} · Question ${esc(img.qId)} · ${esc(img.alt || 'No description')}
      </div>
    </div>
    <div class="image-item-actions">
      <button class="q-btn" data-image-action="upload" data-image-qid="${esc(img.qId)}">${img.url ? 'Replace' : 'Upload'}</button>
      ${img.url ? `<button class="q-btn delete" data-image-action="remove" data-image-qid="${esc(img.qId)}">Remove</button>` : ''}
    </div>
  `;
  return div;
}

function renderQuestionRow(q, sIdx, qIdx, isFirst = false, isLast = false) {
  const issues = validateExamQuestion(q);
  const div = document.createElement('div');
  div.className = 'question-row';
  if (issues.errors.length) div.classList.add('has-error');
  else if (issues.warnings.length) div.classList.add('has-warning');

  const promptPreview = (q.prompt || q.expected_answer || '(no prompt)').slice(0, 200);
  const gradingClass = q.grading === 'auto' ? 'auto' : 'manual';

  let warningHtml = '';
  if (issues.errors.length) {
    warningHtml = `<div class="q-warnings">${issues.errors.map(e => `<span>✗ ${esc(e)}</span>`).join('')}</div>`;
  } else if (issues.warnings.length) {
    warningHtml = `<div class="q-warnings"><span class="warn-icon">⚠ ${esc(issues.warnings[0])}</span></div>`;
  }

  div.innerHTML = `
    <span class="q-num-badge">${esc(q.id)}</span>
    <div class="q-info">
      <div class="q-prompt-preview">${esc(promptPreview)}</div>
      <div class="q-meta">
        <span class="type-badge">${esc(q.type || 'unknown')}</span>
        <span class="${gradingClass}">${esc(q.grading || '?')}</span>
        <span class="points">${q.points ?? '?'} pt${q.points === 1 ? '' : 's'}</span>
        ${q.image ? `<span class="text-medium-blue">📷 image</span>` : ''}
      </div>
    </div>
    ${warningHtml}
    <div class="q-actions">
      <button class="q-btn" data-q-action="edit" data-q-section="${sIdx}" data-q-idx="${qIdx}">Edit</button>
    </div>
    <div class="q-hover-actions">
      <button class="q-hover-btn" title="Move up" data-q-action="move-up" data-q-section="${sIdx}" data-q-idx="${qIdx}" ${isFirst ? 'disabled' : ''}>↑</button>
      <button class="q-hover-btn" title="Move down" data-q-action="move-down" data-q-section="${sIdx}" data-q-idx="${qIdx}" ${isLast ? 'disabled' : ''}>↓</button>
      <button class="q-hover-btn delete" title="Delete question" data-q-action="delete" data-q-section="${sIdx}" data-q-idx="${qIdx}">⌫</button>
    </div>
  `;
  return div;
}

// Delegated click handling for the whole content area (buttons rendered via innerHTML)
document.getElementById('contentArea').addEventListener('click', (e) => {
  const passageToggle = e.target.closest('[data-passage-toggle]');
  if (passageToggle) {
    const idx = passageToggle.dataset.passageToggle;
    const el = document.querySelector(`[data-passage="${idx}"]`);
    if (el) {
      el.classList.toggle('expanded');
      el.querySelector('.passage-toggle').textContent = el.classList.contains('expanded') ? 'Show less' : 'Show more';
    }
    return;
  }
  const sectionBtn = e.target.closest('[data-section-action]');
  if (sectionBtn) {
    const idx = parseInt(sectionBtn.dataset.sectionIdx, 10);
    const action = sectionBtn.dataset.sectionAction;
    if (action === 'up') moveSection(idx, -1);
    else if (action === 'down') moveSection(idx, 1);
    else if (action === 'edit') openSectionEdit(idx);
    else if (action === 'delete') deleteSection(idx);
    return;
  }
  const imageBtn = e.target.closest('[data-image-action]');
  if (imageBtn) {
    const qId = imageBtn.dataset.imageQid;
    if (imageBtn.dataset.imageAction === 'upload') openImageUpload(qId);
    else removeImage(qId);
    return;
  }
  const qBtn = e.target.closest('[data-q-action]');
  if (qBtn) {
    const sIdx = parseInt(qBtn.dataset.qSection, 10);
    const qIdx = parseInt(qBtn.dataset.qIdx, 10);
    const action = qBtn.dataset.qAction;
    if (action === 'edit') openQuestionEdit(sIdx, qIdx);
    else if (action === 'move-up') moveQuestion(sIdx, qIdx, -1);
    else if (action === 'move-down') moveQuestion(sIdx, qIdx, 1);
    else if (action === 'delete') deleteQuestion(sIdx, qIdx);
  }
});

// ===== SIDEBAR =====
function updateSidebar() {
  if (!examDef) {
    ['sumSections', 'sumQuestions', 'sumAuto', 'sumManual', 'sumPoints', 'sumImagesNeeded', 'sumImagesUploaded']
      .forEach(id => document.getElementById(id).textContent = '—');
    renderValidation([{ ok: false, text: 'No content yet — build from scratch or upload a JSON.' }]);
    document.getElementById('previewBtn').disabled = true;
    document.getElementById('saveDraftBtn').disabled = true;
    document.getElementById('publishBtn').disabled = true;
    return;
  }

  const sections = examDef.sections || [];
  let totalQ = 0, autoQ = 0, manualQ = 0, totalPoints = 0;
  sections.forEach(s => (s.questions || []).forEach(q => {
    totalQ++;
    if (q.grading === 'auto') autoQ++; else manualQ++;
    totalPoints += Number(q.points) || 0;
  }));

  const images = collectImagePlaceholders();
  const imagesUploaded = images.filter(i => i.url).length;

  document.getElementById('sumSections').textContent = sections.length;
  document.getElementById('sumQuestions').textContent = totalQ;
  document.getElementById('sumAuto').textContent = autoQ;
  document.getElementById('sumManual').textContent = manualQ;
  document.getElementById('sumPoints').textContent = totalPoints;
  document.getElementById('sumImagesNeeded').textContent = images.length;
  document.getElementById('sumImagesUploaded').textContent = imagesUploaded;

  const checks = [];
  checks.push({ ok: sections.length > 0, text: `${sections.length} section${sections.length === 1 ? '' : 's'}` });
  checks.push({ ok: totalQ > 0, text: `${totalQ} question${totalQ === 1 ? '' : 's'}` });

  let issuesCount = 0;
  sections.forEach(s => (s.questions || []).forEach(q => {
    if (validateExamQuestion(q).errors.length) issuesCount++;
  }));
  checks.push(issuesCount > 0
    ? { ok: false, text: `${issuesCount} question${issuesCount === 1 ? '' : 's'} with errors` }
    : { ok: true, text: 'All questions are valid' });

  if (images.length > 0) {
    const allUploaded = imagesUploaded === images.length;
    checks.push({
      ok: allUploaded,
      text: allUploaded
        ? `All ${images.length} image${images.length === 1 ? '' : 's'} uploaded`
        : `${images.length - imagesUploaded} image${images.length - imagesUploaded === 1 ? '' : 's'} not yet uploaded`
    });
  }

  renderValidation(checks);

  const allValid = issuesCount === 0 && imagesUploaded === images.length && totalQ > 0;
  document.getElementById('previewBtn').disabled = false;
  document.getElementById('saveDraftBtn').disabled = false;
  document.getElementById('publishBtn').disabled = !allValid;
}

function renderValidation(checks) {
  document.getElementById('validationList').innerHTML = checks.map(c =>
    `<li class="${c.ok ? 'ok' : 'fail'}">${esc(c.text)}</li>`
  ).join('');
}

// ===== JSON UPLOAD / DOWNLOAD =====
function setupJsonUpload() {
  const zone = document.getElementById('uploadZone');
  const input = document.getElementById('jsonFileInput');

  input.addEventListener('change', e => { if (e.target.files[0]) handleJsonFile(e.target.files[0]); });

  ['dragover', 'dragenter'].forEach(evt => zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(evt => zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.remove('dragover'); }));
  zone.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files[0]) handleJsonFile(e.dataTransfer.files[0]); });

  document.getElementById('reuploadJsonBtn').addEventListener('click', () => {
    if (!confirm('Replace the current exam content? Image uploads will be preserved if filenames match.')) return;
    examDef = null;
    renderContent();
    updateSidebar();
  });

  document.getElementById('downloadJsonBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(examDef, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentExam.code}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('startScratchBtn').addEventListener('click', () => {
    examDef = { schema_version: '1.0', exam_metadata: { title: null, instructions: null }, sections: [] };
    markDirty();
    renderContent();
    updateSidebar();
    showToast('Started a new exam. Add your first section to begin.', 'success');
  });
}

function handleJsonFile(file) {
  if (!file.name.endsWith('.json') && file.type !== 'application/json') {
    showToast('Please upload a .json file', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!parsed.schema_version || !parsed.sections) {
        throw new Error('Invalid schema — missing schema_version or sections');
      }
      if (examDef) {
        const existingImages = collectImagePlaceholders();
        const merge = (q) => {
          if (q.image?.placeholder) {
            const match = existingImages.find(i => i.placeholder === q.image.placeholder && i.url);
            if (match) q.image.url = match.url;
          }
        };
        (parsed.sections || []).forEach(s => (s.questions || []).forEach(merge));
      }
      examDef = parsed;
      markDirty();
      renderContent();
      updateSidebar();
      showToast('JSON loaded successfully', 'success');
    } catch (err) {
      showToast('Could not parse JSON: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}

// ===== IMAGE UPLOAD =====
function openImageUpload(qId) {
  const ctx = collectImagePlaceholders().find(i => i.qId === qId);
  if (!ctx) return;
  pendingImageContext = ctx;
  document.getElementById('imageModalTitle').textContent = `Question ${qId}`;
  document.getElementById('imageModalSub').textContent = `Filename: ${ctx.placeholder} · ${ctx.alt}`;
  document.getElementById('imageFileInput').value = '';
  document.getElementById('imagePreviewWrap').style.display = 'none';
  document.getElementById('uploadImageBtn').disabled = true;
  openModal('imageUploadModal');
}

function closeImageModal() {
  closeModal('imageUploadModal');
  pendingImageContext = null;
}
document.getElementById('cancelImageBtn').addEventListener('click', closeImageModal);
document.getElementById('imageUploadModal').addEventListener('click', e => { if (e.target.id === 'imageUploadModal') closeImageModal(); });

document.getElementById('imageFileInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    showToast('Only PNG, JPEG, and WebP files are accepted', 'error');
    e.target.value = '';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast('File is larger than 5 MB', 'error');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = ev => {
    document.getElementById('imagePreview').src = ev.target.result;
    document.getElementById('imagePreviewWrap').style.display = 'block';
    document.getElementById('uploadImageBtn').disabled = false;
  };
  reader.readAsDataURL(file);
});

document.getElementById('uploadImageBtn').addEventListener('click', async () => {
  const file = document.getElementById('imageFileInput').files[0];
  if (!file || !pendingImageContext) return;
  const btn = document.getElementById('uploadImageBtn');
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  try {
    const ext = file.name.split('.').pop().toLowerCase();
    const path = `${currentExam.code}/${pendingImageContext.placeholder.replace(/\.[^.]+$/, '')}.${ext}`;
    const { error: upErr } = await db.storage.from(STORAGE_BUCKET).upload(path, file, { upsert: true, contentType: file.type });
    if (upErr) throw upErr;
    const { data: urlData } = db.storage.from(STORAGE_BUCKET).getPublicUrl(path);
    const publicUrl = urlData.publicUrl + `?v=${Date.now()}`;
    const sIdx = pendingImageContext.section, qIdx = pendingImageContext.question;
    examDef.sections[sIdx].questions[qIdx].image.url = publicUrl;
    markDirty();
    closeImageModal();
    renderContent();
    updateSidebar();
    showToast('Image uploaded', 'success');
  } catch (err) {
    console.error(err);
    showToast('Upload failed: ' + err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Upload';
  }
});

async function removeImage(qId) {
  if (!confirm('Remove this image? The file will be deleted from storage.')) return;
  const img = collectImagePlaceholders().find(i => i.qId === qId);
  if (!img || !img.url) return;
  try {
    const urlParts = img.url.split(`/${STORAGE_BUCKET}/`);
    if (urlParts.length === 2) {
      const path = urlParts[1].split('?')[0];
      await db.storage.from(STORAGE_BUCKET).remove([path]);
    }
    examDef.sections[img.section].questions[img.question].image.url = null;
    markDirty();
    renderContent();
    updateSidebar();
    showToast('Image removed', 'success');
  } catch (err) {
    console.error(err);
    showToast('Could not remove image: ' + err.message, 'error');
  }
}

// ===== EDIT QUESTION MODAL =====
function openQuestionEdit(sIdx, qIdx) {
  const q = examDef.sections[sIdx].questions[qIdx];
  editingQuestion = { sIdx, qIdx, q };

  document.getElementById('editQTitle').textContent = `Question ${q.id}`;
  document.getElementById('editQSub').textContent = `Type: ${q.type}`;
  document.getElementById('editQType').value = q.type;
  document.getElementById('editQGrading').value = q.grading || 'auto';
  document.getElementById('editQPoints').value = q.points ?? 1;
  document.getElementById('editQPrompt').value = q.prompt || '';

  refreshJsonViewer(q);
  document.getElementById('editQJson').style.display = 'none';
  document.getElementById('jsonToggleBtn').textContent = 'Show';

  const specific = document.getElementById('editQTypeSpecific');
  specific.innerHTML = '';
  renderTypeEditor(q, specific);

  openModal('editQuestionModal');
}

function refreshJsonViewer(q) {
  document.getElementById('editQJson').textContent = JSON.stringify(q, null, 2);
}

function closeQuestionModal() {
  closeModal('editQuestionModal');
  editingQuestion = null;
}
document.getElementById('cancelQuestionBtn').addEventListener('click', closeQuestionModal);
document.getElementById('editQuestionModal').addEventListener('click', e => { if (e.target.id === 'editQuestionModal') closeQuestionModal(); });

document.getElementById('jsonToggleBtn').addEventListener('click', () => {
  const viewer = document.getElementById('editQJson');
  const btn = document.getElementById('jsonToggleBtn');
  if (viewer.style.display === 'none') { viewer.style.display = 'block'; btn.textContent = 'Hide'; }
  else { viewer.style.display = 'none'; btn.textContent = 'Show'; }
});

// ===== TYPE-SPECIFIC EDITORS =====
// Each type's editor uses data attributes/inputs read live — sub-rows added
// or removed re-render the whole editor section immediately so the answer
// key stays in sync (e.g. deleting an option auto-clears stale answer refs).
function renderTypeEditor(q, container) {
  switch (q.type) {
    case 'multiple_choice':  renderMultipleChoiceEditor(q, container); break;
    case 'true_false':       renderTrueFalseEditor(q, container); break;
    case 'inline_choice':    renderInlineChoiceEditor(q, container); break;
    case 'fill_blank':       renderFillBlankEditor(q, container); break;
    case 'fill_blank_multi': renderFillBlankMultiEditor(q, container); break;
    case 'matching':         renderMatchingEditor(q, container); break;
    case 'categorization':   renderCategorizationEditor(q, container); break;
    case 'sentence_order':   renderSentenceOrderEditor(q, container); break;
    case 'short_answer':     renderShortAnswerEditor(q, container); break;
    case 'writing_prompt':   renderWritingPromptEditor(q, container); break;
    case 'pool_writing':     renderPoolWritingEditor(q, container); break;
    case 'image_label':      renderImageLabelEditor(q, container); break;
    case 'image_match':      renderImageMatchEditor(q, container); break;
  }
}

function rerenderTypeEditor() {
  if (!editingQuestion) return;
  const container = document.getElementById('editQTypeSpecific');
  container.innerHTML = '';
  renderTypeEditor(editingQuestion.q, container);
  refreshJsonViewer(editingQuestion.q);
}

// ----- Multiple Choice -----
function renderMultipleChoiceEditor(q, container) {
  q.options = q.options || [];
  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-label">Options</div>
      <div class="editor-section-hint">Click the circle next to an option to mark it as the correct answer.</div>
      <div id="optsList">
        ${q.options.map((opt, i) => `
          <div class="sub-row opt-row">
            <span class="sub-key">${esc(opt.key || '')}</span>
            <input type="text" data-mc-text="${i}" value="${esc(opt.text || '')}" placeholder="Option text">
            <label class="sub-radio">
              <input type="radio" name="mc-answer" data-mc-answer="${esc(opt.key)}" ${q.answer === opt.key ? 'checked' : ''}>
              Correct
            </label>
            <button class="sub-delete-btn" data-mc-delete="${i}" title="Remove option">⌫</button>
          </div>
        `).join('')}
      </div>
      <button class="add-row-btn" id="addOptBtn">+ Add Option</button>
    </div>
  `;
  container.querySelectorAll('[data-mc-text]').forEach(input => {
    input.addEventListener('input', () => { q.options[parseInt(input.dataset.mcText, 10)].text = input.value; refreshJsonViewer(q); });
  });
  container.querySelectorAll('[data-mc-answer]').forEach(radio => {
    radio.addEventListener('change', () => { if (radio.checked) { q.answer = radio.dataset.mcAnswer; refreshJsonViewer(q); } });
  });
  container.querySelectorAll('[data-mc-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.mcDelete, 10);
      const removedKey = q.options[i].key;
      q.options.splice(i, 1);
      q.options.forEach((o, idx) => o.key = String.fromCharCode(97 + idx));
      if (q.answer === removedKey || (q.answer && !q.options.find(o => o.key === q.answer))) q.answer = '';
      rerenderTypeEditor();
    });
  });
  document.getElementById('addOptBtn').addEventListener('click', () => {
    q.options.push({ key: String.fromCharCode(97 + q.options.length), text: '' });
    rerenderTypeEditor();
  });
}

// ----- True / False -----
function renderTrueFalseEditor(q, container) {
  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-label">Correct Answer</div>
      <div class="tf-btn-group">
        <label class="sub-radio sub-radio--btn"><input type="radio" name="tf-answer" value="T" ${q.answer === 'T' ? 'checked' : ''}> True</label>
        <label class="sub-radio sub-radio--btn"><input type="radio" name="tf-answer" value="F" ${q.answer === 'F' ? 'checked' : ''}> False</label>
      </div>
    </div>
  `;
  container.querySelectorAll('[name="tf-answer"]').forEach(r => {
    r.addEventListener('change', () => { if (r.checked) { q.answer = r.value; refreshJsonViewer(q); } });
  });
}

// ----- Inline Choice -----
function renderInlineChoiceEditor(q, container) {
  q.options = q.options || ['', ''];
  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-label">Two Options (inside the sentence)</div>
      <div class="editor-section-hint">Use <code class="inline-code">{choice}</code> in the prompt to mark where the choice appears. Click the circle to mark the correct one.</div>
      ${q.options.map((opt, i) => `
        <div class="sub-row opt-row">
          <input type="text" data-ic-text="${i}" value="${esc(opt || '')}" placeholder="Option ${i + 1}">
          <label class="sub-radio">
            <input type="radio" name="ic-answer" data-ic-answer="${esc(opt || '')}" ${q.answer === opt && opt ? 'checked' : ''}>
            Correct
          </label>
        </div>
      `).join('')}
    </div>
  `;
  container.querySelectorAll('[data-ic-text]').forEach(input => {
    input.addEventListener('input', () => {
      const i = parseInt(input.dataset.icText, 10);
      if (q.options[i] === q.answer) q.answer = input.value;
      q.options[i] = input.value;
      refreshJsonViewer(q);
    });
  });
  container.querySelectorAll('[name="ic-answer"]').forEach(r => {
    r.addEventListener('change', () => { if (r.checked) { q.answer = r.dataset.icAnswer; refreshJsonViewer(q); } });
  });
}

// ----- Fill Blank -----
function renderFillBlankEditor(q, container) {
  q.accepted_answers = q.accepted_answers || [];
  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-label">Answer</div>
      <div class="editor-section-hint">Use <code class="inline-code">{blank}</code> in the prompt to mark where the blank goes.</div>
      <div class="field"><label>Correct Answer</label><input type="text" id="fb-answer" value="${esc(q.answer || '')}"></div>
      <div class="field"><label>Accepted Variants (comma separated)</label><input type="text" id="fb-accepted" value="${esc(q.accepted_answers.join(', '))}" placeholder="e.g. cannot, can not, can't"></div>
      <label class="sub-radio sub-radio--mt"><input type="checkbox" id="fb-case" ${q.case_sensitive ? 'checked' : ''}> Case sensitive</label>
    </div>
  `;
  document.getElementById('fb-answer').addEventListener('input', e => { q.answer = e.target.value; refreshJsonViewer(q); });
  document.getElementById('fb-accepted').addEventListener('input', e => { q.accepted_answers = e.target.value.split(',').map(s => s.trim()).filter(Boolean); refreshJsonViewer(q); });
  document.getElementById('fb-case').addEventListener('change', e => { q.case_sensitive = e.target.checked; refreshJsonViewer(q); });
}

// ----- Fill Blank Multi -----
function renderFillBlankMultiEditor(q, container) {
  q.blanks = q.blanks || [];
  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-label"><span>Blanks (in order)</span><span class="q-meta-mono">${q.blanks.length} blank${q.blanks.length === 1 ? '' : 's'}</span></div>
      <div class="editor-section-hint">Each <code class="inline-code">{blank}</code> in the prompt corresponds to one row below, in order.</div>
      <div class="blank-row-header"><span>ID</span><span>Answer</span><span>Accepted</span><span>Points</span><span></span></div>
      <div id="blanksList">
        ${q.blanks.map((b, i) => `
          <div class="sub-row blank-row">
            <span class="sub-key">${esc(b.id || '')}</span>
            <input type="text" data-fbm-answer="${i}" value="${esc(b.answer || '')}" placeholder="Answer">
            <input type="text" data-fbm-accepted="${i}" value="${esc((b.accepted_answers || []).join(', '))}" placeholder="Variants">
            <input type="number" data-fbm-points="${i}" value="${b.points ?? 0.5}" step="0.1" min="0">
            <button class="sub-delete-btn" data-fbm-delete="${i}" title="Remove blank">⌫</button>
          </div>
        `).join('')}
      </div>
      <button class="add-row-btn" id="addBlankBtn">+ Add Blank</button>
      <label class="sub-radio sub-radio--mt"><input type="checkbox" id="fbm-case" ${q.case_sensitive ? 'checked' : ''}> Case sensitive</label>
    </div>
  `;
  container.querySelectorAll('[data-fbm-answer]').forEach(input => input.addEventListener('input', () => { q.blanks[parseInt(input.dataset.fbmAnswer, 10)].answer = input.value; refreshJsonViewer(q); }));
  container.querySelectorAll('[data-fbm-accepted]').forEach(input => input.addEventListener('input', () => { q.blanks[parseInt(input.dataset.fbmAccepted, 10)].accepted_answers = input.value.split(',').map(s => s.trim()).filter(Boolean); refreshJsonViewer(q); }));
  container.querySelectorAll('[data-fbm-points]').forEach(input => input.addEventListener('input', () => { q.blanks[parseInt(input.dataset.fbmPoints, 10)].points = parseFloat(input.value) || 0; refreshJsonViewer(q); }));
  container.querySelectorAll('[data-fbm-delete]').forEach(btn => btn.addEventListener('click', () => { q.blanks.splice(parseInt(btn.dataset.fbmDelete, 10), 1); rerenderTypeEditor(); }));
  document.getElementById('addBlankBtn').addEventListener('click', () => {
    const next = q.blanks.length + 1;
    q.blanks.push({ id: `${q.id}${String.fromCharCode(96 + next)}`, answer: '', accepted_answers: [], points: 0.5 });
    rerenderTypeEditor();
  });
  document.getElementById('fbm-case').addEventListener('change', e => { q.case_sensitive = e.target.checked; refreshJsonViewer(q); });
}

// ----- Matching -----
function renderMatchingEditor(q, container) {
  q.left_items = q.left_items || [];
  q.right_items = q.right_items || [];
  q.answers = q.answers || {};
  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-label">Left Items (numbered)</div>
      <div id="leftItemsList">${q.left_items.map((it, i) => `
        <div class="sub-row left-item-row">
          <span class="sub-key">${esc(it.id || '')}</span>
          <input type="text" data-mt-left="${i}" value="${esc(it.text || '')}" placeholder="Item text">
          <button class="sub-delete-btn" data-mt-left-delete="${i}" title="Remove">⌫</button>
        </div>`).join('')}</div>
      <button class="add-row-btn" id="addLeftBtn">+ Add Left Item</button>
    </div>
    <div class="editor-section">
      <div class="editor-section-label">Right Items (lettered)</div>
      <div id="rightItemsList">${q.right_items.map((it, i) => `
        <div class="sub-row right-item-row">
          <span class="sub-key">${esc(it.key || '')}</span>
          <input type="text" data-mt-right="${i}" value="${esc(it.text || '')}" placeholder="Item text">
          <button class="sub-delete-btn" data-mt-right-delete="${i}" title="Remove">⌫</button>
        </div>`).join('')}</div>
      <button class="add-row-btn" id="addRightBtn">+ Add Right Item</button>
    </div>
    <div class="editor-section">
      <div class="editor-section-label">Answer Key</div>
      <div class="editor-section-hint">For each left item, choose the matching right item.</div>
      <div class="answers-grid">${q.left_items.map(l => {
        const rightOpts = q.right_items.map(r => {
          const sel = q.answers[l.id] === r.key ? ' selected' : '';
          return `<option value="${esc(r.key)}"${sel}>${esc(r.key)}) ${esc(r.text || '(empty)')}</option>`;
        }).join('');
        return `<div><span class="answer-label">${esc(l.id)}) ${esc(l.text || '(empty)')}</span><select data-mt-answer="${esc(l.id)}"><option value="">— pick —</option>${rightOpts}</select></div>`;
      }).join('')}</div>
    </div>
  `;
  container.querySelectorAll('[data-mt-left]').forEach(input => input.addEventListener('input', () => { q.left_items[parseInt(input.dataset.mtLeft, 10)].text = input.value; refreshJsonViewer(q); }));
  container.querySelectorAll('[data-mt-right]').forEach(input => input.addEventListener('input', () => { q.right_items[parseInt(input.dataset.mtRight, 10)].text = input.value; refreshJsonViewer(q); }));
  container.querySelectorAll('[data-mt-left-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.mtLeftDelete, 10);
      const removedId = q.left_items[i].id;
      q.left_items.splice(i, 1);
      delete q.answers[removedId];
      q.left_items.forEach((it, idx) => {
        const newId = String(idx + 1);
        if (q.answers[it.id] != null && newId !== it.id) { q.answers[newId] = q.answers[it.id]; delete q.answers[it.id]; }
        it.id = newId;
      });
      rerenderTypeEditor();
    });
  });
  container.querySelectorAll('[data-mt-right-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.mtRightDelete, 10);
      const removedKey = q.right_items[i].key;
      q.right_items.splice(i, 1);
      q.right_items.forEach((it, idx) => {
        const newKey = String.fromCharCode(65 + idx);
        if (newKey !== it.key) { Object.keys(q.answers).forEach(k => { if (q.answers[k] === it.key) q.answers[k] = newKey; }); it.key = newKey; }
      });
      Object.keys(q.answers).forEach(k => {
        if (q.answers[k] === removedKey) delete q.answers[k];
        if (q.answers[k] && !q.right_items.find(r => r.key === q.answers[k])) delete q.answers[k];
      });
      rerenderTypeEditor();
    });
  });
  container.querySelectorAll('[data-mt-answer]').forEach(sel => {
    sel.addEventListener('change', () => { if (sel.value) q.answers[sel.dataset.mtAnswer] = sel.value; else delete q.answers[sel.dataset.mtAnswer]; refreshJsonViewer(q); });
  });
  document.getElementById('addLeftBtn').addEventListener('click', () => { q.left_items.push({ id: String(q.left_items.length + 1), text: '' }); rerenderTypeEditor(); });
  document.getElementById('addRightBtn').addEventListener('click', () => { q.right_items.push({ key: String.fromCharCode(65 + q.right_items.length), text: '' }); rerenderTypeEditor(); });
}

// ----- Categorization -----
function renderCategorizationEditor(q, container) {
  q.items = q.items || [];
  q.categories = q.categories || [];
  q.answers = q.answers || {};
  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-label">Categories</div>
      <div id="catsList">${q.categories.map((c, i) => `
        <div class="sub-row categ-cat-row">
          <span class="sub-key">${esc(c.id || '')}</span>
          <input type="text" data-cat-label="${i}" value="${esc(c.label || '')}" placeholder="Category name">
          <button class="sub-delete-btn" data-cat-delete="${i}" title="Remove category">⌫</button>
        </div>`).join('')}</div>
      <button class="add-row-btn" id="addCatBtn">+ Add Category</button>
    </div>
    <div class="editor-section">
      <div class="editor-section-label">Items (with correct category)</div>
      <div class="editor-section-hint">For each item, choose the correct category from the dropdown.</div>
      <div id="itemsList">${q.items.map((it, i) => `
        <div class="sub-row categ-item-row">
          <input type="text" data-item-text="${i}" value="${esc(it || '')}" placeholder="Item text">
          <select data-item-cat="${i}">
            <option value="">— pick category —</option>
            ${q.categories.map(c => `<option value="${esc(c.id)}" ${q.answers[it] === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
          </select>
          <button class="sub-delete-btn" data-item-delete="${i}" title="Remove item">⌫</button>
        </div>`).join('')}</div>
      <button class="add-row-btn" id="addItemBtn">+ Add Item</button>
    </div>
  `;
  container.querySelectorAll('[data-cat-label]').forEach(input => input.addEventListener('input', () => { q.categories[parseInt(input.dataset.catLabel, 10)].label = input.value; refreshJsonViewer(q); }));
  container.querySelectorAll('[data-cat-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.catDelete, 10);
      const removedId = q.categories[i].id;
      q.categories.splice(i, 1);
      Object.keys(q.answers).forEach(k => { if (q.answers[k] === removedId) delete q.answers[k]; });
      rerenderTypeEditor();
    });
  });
  container.querySelectorAll('[data-item-text]').forEach(input => {
    input.addEventListener('input', () => {
      const i = parseInt(input.dataset.itemText, 10);
      const oldText = q.items[i];
      q.items[i] = input.value;
      if (oldText !== input.value && q.answers[oldText] != null) { q.answers[input.value] = q.answers[oldText]; delete q.answers[oldText]; }
      refreshJsonViewer(q);
    });
  });
  container.querySelectorAll('[data-item-cat]').forEach(sel => {
    sel.addEventListener('change', () => {
      const i = parseInt(sel.dataset.itemCat, 10);
      const itemText = q.items[i];
      if (sel.value) q.answers[itemText] = sel.value; else delete q.answers[itemText];
      refreshJsonViewer(q);
    });
  });
  container.querySelectorAll('[data-item-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.itemDelete, 10);
      const removedItem = q.items[i];
      q.items.splice(i, 1);
      delete q.answers[removedItem];
      rerenderTypeEditor();
    });
  });
  document.getElementById('addCatBtn').addEventListener('click', () => {
    const nextN = q.categories.length + 1;
    q.categories.push({ id: `cat${nextN}`, label: `Category ${nextN}` });
    rerenderTypeEditor();
  });
  document.getElementById('addItemBtn').addEventListener('click', () => { q.items.push(''); rerenderTypeEditor(); });
}

// ----- Sentence Order -----
function renderSentenceOrderEditor(q, container) {
  q.words = q.words || [];
  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-label">Sentence Order</div>
      <div class="field"><label>Scrambled Words (comma separated)</label><input type="text" id="so-words" value="${esc(q.words.join(', '))}" placeholder="e.g. are, these, hard, working, students"></div>
      <div class="field"><label>Expected Order (full sentence)</label><input type="text" id="so-expected" value="${esc(q.expected || '')}" placeholder="e.g. These students are working hard."></div>
      <div class="field"><label>Grading Rubric</label><textarea id="so-rubric">${esc(q.rubric || '')}</textarea></div>
    </div>
  `;
  document.getElementById('so-words').addEventListener('input', e => { q.words = e.target.value.split(',').map(s => s.trim()).filter(Boolean); refreshJsonViewer(q); });
  document.getElementById('so-expected').addEventListener('input', e => { q.expected = e.target.value; refreshJsonViewer(q); });
  document.getElementById('so-rubric').addEventListener('input', e => { q.rubric = e.target.value; refreshJsonViewer(q); });
}

// ----- Short Answer -----
function renderShortAnswerEditor(q, container) {
  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-label">Short Answer (Manual)</div>
      <div class="field"><label>Expected Answer (for grading reference)</label><input type="text" id="sa-expected" value="${esc(q.expected_answer || '')}" placeholder="What you'd consider a correct answer"></div>
      <div class="field"><label>Grading Rubric</label><textarea id="sa-rubric" placeholder="Notes for the grader (e.g. partial credit guidelines)">${esc(q.rubric || '')}</textarea></div>
    </div>
  `;
  document.getElementById('sa-expected').addEventListener('input', e => { q.expected_answer = e.target.value; refreshJsonViewer(q); });
  document.getElementById('sa-rubric').addEventListener('input', e => { q.rubric = e.target.value; refreshJsonViewer(q); });
}

// ----- Writing Prompt -----
function renderWritingPromptEditor(q, container) {
  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-label">Writing Prompt (Manual)</div>
      <div class="field"><label>Grading Rubric</label><textarea id="wp-rubric" placeholder="Notes for the grader (e.g. grammar focus, length expectations)">${esc(q.rubric || '')}</textarea></div>
    </div>
  `;
  document.getElementById('wp-rubric').addEventListener('input', e => { q.rubric = e.target.value; refreshJsonViewer(q); });
}

// ----- Pool Writing -----
function renderPoolWritingEditor(q, container) {
  q.word_pool = q.word_pool || [];
  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-label">Pool Writing (Manual)</div>
      <div class="field"><label>Word Pool (comma separated)</label><input type="text" id="pw-pool" value="${esc(q.word_pool.join(', '))}" placeholder="e.g. spring, snow, flower, people, garden"></div>
      <div class="grid-2col">
        <div class="field"><label>Required Sentences</label><input type="number" id="pw-required" value="${q.required_count ?? 5}" min="1"></div>
        <div class="field"><label>Points per Sentence</label><input type="number" id="pw-pps" value="${q.points_per_sentence ?? 2}" step="0.5" min="0"></div>
      </div>
      <div class="field"><label>Grading Rubric</label><textarea id="pw-rubric">${esc(q.rubric || '')}</textarea></div>
    </div>
  `;
  document.getElementById('pw-pool').addEventListener('input', e => { q.word_pool = e.target.value.split(',').map(s => s.trim()).filter(Boolean); refreshJsonViewer(q); });
  document.getElementById('pw-required').addEventListener('input', e => { q.required_count = parseInt(e.target.value, 10) || 1; refreshJsonViewer(q); });
  document.getElementById('pw-pps').addEventListener('input', e => { q.points_per_sentence = parseFloat(e.target.value) || 0; refreshJsonViewer(q); });
  document.getElementById('pw-rubric').addEventListener('input', e => { q.rubric = e.target.value; refreshJsonViewer(q); });
}

// ----- Image Label -----
function renderImageLabelEditor(q, container) {
  q.image = q.image || { placeholder: '', alt: '', url: null };
  q.labels = q.labels || [];
  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-label">Image</div>
      <div class="image-info-row">
        <div><label>Placeholder filename</label><input type="text" id="il-placeholder" value="${esc(q.image.placeholder || '')}" placeholder="${esc(q.id)}_image.png"></div>
        <div><label>Alt text (description)</label><input type="text" id="il-alt" value="${esc(q.image.alt || '')}" placeholder="What does the image show?"></div>
      </div>
      <div class="editor-note">${q.image.url ? '✓ Image uploaded' : 'Image not yet uploaded — use the image inventory section above to upload.'}</div>
    </div>
    <div class="editor-section">
      <div class="editor-section-label">Labels</div>
      <div class="editor-section-hint">Each label is a part of the image the student must identify.</div>
      <div class="label-row-header"><span>Label name</span><span>Correct answer</span><span>Accepted variants</span><span></span></div>
      <div id="labelsList">${q.labels.map((l, i) => `
        <div class="sub-row label-row">
          <input type="text" data-il-label="${i}" value="${esc(l.label || '')}" placeholder="e.g. John">
          <input type="text" data-il-answer="${i}" value="${esc(l.answer || '')}" placeholder="e.g. eat">
          <input type="text" data-il-accepted="${i}" value="${esc((l.accepted_answers || []).join(', '))}" placeholder="eats, eating">
          <button class="sub-delete-btn" data-il-delete="${i}" title="Remove">⌫</button>
        </div>`).join('')}</div>
      <button class="add-row-btn" id="addLabelBtn">+ Add Label</button>
      <label class="sub-radio sub-radio--mt"><input type="checkbox" id="il-case" ${q.case_sensitive ? 'checked' : ''}> Case sensitive</label>
    </div>
  `;
  document.getElementById('il-placeholder').addEventListener('input', e => { q.image.placeholder = e.target.value; refreshJsonViewer(q); });
  document.getElementById('il-alt').addEventListener('input', e => { q.image.alt = e.target.value; refreshJsonViewer(q); });
  document.getElementById('il-case').addEventListener('change', e => { q.case_sensitive = e.target.checked; refreshJsonViewer(q); });
  container.querySelectorAll('[data-il-label]').forEach(input => input.addEventListener('input', () => { q.labels[parseInt(input.dataset.ilLabel, 10)].label = input.value; refreshJsonViewer(q); }));
  container.querySelectorAll('[data-il-answer]').forEach(input => input.addEventListener('input', () => { q.labels[parseInt(input.dataset.ilAnswer, 10)].answer = input.value; refreshJsonViewer(q); }));
  container.querySelectorAll('[data-il-accepted]').forEach(input => input.addEventListener('input', () => { q.labels[parseInt(input.dataset.ilAccepted, 10)].accepted_answers = input.value.split(',').map(s => s.trim()).filter(Boolean); refreshJsonViewer(q); }));
  container.querySelectorAll('[data-il-delete]').forEach(btn => btn.addEventListener('click', () => { q.labels.splice(parseInt(btn.dataset.ilDelete, 10), 1); rerenderTypeEditor(); }));
  document.getElementById('addLabelBtn').addEventListener('click', () => {
    const nextN = q.labels.length + 1;
    q.labels.push({ id: `l${nextN}`, label: '', answer: '', accepted_answers: [] });
    rerenderTypeEditor();
  });
}

// ----- Image Match -----
function renderImageMatchEditor(q, container) {
  q.image = q.image || { placeholder: '', alt: '', url: null };
  q.items = q.items || [];
  q.image_regions = q.image_regions || [];
  q.answers = q.answers || {};
  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-label">Image</div>
      <div class="image-info-row">
        <div><label>Placeholder filename</label><input type="text" id="im-placeholder" value="${esc(q.image.placeholder || '')}" placeholder="${esc(q.id)}_image.png"></div>
        <div><label>Alt text (description)</label><input type="text" id="im-alt" value="${esc(q.image.alt || '')}" placeholder="What does the image show?"></div>
      </div>
      <div class="editor-note">${q.image.url ? '✓ Image uploaded' : 'Image not yet uploaded — use the image inventory section above to upload.'}</div>
    </div>
    <div class="editor-section">
      <div class="editor-section-label">Image Regions</div>
      <div class="editor-section-hint">Numbered regions visible on the image (the student picks one for each item).</div>
      <div class="field"><input type="text" id="im-regions" value="${esc(q.image_regions.join(', '))}" placeholder="1, 2, 3, 4, 5, 6"></div>
    </div>
    <div class="editor-section">
      <div class="editor-section-label">Items (with correct region)</div>
      <div id="imItemsList">${q.items.map((it, i) => `
        <div class="sub-row sub-row--3col">
          <input type="text" data-im-item="${i}" value="${esc(it || '')}" placeholder="Item text">
          <select data-im-answer="${i}">
            <option value="">— pick region —</option>
            ${q.image_regions.map(r => `<option value="${esc(r)}" ${q.answers[it] === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
          </select>
          <button class="sub-delete-btn" data-im-item-delete="${i}" title="Remove">⌫</button>
        </div>`).join('')}</div>
      <button class="add-row-btn" id="addImItemBtn">+ Add Item</button>
    </div>
  `;
  document.getElementById('im-placeholder').addEventListener('input', e => { q.image.placeholder = e.target.value; refreshJsonViewer(q); });
  document.getElementById('im-alt').addEventListener('input', e => { q.image.alt = e.target.value; refreshJsonViewer(q); });
  document.getElementById('im-regions').addEventListener('input', e => {
    q.image_regions = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
    Object.keys(q.answers).forEach(k => { if (!q.image_regions.includes(q.answers[k])) delete q.answers[k]; });
    rerenderTypeEditor();
  });
  container.querySelectorAll('[data-im-item]').forEach(input => {
    input.addEventListener('input', () => {
      const i = parseInt(input.dataset.imItem, 10);
      const oldText = q.items[i];
      q.items[i] = input.value;
      if (oldText !== input.value && q.answers[oldText] != null) { q.answers[input.value] = q.answers[oldText]; delete q.answers[oldText]; }
      refreshJsonViewer(q);
    });
  });
  container.querySelectorAll('[data-im-answer]').forEach(sel => {
    sel.addEventListener('change', () => {
      const itemText = q.items[parseInt(sel.dataset.imAnswer, 10)];
      if (sel.value) q.answers[itemText] = sel.value; else delete q.answers[itemText];
      refreshJsonViewer(q);
    });
  });
  container.querySelectorAll('[data-im-item-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.imItemDelete, 10);
      const removedItem = q.items[i];
      q.items.splice(i, 1);
      delete q.answers[removedItem];
      rerenderTypeEditor();
    });
  });
  document.getElementById('addImItemBtn').addEventListener('click', () => { q.items.push(''); rerenderTypeEditor(); });
}

// ===== SAVE QUESTION =====
function syncQuestionStandardFields() {
  if (!editingQuestion) return;
  const { q } = editingQuestion;
  q.grading = document.getElementById('editQGrading').value;
  q.points = parseFloat(document.getElementById('editQPoints').value) || 0;
  q.prompt = document.getElementById('editQPrompt').value;
}

document.getElementById('saveQuestionBtn').addEventListener('click', () => {
  if (!editingQuestion) return;
  const { sIdx, qIdx, q } = editingQuestion;
  syncQuestionStandardFields();
  examDef.sections[sIdx].questions[qIdx] = q;
  markDirty();
  closeQuestionModal();
  renderContent();
  updateSidebar();
  showToast('Question updated. Don\'t forget to save your changes.', 'success');
});

document.getElementById('saveToBankBtn').addEventListener('click', async () => {
  if (!editingQuestion) return;
  syncQuestionStandardFields();
  const { q } = editingQuestion;
  const btn = document.getElementById('saveToBankBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const { error } = await db.from('question_bank').insert({
      created_by: currentProfile.id,
      source: 'exam',
      question_type: q.type,
      question_data: q,
      label: (q.prompt || q.type).slice(0, 120),
      tags: []
    });
    if (error) throw error;
    showToast('Question saved to the bank', 'success');
  } catch (err) {
    showToast('Could not save to bank: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save to Bank';
  }
});

// ===== SAVE / PUBLISH =====
async function saveExam(newStatus = null) {
  const updates = { exam_definition: examDef, proctoring_settings: currentExam.proctoring_settings, shared: !!currentExam.shared };
  if (newStatus) updates.status = newStatus;
  const { data, error } = await db.from('exams').update(updates).eq('id', currentExam.id).select().single();
  if (error) throw error;
  currentExam = { ...currentExam, ...data };
  clearDirty();
  renderMetadata();
  renderProctoring();
}

document.getElementById('saveDraftBtn').addEventListener('click', async () => {
  const btn = document.getElementById('saveDraftBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await saveExam(currentExam.status === 'archived' ? null : 'draft');
    showToast('Draft saved', 'success');
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Draft';
    updateSidebar();
  }
});

document.getElementById('publishBtn').addEventListener('click', async () => {
  if (!confirm('Publish this exam? Once published, it will be available to students within its scheduled window.')) return;
  const btn = document.getElementById('publishBtn');
  btn.disabled = true;
  btn.textContent = 'Publishing…';
  try {
    await saveExam('active');
    showToast('Exam published', 'success');
  } catch (err) {
    showToast('Publish failed: ' + err.message, 'error');
  } finally {
    btn.textContent = 'Publish';
    updateSidebar();
  }
});

document.getElementById('archiveBtn').addEventListener('click', async () => {
  if (!confirm('Archive this exam? It will no longer be available to students.')) return;
  try {
    await saveExam('archived');
    showToast('Exam archived', 'success');
  } catch (err) {
    showToast('Archive failed: ' + err.message, 'error');
  }
});

// ===== DELETE EXAM =====
function openDeleteExamModal() {
  document.getElementById('deleteExamSub').textContent = `${currentExam._class_name} · ${currentExam.code}`;
  document.getElementById('deleteExamCodeLabel').textContent = currentExam.code;
  document.getElementById('deleteExamConfirmInput').value = '';
  document.getElementById('confirmDeleteExamBtn').disabled = true;
  openModal('deleteExamModal');
}

function closeDeleteExamModal() { closeModal('deleteExamModal'); }

document.getElementById('deleteExamBtn').addEventListener('click', openDeleteExamModal);
document.getElementById('cancelDeleteExamBtn').addEventListener('click', closeDeleteExamModal);
document.getElementById('deleteExamModal').addEventListener('click', e => { if (e.target.id === 'deleteExamModal') closeDeleteExamModal(); });

document.getElementById('deleteExamConfirmInput').addEventListener('input', (e) => {
  document.getElementById('confirmDeleteExamBtn').disabled = e.target.value !== currentExam.code;
});

document.getElementById('confirmDeleteExamBtn').addEventListener('click', async () => {
  if (document.getElementById('deleteExamConfirmInput').value !== currentExam.code) return;
  const btn = document.getElementById('confirmDeleteExamBtn');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    await deleteExamCompletely();
    isDirty = false;
    showToast('Exam deleted', 'success');
    window.location.href = 'dashboard.html';
  } catch (err) {
    console.error(err);
    showToast('Delete failed: ' + err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Delete Exam';
  }
});

async function deleteExamCompletely() {
  const { error: subErr } = await db.from('submissions').delete().eq('exam_id', currentExam.id);
  if (subErr) throw subErr;

  const { data: files, error: listErr } = await db.storage.from(STORAGE_BUCKET).list(currentExam.code);
  if (listErr) throw listErr;
  if (files && files.length) {
    const paths = files.map(f => `${currentExam.code}/${f.name}`);
    const { error: rmErr } = await db.storage.from(STORAGE_BUCKET).remove(paths);
    if (rmErr) throw rmErr;
  }

  const { error: examErr } = await db.from('exams').delete().eq('id', currentExam.id);
  if (examErr) throw examErr;
}

document.getElementById('previewBtn').addEventListener('click', () => {
  if (!currentExam) return;
  if (!examDef || !examDef.sections) {
    showToast('Add content first to preview it', 'error');
    return;
  }
  if (isDirty && !confirm('You have unsaved changes. The preview will show the last saved version. Save first?')) return;
  window.open(`page.html?preview=true&id=${currentExam.id}`, '_blank');
});

// ===== METADATA EDIT MODAL =====
function formatDateForInput(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openMetadataModal() {
  const e = currentExam;
  document.getElementById('metadataModalTitle').textContent = e._class_name;
  document.getElementById('metadataModalCode').textContent = `${e.code} · ${e.type} · ${e.quarter} ${e.year}`;

  document.getElementById('metaEditClassId').innerHTML = '<option value="">— select class —</option>' +
    allClasses.filter(c => c.is_active || c.id === e.class_id).map(c => `<option value="${c.id}" ${c.id === e.class_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  document.getElementById('metaEditLevelId').innerHTML = '<option value="">— select level —</option>' +
    allLevels.filter(l => l.is_active || l.id === e.level_id).map(l => `<option value="${l.id}" ${l.id === e.level_id ? 'selected' : ''}>${esc(l.name)}</option>`).join('');

  const teacherFieldEl = document.getElementById('metaEditTeacherField');
  const teacherSelect = document.getElementById('metaEditTeacherId');
  if (currentProfile.role === 'academic') {
    teacherFieldEl.style.display = 'flex';
    teacherSelect.disabled = false;
    teacherSelect.innerHTML = '<option value="">— select teacher —</option>' +
      allTeachers.map(t => `<option value="${t.id}" ${t.id === e.teacher_id ? 'selected' : ''}>${esc(t.full_name || t.email)}${t.role === 'academic' ? ' (Academic)' : ''}</option>`).join('');
  } else {
    teacherFieldEl.style.display = 'flex';
    teacherSelect.disabled = true;
    const currentTeacher = allTeachers.find(t => t.id === e.teacher_id);
    teacherSelect.innerHTML = `<option value="${e.teacher_id}" selected>${esc(currentTeacher?.full_name || currentTeacher?.email || 'Unknown')}${currentTeacher?.role === 'academic' ? ' (Academic)' : ''}</option>`;
  }

  document.getElementById('metaEditAvailableFrom').value = formatDateForInput(e.available_from);
  document.getElementById('metaEditAvailableUntil').value = formatDateForInput(e.available_until);
  document.getElementById('metaEditStatus').value = e.status;
  document.getElementById('metaEditNotes').value = e.notes || '';

  openModal('metadataModal');
}

function closeMetadataModal() { closeModal('metadataModal'); }
document.getElementById('cancelMetadataBtn').addEventListener('click', closeMetadataModal);
document.getElementById('metadataModal').addEventListener('click', e => { if (e.target.id === 'metadataModal') closeMetadataModal(); });

document.getElementById('metadataForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const saveBtn = document.getElementById('metaEditSaveBtn');
  const from = new Date(document.getElementById('metaEditAvailableFrom').value);
  const until = new Date(document.getElementById('metaEditAvailableUntil').value);
  if (until <= from) { showToast('"Available Until" must be after "Available From".', 'error'); return; }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  const updates = {
    class_id: document.getElementById('metaEditClassId').value,
    level_id: document.getElementById('metaEditLevelId').value,
    available_from: from.toISOString(),
    available_until: until.toISOString(),
    status: document.getElementById('metaEditStatus').value,
    notes: document.getElementById('metaEditNotes').value.trim() || null
  };
  if (currentProfile.role === 'academic') updates.teacher_id = document.getElementById('metaEditTeacherId').value;

  try {
    const { data, error } = await db.from('exams').update(updates).eq('id', currentExam.id).select().single();
    if (error) throw error;
    const cls = allClasses.find(c => c.id === data.class_id);
    const lvl = allLevels.find(l => l.id === data.level_id);
    const tch = allTeachers.find(t => t.id === data.teacher_id);
    currentExam = { ...currentExam, ...data, _class_name: cls?.name || '—', _level_name: lvl?.name || '—', _teacher_name: tch?.full_name || tch?.email || '—' };
    renderMetadata();
    closeMetadataModal();
    showToast('Metadata updated', 'success');
  } catch (err) {
    console.error(err);
    showToast(`Failed to save: ${err.message}`, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Changes';
  }
});

document.getElementById('editMetadataBtn').addEventListener('click', (e) => { e.preventDefault(); openMetadataModal(); });

// ===== SECTION EDIT MODAL =====
function openSectionEdit(sIdx) {
  const section = examDef.sections[sIdx];
  if (!section) return;
  editingSectionIdx = sIdx;
  document.getElementById('sectionModalStamp').textContent = `Section ${sIdx + 1}`;
  document.getElementById('sectionModalTitle').textContent = section.title || 'Untitled Section';
  document.getElementById('secEditTitle').value = section.title || '';
  document.getElementById('secEditInstructions').value = section.instructions || '';
  document.getElementById('secEditPassage').value = section.passage?.content || '';
  openModal('sectionModal');
}

function closeSectionModal() {
  closeModal('sectionModal');
  editingSectionIdx = null;
}
document.getElementById('cancelSectionBtn').addEventListener('click', closeSectionModal);
document.getElementById('sectionModal').addEventListener('click', e => { if (e.target.id === 'sectionModal') closeSectionModal(); });

document.getElementById('secEditSaveBtn').addEventListener('click', () => {
  if (editingSectionIdx == null) return;
  const section = examDef.sections[editingSectionIdx];
  const title = document.getElementById('secEditTitle').value.trim();
  const instructions = document.getElementById('secEditInstructions').value.trim();
  const passage = document.getElementById('secEditPassage').value.trim();
  section.title = title || 'Untitled Section';
  section.instructions = instructions || null;
  section.passage = passage ? { type: 'text', content: passage } : null;
  markDirty();
  closeSectionModal();
  renderContent();
  updateSidebar();
  showToast('Section updated. Don\'t forget to save your changes.', 'success');
});

// ===== PROMPT MODAL =====
function openPromptModal() {
  document.getElementById('promptBox').textContent = CONVERSION_PROMPT;
  document.getElementById('promptBox').style.maxHeight = '240px';
  document.getElementById('togglePromptBtn').textContent = 'Expand';
  openModal('promptModal');
}
function closePromptModal() { closeModal('promptModal'); }

document.getElementById('openPromptBtn').addEventListener('click', openPromptModal);
document.getElementById('closePromptBtn').addEventListener('click', closePromptModal);
document.getElementById('promptModal').addEventListener('click', e => { if (e.target.id === 'promptModal') closePromptModal(); });

document.getElementById('togglePromptBtn').addEventListener('click', () => {
  const box = document.getElementById('promptBox');
  const btn = document.getElementById('togglePromptBtn');
  if (box.style.maxHeight === '240px' || box.style.maxHeight === '') {
    box.style.maxHeight = 'calc(80vh - 200px)';
    btn.textContent = 'Collapse';
  } else {
    box.style.maxHeight = '240px';
    btn.textContent = 'Expand';
  }
});

document.getElementById('copyPromptBtn').addEventListener('click', async () => {
  const btn = document.getElementById('copyPromptBtn');
  try {
    await navigator.clipboard.writeText(CONVERSION_PROMPT);
    const original = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = original; }, 2000);
  } catch (err) {
    showToast('Could not copy. Select the text manually and copy.', 'error');
  }
});

// ===== BULK CSV/XLSX IMPORT =====
function populateBulkSectionSelect() {
  const sel = document.getElementById('bulkImportSection');
  const sections = examDef?.sections || [];
  sel.innerHTML = sections.map((s, i) => `<option value="${i}">${esc(s.title || `Section ${i + 1}`)}</option>`).join('') +
    `<option value="__new__">+ New Section</option>`;
}

function openBulkImportModal() {
  if (!examDef) {
    showToast('Start building the exam first (from scratch or JSON) before importing.', 'error');
    return;
  }
  bulkParsedQuestions = [];
  document.getElementById('bulkImportFileInput').value = '';
  document.getElementById('bulkImportResults').innerHTML = '';
  document.getElementById('runBulkImportBtn').disabled = true;
  populateBulkSectionSelect();
  openModal('bulkImportModal');
}
document.getElementById('bulkImportBtn').addEventListener('click', openBulkImportModal);
document.getElementById('cancelBulkImportBtn').addEventListener('click', () => closeModal('bulkImportModal'));
document.getElementById('bulkImportModal').addEventListener('click', e => { if (e.target.id === 'bulkImportModal') closeModal('bulkImportModal'); });

function normalizeRow(row) {
  const out = {};
  Object.keys(row).forEach(k => { out[String(k).trim().toLowerCase()] = row[k]; });
  return out;
}

function buildQuestionFromRow(row, rowNum, tempDef) {
  const type = String(row.type || '').trim().toLowerCase();
  const prompt = String(row.prompt || '').trim();
  const points = row.points != null && row.points !== '' ? parseFloat(row.points) : 1;

  if (!EXAM_BULK_IMPORT_TYPES.includes(type)) {
    return { error: `Row ${rowNum}: unsupported type "${row.type || ''}" — bulk import only supports ${EXAM_BULK_IMPORT_TYPES.join(', ')}` };
  }
  if (!prompt) return { error: `Row ${rowNum}: missing prompt` };

  const id = generateQuestionId(tempDef);

  if (type === 'multiple_choice') {
    const base = { id, type, prompt, points: isNaN(points) ? 1 : points, grading: 'auto' };
    const letters = ['a', 'b', 'c', 'd'];
    const options = letters
      .map(l => ({ key: l, text: String(row[`option_${l}`] || '').trim() }))
      .filter(o => o.text);
    if (options.length < 2) return { error: `Row ${rowNum}: multiple_choice needs at least 2 non-empty options (option_a, option_b, …)` };
    const answer = String(row.answer || '').trim().toLowerCase();
    if (!options.find(o => o.key === answer)) return { error: `Row ${rowNum}: answer "${row.answer || ''}" does not match any option letter` };
    return { question: { ...base, options, answer } };
  }

  if (type === 'true_false') {
    const base = { id, type, prompt, points: isNaN(points) ? 1 : points, grading: 'auto' };
    const raw = String(row.answer || '').trim().toUpperCase();
    const answer = raw.startsWith('T') ? 'T' : raw.startsWith('F') ? 'F' : null;
    if (!answer) return { error: `Row ${rowNum}: true_false answer must be T or F` };
    return { question: { ...base, answer } };
  }

  if (type === 'fill_blank') {
    const base = { id, type, prompt, points: isNaN(points) ? 1 : points, grading: 'auto' };
    const answer = String(row.answer || '').trim();
    if (!answer) return { error: `Row ${rowNum}: fill_blank needs an answer` };
    if (!prompt.includes('{blank}')) return { error: `Row ${rowNum}: fill_blank prompt should contain {blank}` };
    return { question: { ...base, answer, accepted_answers: [], case_sensitive: false } };
  }

  // short_answer — manually graded; the answer column is an optional reference answer.
  const base = { id, type, prompt, points: isNaN(points) ? 1 : points, grading: 'manual' };
  return { question: { ...base, expected_answer: String(row.answer || '').trim(), rubric: '' } };
}

async function parseBulkFile(file) {
  const isCsv = file.name.toLowerCase().endsWith('.csv');
  let workbook;
  if (isCsv) {
    const text = await file.text();
    workbook = XLSX.read(text, { type: 'string' });
  } else {
    const buf = await file.arrayBuffer();
    workbook = XLSX.read(buf, { type: 'array' });
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  return rows.map(normalizeRow);
}

document.getElementById('bulkImportFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const resultsEl = document.getElementById('bulkImportResults');
  const runBtn = document.getElementById('runBulkImportBtn');
  bulkParsedQuestions = [];
  if (!file) { resultsEl.innerHTML = ''; runBtn.disabled = true; return; }

  try {
    const rows = await parseBulkFile(file);
    if (!rows.length) throw new Error('No data rows found in the file.');

    const tempDef = JSON.parse(JSON.stringify(examDef));
    const errors = [];
    rows.forEach((row, i) => {
      const result = buildQuestionFromRow(row, i + 2, tempDef);
      if (result.error) { errors.push(result.error); return; }
      bulkParsedQuestions.push(result.question);
      tempDef.sections = tempDef.sections || [];
      if (!tempDef.sections.length) tempDef.sections.push({ id: 'tmp', questions: [] });
      tempDef.sections[0].questions.push(result.question);
    });

    let html = `<p style="font-size:0.85rem;color:var(--navy-l);margin-bottom:0.5rem;"><strong>${bulkParsedQuestions.length}</strong> question${bulkParsedQuestions.length === 1 ? '' : 's'} ready to import${errors.length ? `, <strong style="color:var(--red);">${errors.length}</strong> row${errors.length === 1 ? '' : 's'} skipped` : ''}.</p>`;
    if (errors.length) html += `<ul class="validation-list">${errors.map(e => `<li class="fail">${esc(e)}</li>`).join('')}</ul>`;
    resultsEl.innerHTML = html;
    runBtn.disabled = bulkParsedQuestions.length === 0;
  } catch (err) {
    resultsEl.innerHTML = `<p style="color:var(--red);font-size:0.85rem;">Could not read file: ${esc(err.message)}</p>`;
    runBtn.disabled = true;
  }
});

document.getElementById('runBulkImportBtn').addEventListener('click', () => {
  if (!bulkParsedQuestions.length) return;
  const sel = document.getElementById('bulkImportSection');
  let targetIdx;
  if (sel.value === '__new__') {
    const newSection = makeSectionStub(examDef);
    newSection.title = 'Imported Questions';
    examDef.sections.push(newSection);
    targetIdx = examDef.sections.length - 1;
  } else {
    targetIdx = parseInt(sel.value, 10);
  }

  bulkParsedQuestions.forEach(q => {
    q.id = generateQuestionId(examDef);
    examDef.sections[targetIdx].questions.push(q);
  });

  markDirty();
  renderContent();
  updateSidebar();
  closeModal('bulkImportModal');
  showToast(`Imported ${bulkParsedQuestions.length} question${bulkParsedQuestions.length === 1 ? '' : 's'}`, 'success');
  bulkParsedQuestions = [];
});

// ===== QUESTION BANK =====
function populateBankTargetSection() {
  const sel = document.getElementById('bankTargetSection');
  const sections = examDef?.sections || [];
  if (!sections.length) { sel.innerHTML = '<option value="">— create a section first —</option>'; return; }
  sel.innerHTML = sections.map((s, i) => `<option value="${i}">${esc(s.title || `Section ${i + 1}`)}</option>`).join('');
}

async function loadBankEntries() {
  const { data, error } = await db.from('question_bank').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  bankEntries = data || [];
  const types = [...new Set(bankEntries.map(b => b.question_type))].sort();
  document.getElementById('bankTypeFilter').innerHTML = '<option value="">All types</option>' +
    types.map(t => `<option value="${esc(t)}">${esc(EXAM_TYPE_INFO[t]?.label || t)}</option>`).join('');
}

function renderBankList() {
  const search = document.getElementById('bankSearch').value.trim().toLowerCase();
  const typeFilter = document.getElementById('bankTypeFilter').value;
  const list = document.getElementById('bankList');
  const filtered = bankEntries.filter(b => {
    if (typeFilter && b.question_type !== typeFilter) return false;
    if (search) {
      const hay = `${b.label || ''} ${b.question_data?.prompt || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><p>No matching questions in the bank.</p></div>`;
    return;
  }

  const canInsert = !!(examDef && examDef.sections && examDef.sections.length);
  list.innerHTML = filtered.map(b => `
    <div class="bank-item">
      <div class="bank-item-info">
        <div class="bank-item-prompt">${esc(b.label || b.question_data?.prompt || '(no prompt)')}</div>
        <div class="bank-item-meta">
          <span class="type-badge">${esc(b.question_type)}</span>
          <span>${b.question_data?.points ?? '?'} pts</span>
          ${b.source ? `<span>${esc(b.source)}</span>` : ''}
        </div>
      </div>
      <button class="btn btn--secondary btn--sm" data-bank-insert="${esc(b.id)}" ${canInsert ? '' : 'disabled'}>Insert</button>
    </div>
  `).join('');
}

document.getElementById('bankList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-bank-insert]');
  if (!btn) return;
  const entry = bankEntries.find(b => String(b.id) === btn.dataset.bankInsert);
  if (!entry) return;
  const sectionIdx = parseInt(document.getElementById('bankTargetSection').value, 10);
  if (isNaN(sectionIdx)) { showToast('Create a section first', 'error'); return; }
  const clone = JSON.parse(JSON.stringify(entry.question_data));
  clone.id = generateQuestionId(examDef);
  examDef.sections[sectionIdx].questions.push(clone);
  markDirty();
  renderContent();
  updateSidebar();
  showToast('Question inserted from bank', 'success');
});

document.getElementById('bankSearch').addEventListener('input', renderBankList);
document.getElementById('bankTypeFilter').addEventListener('change', renderBankList);
document.getElementById('bankTargetSection').addEventListener('change', renderBankList);

async function openQuestionBankModal() {
  if (!examDef) {
    showToast('Start building the exam first (from scratch or JSON) before using the question bank.', 'error');
    return;
  }
  populateBankTargetSection();
  openModal('questionBankModal');
  document.getElementById('bankList').innerHTML = '<div class="empty-state"><p>Loading…</p></div>';
  try {
    await loadBankEntries();
    renderBankList();
  } catch (err) {
    document.getElementById('bankList').innerHTML = `<p style="color:var(--red);">Could not load question bank: ${esc(err.message)}</p>`;
  }
}
document.getElementById('questionBankBtn').addEventListener('click', openQuestionBankModal);
document.getElementById('closeBankBtn').addEventListener('click', () => closeModal('questionBankModal'));
document.getElementById('questionBankModal').addEventListener('click', e => { if (e.target.id === 'questionBankModal') closeModal('questionBankModal'); });

// ===== INIT =====
(async () => {
  const auth = await requireAuth();
  if (!auth) return;
  currentUser = auth.session.user;
  currentProfile = auth.profile;
  renderNavbar(document.getElementById('navbarContainer'), { profile: currentProfile, active: 'exams' });
  await loadExam();
  setupJsonUpload();
})();
