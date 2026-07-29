import { db } from '../supabase-client.js';
import { showToast, esc } from '../ui.js';
import { createProctor } from '../proctoring.js';

const DEFAULT_PROCTORING = { fullscreen_lock: true, tab_switch_tracking: true, window_blur_tracking: true };

// ===== STATE =====
const state = {
  examRecord: null,
  examDef: null,
  examCode: null,
  submissionId: null,
  sessionId: null,
  student: '',
  teacherName: '',
  classLabel: '',
  startTime: null,
  examActive: false,
  previewMode: false,
  proctor: null,
};

// ===== DOM REFERENCES =====
const startScreen = document.getElementById('startScreen');
const examScreen = document.getElementById('examScreen');
const examBody = document.getElementById('examBody');
const lockout = document.getElementById('lockout');
const timerEl = document.getElementById('timer');
const studentLabel = document.getElementById('studentLabel');

const loadingPanel = document.getElementById('loadingPanel');
const blockedPanel = document.getElementById('blockedPanel');
const startForm = document.getElementById('startForm');
const acknowledgeBox = document.getElementById('acknowledgeBox');
const startBtn = document.getElementById('startBtn');
const studentNameEl = document.getElementById('studentName');

// ===== HELPERS =====
function generateSessionId() {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function lsKey(suffix) { return `exam_${state.examCode}_${suffix}`; }
function submittedFlagKey(code, name) {
  return `submitted_${code}_${name.toUpperCase().trim()}`;
}

function formatDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) +
    ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// Word counter
function countWords(text) {
  if (!text || !text.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

function setSaveStatus(cls, text) {
  const el = document.getElementById('saveIndicator');
  el.className = 'assess-monitor-value ' + cls;
  el.textContent = text;
}

function showBlocked(title, message) {
  loadingPanel.style.display = 'none';
  startForm.style.display = 'none';
  blockedPanel.style.display = 'block';
  document.getElementById('blockedTitle').textContent = title;
  document.getElementById('blockedMessage').textContent = message;
}

// ===== SCROLL TO TOP ON LOAD =====
window.scrollTo(0, 0);
if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

// ===== INIT =====
async function init() {
  const params = new URLSearchParams(window.location.search);

  // Preview mode: teachers loading the exam from edit.html.
  // No proctoring, no auto-save, no submission record, no fullscreen.
  if (params.get('preview') === 'true') {
    state.previewMode = true;
    return initPreview(params.get('id'));
  }

  state.examCode = params.get('code');

  if (!state.examCode) {
    showBlocked('No code provided', 'This exam page must be opened through the exam entry portal.');
    return;
  }

  try {
    const { data, error } = await db.from('exams')
      .select('*').eq('code', state.examCode).maybeSingle();

    if (error) throw error;
    if (!data) {
      showBlocked('Code not recognized', 'The exam code is not valid. Please return to the entry page.');
      return;
    }

    const now = new Date();
    const from = new Date(data.available_from);
    const until = new Date(data.available_until);

    if (data.status === 'archived') {
      showBlocked('This exam is no longer available', 'It has been archived. Please contact your teacher.');
      return;
    }
    if (data.status === 'draft') {
      showBlocked('This exam is not yet published', 'Please check back later or contact your teacher.');
      return;
    }
    if (now < from) {
      showBlocked('This exam is not available yet', `The exam opens on ${formatDateTime(data.available_from)}.`);
      return;
    }
    if (now > until) {
      showBlocked('This exam window has ended', `The exam closed on ${formatDateTime(data.available_until)}. Please contact your teacher.`);
      return;
    }

    if (!data.exam_definition || !data.exam_definition.sections) {
      showBlocked('Exam content unavailable', 'This exam has no questions yet. Please contact your teacher.');
      return;
    }

    const [teacherRes, classRes] = await Promise.all([
      db.from('profiles').select('full_name, email').eq('id', data.teacher_id).maybeSingle(),
      db.from('classes').select('name').eq('id', data.class_id).maybeSingle(),
    ]);
    state.teacherName = teacherRes.data?.full_name || teacherRes.data?.email || '—';
    state.classLabel = classRes.data?.name || '—';

    state.examRecord = data;
    state.examDef = data.exam_definition;
    setupProctor(data.proctoring_settings || { ...DEFAULT_PROCTORING });
    populateStartScreen();

  } catch (err) {
    console.error('Failed to verify exam:', err);
    showBlocked('Connection error', `Could not verify the exam. Please check your connection and refresh. (${err.message || 'unknown'})`);
  }
}

// ===== PREVIEW MODE INIT =====
async function initPreview(examId) {
  if (!examId) {
    showBlocked('No exam ID provided', 'Preview must be opened from the exam edit page.');
    return;
  }

  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) {
      showBlocked('Not signed in', 'You must be signed in to preview an exam.');
      return;
    }
  } catch (err) {
    console.warn('Auth check failed:', err);
  }

  try {
    const { data, error } = await db.from('exams').select('*').eq('id', examId).maybeSingle();
    if (error) throw error;
    if (!data) {
      showBlocked('Exam not found', 'The exam could not be loaded for preview.');
      return;
    }
    if (!data.exam_definition || !data.exam_definition.sections) {
      showBlocked('No content to preview', 'This exam has no questions yet. Upload a JSON file first.');
      return;
    }

    const [teacherRes, classRes] = await Promise.all([
      db.from('profiles').select('full_name, email').eq('id', data.teacher_id).maybeSingle(),
      db.from('classes').select('name').eq('id', data.class_id).maybeSingle(),
    ]);
    state.teacherName = teacherRes.data?.full_name || teacherRes.data?.email || '—';
    state.classLabel = classRes.data?.name || '—';

    state.examRecord = data;
    state.examDef = data.exam_definition;
    state.examCode = data.code;
    state.startTime = Date.now();
    // Preview mode never proctors — state.proctor stays null.

    const def = state.examDef;
    const title = def.exam_metadata?.title || `${data.type}`;
    document.getElementById('headerExamTitle').textContent = title;
    studentLabel.innerHTML = '<span class="preview-badge">PREVIEW MODE</span> · ' + esc(state.classLabel);

    // Hide the proctoring monitors that don't apply in preview.
    document.getElementById('monitorTabSwitches').style.display = 'none';
    document.getElementById('monitorFullscreen').style.display = 'none';

    renderExam();

    // Replace the Submit button with a Close Preview button.
    const submitBtn = document.getElementById('submitBtn');
    if (submitBtn) {
      submitBtn.textContent = 'Close Preview';
      submitBtn.addEventListener('click', () => {
        window.close();
        setTimeout(() => {
          // If window.close() didn't work (tab opened by user, not JS), show a message instead.
          submitBtn.textContent = 'You can close this tab';
          submitBtn.disabled = true;
        }, 200);
      });
    }

    startScreen.style.display = 'none';
    examScreen.style.display = 'block';
    state.examActive = true;
    startTimer();
    setupSectionTracking();
    window.scrollTo(0, 0);

  } catch (err) {
    console.error('Failed to load preview:', err);
    showBlocked('Preview error', `Could not load the exam for preview. (${err.message || 'unknown'})`);
  }
}

// ===== PROCTORING SETUP (rules list, monitor bar, lockout) =====
function setupProctor(settings) {
  state.proctor = createProctor({ settings, onStateChange: onProctorStateChange });
  const p = state.proctor;
  const anyEnabled = p.settings.fullscreen_lock || p.settings.tab_switch_tracking || p.settings.window_blur_tracking;

  document.getElementById('monitorTabSwitches').style.display = p.settings.tab_switch_tracking ? 'flex' : 'none';
  document.getElementById('monitorFullscreen').style.display = p.fullscreenRequired ? 'flex' : 'none';

  const rules = [];
  if (p.fullscreenRequired) {
    rules.push('The exam will open in fullscreen mode.');
    rules.push('Leaving fullscreen will pause the exam and lock the questions.');
  }
  if (p.settings.tab_switch_tracking || p.settings.window_blur_tracking) {
    rules.push('Switching tabs or windows is recorded and reported.');
  }
  rules.push('Your progress is auto-saved. You may resume if disconnected.');
  rules.push('Once submitted, you cannot retake this exam.');

  document.getElementById('rulesList').innerHTML = rules.map(r => `<li>${esc(r)}</li>`).join('');

  if (anyEnabled) {
    document.getElementById('proctorRules').style.display = 'block';
    document.getElementById('acknowledgeRow').style.display = 'flex';
  } else {
    document.getElementById('proctorRules').style.display = 'none';
    document.getElementById('acknowledgeRow').style.display = 'none';
  }

  if (p.settings.fullscreen_lock && p.isAppleMobile) {
    document.getElementById('appleMobileNotice').style.display = 'block';
  }
}

function onProctorStateChange(s) {
  const switchCountEl = document.getElementById('switchCount');
  if (switchCountEl) {
    switchCountEl.textContent = s.tabSwitches;
    switchCountEl.classList.toggle('alert', s.tabSwitches >= 3);
    switchCountEl.classList.toggle('warning', s.tabSwitches >= 1 && s.tabSwitches < 3);
    // Toast only on the "came back" transition, matching the original
    // exam's behavior (not on the "left" transition too).
    if (s.tabSwitches > 0 && !document.hidden) {
      showToast(`Tab switch detected (${s.tabSwitches} total)`);
    }
  }
  const statusEl = document.getElementById('statusValue');
  if (statusEl) {
    statusEl.textContent = s.paused ? 'PAUSED' : 'Active';
    statusEl.classList.toggle('alert', s.paused);
  }
  if (lockout) lockout.classList.toggle('active', !!s.paused);
  saveToLocalStorage();
  saveToSupabase(true);
}

// ===== START SCREEN =====
function populateStartScreen() {
  const e = state.examRecord;
  const def = state.examDef;
  const title = def.exam_metadata?.title || `${e.type}`;

  document.getElementById('examStamp').textContent =
    `${state.classLabel} · ${e.type} · ${e.quarter} ${e.year}`;
  document.getElementById('examTitle').innerHTML =
    e.type === 'MIDTERM' ? 'The <em>Midterm</em>' : 'The <em>Final Exam</em>';

  const totalQ = def.sections.reduce((sum, s) => sum + (s.questions?.length || 0), 0);
  document.getElementById('examSubtitle').textContent =
    `${totalQ} questions · Online proctored exam`;

  document.getElementById('infoClass').textContent = state.classLabel;
  document.getElementById('infoTeacher').textContent = state.teacherName;
  document.getElementById('infoCode').textContent = e.code;

  document.getElementById('headerExamTitle').textContent = title;

  loadingPanel.style.display = 'none';
  startForm.style.display = 'block';
  studentNameEl.focus();
}

function updateStartButton() {
  const nameReady = studentNameEl.value.trim().length >= 2;
  const rulesShown = document.getElementById('proctorRules').style.display !== 'none';
  const ackReady = !rulesShown || acknowledgeBox.checked;
  startBtn.disabled = !(nameReady && ackReady);
}
studentNameEl.addEventListener('input', updateStartButton);
acknowledgeBox.addEventListener('change', updateStartButton);

// ===== START EXAM =====
startBtn.addEventListener('click', async () => {
  const name = studentNameEl.value.trim().toUpperCase();
  if (!name || !state.examRecord) return;

  const flag = localStorage.getItem(submittedFlagKey(state.examCode, name));
  if (flag) {
    const submittedAt = new Date(flag).toLocaleString();
    showBlocked('Already submitted', `You already submitted this exam on ${submittedAt}. If this is a mistake, please contact your teacher.`);
    return;
  }

  state.student = name;

  // Try to resume an existing in-progress session.
  const savedSessionId = localStorage.getItem(lsKey('session'));
  const savedName = localStorage.getItem(lsKey('name'));
  let resumeData = null;

  if (savedSessionId && savedName === name) {
    try {
      const { data: rows } = await db.rpc('resume_exam_submission', { p_session_id: savedSessionId });
      const data = rows?.[0] || null;
      if (data) {
        if (confirm('We found an unfinished exam from this session. Resume where you left off?')) {
          resumeData = data;
          state.submissionId = data.id;
          state.sessionId = data.session_id;
          state.startTime = new Date(data.started_at).getTime();
          state.proctor.restoreCounts(data.proctoring);
        }
      }
    } catch (err) {
      console.warn('Could not check resume session:', err);
    }
  }

  if (state.proctor.fullscreenRequired) {
    const ok = await state.proctor.requestFullscreen();
    if (!ok) {
      alert('Fullscreen is required to begin the exam. Please allow fullscreen and try again.');
      return;
    }
  }

  if (!resumeData) {
    state.sessionId = generateSessionId();
    state.startTime = Date.now();
    const submissionId = crypto.randomUUID();
    try {
      // Generate the id client-side and skip .select() after insert: RETURNING
      // is filtered through the table's SELECT policy, which (by design) only
      // allows the owning teacher/academic to read submissions back — an anon
      // student's insert would otherwise fail RLS on the RETURNING step.
      const { error } = await db.from('submissions').insert({
        id: submissionId,
        exam_id: state.examRecord.id,
        exam_code: state.examCode,
        student_name: name,
        session_id: state.sessionId,
        status: 'in_progress',
        started_at: new Date().toISOString(),
        answers: {},
        proctoring: {
          tab_switches: 0, window_blur_events: 0, fullscreen_exits: 0,
          right_clicks_blocked: 0, devtools_attempts: 0, event_log: [],
        },
        user_agent: navigator.userAgent,
      });
      if (error) throw error;
      state.submissionId = submissionId;
    } catch (err) {
      console.error('Failed to create submission:', err);
      alert(`Could not start the exam: ${err.message}\n\nPlease try again.`);
      state.proctor.exitFullscreen();
      return;
    }
    localStorage.setItem(lsKey('session'), state.sessionId);
    localStorage.setItem(lsKey('name'), name);
  }

  studentLabel.textContent = `${name} · ${state.teacherName}`;
  renderExam();
  if (resumeData) restoreAnswersToForm(resumeData.answers || {});

  startScreen.style.display = 'none';
  examScreen.style.display = 'block';
  state.examActive = true;
  state.proctor.logEvent(resumeData ? 'exam_resumed' : 'exam_started', `student: ${name}`);
  state.proctor.start();
  startTimer();
  setupSectionTracking();
  window.scrollTo(0, 0);
});

document.getElementById('resumeBtn').addEventListener('click', () => {
  state.proctor?.resumeFullscreen();
});

// ===== TIMER =====
function startTimer() {
  setInterval(() => {
    if (!state.examActive) return;
    const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    timerEl.textContent = `${m}:${s}`;
  }, 1000);
}

// ===== RENDER EXAM =====
function renderExam() {
  examBody.innerHTML = '';

  // Title block
  if (state.examDef.exam_metadata?.title) {
    const titleBlock = document.createElement('div');
    titleBlock.className = 'exam-title-block';
    titleBlock.innerHTML = `
      <h2>${esc(state.examDef.exam_metadata.title)}</h2>
      ${state.examDef.exam_metadata.instructions
        ? `<div class="exam-instructions">${esc(state.examDef.exam_metadata.instructions)}</div>`
        : ''}
    `;
    examBody.appendChild(titleBlock);
  }

  // Sections + questions.
  // Maintain a running counter so students see sequential numbers (1, 2, 3, ...)
  // even if the JSON has gaps from edits (e.g., q1, q5, q14). The actual q.id
  // stays as the internal reference for DOM ids and the answers payload.
  let displayCounter = 0;
  state.examDef.sections.forEach((section, sIdx) => {
    const partEl = document.createElement('section');
    partEl.className = 'part';
    partEl.id = `section-${sIdx}`;
    partEl.dataset.sectionIdx = sIdx;
    partEl.dataset.sectionTitle = section.title || `Section ${sIdx + 1}`;

    let html = `
      <div class="part-header">
        <div class="part-label">Section ${sIdx + 1} of ${state.examDef.sections.length}</div>
        <div class="part-title">${esc(section.title || 'Untitled section')}</div>
        ${section.instructions ? `<div class="part-instructions">${esc(section.instructions)}</div>` : ''}
      </div>
    `;

    if (section.passage?.content) {
      html += `
        <div class="passage-box">
          <span class="passage-label">Reading</span>
          ${esc(section.passage.content)}
        </div>
      `;
    }

    partEl.innerHTML = html;

    (section.questions || []).forEach(q => {
      displayCounter++;
      const qEl = renderQuestion(q, displayCounter);
      if (qEl) partEl.appendChild(qEl);
    });

    examBody.appendChild(partEl);
  });

  // Submit button
  const submitBtn = document.createElement('button');
  submitBtn.className = 'submit-btn';
  submitBtn.id = 'submitBtn';
  submitBtn.textContent = 'Submit Exam';
  examBody.appendChild(submitBtn);

  submitBtn.addEventListener('click', openSubmitModal);

  // Section progress totals
  document.getElementById('totalSections').textContent = state.examDef.sections.length;
}

// ===== SECTION TRACKING (header progress) =====
function setupSectionTracking() {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const idx = parseInt(entry.target.dataset.sectionIdx, 10);
        const title = entry.target.dataset.sectionTitle;
        document.getElementById('curSection').textContent = idx + 1;
        document.getElementById('curSectionTitle').textContent = title;
      }
    });
  }, { rootMargin: '-100px 0px -50% 0px', threshold: 0 });

  document.querySelectorAll('.part').forEach(p => observer.observe(p));
}

// ===== QUESTION RENDERERS =====
function renderQuestion(q, displayNumber) {
  const qEl = document.createElement('div');
  qEl.className = 'question';
  qEl.id = `q-${q.id}`;
  qEl.dataset.qid = q.id;
  qEl.dataset.qtype = q.type;
  qEl.dataset.displayNumber = displayNumber;

  const pointsText = q.points ? `${q.points} pt${q.points === 1 ? '' : 's'}` : '';
  const pointsHtml = pointsText ? `<span class="q-points">${esc(pointsText)}</span>` : '';
  const numHtml = `<span class="q-number">${esc(String(displayNumber))}</span>${pointsHtml}`;

  switch (q.type) {
    case 'multiple_choice': renderMultipleChoice(qEl, q, numHtml); break;
    case 'true_false':      renderTrueFalse(qEl, q, numHtml); break;
    case 'inline_choice':   renderInlineChoice(qEl, q, numHtml); break;
    case 'fill_blank':      renderFillBlank(qEl, q, numHtml); break;
    case 'fill_blank_multi':renderFillBlankMulti(qEl, q, numHtml); break;
    case 'matching':        renderMatching(qEl, q, numHtml); break;
    case 'categorization':  renderCategorization(qEl, q, numHtml); break;
    case 'sentence_order':  renderSentenceOrder(qEl, q, numHtml); break;
    case 'short_answer':    renderWritingPrompt(qEl, q, numHtml); break;
    case 'writing_prompt':  renderWritingPrompt(qEl, q, numHtml); break;
    case 'pool_writing':    renderPoolWriting(qEl, q, numHtml); break;
    case 'image_label':     renderImageLabel(qEl, q, numHtml); break;
    case 'image_match':     renderImageMatch(qEl, q, numHtml); break;
    default:
      qEl.innerHTML = `<div class="q-prompt">${numHtml}<em class="q-unknown-type">Unknown question type: ${esc(q.type)}</em></div>`;
  }

  return qEl;
}

function renderMultipleChoice(qEl, q, numHtml) {
  qEl.innerHTML = `
    <div class="q-prompt">${numHtml}${esc(q.prompt)}</div>
    <div class="options">
      ${(q.options || []).map(opt => `
        <label class="option">
          <input type="radio" name="${esc(q.id)}" value="${esc(opt.key)}">
          <span class="option-letter">${esc(String(opt.key).toUpperCase())}</span>
          <span>${esc(opt.text)}</span>
        </label>`).join('')}
    </div>
  `;
}

function renderTrueFalse(qEl, q, numHtml) {
  qEl.innerHTML = `
    <div class="q-prompt">${numHtml}<span class="visually-hidden">·</span></div>
    <div class="tf-row">
      <div class="tf-statement">${esc(q.prompt)}</div>
      <div class="tf-buttons">
        <label><input type="radio" name="${esc(q.id)}" value="T">T</label>
        <label><input type="radio" name="${esc(q.id)}" value="F">F</label>
      </div>
    </div>
  `;
  // Cleaner layout: hide the empty prompt line, re-attach the question
  // number to the tf-row instead.
  qEl.querySelector('.q-prompt').style.display = 'none';
  const tfRow = qEl.querySelector('.tf-row');
  const numWrap = document.createElement('span');
  numWrap.innerHTML = numHtml;
  numWrap.style.flexShrink = '0';
  tfRow.insertBefore(numWrap, tfRow.firstChild);
}

function renderInlineChoice(qEl, q, numHtml) {
  const opts = q.options || [];
  const choicesHtml = `
    <span class="inline-choices">
      ${opts.map(o => `
        <label><input type="radio" name="${esc(q.id)}" value="${esc(o)}"><span>${esc(o)}</span></label>
      `).join('')}
    </span>
  `;
  const promptHtml = esc(q.prompt).replace('{choice}', choicesHtml);
  qEl.innerHTML = `<div class="q-prompt">${numHtml}${promptHtml}</div>`;
}

function renderFillBlank(qEl, q, numHtml) {
  const inputHtml = `<input type="text" class="blank-input" name="${esc(q.id)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">`;
  const promptHtml = esc(q.prompt).replace('{blank}', inputHtml);
  qEl.innerHTML = `<div class="q-prompt">${numHtml}${promptHtml}</div>`;
}

function renderFillBlankMulti(qEl, q, numHtml) {
  let html = esc(q.prompt);
  (q.blanks || []).forEach(blank => {
    const input = `<input type="text" class="blank-input" name="${esc(blank.id)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">`;
    html = html.replace('{blank}', input);
  });
  qEl.innerHTML = `<div class="q-prompt">${numHtml}${html}</div>`;
}

function renderMatching(qEl, q, numHtml) {
  const left = q.left_items || [];
  const right = q.right_items || [];
  let gridHtml = '';
  left.forEach(l => {
    const opts = right.map(r =>
      `<option value="${esc(r.key)}">${esc(r.key)}) ${esc(r.text)}</option>`
    ).join('');
    gridHtml += `
      <div class="match-left">${esc(l.id)}) ${esc(l.text)}</div>
      <div class="match-arrow">→</div>
      <select name="${esc(q.id)}__${esc(l.id)}">
        <option value="">— select —</option>
        ${opts}
      </select>
    `;
  });
  qEl.innerHTML = `
    <div class="q-prompt">${numHtml}${esc(q.prompt)}</div>
    <div class="match-grid">${gridHtml}</div>
  `;
}

function renderCategorization(qEl, q, numHtml) {
  const items = q.items || [];
  const categories = q.categories || [];
  const optsHtml = categories.map(c =>
    `<option value="${esc(c.id)}">${esc(c.label)}</option>`
  ).join('');
  let gridHtml = '';
  items.forEach(it => {
    gridHtml += `
      <div class="categ-item">${esc(it)}</div>
      <select name="${esc(q.id)}__${esc(it)}">
        <option value="">— choose category —</option>
        ${optsHtml}
      </select>
    `;
  });
  qEl.innerHTML = `
    <div class="q-prompt">${numHtml}${esc(q.prompt)}</div>
    <div class="categ-pool">
      <div class="categ-pool-label">Words</div>
      ${items.map(i => `<span class="pool-word pool-word--spaced">${esc(i)}</span>`).join('')}
    </div>
    <div class="categ-grid">${gridHtml}</div>
  `;
}

function renderSentenceOrder(qEl, q, numHtml) {
  qEl.innerHTML = `
    <div class="q-prompt">${numHtml}${esc(q.prompt || '')}</div>
    <div class="order-words">${(q.words || []).map(esc).join(' / ')}</div>
    <input type="text" class="order-input" name="${esc(q.id)}" placeholder="Write the sentence in correct order…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
  `;
}

function renderWritingPrompt(qEl, q, numHtml) {
  qEl.innerHTML = `
    <div class="q-prompt">${numHtml}${esc(q.prompt)}</div>
    <div class="writing-wrap">
      <textarea class="writing-input" name="${esc(q.id)}" placeholder="Write your answer here…" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
      <div class="word-count"><strong>0</strong> words</div>
    </div>
  `;
  setupWordCount(qEl.querySelector('textarea'), qEl.querySelector('.word-count strong'));
}

function renderPoolWriting(qEl, q, numHtml) {
  const required = q.required_count || (q.word_pool || []).length;
  const poolHtml = (q.word_pool || [])
    .map(w => `<span class="pool-word">${esc(w)}</span>`).join('');

  let sentencesHtml = '';
  for (let i = 1; i <= required; i++) {
    sentencesHtml += `
      <div class="pool-sentence-row">
        <div class="pool-sentence-num">${String(i).padStart(2, '0')}</div>
        <div class="pool-sentence-input writing-wrap">
          <textarea class="writing-input" rows="2" name="${esc(q.id)}__${i}" placeholder="Sentence ${i}…" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
          <div class="word-count"><strong>0</strong> words</div>
        </div>
      </div>
    `;
  }

  qEl.innerHTML = `
    <div class="q-prompt">${numHtml}${esc(q.prompt)}</div>
    <div class="pool-bank">
      <span class="pool-bank-label">Word bank</span>
      ${poolHtml}
    </div>
    <div class="pool-sentences">${sentencesHtml}</div>
  `;
  qEl.querySelectorAll('.pool-sentence-row').forEach(row => {
    const ta = row.querySelector('textarea');
    const count = row.querySelector('.word-count strong');
    setupWordCount(ta, count);
  });
}

function renderImageLabel(qEl, q, numHtml) {
  const imgHtml = q.image?.url
    ? `<img src="${esc(q.image.url)}" alt="${esc(q.image.alt || '')}">`
    : `<div class="image-missing">[Image not uploaded]</div>`;

  const labelsHtml = (q.labels || []).map(label => `
    <div class="image-label-item">
      <div class="image-label-name">${esc(label.label)}</div>
      <input type="text" class="image-label-input" name="${esc(q.id)}__${esc(label.id)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
    </div>
  `).join('');

  qEl.innerHTML = `
    <div class="q-prompt">${numHtml}${esc(q.prompt)}</div>
    <div class="question-image-wrap">${imgHtml}</div>
    <div class="image-labels">${labelsHtml}</div>
  `;
}

function renderImageMatch(qEl, q, numHtml) {
  const imgHtml = q.image?.url
    ? `<img src="${esc(q.image.url)}" alt="${esc(q.image.alt || '')}">`
    : `<div class="image-missing">[Image not uploaded]</div>`;

  const regionOpts = (q.image_regions || []).map(r =>
    `<option value="${esc(r)}">${esc(r)}</option>`
  ).join('');

  let gridHtml = '';
  (q.items || []).forEach(item => {
    gridHtml += `
      <div class="match-left">${esc(item)}</div>
      <div class="match-arrow">→</div>
      <select name="${esc(q.id)}__${esc(item)}">
        <option value="">— select —</option>
        ${regionOpts}
      </select>
    `;
  });

  qEl.innerHTML = `
    <div class="q-prompt">${numHtml}${esc(q.prompt)}</div>
    <div class="question-image-wrap">${imgHtml}</div>
    <div class="match-grid">${gridHtml}</div>
  `;
}

function setupWordCount(textarea, counterEl) {
  textarea.addEventListener('input', () => {
    counterEl.textContent = countWords(textarea.value);
  });
}

// ===== ANSWER COLLECTION =====
// Generic, name-based collection — this page does not need per-question-type
// dispatch the way the Assessment system's question-engine.js does, because
// every renderer above is a plain native-HTML-form control with a `name`.
function collectAnswers() {
  const answers = {};
  examBody.querySelectorAll('input, select, textarea').forEach(el => {
    if (!el.name) return;
    if (el.type === 'radio') {
      if (el.checked) answers[el.name] = el.value;
    } else if (el.value !== '') {
      answers[el.name] = el.value;
    }
  });
  return answers;
}

function restoreAnswersToForm(answers) {
  Object.entries(answers).forEach(([name, value]) => {
    if (value == null || value === '') return;
    const radio = examBody.querySelector(`input[type="radio"][name="${CSS.escape(name)}"][value="${CSS.escape(value)}"]`);
    if (radio) { radio.checked = true; return; }
    const el = examBody.querySelector(`[name="${CSS.escape(name)}"]`);
    if (el) {
      el.value = value;
      // Trigger word count refresh for textareas
      if (el.tagName === 'TEXTAREA') {
        el.dispatchEvent(new Event('input'));
      }
    }
  });
}

// ===== AUTO-SAVE =====
function saveToLocalStorage() {
  if (!state.examActive || state.previewMode) return;
  try {
    localStorage.setItem(lsKey('answers'), JSON.stringify(collectAnswers()));
    localStorage.setItem(lsKey('proctoring'), JSON.stringify(state.proctor.buildPayload()));
  } catch (err) {
    console.warn('localStorage save failed:', err);
  }
}

let saveTimeout = null;
let isSaving = false;
async function saveToSupabase(immediate = false) {
  if (!state.examActive || !state.submissionId || state.previewMode) return;
  if (saveTimeout) clearTimeout(saveTimeout);
  if (!immediate) {
    saveTimeout = setTimeout(() => saveToSupabase(true), 10000);
    return;
  }
  if (isSaving) return;
  isSaving = true;
  setSaveStatus('saving', 'Saving…');
  try {
    const { error } = await db.from('submissions').update({
      answers: collectAnswers(),
      proctoring: state.proctor.buildPayload(),
    }).eq('id', state.submissionId);
    if (error) throw error;
    setSaveStatus('saved', 'Saved');
  } catch (err) {
    console.error('Auto-save failed:', err);
    setSaveStatus('offline', 'Offline');
  } finally {
    isSaving = false;
  }
}

document.addEventListener('input', (e) => {
  if (!state.examActive || state.previewMode) return;
  if (!e.target.matches('input, select, textarea')) return;
  if (!e.target.closest('#examBody')) return;
  saveToLocalStorage();
  setSaveStatus('saving', 'Saving…');
  saveToSupabase(false);
});

document.addEventListener('change', (e) => {
  if (!state.examActive || state.previewMode) return;
  if (!e.target.matches('input, select, textarea')) return;
  if (!e.target.closest('#examBody')) return;
  saveToLocalStorage();
  saveToSupabase(false);
});

window.addEventListener('beforeunload', e => {
  if (state.examActive && !state.previewMode) {
    saveToLocalStorage();
    e.preventDefault();
    e.returnValue = '';
  }
});

// ===== SUBMIT FLOW =====
function findUnansweredQuestions() {
  const blanks = [];
  const answers = collectAnswers();
  state.examDef.sections.forEach(section => {
    (section.questions || []).forEach(q => {
      if (isQuestionBlank(q, answers)) {
        blanks.push(q.id);
      }
    });
  });
  return blanks;
}

function isQuestionBlank(q, answers) {
  // Compound types — check that ALL sub-fields are answered.
  switch (q.type) {
    case 'fill_blank_multi': {
      const blanks = q.blanks || [];
      return blanks.some(b => !answers[b.id] || answers[b.id].trim() === '');
    }
    case 'matching':
    case 'image_match': {
      const items = q.type === 'matching' ? (q.left_items || []).map(l => l.id) : (q.items || []);
      return items.some(itemId => !answers[`${q.id}__${itemId}`]);
    }
    case 'categorization': {
      return (q.items || []).some(it => !answers[`${q.id}__${it}`]);
    }
    case 'image_label': {
      return (q.labels || []).some(l => !answers[`${q.id}__${l.id}`] || answers[`${q.id}__${l.id}`].trim() === '');
    }
    case 'pool_writing': {
      const required = q.required_count || 0;
      let filled = 0;
      for (let i = 1; i <= required; i++) {
        const v = answers[`${q.id}__${i}`];
        if (v && v.trim() !== '') filled++;
      }
      return filled === 0;
    }
    default: {
      const v = answers[q.id];
      return v == null || (typeof v === 'string' && v.trim() === '');
    }
  }
}

function openSubmitModal() {
  const blanks = findUnansweredQuestions();
  const totalQ = state.examDef.sections.reduce((sum, s) => sum + (s.questions?.length || 0), 0);
  const answered = totalQ - blanks.length;

  document.getElementById('submitSummary').innerHTML =
    `You have answered <strong>${answered} of ${totalQ}</strong> questions.`;

  const blanksList = document.getElementById('blanksList');
  if (blanks.length > 0) {
    blanksList.style.display = 'block';
    document.getElementById('blanksChips').innerHTML = blanks.map(id => {
      const el = document.getElementById(`q-${id}`);
      const num = el?.dataset.displayNumber || id;
      return `<button type="button" class="blank-chip" data-qid="${esc(id)}">${esc(num)}</button>`;
    }).join('');
  } else {
    blanksList.style.display = 'none';
  }

  document.getElementById('submitModal').classList.add('open');
}

function closeSubmitModal() {
  document.getElementById('submitModal').classList.remove('open');
}

function jumpToQuestion(qId) {
  closeSubmitModal();
  const el = document.getElementById(`q-${qId}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.transition = 'background 0.3s';
    el.style.background = 'rgba(174, 145, 66, 0.15)';
    setTimeout(() => { el.style.background = ''; }, 1500);
    const input = el.querySelector('input, select, textarea');
    if (input) input.focus();
  }
}

document.getElementById('blanksChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.blank-chip');
  if (chip) jumpToQuestion(chip.dataset.qid);
});

document.getElementById('reviewBtn').addEventListener('click', closeSubmitModal);
document.getElementById('submitModal').addEventListener('click', (e) => {
  if (e.target.id === 'submitModal') closeSubmitModal();
});

document.getElementById('confirmSubmitBtn').addEventListener('click', async () => {
  closeSubmitModal();
  state.examActive = false;
  state.proctor?.logEvent('exam_submitted');
  setSaveStatus('saving', 'Submitting…');

  const answers = collectAnswers();
  const submittedAt = new Date();
  const timeTakenSec = Math.floor((submittedAt.getTime() - state.startTime) / 1000);
  const totalQ = state.examDef.sections.reduce((sum, s) => sum + (s.questions?.length || 0), 0);
  const blanks = findUnansweredQuestions();

  try {
    const { error } = await db.from('submissions').update({
      status: 'submitted',
      submitted_at: submittedAt.toISOString(),
      time_taken_seconds: timeTakenSec,
      answers,
      proctoring: state.proctor.buildPayload(),
    }).eq('id', state.submissionId);

    if (error) throw error;

    localStorage.setItem(submittedFlagKey(state.examCode, state.student), submittedAt.toISOString());
    localStorage.removeItem(lsKey('session'));
    localStorage.removeItem(lsKey('name'));
    localStorage.removeItem(lsKey('answers'));
    localStorage.removeItem(lsKey('proctoring'));

    state.proctor.stop();
    state.proctor.exitFullscreen();
    document.getElementById('sectionProgress').style.display = 'none';

    showResultsScreen(submittedAt, timeTakenSec, totalQ, blanks.length);
  } catch (err) {
    console.error('Submit failed:', err);
    state.examActive = true;
    setSaveStatus('error', 'Submit failed');
    alert(`Could not submit your exam: ${err.message}\n\nYour answers are saved. Please try submitting again.`);
  }
});

// ===== RESULTS SCREEN =====
// No auto-score is shown here — exam grading is teacher-reviewed/manual, so
// the student only sees a submission confirmation with basic stats.
function showResultsScreen(submittedAt, timeTakenSec, totalQ, blankCount) {
  examScreen.style.display = 'none';

  const m = String(Math.floor(timeTakenSec / 60)).padStart(2, '0');
  const s = String(timeTakenSec % 60).padStart(2, '0');

  document.getElementById('resultsSubtitle').textContent = `${state.student} · ${state.classLabel}`;
  document.getElementById('resultsMessage').textContent =
    `Your responses have been recorded and submitted to ${state.teacherName}.`;
  document.getElementById('resultsRows').innerHTML = `
    <div class="results-row"><span>Student</span><span>${esc(state.student)}</span></div>
    <div class="results-row"><span>Class</span><span>${esc(state.classLabel)}</span></div>
    <div class="results-row"><span>Code</span><span class="mono-val">${esc(state.examCode)}</span></div>
    <div class="results-row"><span>Submitted at</span><span>${submittedAt.toLocaleString()}</span></div>
    <div class="results-row"><span>Time taken</span><span>${m}:${s}</span></div>
    <div class="results-row"><span>Questions answered</span><span>${totalQ - blankCount} / ${totalQ}</span></div>
  `;

  document.getElementById('resultsScreen').style.display = 'block';
  window.scrollTo(0, 0);
}

// ===== START =====
init();
