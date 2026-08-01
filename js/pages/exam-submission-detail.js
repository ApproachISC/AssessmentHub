import { db } from '../supabase-client.js';
import { requireAuth } from '../auth.js';
import { renderNavbar, showToast, esc } from '../ui.js';
import { scoreDefinitionWithManual, renderDefinitionResults, rerenderQuestionChip, gradeQuestion } from '../question-engine.js';

let submission = null, exam = null, examDef = null, className = '—';
let manualGrades = {}; // { questionId: score } or, for pool_writing, { 'qid__1': score }

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function formatDuration(sec) {
  if (sec == null) return '—';
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
}
function showError(title, message) {
  document.getElementById('authLoading').style.display = 'none';
  document.getElementById('content').style.display = 'none';
  document.getElementById('errorTitle').textContent = title;
  document.getElementById('errorMessage').textContent = message;
  document.getElementById('errorScreen').style.display = 'block';
}

async function loadSubmission() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  if (!id) { showError('No submission ID', 'No submission ID was provided in the URL.'); return; }

  try {
    const subRes = await db.from('submissions').select('*').eq('id', id).single();
    if (subRes.error) throw subRes.error;
    submission = subRes.data;

    const examRes = await db.from('exams').select('*').eq('id', submission.exam_id).single();
    if (examRes.error) throw examRes.error;
    exam = examRes.data;
    examDef = exam.exam_definition;

    const classRes = await db.from('classes').select('name').eq('id', exam.class_id).maybeSingle();
    className = classRes.data?.name || '—';

    manualGrades = submission.manual_grades || {};

    const backUrl = `submissions.html?id=${encodeURIComponent(submission.exam_id)}`;
    document.getElementById('bcSubmissionsLink').href = backUrl;
    document.getElementById('backToListLink').href = backUrl;

    renderMeta();
    renderProctoring();
    renderSections();
    updateScoreSummary();

    document.getElementById('reviewedCheckbox').checked = submission.reviewed || false;
    document.getElementById('reviewerNotes').value = submission.reviewer_notes || '';

    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('content').style.display = 'block';
  } catch (err) {
    showError('Could not load submission', err.message || 'Unknown error');
  }
}

function renderMeta() {
  document.getElementById('bcStudent').textContent = submission.student_name;
  document.getElementById('metaStudent').textContent = submission.student_name;
  document.getElementById('metaCode').textContent = submission.exam_code;
  document.getElementById('metaClass').textContent = className;
  document.getElementById('metaSubmitted').textContent = formatDate(submission.submitted_at);
  document.getElementById('metaDuration').textContent = formatDuration(submission.time_taken_seconds);
}

function renderProctoring() {
  const p = submission.proctoring || {};
  const grid = document.getElementById('proctorGrid');
  const stats = [
    { label: 'Tab Switches', value: p.tab_switches || 0, threshold: { warn: 1, alert: 3 } },
    { label: 'Window Blurs', value: p.window_blur_events || 0, threshold: { warn: 3, alert: 8 } },
    { label: 'Fullscreen Exits', value: p.fullscreen_exits || 0, threshold: { warn: 1, alert: 3 } },
    { label: 'Right-Click Blocks', value: p.right_clicks_blocked || 0, threshold: { warn: 3, alert: 8 } },
    { label: 'Devtools Attempts', value: p.devtools_attempts || 0, threshold: { warn: 1, alert: 2 } },
  ];
  grid.innerHTML = stats.map(s => {
    let cls = 'ok';
    if (s.value >= s.threshold.alert) cls = 'alert';
    else if (s.value >= s.threshold.warn) cls = 'warning';
    if (s.value === 0) cls = 'ok';
    return `<div class="proctor-stat ${cls}"><div class="proctor-stat-label">${s.label}</div><div class="proctor-stat-value">${s.value}</div></div>`;
  }).join('');

  const log = p.event_log || [];
  document.getElementById('eventCount').textContent = log.length;
  document.getElementById('eventLogList').innerHTML = log.length === 0
    ? '<div style="color:var(--muted);font-style:italic;font-family:var(--serif);padding:0.5rem;">No events recorded.</div>'
    : log.map(e => {
        const t = new Date(e.ts);
        return `<div class="event-row"><span class="event-time">${t.toLocaleTimeString('en-US', { hour12: false })}</span><span class="event-type">${esc(e.type)}</span><span>${esc(e.detail || '')}</span></div>`;
      }).join('');
}
document.getElementById('eventLogToggle').addEventListener('click', () => {
  document.getElementById('eventLogList').classList.toggle('expanded');
});

function renderSections() {
  const container = document.getElementById('sectionsContainer');
  if (!examDef || !examDef.sections) {
    container.innerHTML = '<p style="color:var(--navy-l);font-style:italic;">This submission has no exam definition. The exam may have been deleted.</p>';
    return;
  }
  renderDefinitionResults(container, examDef, submission.answers || {}, manualGrades);
}

function updateScoreSummary() {
  const { auto, manual, max, total } = scoreDefinitionWithManual(examDef, submission.answers || {}, manualGrades);
  document.getElementById('sumAuto').textContent = auto;
  document.getElementById('sumManual').textContent = manual;
  document.getElementById('sumMax').textContent = max;
  document.getElementById('sumTotal').textContent = `${total} / ${max}`;
}

// ===== MANUAL GRADE INPUT =====
document.addEventListener('input', (e) => {
  if (!e.target.matches('input[data-grade-key]')) return;
  const key = e.target.dataset.gradeKey;
  const value = e.target.value;
  if (value === '' || value == null) delete manualGrades[key];
  else manualGrades[key] = Number(value);

  const qid = key.split('__')[0];
  const q = (examDef?.sections || []).flatMap(s => s.questions || []).find(q => q.id === qid);
  if (q) rerenderQuestionChip(document.getElementById('sectionsContainer'), q, submission.answers || {}, manualGrades);
  updateScoreSummary();
});

// ===== SAVE =====
document.getElementById('saveBtn').addEventListener('click', async () => {
  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const { auto, manual, max, total } = scoreDefinitionWithManual(examDef, submission.answers || {}, manualGrades);
  const reviewed = document.getElementById('reviewedCheckbox').checked;
  const reviewerNotes = document.getElementById('reviewerNotes').value.trim() || null;

  try {
    const { error } = await db.from('submissions').update({
      manual_grades: manualGrades,
      auto_score: auto,
      manual_score: manual,
      total_score: total,
      max_score: max,
      reviewed,
      reviewed_at: reviewed ? new Date().toISOString() : null,
      reviewer_notes: reviewerNotes,
    }).eq('id', submission.id);
    if (error) throw error;
    showToast('Grade saved successfully', 'success');
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Grade';
  }
});

document.getElementById('printBtn').addEventListener('click', () => window.print());

// ===== INIT =====
(async () => {
  const auth = await requireAuth();
  if (!auth) return;
  renderNavbar(document.getElementById('navbarContainer'), { profile: auth.profile, active: 'exams' });
  await loadSubmission();
})();
