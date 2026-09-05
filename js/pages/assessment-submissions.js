import { db } from '../supabase-client.js';
import { requireAuth } from '../auth.js';
import { renderNavbar, showToast, esc, openModal, closeModal } from '../ui.js';
import { scoreDefinition } from '../question-engine.js';

let currentProfile = null, assessment = null, allSubs = [], sortBy = 'submitted_at', sortDir = 'desc';

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function formatDur(s) {
  if (s == null) return '—';
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

async function loadData() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  if (!id) { showToast('No assessment ID', 'error'); return; }
  try {
    const [aRes, sRes] = await Promise.all([
      db.from('assessments').select('*').eq('id', id).single(),
      db.from('assessment_submissions').select('*').eq('assessment_id', id).order('submitted_at', { ascending: false, nullsFirst: false }),
    ]);
    if (aRes.error) throw aRes.error;
    assessment = aRes.data;
    allSubs = sRes.data || [];
    document.getElementById('bcAssessment').textContent = assessment.title || assessment.code;
    document.getElementById('pageAssessmentTitle').textContent = assessment.title || assessment.code;
    document.getElementById('pageSub').textContent = `${assessment.quarter} ${assessment.year} · ${allSubs.length} submission${allSubs.length === 1 ? '' : 's'}`;
    updateStats();
    renderTable();
    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('page').style.display = 'block';
  } catch (err) {
    showToast('Load failed: ' + err.message, 'error');
    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('page').style.display = 'block';
  }
}

function updateStats() {
  let ip = 0, sub = 0, rev = 0;
  allSubs.forEach(s => {
    if (s.status === 'in_progress') ip++;
    else if (s.reviewed) rev++;
    else sub++;
  });
  document.getElementById('statTotal').textContent = allSubs.length;
  document.getElementById('statInProgress').textContent = ip;
  document.getElementById('statSubmitted').textContent = sub;
  document.getElementById('statReviewed').textContent = rev;
}

function getFiltered() {
  const search = document.getElementById('filterSearch').value.toLowerCase();
  const status = document.getElementById('filterStatus').value;
  const dateRange = document.getElementById('filterDate').value;
  const now = new Date();
  let dateMin = null;
  if (dateRange === 'today') dateMin = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  else if (dateRange === 'week') dateMin = new Date(now - 7 * 864e5);
  let r = allSubs.filter(s => {
    if (status === 'reviewed' && !(s.status === 'submitted' && s.reviewed)) return false;
    if (status === 'submitted' && !(s.status === 'submitted' && !s.reviewed)) return false;
    if (status === 'in_progress' && s.status !== 'in_progress') return false;
    if (dateMin && s.submitted_at && new Date(s.submitted_at) < dateMin) return false;
    if (search && !s.student_name.toLowerCase().includes(search)) return false;
    return true;
  });
  r.sort((a, b) => {
    let av = a[sortBy], bv = b[sortBy];
    if (av == null) av = '';
    if (bv == null) bv = '';
    if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    return sortDir === 'asc' ? (av > bv ? 1 : -1) : (bv > av ? 1 : -1);
  });
  return r;
}

function renderTable() {
  const subs = getFiltered();
  const tbody = document.getElementById('tableBody');
  if (!subs.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="icon">⌗</div><h3>No submissions found</h3><p>${allSubs.length === 0 ? 'No students have started this assessment yet.' : 'Try adjusting your filters.'}</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = subs.map(s => {
    let chip;
    if (s.status === 'in_progress') chip = '<span class="chip in_progress">In Progress</span>';
    else if (s.reviewed) chip = '<span class="chip active">Reviewed</span>';
    else chip = '<span class="chip upcoming">Submitted</span>';
    const score = s.total_score != null && s.max_score != null
      ? `${s.total_score} / ${s.max_score}`
      : (s.status === 'submitted' ? '<span style="font-style:italic;color:var(--navy-l);font-family:var(--serif);">Pending</span>' : '—');
    return `<tr>
      <td style="font-weight:500;">${esc(s.student_name)}</td>
      <td>${chip}</td>
      <td style="font-size:0.82rem;color:var(--navy-l);">${formatDate(s.submitted_at || s.started_at)}</td>
      <td style="font-size:0.82rem;color:var(--navy-l);">${formatDur(s.time_taken_seconds)}</td>
      <td>${score}</td>
      <td><div class="row-actions">
        ${s.status === 'submitted'
          ? `<a href="submission-detail.html?id=${s.id}" class="row-btn">Review</a>`
          : `<button class="row-btn success" data-force-id="${s.id}" data-force-name="${esc(s.student_name)}">Force Submit</button>
             <button class="row-btn archive" data-delete-id="${s.id}" data-delete-name="${esc(s.student_name)}">Delete</button>`}
      </div></td>
    </tr>`;
  }).join('');
}

async function deleteInProgress(id, name) {
  if (!confirm(`Delete in-progress submission from ${name}?`)) return;
  try {
    const { data, error } = await db.from('assessment_submissions').delete().eq('id', id).select();
    if (error) throw error;
    if (!data || data.length === 0) throw new Error('No submission was deleted (permission denied?)');
    allSubs = allSubs.filter(s => s.id !== id);
    updateStats();
    renderTable();
    showToast('Deleted', 'success');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function forceSubmit(id) {
  const submission = allSubs.find(s => s.id === id);
  if (!submission) return;
  try {
    const timeTakenSec = Math.floor((Date.now() - new Date(submission.started_at).getTime()) / 1000);
    const { autoScore, maxScore } = scoreDefinition(assessment.assessment_definition, submission.answers || {});
    const { data: ok, error } = await db.rpc('submit_assessment_submission', {
      p_id: submission.id,
      p_session_id: submission.session_id,
      p_answers: submission.answers || {},
      p_auto_score: autoScore,
      p_max_score: maxScore,
      p_time_taken_seconds: timeTakenSec,
      p_results_shown: assessment.results_visibility !== 'none',
      p_proctoring: submission.proctoring,
    });
    if (error) throw error;
    if (!ok) throw new Error('Submission record not found — it may have been deleted.');
    submission.status = 'submitted';
    submission.submitted_at = new Date().toISOString();
    submission.time_taken_seconds = timeTakenSec;
    submission.auto_score = autoScore;
    submission.total_score = autoScore;
    submission.max_score = maxScore;
    updateStats();
    renderTable();
    showToast('Submission force-submitted', 'success');
  } catch (err) {
    showToast('Could not force-submit: ' + err.message, 'error');
  }
}

let pendingForceSubmitId = null;
document.getElementById('cancelForceSubmitBtn').addEventListener('click', () => closeModal('forceSubmitModal'));
document.getElementById('forceSubmitModal').addEventListener('click', (e) => {
  if (e.target.id === 'forceSubmitModal') closeModal('forceSubmitModal');
});
document.getElementById('confirmForceSubmitBtn').addEventListener('click', () => {
  closeModal('forceSubmitModal');
  if (pendingForceSubmitId) forceSubmit(pendingForceSubmitId);
  pendingForceSubmitId = null;
});

document.getElementById('tableBody').addEventListener('click', (e) => {
  const deleteBtn = e.target.closest('[data-delete-id]');
  if (deleteBtn) { deleteInProgress(deleteBtn.dataset.deleteId, deleteBtn.dataset.deleteName); return; }
  const forceBtn = e.target.closest('[data-force-id]');
  if (forceBtn) {
    pendingForceSubmitId = forceBtn.dataset.forceId;
    document.getElementById('forceSubmitSub').textContent = `Student: ${forceBtn.dataset.forceName}`;
    openModal('forceSubmitModal');
  }
});

['filterSearch', 'filterStatus', 'filterDate'].forEach(id => {
  const el = document.getElementById(id);
  if (el) { el.addEventListener('input', renderTable); el.addEventListener('change', renderTable); }
});

document.querySelectorAll('th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (sortBy === col) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else { sortBy = col; sortDir = 'asc'; }
    document.querySelectorAll('th[data-sort]').forEach(t => {
      t.classList.remove('sorted');
      t.querySelector('.sort-arrow').textContent = '↕';
    });
    th.classList.add('sorted');
    th.querySelector('.sort-arrow').textContent = sortDir === 'asc' ? '↑' : '↓';
    renderTable();
  });
});

document.getElementById('exportBtn').addEventListener('click', () => {
  const subs = getFiltered();
  const headers = ['Student', 'Status', 'Submitted At', 'Duration (sec)', 'Auto Score', 'Manual Score', 'Total Score', 'Max Score', 'Reviewed'];
  const rows = subs.map(s => [s.student_name, s.reviewed ? 'Reviewed' : s.status, s.submitted_at || s.started_at || '', s.time_taken_seconds || '', s.auto_score ?? '', s.manual_score ?? '', s.total_score ?? '', s.max_score ?? '', s.reviewed ? 'Yes' : 'No']);
  const csv = [headers, ...rows].map(r => r.map(c => {
    const v = String(c == null ? '' : c);
    return v.includes(',') || v.includes('"') || v.includes('\n') ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${assessment?.code || 'assessment'}-submissions.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ===== INIT =====
(async () => {
  const auth = await requireAuth();
  if (!auth) return;
  currentProfile = auth.profile;
  renderNavbar(document.getElementById('navbarContainer'), { profile: currentProfile, active: 'assessments' });
  await loadData();
})();
