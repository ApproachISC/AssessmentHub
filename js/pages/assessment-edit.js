import { db } from '../supabase-client.js';
import { requireAuth } from '../auth.js';
import { renderNavbar, showToast, esc, openModal, closeModal } from '../ui.js';
import {
  VALID_QUESTION_TYPES, TYPE_INFO, BULK_IMPORT_TYPES,
  generateQuestionId, generateSectionId, makeQuestionStub, makeSectionStub,
  validateAuthoredQuestion
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
let bulkParsedQuestions = []; // validated stubs ready to import
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

// ===== CONVERSION PROMPT =====
const CONVERSION_PROMPT = `You are an assessment-conversion assistant for the Approach International Student Center online assessment platform. Your task is to read the attached document and convert it into a structured JSON file that follows our exact schema.

# CRITICAL RULES

1. Output ONLY a single valid JSON object. No commentary before, no commentary after, no markdown code fences, no explanations. The first character of your response must be \`{\` and the last must be \`}\`.
2. Every question must have an \`id\`, \`type\`, \`grading\`, \`points\`, and \`prompt\`.
3. All assessment question types are auto-graded. Do not use \`grading: "manual"\` unless there is genuinely no determinable correct answer, in which case use \`short_answer\` as a fallback and note it in \`rubric\`.
4. For images: assessments do not support image questions. If the source document contains image-based questions, convert them to the closest text-based equivalent (e.g. describe the image in the prompt and use multiple_choice or fill_blank).
5. Preserve the document's original section structure using the \`sections\` array.
6. If the document contains reading passages, place the full text in the section's \`passage\` field as plain text (no markdown). Questions about that passage go in the same section's \`questions\` array.

# JSON SCHEMA

The output must conform to this exact structure:

{
  "schema_version": "1.0",
  "exam_metadata": {
    "title": "<assessment title from the document>",
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

## "multiple_choice" — single correct answer selected from a list of options
Each option has a unique key (a, b, c, d…). The student picks exactly one.
{
  "id": "q1", "type": "multiple_choice", "grading": "auto", "points": 1,
  "prompt": "Which sentence uses the Simple Past correctly?",
  "options": [
    {"key": "a", "text": "She go to school yesterday."},
    {"key": "b", "text": "She went to school yesterday."},
    {"key": "c", "text": "She goes to school yesterday."},
    {"key": "d", "text": "She gone to school yesterday."}
  ],
  "answer": "b"
}

## "multiple_select" — one or more correct answers from a list (partial credit)
The student checks all options they believe are correct. Use when more than one answer is right.
Partial credit: each correct selection earns points; each wrong selection deducts the same amount (minimum 0).
{
  "id": "q2", "type": "multiple_select", "grading": "auto", "points": 2,
  "prompt": "Which of the following are irregular past tense verbs? Select all that apply.",
  "options": [
    {"key": "a", "text": "went"},
    {"key": "b", "text": "played"},
    {"key": "c", "text": "ate"},
    {"key": "d", "text": "talked"}
  ],
  "correct_answers": ["a", "c"]
}

## "true_false" — student marks a statement as True or False
{
  "id": "q3", "type": "true_false", "grading": "auto", "points": 1,
  "prompt": "The article says that Maria works as a nurse.",
  "answer": "T"
}

## "fill_blank" — one blank in a sentence; student types the missing word or phrase
Use {blank} exactly once in the prompt to mark the blank position.
{
  "id": "q4", "type": "fill_blank", "grading": "auto", "points": 1,
  "prompt": "She {blank} to the gym every morning before work.",
  "answer": "goes",
  "accepted_answers": ["goes", "go"],
  "case_sensitive": false
}

## "fill_blank_multi" — multiple blanks in one sentence or passage excerpt
Use {blank} for each blank position, in order. Provide one entry in \`blanks\` per {blank}.
{
  "id": "q5", "type": "fill_blank_multi", "grading": "auto", "points": 2,
  "prompt": "Last night, they {blank} dinner and {blank} a movie.",
  "blanks": [
    {"id": "q5a", "answer": "cooked", "accepted_answers": ["cooked", "made"], "points": 1},
    {"id": "q5b", "answer": "watched", "accepted_answers": ["watched", "saw"], "points": 1}
  ],
  "case_sensitive": false
}

## "dropdown" — student selects one option from a dropdown embedded inside a sentence
Use {choice} exactly once in the prompt to mark where the dropdown appears.
Identical in structure to multiple_choice, but rendered inline within the sentence rather than as a separate list.
{
  "id": "q6", "type": "dropdown", "grading": "auto", "points": 1,
  "prompt": "By the time we arrived, the meeting {choice} already started.",
  "options": ["have", "has", "had", "having"],
  "answer": "had"
}

## "matching" — student matches each left item to one right item
Left items are numbered ("1", "2", …). Right items are lettered ("A", "B", …).
The \`answers\` object maps each left item ID to the correct right item key.
{
  "id": "q7", "type": "matching", "grading": "auto", "points": 6,
  "prompt": "Match each word with its correct definition.",
  "left_items": [
    {"id": "1", "text": "ambitious"},
    {"id": "2", "text": "generous"},
    {"id": "3", "text": "patient"}
  ],
  "right_items": [
    {"key": "A", "text": "willing to give time or money to help others"},
    {"key": "B", "text": "able to wait without becoming upset"},
    {"key": "C", "text": "having a strong desire to succeed"},
    {"key": "D", "text": "feeling nervous or worried about something"}
  ],
  "answers": {"1": "C", "2": "A", "3": "B"}
}

## "drag_reorder" — student drags word chips into the correct sentence order
Use when the question asks students to unscramble words to form a sentence.
\`words\` is the scrambled list shown to the student.
\`expected\` is the correct sentence (the answer key — exact string match, case-insensitive).
{
  "id": "q8", "type": "drag_reorder", "grading": "auto", "points": 2,
  "prompt": "Arrange the words to make a correct sentence.",
  "words": ["coffee", "every", "drinks", "morning", "she"],
  "expected": "She drinks coffee every morning."
}

IMPORTANT for drag_reorder:
- \`words\` should be the individual tokens the student will drag — typically one word per chip, but compound tokens (e.g. "every morning") are allowed if the question groups them.
- \`expected\` must be the complete correct sentence including punctuation.
- The platform does a case-insensitive, trimmed comparison of the student's assembled string against \`expected\`.
- If multiple word orders are equally correct, pick the most natural one as \`expected\` and note any alternates in a comment field (not graded).

## "drag_categorize" — student drags item chips into category columns
Use when the question asks students to sort words, phrases, or items into two or more groups.
\`items\` is the flat list of chips shown to the student.
\`categories\` defines the column headers.
\`answers\` maps each item (exact string) to its correct category ID.
{
  "id": "q9", "type": "drag_categorize", "grading": "auto", "points": 8,
  "prompt": "Sort the words into the correct category.",
  "items": ["went", "played", "ate", "walked", "drove", "talked", "brought", "cooked"],
  "categories": [
    {"id": "regular", "label": "Regular Past Tense"},
    {"id": "irregular", "label": "Irregular Past Tense"}
  ],
  "answers": {
    "went":    "irregular",
    "played":  "regular",
    "ate":     "irregular",
    "walked":  "regular",
    "drove":   "irregular",
    "talked":  "regular",
    "brought": "irregular",
    "cooked":  "regular"
  }
}

IMPORTANT for drag_categorize:
- Every item in \`items\` must appear as a key in \`answers\`.
- Category IDs in \`answers\` must exactly match IDs defined in \`categories\`.
- Items are strings — use the exact same string in both \`items\` and \`answers\`.

# RULES FOR DETERMINING POINTS

1. If the source document specifies points (e.g. "(8 points)"), use that exact value.
2. For matching and drag_categorize, the total \`points\` covers all items. The platform divides by the number of items for per-item scoring.
3. For multiple_select, set \`points\` to the total for that question. Partial credit is calculated automatically.
4. For fill_blank_multi, distribute the question's total points evenly across blanks unless otherwise specified.
5. If no points are specified, default to 1 point per question (or per blank in fill_blank_multi).

# RULES FOR DETERMINING ANSWERS

1. If the document has an answer key, use it exactly.
2. If there is no answer key, infer the answer from the question content where clearly possible (e.g. a definition matching question). If genuinely ambiguous, still provide your best answer — unlike the exam system, assessments are expected to be fully auto-graded.
3. For \`accepted_answers\` in fill_blank and fill_blank_multi, include natural variations: alternate forms of the same verb (go/goes/going), common contractions, minor spelling variants. Do not include semantically different answers.
4. Always set \`case_sensitive: false\`.
5. For drag_reorder \`expected\`, write the complete correct sentence with standard punctuation.

# RULES FOR SECTIONS AND PASSAGES

1. If the document has a reading passage followed by comprehension questions, put the passage in \`passage.content\` and all related questions in the same section's \`questions\` array.
2. If there are multiple passages, create one section per passage.
3. If there are question groups without a passage (e.g. "Section B: Grammar"), create a section with \`passage: null\`.
4. Section \`instructions\` should capture any directions that apply to all questions in that section (e.g. "Choose the best answer", "Complete the sentences").

# IDs

- Use \`q1\`, \`q2\`, \`q3\`, ... for question IDs in document order.
- Use \`section_1\`, \`section_2\`, ... for section IDs.
- For fill_blank_multi blanks, prefix with the question ID: \`q5a\`, \`q5b\`, etc.
- For matching left_items, use \`"1"\`, \`"2"\`, \`"3"\`, ... For right_items, use \`"A"\`, \`"B"\`, \`"C"\`, ...
- For drag_categorize category IDs, use short descriptive slugs: \`"regular"\`, \`"irregular"\`, \`"past"\`, \`"present"\`, etc.

# REMEMBER

- Output a single valid JSON object only. No markdown code fences. No text before or after.
- All question types in this system are auto-graded — do not use manual grading types from the exam system (sentence_order, short_answer, writing_prompt, pool_writing).
- Verify the JSON is syntactically valid before returning it.
- Do not write the output in the chat — put it in a downloadable file.`;

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
      db.from('assessments').select('*').eq('id', id).single(),
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

    examDef = currentExam.assessment_definition || null;
    document.getElementById('sharedToggle').checked = !!currentExam.shared;
    renderMetadata();
    renderProctoring();
    renderContent();
    updateSidebar();

    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('content').style.display = 'block';

    if (isNew) {
      showToast('Assessment created. Build from scratch or upload a JSON file.', 'success');
    }
  } catch (err) {
    console.error(err);
    showError('Could not load exam', err.message || 'Unknown error');
  }
}

function renderMetadata() {
  const e = currentExam;
  document.getElementById('metaTitle').textContent = e.title || '(untitled)';
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
      ${VALID_QUESTION_TYPES.map(t => `
        <button class="type-pill" data-type="${t}">
          <span class="type-name">${esc(TYPE_INFO[t].label)}</span>
          <span class="type-desc">${esc(TYPE_INFO[t].desc)}</span>
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
  const issues = validateAuthoredQuestion(q);
  const div = document.createElement('div');
  div.className = 'question-row';
  if (issues.errors.length) div.classList.add('has-error');
  else if (issues.warnings.length) div.classList.add('has-warning');

  const promptPreview = (q.prompt || '(no prompt)').slice(0, 200);
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
    if (validateAuthoredQuestion(q).errors.length) issuesCount++;
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
    showToast('Started a new assessment. Add your first section to begin.', 'success');
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
function renderTypeEditor(q, container) {
  switch (q.type) {
    case 'multiple_choice':  renderMultipleChoiceEditor(q, container); break;
    case 'multiple_select':  renderMultipleSelectEditor(q, container); break;
    case 'true_false':       renderTrueFalseEditor(q, container); break;
    case 'fill_blank':       renderFillBlankEditor(q, container); break;
    case 'fill_blank_multi': renderFillBlankMultiEditor(q, container); break;
    case 'dropdown':         renderDropdownEditor(q, container); break;
    case 'matching':         renderMatchingEditor(q, container); break;
    case 'drag_reorder':     renderDragReorderEditor(q, container); break;
    case 'drag_categorize':  renderDragCategorizeEditor(q, container); break;
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
    input.addEventListener('input', () => { q.options[parseInt(input.dataset.mcText)].text = input.value; refreshJsonViewer(q); });
  });
  container.querySelectorAll('[data-mc-answer]').forEach(radio => {
    radio.addEventListener('change', () => { if (radio.checked) { q.answer = radio.dataset.mcAnswer; refreshJsonViewer(q); } });
  });
  container.querySelectorAll('[data-mc-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.mcDelete);
      const removedKey = q.options[i].key;
      q.options.splice(i, 1);
      q.options.forEach((o, idx) => o.key = String.fromCharCode(97 + idx));
      if (q.answer === removedKey || !q.options.find(o => o.key === q.answer)) q.answer = '';
      rerenderTypeEditor();
    });
  });
  document.getElementById('addOptBtn').addEventListener('click', () => {
    q.options.push({ key: String.fromCharCode(97 + q.options.length), text: '' });
    rerenderTypeEditor();
  });
}

// ----- Multiple Select -----
function renderMultipleSelectEditor(q, container) {
  q.options = q.options || [];
  q.correct_answers = q.correct_answers || [];
  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-label">Options</div>
      <div class="editor-section-hint">Check all options that are correct. Students earn partial credit per correct selection.</div>
      <div id="msOptsList">
        ${q.options.map((opt, i) => `
          <div class="sub-row opt-row">
            <span class="sub-key">${esc(opt.key || '')}</span>
            <input type="text" data-ms-text="${i}" value="${esc(opt.text || '')}" placeholder="Option text">
            <label class="sub-radio">
              <input type="checkbox" data-ms-correct="${esc(opt.key)}" ${q.correct_answers.includes(opt.key) ? 'checked' : ''}>
              Correct
            </label>
            <button class="sub-delete-btn" data-ms-delete="${i}" title="Remove">⌫</button>
          </div>
        `).join('')}
      </div>
      <button class="add-row-btn" id="addMsOptBtn">+ Add Option</button>
      <div class="editor-section-hint editor-hint--mt">Points are distributed equally across correct options. Total points set above.</div>
    </div>
  `;
  container.querySelectorAll('[data-ms-text]').forEach(input => {
    input.addEventListener('input', () => { q.options[parseInt(input.dataset.msText)].text = input.value; refreshJsonViewer(q); });
  });
  container.querySelectorAll('[data-ms-correct]').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.msCorrect;
      if (cb.checked) { if (!q.correct_answers.includes(key)) q.correct_answers.push(key); }
      else { q.correct_answers = q.correct_answers.filter(k => k !== key); }
      refreshJsonViewer(q);
    });
  });
  container.querySelectorAll('[data-ms-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.msDelete);
      const removedKey = q.options[i].key;
      q.options.splice(i, 1);
      q.options.forEach((o, idx) => o.key = String.fromCharCode(97 + idx));
      q.correct_answers = q.correct_answers.filter(k => k !== removedKey);
      rerenderTypeEditor();
    });
  });
  document.getElementById('addMsOptBtn').addEventListener('click', () => {
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
      <div class="editor-section-label"><span>Blanks (in order)</span></div>
      <div class="editor-section-hint">Each <code class="inline-code">{blank}</code> in the prompt corresponds to one row below, in order.</div>
      <div class="blank-row-header"><span>ID</span><span>Answer</span><span>Accepted</span><span>Points</span><span></span></div>
      <div id="blanksList">
        ${q.blanks.map((b, i) => `
          <div class="sub-row blank-row">
            <span class="sub-key">${esc(b.id || '')}</span>
            <input type="text" data-fbm-answer="${i}" value="${esc(b.answer || '')}" placeholder="Answer">
            <input type="text" data-fbm-accepted="${i}" value="${esc((b.accepted_answers || []).join(', '))}" placeholder="Variants">
            <input type="number" data-fbm-points="${i}" value="${b.points ?? 0.5}" step="0.1" min="0">
            <button class="sub-delete-btn" data-fbm-delete="${i}">⌫</button>
          </div>
        `).join('')}
      </div>
      <button class="add-row-btn" id="addBlankBtn">+ Add Blank</button>
      <label class="sub-radio sub-radio--mt"><input type="checkbox" id="fbm-case" ${q.case_sensitive ? 'checked' : ''}> Case sensitive</label>
    </div>
  `;
  container.querySelectorAll('[data-fbm-answer]').forEach(input => input.addEventListener('input', () => { q.blanks[parseInt(input.dataset.fbmAnswer)].answer = input.value; refreshJsonViewer(q); }));
  container.querySelectorAll('[data-fbm-accepted]').forEach(input => input.addEventListener('input', () => { q.blanks[parseInt(input.dataset.fbmAccepted)].accepted_answers = input.value.split(',').map(s => s.trim()).filter(Boolean); refreshJsonViewer(q); }));
  container.querySelectorAll('[data-fbm-points]').forEach(input => input.addEventListener('input', () => { q.blanks[parseInt(input.dataset.fbmPoints)].points = parseFloat(input.value) || 0; refreshJsonViewer(q); }));
  container.querySelectorAll('[data-fbm-delete]').forEach(btn => btn.addEventListener('click', () => { q.blanks.splice(parseInt(btn.dataset.fbmDelete), 1); rerenderTypeEditor(); }));
  document.getElementById('addBlankBtn').addEventListener('click', () => {
    const next = q.blanks.length + 1;
    q.blanks.push({ id: `${q.id}${String.fromCharCode(96 + next)}`, answer: '', accepted_answers: [], points: 0.5 });
    rerenderTypeEditor();
  });
  document.getElementById('fbm-case').addEventListener('change', e => { q.case_sensitive = e.target.checked; refreshJsonViewer(q); });
}

// ----- Dropdown -----
function renderDropdownEditor(q, container) {
  q.options = q.options || ['', ''];
  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-label">Dropdown Options</div>
      <div class="editor-section-hint">Use <code class="inline-code">{choice}</code> in the prompt to mark where the dropdown appears. Click the circle to mark the correct answer.</div>
      ${q.options.map((opt, i) => `
        <div class="sub-row sub-row--2col">
          <input type="text" data-dd-text="${i}" value="${esc(opt || '')}" placeholder="Option ${i + 1}">
          <label class="sub-radio">
            <input type="radio" name="dd-answer" data-dd-answer="${esc(opt || '')}" ${q.answer === opt && opt ? 'checked' : ''}>
            Correct
          </label>
        </div>
      `).join('')}
      <button class="add-row-btn" id="addDdOptBtn">+ Add Option</button>
    </div>
  `;
  container.querySelectorAll('[data-dd-text]').forEach(input => {
    input.addEventListener('input', () => {
      const i = parseInt(input.dataset.ddText);
      if (q.options[i] === q.answer) q.answer = input.value;
      q.options[i] = input.value;
      refreshJsonViewer(q);
    });
  });
  container.querySelectorAll('[name="dd-answer"]').forEach(r => {
    r.addEventListener('change', () => { if (r.checked) { q.answer = r.dataset.ddAnswer; refreshJsonViewer(q); } });
  });
  document.getElementById('addDdOptBtn').addEventListener('click', () => { q.options.push(''); rerenderTypeEditor(); });
}

// ----- Matching -----
function renderMatchingEditor(q, container) {
  q.left_items = q.left_items || [];
  q.right_items = q.right_items || [];
  q.answers = q.answers || {};
  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-label">Left Items</div>
      <div id="leftItemsList">${q.left_items.map((it, i) => `
        <div class="sub-row left-item-row">
          <span class="sub-key">${esc(it.id || '')}</span>
          <input type="text" data-mt-left="${i}" value="${esc(it.text || '')}" placeholder="Item text">
          <button class="sub-delete-btn" data-mt-left-delete="${i}">⌫</button>
        </div>`).join('')}</div>
      <button class="add-row-btn" id="addLeftBtn">+ Add Left Item</button>
    </div>
    <div class="editor-section">
      <div class="editor-section-label">Right Items</div>
      <div id="rightItemsList">${q.right_items.map((it, i) => `
        <div class="sub-row right-item-row">
          <span class="sub-key">${esc(it.key || '')}</span>
          <input type="text" data-mt-right="${i}" value="${esc(it.text || '')}" placeholder="Item text">
          <button class="sub-delete-btn" data-mt-right-delete="${i}">⌫</button>
        </div>`).join('')}</div>
      <button class="add-row-btn" id="addRightBtn">+ Add Right Item</button>
    </div>
    <div class="editor-section">
      <div class="editor-section-label">Answer Key</div>
      <div class="answers-grid">${q.left_items.map(l => {
        const rightOpts = q.right_items.map(r => {
          const sel = q.answers[l.id] === r.key ? ' selected' : '';
          return `<option value="${esc(r.key)}"${sel}>${esc(r.key)}) ${esc(r.text || '(empty)')}</option>`;
        }).join('');
        return `<div><span class="answer-label">${esc(l.id)}) ${esc(l.text || '(empty)')}</span><select data-mt-answer="${esc(l.id)}"><option value="">— pick —</option>${rightOpts}</select></div>`;
      }).join('')}</div>
    </div>
  `;
  container.querySelectorAll('[data-mt-left]').forEach(input => input.addEventListener('input', () => { q.left_items[parseInt(input.dataset.mtLeft)].text = input.value; refreshJsonViewer(q); }));
  container.querySelectorAll('[data-mt-right]').forEach(input => input.addEventListener('input', () => { q.right_items[parseInt(input.dataset.mtRight)].text = input.value; refreshJsonViewer(q); }));
  container.querySelectorAll('[data-mt-left-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.mtLeftDelete);
      const removedId = q.left_items[i].id;
      q.left_items.splice(i, 1);
      delete q.answers[removedId];
      q.left_items.forEach((it, idx) => { const newId = String(idx + 1); if (q.answers[it.id] != null) { q.answers[newId] = q.answers[it.id]; delete q.answers[it.id]; } it.id = newId; });
      rerenderTypeEditor();
    });
  });
  container.querySelectorAll('[data-mt-right-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.mtRightDelete);
      const removedKey = q.right_items[i].key;
      q.right_items.splice(i, 1);
      q.right_items.forEach((it, idx) => { const newKey = String.fromCharCode(65 + idx); Object.keys(q.answers).forEach(k => { if (q.answers[k] === it.key) q.answers[k] = newKey; }); it.key = newKey; });
      Object.keys(q.answers).forEach(k => { if (!q.right_items.find(r => r.key === q.answers[k])) delete q.answers[k]; });
      rerenderTypeEditor();
    });
  });
  container.querySelectorAll('[data-mt-answer]').forEach(sel => {
    sel.addEventListener('change', () => { if (sel.value) q.answers[sel.dataset.mtAnswer] = sel.value; else delete q.answers[sel.dataset.mtAnswer]; refreshJsonViewer(q); });
  });
  document.getElementById('addLeftBtn').addEventListener('click', () => { q.left_items.push({ id: String(q.left_items.length + 1), text: '' }); rerenderTypeEditor(); });
  document.getElementById('addRightBtn').addEventListener('click', () => { q.right_items.push({ key: String.fromCharCode(65 + q.right_items.length), text: '' }); rerenderTypeEditor(); });
}

// ----- Drag to Reorder -----
function renderDragReorderEditor(q, container) {
  q.words = q.words || [];
  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-label">Drag to Reorder</div>
      <div class="editor-section-hint">Enter the words the student will drag into the correct order. The expected sentence is the answer key.</div>
      <div class="field"><label>Words (comma separated — these are shown scrambled to the student)</label><input type="text" id="dr-words" value="${esc(q.words.join(', '))}" placeholder="e.g. students, are, hard, working, these"></div>
      <div class="field"><label>Expected Order (correct sentence — the answer key)</label><input type="text" id="dr-expected" value="${esc(q.expected || '')}" placeholder="e.g. These students are working hard."></div>
    </div>
  `;
  document.getElementById('dr-words').addEventListener('input', e => { q.words = e.target.value.split(',').map(s => s.trim()).filter(Boolean); refreshJsonViewer(q); });
  document.getElementById('dr-expected').addEventListener('input', e => { q.expected = e.target.value; refreshJsonViewer(q); });
}

// ----- Drag to Categorize -----
function renderDragCategorizeEditor(q, container) {
  q.items = q.items || [];
  q.categories = q.categories || [];
  q.answers = q.answers || {};
  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-label">Categories</div>
      <div id="dcCatsList">${q.categories.map((c, i) => `
        <div class="sub-row categ-cat-row">
          <span class="sub-key">${esc(c.id)}</span>
          <input type="text" data-dc-cat-label="${i}" value="${esc(c.label || '')}" placeholder="Category name">
          <button class="sub-delete-btn" data-dc-cat-delete="${i}">⌫</button>
        </div>`).join('')}</div>
      <button class="add-row-btn" id="addDcCatBtn">+ Add Category</button>
    </div>
    <div class="editor-section">
      <div class="editor-section-label">Items (with correct category)</div>
      <div id="dcItemsList">${q.items.map((it, i) => `
        <div class="sub-row categ-item-row">
          <input type="text" data-dc-item-text="${i}" value="${esc(it || '')}" placeholder="Item text">
          <select data-dc-item-cat="${i}">
            <option value="">— pick category —</option>
            ${q.categories.map(c => `<option value="${esc(c.id)}" ${q.answers[it] === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
          </select>
          <button class="sub-delete-btn" data-dc-item-delete="${i}">⌫</button>
        </div>`).join('')}</div>
      <button class="add-row-btn" id="addDcItemBtn">+ Add Item</button>
    </div>
  `;
  container.querySelectorAll('[data-dc-cat-label]').forEach(input => input.addEventListener('input', () => { q.categories[parseInt(input.dataset.dcCatLabel)].label = input.value; refreshJsonViewer(q); }));
  container.querySelectorAll('[data-dc-cat-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const removedId = q.categories[parseInt(btn.dataset.dcCatDelete)].id;
      q.categories.splice(parseInt(btn.dataset.dcCatDelete), 1);
      Object.keys(q.answers).forEach(k => { if (q.answers[k] === removedId) delete q.answers[k]; });
      rerenderTypeEditor();
    });
  });
  container.querySelectorAll('[data-dc-item-text]').forEach(input => {
    input.addEventListener('input', () => {
      const i = parseInt(input.dataset.dcItemText);
      const old = q.items[i]; q.items[i] = input.value;
      if (old !== input.value && q.answers[old] != null) { q.answers[input.value] = q.answers[old]; delete q.answers[old]; }
      refreshJsonViewer(q);
    });
  });
  container.querySelectorAll('[data-dc-item-cat]').forEach(sel => {
    sel.addEventListener('change', () => {
      const it = q.items[parseInt(sel.dataset.dcItemCat)];
      if (sel.value) q.answers[it] = sel.value; else delete q.answers[it];
      refreshJsonViewer(q);
    });
  });
  container.querySelectorAll('[data-dc-item-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.dcItemDelete);
      const removed = q.items[i]; q.items.splice(i, 1); delete q.answers[removed];
      rerenderTypeEditor();
    });
  });
  document.getElementById('addDcCatBtn').addEventListener('click', () => {
    const n = q.categories.length + 1;
    q.categories.push({ id: `cat${n}`, label: `Category ${n}` });
    rerenderTypeEditor();
  });
  document.getElementById('addDcItemBtn').addEventListener('click', () => { q.items.push(''); rerenderTypeEditor(); });
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
      source: 'assessment',
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
  const updates = { assessment_definition: examDef, proctoring_settings: currentExam.proctoring_settings, shared: !!currentExam.shared };
  if (newStatus) updates.status = newStatus;
  const { data, error } = await db.from('assessments').update(updates).eq('id', currentExam.id).select().single();
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
  if (!confirm('Publish this assessment? Once published, it will be available to students within its scheduled window.')) return;
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

  document.getElementById('metaEditTitle').value = e.title || '';
  document.getElementById('metaEditAvailableFrom').value = formatDateForInput(e.available_from);
  document.getElementById('metaEditAvailableUntil').value = formatDateForInput(e.available_until);
  document.getElementById('metaEditStatus').value = e.status;
  document.getElementById('metaEditResultsVisibility').value = e.results_visibility || 'score_only';
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
    title: document.getElementById('metaEditTitle').value.trim() || null,
    class_id: document.getElementById('metaEditClassId').value,
    level_id: document.getElementById('metaEditLevelId').value,
    available_from: from.toISOString(),
    available_until: until.toISOString(),
    status: document.getElementById('metaEditStatus').value,
    results_visibility: document.getElementById('metaEditResultsVisibility').value,
    notes: document.getElementById('metaEditNotes').value.trim() || null
  };
  if (currentProfile.role === 'academic') updates.teacher_id = document.getElementById('metaEditTeacherId').value;

  try {
    const { data, error } = await db.from('assessments').update(updates).eq('id', currentExam.id).select().single();
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
    showToast('Start building the assessment first (from scratch or JSON) before importing.', 'error');
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

  if (!BULK_IMPORT_TYPES.includes(type)) {
    return { error: `Row ${rowNum}: unsupported type "${row.type || ''}" — bulk import only supports ${BULK_IMPORT_TYPES.join(', ')}` };
  }
  if (!prompt) return { error: `Row ${rowNum}: missing prompt` };

  const id = generateQuestionId(tempDef);
  const base = { id, type, prompt, points: isNaN(points) ? 1 : points, grading: 'auto' };

  if (type === 'multiple_choice') {
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
    const raw = String(row.answer || '').trim().toUpperCase();
    const answer = raw.startsWith('T') ? 'T' : raw.startsWith('F') ? 'F' : null;
    if (!answer) return { error: `Row ${rowNum}: true_false answer must be T or F` };
    return { question: { ...base, answer } };
  }

  // fill_blank
  const answer = String(row.answer || '').trim();
  if (!answer) return { error: `Row ${rowNum}: fill_blank needs an answer` };
  if (!prompt.includes('{blank}')) return { error: `Row ${rowNum}: fill_blank prompt should contain {blank}` };
  return { question: { ...base, answer, accepted_answers: [], case_sensitive: false } };
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

    // Build against a throwaway copy of examDef so ID generation sees only already-committed questions.
    const tempDef = JSON.parse(JSON.stringify(examDef));
    const errors = [];
    rows.forEach((row, i) => {
      const result = buildQuestionFromRow(row, i + 2, tempDef);
      if (result.error) { errors.push(result.error); return; }
      bulkParsedQuestions.push(result.question);
      // Reserve the ID against the temp copy so subsequent rows don't collide.
      tempDef.sections = tempDef.sections || [];
      if (!tempDef.sections.length) tempDef.sections.push({ id: 'tmp', questions: [] });
      tempDef.sections[0].questions.push(result.question);
    });

    let html = `<p style="font-size:0.85rem;color:var(--navy-l);margin-bottom:0.5rem;"><strong>${bulkParsedQuestions.length}</strong> question${bulkParsedQuestions.length === 1 ? '' : 's'} ready to import${errors.length ? `, <strong style="color:var(--red);">${errors.length}</strong> row${errors.length === 1 ? '' : 's'} skipped` : ''}.</p>`;
    if (errors.length) {
      html += `<ul class="validation-list">${errors.map(e => `<li class="fail">${esc(e)}</li>`).join('')}</ul>`;
    }
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
  if (!sections.length) {
    sel.innerHTML = '<option value="">— create a section first —</option>';
    return;
  }
  sel.innerHTML = sections.map((s, i) => `<option value="${i}">${esc(s.title || `Section ${i + 1}`)}</option>`).join('');
}

async function loadBankEntries() {
  const { data, error } = await db.from('question_bank').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  bankEntries = data || [];
  const types = [...new Set(bankEntries.map(b => b.question_type))].sort();
  document.getElementById('bankTypeFilter').innerHTML = '<option value="">All types</option>' +
    types.map(t => `<option value="${esc(t)}">${esc(TYPE_INFO[t]?.label || t)}</option>`).join('');
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
    showToast('Start building the assessment first (from scratch or JSON) before using the question bank.', 'error');
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
  renderNavbar(document.getElementById('navbarContainer'), { profile: currentProfile, active: 'assessments' });
  await loadExam();
  setupJsonUpload();
})();
