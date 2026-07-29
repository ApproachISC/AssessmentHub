import { db } from '../supabase-client.js';
import { requireAuth } from '../auth.js';
import { renderNavbar, showToast, esc } from '../ui.js';

let currentProfile = null;
let allSubmissions = [], allExams = [], allClasses = [];
let sortBy = 'submitted_at', sortDir = 'desc', currentPage = 1;
const ROWS_PER_PAGE = 20;

const submissionsBody = document.getElementById('submissionsBody');
const searchEl = document.getElementById('search');
const filterExam = document.getElementById('filterExam');
const filterStatus = document.getElementById('filterStatus');
const filterDate = document.getElementById('filterDate');
const resultsCount = document.getElementById('resultsCount');

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
function proctorScore(p) {
  if (!p) return 0;
  return (p.tab_switches || 0) + (p.fullscreen_exits || 0) * 2 + (p.devtools_attempts || 0) * 3;
}

async function loadData() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const singleExamId = urlParams.get('id');

    const [examsRes, classesRes, submissionsRes] = await Promise.all([
      db.from('exams').select('id, code, class_id, level_id, teacher_id, type, year, quarter').order('created_at', { ascending: false }),
      db.from('classes').select('id, name'),
      singleExamId
        ? db.from('submissions').select('*').eq('exam_id', singleExamId).order('submitted_at', { ascending: false, nullsFirst: false })
        : db.from('submissions').select('*').order('submitted_at', { ascending: false, nullsFirst: false }),
    ]);
    if (examsRes.error) throw examsRes.error;
    if (classesRes.error) throw classesRes.error;
    if (submissionsRes.error) throw submissionsRes.error;

    allExams = examsRes.data || [];
    allClasses = classesRes.data || [];
    const allSubs = submissionsRes.data || [];

    // RLS allows all submissions to be read for now (broad dev policy);
    // we filter teacher submissions in the UI based on the visible exams.
    const visibleExamIds = new Set(allExams.map(e => e.id));

    allSubmissions = allSubs.filter(s => visibleExamIds.has(s.exam_id)).map(s => {
      const exam = allExams.find(e => e.id === s.exam_id);
      const cls = exam ? allClasses.find(c => c.id === exam.class_id) : null;
      return { ...s, _exam: exam, _class_name: cls?.name || '—', _proctor_score: proctorScore(s.proctoring) };
    });

    if (singleExamId) {
      const exam = allExams.find(e => e.id === singleExamId);
      const cls = exam ? allClasses.find(c => c.id === exam.class_id) : null;
      const label = exam ? `${exam.code} — ${cls?.name || ''}` : singleExamId;

      document.getElementById('breadcrumb').style.display = 'block';
      document.getElementById('bcExam').textContent = label;
      document.getElementById('backBtn').style.display = 'inline-flex';
      document.getElementById('pageTitle').innerHTML = `${esc(cls?.name || '—')} · ${exam?.quarter || ''} ${exam?.year || ''} <em>Submissions</em>`;
      document.getElementById('pageSub').textContent = esc(exam?.code || '—');

      filterExam.innerHTML = `<option value="${singleExamId}" selected>${esc(label)}</option>`;
      filterExam.value = singleExamId;
      filterExam.closest('.filter-field').style.display = 'none';
    } else {
      filterExam.innerHTML = '<option value="">All exams</option>' +
        allExams.map(e => {
          const cls = allClasses.find(c => c.id === e.class_id);
          return `<option value="${e.id}">${esc(e.code)} — ${esc(cls?.name || 'Unknown class')}</option>`;
        }).join('');
    }

    updateStats();
    renderTable();

    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('page').style.display = 'block';
  } catch (err) {
    submissionsBody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><h3>Could not load submissions</h3><p>${esc(err.message || 'Check your connection.')}</p></div></td></tr>`;
    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('page').style.display = 'block';
  }
}

function updateStats() {
  let inProgress = 0, submitted = 0, reviewed = 0;
  allSubmissions.forEach(s => {
    if (s.status === 'in_progress') inProgress++;
    else if (s.status === 'submitted') { if (s.reviewed) reviewed++; else submitted++; }
  });
  document.getElementById('statTotal').textContent = allSubmissions.length;
  document.getElementById('statInProgress').textContent = inProgress;
  document.getElementById('statSubmitted').textContent = submitted;
  document.getElementById('statReviewed').textContent = reviewed;
}

function getFilteredSubmissions() {
  const search = searchEl.value.toLowerCase().trim();
  const examId = filterExam.value;
  const status = filterStatus.value;
  const dateRange = filterDate.value;

  const now = new Date();
  let dateMin = null;
  if (dateRange === 'today') dateMin = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  else if (dateRange === 'week') dateMin = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  else if (dateRange === 'month') dateMin = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  let filtered = allSubmissions.filter(s => {
    if (examId && s.exam_id !== examId) return false;
    if (status === 'reviewed') { if (!(s.status === 'submitted' && s.reviewed)) return false; }
    else if (status === 'submitted') { if (!(s.status === 'submitted' && !s.reviewed)) return false; }
    else if (status === 'in_progress') { if (s.status !== 'in_progress') return false; }
    else if (status === 'flagged') { if (s._proctor_score < 3) return false; }
    if (dateMin && s.submitted_at && new Date(s.submitted_at) < dateMin) return false;
    if (dateMin && !s.submitted_at && new Date(s.started_at) < dateMin) return false;
    if (search && !`${s.student_name} ${s.exam_code} ${s._class_name}`.toLowerCase().includes(search)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    let av = a[sortBy], bv = b[sortBy];
    if (av == null) av = '';
    if (bv == null) bv = '';
    if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    return sortDir === 'asc' ? (av > bv ? 1 : -1) : (bv > av ? 1 : -1);
  });
  return filtered;
}

function renderTable() {
  const subs = getFilteredSubmissions();
  resultsCount.textContent = `${subs.length} submission${subs.length === 1 ? '' : 's'}`;
  const paginationContainer = document.getElementById('paginationContainer');

  if (subs.length === 0) {
    submissionsBody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="icon">⌗</div><h3>No submissions found</h3><p>${allSubmissions.length === 0 ? 'No students have started any exams yet.' : 'Try adjusting your filters.'}</p></div></td></tr>`;
    paginationContainer.style.display = 'none';
    return;
  }

  const totalPages = Math.ceil(subs.length / ROWS_PER_PAGE);
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  const start = (currentPage - 1) * ROWS_PER_PAGE, end = start + ROWS_PER_PAGE;
  const pageSubmissions = subs.slice(start, end);

  submissionsBody.innerHTML = pageSubmissions.map(s => {
    let statusChip;
    if (s.status === 'in_progress') statusChip = '<span class="chip in_progress">In Progress</span>';
    else if (s.reviewed) statusChip = '<span class="chip reviewed">Reviewed</span>';
    else statusChip = '<span class="chip submitted">Submitted</span>';
    const flaggedChip = s._proctor_score >= 3 ? '<span class="chip flagged" style="margin-left:0.3rem;">Flagged</span>' : '';

    const scoreCell = s.total_score != null && s.max_score != null
      ? `${s.total_score} / ${s.max_score}`
      : (s.status === 'submitted' ? '<span style="color:var(--navy-l);font-style:italic;font-family:var(--serif);">Pending</span>' : '—');

    return `<tr>
      <td style="font-weight:500;">${esc(s.student_name)}</td>
      <td>
        <div style="font-weight:500;color:var(--navy);margin-bottom:0.2rem;">${esc(s._class_name)}</div>
        <div style="font-family:var(--mono);font-size:0.78rem;color:var(--navy-l);">${esc(s.exam_code)}</div>
      </td>
      <td>${statusChip}${flaggedChip}</td>
      <td style="font-size:0.82rem;color:var(--navy-l);">${formatDate(s.submitted_at || s.started_at)}</td>
      <td style="font-size:0.82rem;color:var(--navy-l);">${formatDuration(s.time_taken_seconds)}</td>
      <td style="text-align:center;">
        ${s._proctor_score === 0
          ? '<span style="color:var(--green);">●</span>'
          : s._proctor_score < 3
            ? `<span style="color:var(--gold-b);">${s._proctor_score}</span>`
            : `<span style="color:var(--red);font-weight:700;">${s._proctor_score}</span>`}
      </td>
      <td>${scoreCell}</td>
      <td><div class="row-actions">
        ${s.status === 'submitted'
          ? `<a href="submission-detail.html?id=${s.id}" class="row-btn">Review</a>`
          : `<button class="row-btn archive" data-delete-id="${s.id}" data-delete-name="${esc(s.student_name)}">Delete</button>`}
      </div></td>
    </tr>`;
  }).join('');

  if (subs.length > ROWS_PER_PAGE) {
    paginationContainer.style.display = 'flex';
    document.getElementById('currentPageNum').textContent = currentPage;
    document.getElementById('totalPageNum').textContent = totalPages;
    document.getElementById('rowsInfo').textContent = `Showing ${start + 1}–${Math.min(end, subs.length)} of ${subs.length}`;
    document.getElementById('prevBtn').disabled = currentPage === 1;
    document.getElementById('nextBtn').disabled = currentPage === totalPages;
  } else {
    paginationContainer.style.display = 'none';
  }
}

async function deleteInProgress(id, studentName) {
  if (!confirm(`Delete the in-progress submission from ${studentName}? They will be able to start fresh.`)) return;
  try {
    const { error } = await db.from('submissions').delete().eq('id', id);
    if (error) throw error;
    allSubmissions = allSubmissions.filter(s => s.id !== id);
    updateStats();
    renderTable();
    showToast('Submission deleted', 'success');
  } catch (err) {
    showToast('Could not delete: ' + err.message, 'error');
  }
}

submissionsBody.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-delete-id]');
  if (btn) deleteInProgress(btn.dataset.deleteId, btn.dataset.deleteName);
});

document.getElementById('prevBtn').addEventListener('click', () => {
  if (currentPage > 1) { currentPage--; renderTable(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
});
document.getElementById('nextBtn').addEventListener('click', () => {
  const subs = getFilteredSubmissions();
  const totalPages = Math.ceil(subs.length / ROWS_PER_PAGE);
  if (currentPage < totalPages) { currentPage++; renderTable(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
});

document.getElementById('exportCsvBtn').addEventListener('click', () => {
  const subs = getFilteredSubmissions();
  if (subs.length === 0) { showToast('Nothing to export with current filters', 'error'); return; }

  const headers = ['Student', 'Exam Code', 'Class', 'Status', 'Submitted At', 'Duration (sec)',
    'Proctor Score', 'Tab Switches', 'Fullscreen Exits', 'Devtools Attempts',
    'Auto Score', 'Manual Score', 'Total Score', 'Max Score', 'Reviewed'];
  const rows = subs.map(s => [
    s.student_name, s.exam_code, s._class_name, s.reviewed ? 'Reviewed' : s.status,
    s.submitted_at || s.started_at, s.time_taken_seconds || '', s._proctor_score,
    s.proctoring?.tab_switches || 0, s.proctoring?.fullscreen_exits || 0, s.proctoring?.devtools_attempts || 0,
    s.auto_score ?? '', s.manual_score ?? '', s.total_score ?? '', s.max_score ?? '', s.reviewed ? 'Yes' : 'No',
  ]);
  const csv = [headers, ...rows].map(row => row.map(cell => {
    const s = String(cell == null ? '' : cell);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `submissions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${subs.length} submission${subs.length === 1 ? '' : 's'}`, 'success');
});

[searchEl, filterExam, filterStatus, filterDate].forEach(el => {
  el.addEventListener('input', () => { currentPage = 1; renderTable(); });
  el.addEventListener('change', () => { currentPage = 1; renderTable(); });
});

document.querySelectorAll('th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (sortBy === col) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else { sortBy = col; sortDir = 'asc'; }
    document.querySelectorAll('th[data-sort]').forEach(t => { t.classList.remove('sorted'); t.querySelector('.sort-arrow').textContent = '↕'; });
    th.classList.add('sorted');
    th.querySelector('.sort-arrow').textContent = sortDir === 'asc' ? '↑' : '↓';
    currentPage = 1;
    renderTable();
  });
});

// ===== INIT =====
(async () => {
  const auth = await requireAuth();
  if (!auth) return;
  currentProfile = auth.profile;
  renderNavbar(document.getElementById('navbarContainer'), { profile: currentProfile, active: 'exams' });

  if (currentProfile.role === 'teacher') {
    document.getElementById('pageTitle').innerHTML = 'My <em>Submissions</em>';
    document.getElementById('pageSub').textContent = "Review and grade students' responses to your exams";
  }

  await loadData();
})();
