import { db } from '../supabase-client.js';
import { requireAuth } from '../auth.js';
import { renderNavbar, showToast } from '../ui.js';
import { scoreDefinition, renderDefinitionResults } from '../question-engine.js';

let submission = null, assessment = null, examDef = null;

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function formatDuration(s) {
  if (s == null) return '—';
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
function showError(title, msg) {
  document.getElementById('authLoading').style.display = 'none';
  document.getElementById('errorTitle').textContent = title;
  document.getElementById('errorMessage').textContent = msg;
  document.getElementById('errorScreen').style.display = 'block';
}

async function loadData() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  if (!id) { showError('No submission ID', 'No submission ID was provided in the URL.'); return; }
  try {
    const subRes = await db.from('assessment_submissions').select('*').eq('id', id).single();
    if (subRes.error) throw subRes.error;
    submission = subRes.data;

    const [aRes, clsIdRes] = await Promise.all([
      db.from('assessments').select('*').eq('id', submission.assessment_id).single(),
      db.from('assessments').select('class_id').eq('id', submission.assessment_id).single(),
    ]);
    if (aRes.error) throw aRes.error;
    assessment = aRes.data;
    examDef = assessment.assessment_definition;

    const clsRes = clsIdRes.data?.class_id
      ? await db.from('classes').select('name').eq('id', clsIdRes.data.class_id).maybeSingle()
      : { data: null };

    document.getElementById('bcStudent').textContent = submission.student_name;
    document.getElementById('bcBackBtn').href = `submissions.html?id=${assessment.id}`;
    document.getElementById('backBtn').href = `submissions.html?id=${assessment.id}`;

    document.getElementById('metaStudent').textContent = submission.student_name;
    document.getElementById('metaAssessmentTitle').textContent = assessment.title || assessment.code;
    document.getElementById('metaCode').textContent = submission.assessment_code;
    document.getElementById('metaClass').textContent = clsRes.data?.name || '—';
    document.getElementById('metaSubmitted').textContent = formatDate(submission.submitted_at);
    document.getElementById('metaDuration').textContent = formatDuration(submission.time_taken_seconds);
    document.getElementById('metaResultsShown').textContent = submission.results_shown ? 'Shown to student' : 'Not shown';

    const visMap = {
      none: 'No results were shown to the student after submission.',
      score_only: 'The student was shown their total score only.',
      full_breakdown: 'The student was shown a full per-question breakdown.',
    };
    document.getElementById('visibilityInfo').textContent = visMap[assessment.results_visibility] || '—';

    document.getElementById('reviewedCheckbox').checked = submission.reviewed || false;
    document.getElementById('reviewerNotes').value = submission.reviewer_notes || '';

    renderDefinitionResults(document.getElementById('sectionsContainer'), examDef, submission.answers || {});
    updateScoreSummary();

    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('content').style.display = 'block';
  } catch (err) {
    showError('Could not load submission', err.message || 'Unknown error');
  }
}

function updateScoreSummary() {
  if (!examDef) return;
  const { autoScore, maxScore } = scoreDefinition(examDef, submission.answers || {});
  document.getElementById('sumAuto').textContent = `${autoScore}`;
  document.getElementById('sumMax').textContent = maxScore;
  document.getElementById('sumTotal').textContent = `${autoScore} / ${maxScore}`;
}

document.getElementById('saveGradeBtn').addEventListener('click', async () => {
  const btn = document.getElementById('saveGradeBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const reviewed = document.getElementById('reviewedCheckbox').checked;
  const notes = document.getElementById('reviewerNotes').value.trim() || null;
  const { autoScore, maxScore } = scoreDefinition(examDef, submission.answers || {});

  try {
    const { error } = await db.from('assessment_submissions').update({
      reviewed,
      reviewer_notes: notes,
      reviewed_at: reviewed ? new Date().toISOString() : null,
      auto_score: autoScore,
      total_score: autoScore,
      max_score: maxScore,
    }).eq('id', submission.id);
    if (error) throw error;
    showToast('Saved', 'success');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Review';
  }
});

// ===== INIT =====
(async () => {
  const auth = await requireAuth();
  if (!auth) return;
  renderNavbar(document.getElementById('navbarContainer'), { profile: auth.profile, active: 'assessments' });
  await loadData();
})();
