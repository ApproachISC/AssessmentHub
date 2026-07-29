import { db } from '../supabase-client.js';
import { showToast, esc, openModal, closeModal } from '../ui.js';
import { renderQuestionTaking, collectQuestionAnswer, restoreQuestionAnswer, scoreDefinition, renderDefinitionResults } from '../question-engine.js';
import { createProctor } from '../proctoring.js';

const DEFAULT_PROCTORING = { fullscreen_lock: true, tab_switch_tracking: true, window_blur_tracking: true };

// ===== STATE =====
const state = {
  assessment: null,
  def: null,
  code: null,
  submissionId: null,
  sessionId: null,
  student: '',
  teacherName: '',
  classLabel: '',
  startTime: null,
  active: false,
  previewMode: false,
  proctor: null,
  pages: [],
  totalQuestions: 0,
  currentPage: 0,
  answers: {},
  dragState: {},
};

// ===== HELPERS =====
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function generateSessionId() { return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`; }
function lsKey(s) { return `assess_${state.code}_${s}`; }
function submittedKey(code, name) { return `asubmitted_${code}_${name.toUpperCase().trim()}`; }
function setSaveStatus(cls, text) {
  const el = document.getElementById('saveIndicator');
  el.className = 'assess-monitor-value ' + cls;
  el.textContent = text;
}

// ===== INIT =====
async function init() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('preview') === 'true') {
    state.previewMode = true;
    return initPreview(params.get('id'));
  }
  state.code = params.get('code');
  if (!state.code) { showBlocked('No code provided', 'Open this page through the assessment entry portal.'); return; }

  try {
    const { data, error } = await db.from('assessments').select('*').eq('code', state.code).maybeSingle();
    if (error) throw error;
    if (!data) { showBlocked('Code not recognized', 'The code is not valid. Return to the entry page.'); return; }

    const now = new Date();
    if (data.status === 'draft') { showBlocked('Not published yet', 'This assessment is not yet available.'); return; }
    if (data.status === 'archived') { showBlocked('No longer available', 'This assessment has been archived.'); return; }
    if (now < new Date(data.available_from)) { showBlocked('Not open yet', `This assessment opens on ${formatDate(data.available_from)}.`); return; }
    if (now > new Date(data.available_until)) { showBlocked('Window has closed', `This assessment closed on ${formatDate(data.available_until)}.`); return; }
    if (!data.assessment_definition?.sections) { showBlocked('No content', 'This assessment has no questions yet. Contact your teacher.'); return; }

    const [teacherRes, classRes] = await Promise.all([
      db.from('profiles').select('full_name, email').eq('id', data.teacher_id).maybeSingle(),
      db.from('classes').select('name').eq('id', data.class_id).maybeSingle(),
    ]);
    state.teacherName = teacherRes.data?.full_name || teacherRes.data?.email || '—';
    state.classLabel = classRes.data?.name || '—';
    state.assessment = data;
    state.def = data.assessment_definition;
    setupProctor(data.proctoring_settings || { ...DEFAULT_PROCTORING });
    populateStartScreen();
  } catch (err) {
    showBlocked('Connection error', `Could not verify the assessment. (${err.message || 'unknown'})`);
  }
}

async function initPreview(id) {
  if (!id) { showBlocked('No ID', 'Preview must be opened from the edit page.'); return; }
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) { showBlocked('Not signed in', 'Sign in to preview assessments.'); return; }
    const { data, error } = await db.from('assessments').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) { showBlocked('Not found', 'Assessment could not be loaded.'); return; }
    if (!data.assessment_definition?.sections) { showBlocked('No content', 'Upload questions first.'); return; }
    const [teacherRes, classRes] = await Promise.all([
      db.from('profiles').select('full_name,email').eq('id', data.teacher_id).maybeSingle(),
      db.from('classes').select('name').eq('id', data.class_id).maybeSingle(),
    ]);
    state.teacherName = teacherRes.data?.full_name || '—';
    state.classLabel = classRes.data?.name || '—';
    state.assessment = data;
    state.def = data.assessment_definition;
    state.student = 'PREVIEW';
    state.code = data.code;
    state.startTime = Date.now();
    // Preview mode never proctors — state.proctor stays null.
    buildPages();
    document.getElementById('startScreen').style.display = 'none';
    document.getElementById('assessScreen').style.display = 'block';
    document.getElementById('headerTitle').textContent = state.assessment.title || 'Assessment';
    document.getElementById('headerStudent').innerHTML = '<span style="color:var(--gold-b);font-weight:700;letter-spacing:0.2em;">PREVIEW MODE</span>';
    state.active = true;
    navigateTo(0);
  } catch (err) {
    showBlocked('Preview error', err.message || 'unknown');
  }
}

function showBlocked(title, message) {
  document.getElementById('loadingPanel').style.display = 'none';
  document.getElementById('startForm').style.display = 'none';
  document.getElementById('blockedPanel').style.display = 'block';
  document.getElementById('blockedTitle').textContent = title;
  document.getElementById('blockedMessage').textContent = message;
}

// ===== PROCTORING SETUP (rules list, monitor bar, lockout) =====
function setupProctor(settings) {
  state.proctor = createProctor({ settings, onStateChange: onProctorStateChange });
  const p = state.proctor;
  const anyEnabled = p.settings.fullscreen_lock || p.settings.tab_switch_tracking || p.settings.window_blur_tracking;

  document.getElementById('monitorTabSwitches').style.display = p.settings.tab_switch_tracking ? 'flex' : 'none';
  document.getElementById('monitorFullscreen').style.display = p.fullscreenRequired ? 'flex' : 'none';

  if (!anyEnabled) {
    document.getElementById('proctorRules').style.display = 'none';
    document.getElementById('acknowledgeRow').style.display = 'none';
    return;
  }

  const rules = [];
  if (p.fullscreenRequired) {
    rules.push('The assessment will open in fullscreen mode.');
    rules.push('Leaving fullscreen will pause the assessment and lock the questions.');
  }
  if (p.settings.tab_switch_tracking || p.settings.window_blur_tracking) {
    rules.push('Switching tabs or windows is recorded and reported.');
  }
  rules.push('Your progress is auto-saved. You may resume if disconnected.');
  rules.push('Once submitted, you cannot retake this assessment.');

  document.getElementById('rulesList').innerHTML = rules.map(r => `<li>${esc(r)}</li>`).join('');
  document.getElementById('proctorRules').style.display = 'block';
  document.getElementById('acknowledgeRow').style.display = 'flex';

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
    if (s.tabSwitches > 0) showToast(`Tab switch detected (${s.tabSwitches} total)`);
  }
  const statusEl = document.getElementById('fullscreenStatus');
  const lockout = document.getElementById('lockout');
  if (statusEl) {
    statusEl.textContent = s.paused ? 'PAUSED' : 'Active';
    statusEl.classList.toggle('alert', s.paused);
  }
  if (lockout) lockout.classList.toggle('active', !!s.paused);
  saveToSupabase();
}

// ===== START SCREEN =====
function populateStartScreen() {
  const d = state.assessment;
  const title = d.title || 'Assessment';
  const totalQ = state.def.sections.reduce((s, sec) => s + (sec.questions?.length || 0), 0);
  document.getElementById('examStamp').textContent = `${state.classLabel} · ${d.quarter} ${d.year}`;
  document.getElementById('examTitle').innerHTML = `<em>${esc(title)}</em>`;
  document.getElementById('examSubtitle').textContent = `${totalQ} question${totalQ === 1 ? '' : 's'}`;
  document.getElementById('infoClass').textContent = state.classLabel;
  document.getElementById('infoTeacher').textContent = state.teacherName;
  document.getElementById('infoCode').textContent = d.code;
  document.getElementById('loadingPanel').style.display = 'none';
  document.getElementById('startForm').style.display = 'block';
  document.getElementById('studentName').focus();
}

const studentNameEl = document.getElementById('studentName');
const acknowledgeBox = document.getElementById('acknowledgeBox');
const startBtn = document.getElementById('startBtn');
function updateStartButton() {
  const nameReady = studentNameEl.value.trim().length >= 2;
  const rulesShown = document.getElementById('proctorRules').style.display !== 'none';
  const ackReady = !rulesShown || acknowledgeBox.checked;
  startBtn.disabled = !(nameReady && ackReady);
}
studentNameEl.addEventListener('input', updateStartButton);
acknowledgeBox.addEventListener('change', updateStartButton);

// ===== START =====
startBtn.addEventListener('click', async () => {
  const name = studentNameEl.value.trim().toUpperCase();
  if (!name) return;
  if (localStorage.getItem(submittedKey(state.code, name))) {
    showBlocked('Already submitted', 'You already submitted this assessment. Contact your teacher if this is a mistake.');
    return;
  }
  state.student = name;

  const savedSession = localStorage.getItem(lsKey('session'));
  const savedName = localStorage.getItem(lsKey('name'));
  let resumeData = null;
  if (savedSession && savedName === name) {
    try {
      const { data: rows } = await db.rpc('resume_assessment_submission', { p_session_id: savedSession });
      const data = rows?.[0] || null;
      if (data && confirm('We found an unfinished attempt. Resume where you left off?')) {
        resumeData = data;
        state.submissionId = data.id;
        state.sessionId = data.session_id;
        state.startTime = new Date(data.started_at).getTime();
        state.answers = data.answers || {};
        state.proctor.restoreCounts(data.proctoring);
      }
    } catch (e) { /* ignore */ }
  }

  if (state.proctor.fullscreenRequired) {
    const ok = await state.proctor.requestFullscreen();
    if (!ok) {
      alert('Fullscreen is required to begin the assessment. Please allow fullscreen and try again.');
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
      const { error } = await db.from('assessment_submissions').insert({
        id: submissionId,
        assessment_id: state.assessment.id,
        assessment_code: state.code,
        student_name: name,
        session_id: state.sessionId,
        status: 'in_progress',
        started_at: new Date().toISOString(),
        answers: {},
        user_agent: navigator.userAgent,
      });
      if (error) throw error;
      state.submissionId = submissionId;
    } catch (err) {
      showToast('Could not start: ' + (err.message || 'error'), 'error');
      state.proctor.exitFullscreen();
      return;
    }
    localStorage.setItem(lsKey('session'), state.sessionId);
    localStorage.setItem(lsKey('name'), name);
  }

  document.getElementById('headerTitle').textContent = state.assessment.title || 'Assessment';
  document.getElementById('headerStudent').textContent = `${name} · ${state.teacherName}`;
  document.getElementById('startScreen').style.display = 'none';
  document.getElementById('assessScreen').style.display = 'block';
  state.active = true;
  state.proctor.start();
  buildPages();
  navigateTo(0);
  if (resumeData) restoreAnswersFromState();
  window.scrollTo(0, 0);
});

document.getElementById('resumeBtn').addEventListener('click', () => {
  state.proctor?.resumeFullscreen();
});

// ===== PAGE BUILDER =====
function buildPages() {
  state.pages = [];
  let displayCounter = 0;
  (state.def.sections || []).forEach((section, sIdx) => {
    if (section.passage?.content) {
      state.pages.push({ type: 'passage', sectionIdx: sIdx });
    }
    (section.questions || []).forEach((q, qIdx) => {
      displayCounter++;
      state.pages.push({ type: 'question', sectionIdx: sIdx, questionIdx: qIdx, displayNumber: displayCounter });
    });
  });
  state.totalQuestions = displayCounter;
}

// ===== NAVIGATION =====
function navigateTo(pageIndex) {
  if (pageIndex < 0 || pageIndex >= state.pages.length) return;
  if (state.active && state.currentPage !== pageIndex) saveCurrentPageAnswer();

  state.currentPage = pageIndex;
  const page = state.pages[pageIndex];

  document.getElementById('passagePage').style.display = 'none';
  document.getElementById('assessScreen').style.display = 'none';

  if (page.type === 'passage') renderPassagePage(page);
  else renderQuestionPage(page);

  updateProgress();
  window.scrollTo(0, 0);
  scheduleAutoSave();
}

function getCurrentQuestion() {
  const page = state.pages[state.currentPage];
  if (!page || page.type !== 'question') return null;
  return state.def.sections[page.sectionIdx].questions[page.questionIdx];
}

function saveCurrentPageAnswer() {
  const page = state.pages[state.currentPage];
  if (!page || page.type !== 'question') return;
  const q = getCurrentQuestion();
  collectQuestionAnswer(q, document.getElementById('assessBody'), state.answers, state.dragState);
}

function updateProgress() {
  const total = state.pages.length;
  const pct = total > 0 ? Math.round(((state.currentPage + 1) / total) * 100) : 0;

  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressFill2').style.width = pct + '%';

  const page = state.pages[state.currentPage];
  const section = state.def.sections[page?.sectionIdx || 0];
  const sectionLabel = section?.title || `Section ${(page?.sectionIdx || 0) + 1}`;
  document.getElementById('passageProgressLabel').textContent = sectionLabel;
  document.getElementById('progressLabel').textContent = sectionLabel;

  if (page?.type === 'question') {
    const dn = page.displayNumber;
    document.getElementById('progressText').textContent = `Question ${dn} of ${state.totalQuestions}`;
    document.getElementById('progressText2').textContent = `Question ${dn} of ${state.totalQuestions}`;
    document.getElementById('navProgress').innerHTML = `Question <strong>${dn}</strong> of <strong>${state.totalQuestions}</strong>`;
  } else {
    document.getElementById('progressText').textContent = 'Reading';
    document.getElementById('progressText2').textContent = 'Reading';
    document.getElementById('navProgress').textContent = 'Reading passage';
  }

  const isFirst = state.currentPage === 0;
  const isLast = state.currentPage === state.pages.length - 1;
  document.getElementById('prevBtn').disabled = isFirst;

  const nextBtn = document.getElementById('nextBtn');
  const nav = document.querySelector('.assess-nav-bar');
  const oldSubmit = document.getElementById('submitBtnNav');
  if (oldSubmit) oldSubmit.remove();

  if (isLast) {
    nextBtn.style.display = 'none';
    const submitBtn = document.createElement('button');
    submitBtn.className = 'nav-submit';
    submitBtn.id = 'submitBtnNav';
    submitBtn.textContent = 'Submit Assessment';
    submitBtn.addEventListener('click', openSubmitModal);
    nav.appendChild(submitBtn);
  } else {
    nextBtn.style.display = 'block';
  }
}

document.getElementById('prevBtn').addEventListener('click', () => { saveCurrentPageAnswer(); navigateTo(state.currentPage - 1); });
document.getElementById('nextBtn').addEventListener('click', () => { saveCurrentPageAnswer(); navigateTo(state.currentPage + 1); });

// ===== PASSAGE PAGE RENDER =====
function renderPassagePage(page) {
  const section = state.def.sections[page.sectionIdx];
  document.getElementById('passageSectionLabel').textContent = section.title || `Section ${page.sectionIdx + 1}`;
  document.getElementById('passageTitle').textContent = section.title || '';
  document.getElementById('passageText').textContent = section.passage.content;
  document.getElementById('passagePage').style.display = 'block';

  document.getElementById('passageNextBtn').onclick = () => {
    saveCurrentPageAnswer();
    navigateTo(state.currentPage + 1);
  };

  document.querySelector('.assess-nav-bar').style.display = 'none';
}

// ===== QUESTION PAGE RENDER =====
function renderQuestionPage(page) {
  const section = state.def.sections[page.sectionIdx];
  const q = section.questions[page.questionIdx];
  document.querySelector('.assess-nav-bar').style.display = 'flex';
  document.getElementById('assessScreen').style.display = 'block';
  renderQuestion(q, page.displayNumber);
}

function renderQuestion(q, displayNumber) {
  const body = document.getElementById('assessBody');
  body.innerHTML = '';
  const qEl = renderQuestionTaking(q, displayNumber, state.dragState, () => {
    collectQuestionAnswer(q, body, state.answers, state.dragState);
    scheduleAutoSave();
    setSaveStatus('saving', 'Saving…');
  });
  body.appendChild(qEl);
  restoreQuestionAnswer(q, body, state.answers, state.dragState);
}

function restoreAnswersFromState() { /* answers already in state.answers, restoreQuestionAnswer called on render */ }

// ===== AUTO-SAVE =====
let saveTimeout = null;
function scheduleAutoSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveToSupabase, 8000);
}

document.getElementById('assessBody').addEventListener('input', () => {
  const q = getCurrentQuestion();
  if (q) collectQuestionAnswer(q, document.getElementById('assessBody'), state.answers, state.dragState);
  scheduleAutoSave();
  setSaveStatus('saving', 'Saving…');
});
document.getElementById('assessBody').addEventListener('change', () => {
  const q = getCurrentQuestion();
  if (q) collectQuestionAnswer(q, document.getElementById('assessBody'), state.answers, state.dragState);
  scheduleAutoSave();
});

async function saveToSupabase() {
  if (!state.active || !state.submissionId || state.previewMode) return;
  setSaveStatus('saving', 'Saving…');
  try {
    const update = { answers: state.answers };
    if (state.proctor) update.proctoring = state.proctor.buildPayload();
    const { error } = await db.from('assessment_submissions').update(update).eq('id', state.submissionId);
    if (error) throw error;
    setSaveStatus('saved', 'Saved');
  } catch (err) {
    setSaveStatus('offline', 'Offline');
  }
}

// ===== SUBMIT =====
function openSubmitModal() {
  saveCurrentPageAnswer();
  if (state.previewMode) { showResultsScreen(); return; }
  openModal('submitModal');
}
document.getElementById('cancelSubmitBtn').addEventListener('click', () => {
  closeModal('submitModal');
});
document.getElementById('confirmSubmitBtn').addEventListener('click', async () => {
  closeModal('submitModal');
  await handleSubmit();
});

async function handleSubmit() {
  const submittedAt = new Date();
  const timeSec = Math.floor((submittedAt.getTime() - state.startTime) / 1000);
  const { autoScore, maxScore } = scoreDefinition(state.def, state.answers);

  try {
    const update = {
      status: 'submitted',
      submitted_at: submittedAt.toISOString(),
      time_taken_seconds: timeSec,
      answers: state.answers,
      auto_score: autoScore,
      total_score: autoScore,
      max_score: maxScore,
      results_shown: state.assessment.results_visibility !== 'none',
    };
    if (state.proctor) update.proctoring = state.proctor.buildPayload();
    const { error } = await db.from('assessment_submissions').update(update).eq('id', state.submissionId);
    if (error) throw error;

    localStorage.setItem(submittedKey(state.code, state.student), submittedAt.toISOString());
    localStorage.removeItem(lsKey('session'));
    localStorage.removeItem(lsKey('name'));
  } catch (err) {
    showToast('Submit failed: ' + err.message, 'error');
    return;
  }
  state.proctor?.stop();
  state.proctor?.exitFullscreen();
  showResultsScreen();
}

// ===== RESULTS SCREEN =====
function showResultsScreen() {
  document.getElementById('assessScreen').style.display = 'none';
  document.getElementById('passagePage').style.display = 'none';
  document.querySelector('.assess-nav-bar').style.display = 'none';
  document.getElementById('lockout').classList.remove('active');
  document.getElementById('resultsScreen').style.display = 'block';

  const visibility = state.previewMode ? 'full_breakdown' : (state.assessment.results_visibility || 'none');
  const title = state.assessment.title || 'Assessment';
  document.getElementById('resultsTitle').textContent = `${title} — Complete`;
  document.getElementById('resultsSubtitle').textContent = `${state.student} · ${state.classLabel}`;

  const scoreArea = document.getElementById('scoreCardArea');
  const qArea = document.getElementById('resultsQArea');

  if (visibility === 'none') {
    scoreArea.innerHTML = `
      <div class="assess-submitted-card">
        <div class="headline">Assessment Submitted ✓</div>
        <p>Your answers have been recorded. Your teacher will share your results.</p>
      </div>`;
    qArea.innerHTML = '';
    window.scrollTo(0, 0);
    return;
  }

  const { autoScore, maxScore } = scoreDefinition(state.def, state.answers);
  const pct = maxScore > 0 ? Math.round((autoScore / maxScore) * 100) : 0;

  scoreArea.innerHTML = `
    <div class="assess-score-card">
      <div class="score-label">Your Score</div>
      <div><span class="score-number">${autoScore}</span><span class="score-max"> / ${maxScore}</span></div>
      <div class="score-pct">${pct}%</div>
    </div>`;

  if (visibility !== 'full_breakdown') { qArea.innerHTML = ''; window.scrollTo(0, 0); return; }

  renderDefinitionResults(qArea, state.def, state.answers);
  window.scrollTo(0, 0);
}

// ===== START =====
window.scrollTo(0, 0);
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
init();
