import { db } from '../supabase-client.js';
import { requireAuth } from '../auth.js';
import { renderNavbar, showToast, esc, openModal, closeModal } from '../ui.js';

let currentProfile = null;
let allExams = [], allClasses = [], allLevels = [], allTeachers = [];
let sortBy = 'created_at', sortDir = 'desc', currentPage = 1;
const ROWS_PER_PAGE = 20;

const examsBody = document.getElementById('examsBody');
const searchEl = document.getElementById('search');
const filterStatus = document.getElementById('filterStatus');
const filterLevel = document.getElementById('filterLevel');
const filterQuarter = document.getElementById('filterQuarter');
const filterYear = document.getElementById('filterYear');
const filterTeacher = document.getElementById('filterTeacher');

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function getWindowStatus(exam) {
  const now = new Date(), from = new Date(exam.available_from), until = new Date(exam.available_until);
  if (now < from) return 'upcoming';
  if (now > until) return 'closed';
  return 'live';
}

async function loadAllData() {
  try {
    const [classesRes, levelsRes, teachersRes, examsRes] = await Promise.all([
      db.from('classes').select('*').order('name'),
      db.from('levels').select('*').order('display_order'),
      db.from('profiles').select('id, full_name, email, role, is_active').order('full_name'),
      db.from('exams').select('*').order('created_at', { ascending: false }),
    ]);
    if (classesRes.error) throw classesRes.error;
    if (levelsRes.error) throw levelsRes.error;
    if (examsRes.error) throw examsRes.error;

    allClasses = classesRes.data || [];
    allLevels = levelsRes.data || [];
    allTeachers = (teachersRes.data || []).filter(t => t.is_active);
    allExams = examsRes.data || [];

    allExams.forEach(e => {
      const cls = allClasses.find(c => c.id === e.class_id);
      const lvl = allLevels.find(l => l.id === e.level_id);
      const tch = allTeachers.find(t => t.id === e.teacher_id);
      e.class_name = cls?.name || '—';
      e.level_name = lvl?.name || '—';
      e.teacher_name = tch?.full_name || tch?.email || '—';
    });

    filterLevel.innerHTML = '<option value="">All levels</option>' +
      allLevels.filter(l => l.is_active).map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');

    const years = [...new Set(allExams.map(e => e.year))].sort((a, b) => b - a);
    filterYear.innerHTML = '<option value="">All years</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');

    if (currentProfile.role === 'academic') {
      filterTeacher.innerHTML = '<option value="">All teachers</option>' +
        allTeachers.map(t => `<option value="${t.id}">${esc(t.full_name || t.email)}</option>`).join('');
    }

    restoreFilterState();
    updateStats();
    renderTable();

    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('page').style.display = 'block';
  } catch (err) {
    examsBody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><h3>Could not load exams</h3><p>${esc(err.message || 'Check your connection.')}</p></div></td></tr>`;
    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('page').style.display = 'block';
  }
}

function updateStats() {
  const now = new Date();
  let live = 0, upcoming = 0, archived = 0;
  allExams.forEach(e => {
    if (e.status === 'archived') { archived++; return; }
    if (e.status !== 'active') return;
    const from = new Date(e.available_from), until = new Date(e.available_until);
    if (now >= from && now <= until) live++;
    else if (now < from) upcoming++;
  });
  document.getElementById('statTotal').textContent = allExams.length;
  document.getElementById('statLive').textContent = live;
  document.getElementById('statUpcoming').textContent = upcoming;
  document.getElementById('statArchived').textContent = archived;
}

function getFilteredExams() {
  const search = searchEl.value.toLowerCase().trim();
  const status = filterStatus.value;
  const levelId = filterLevel.value;
  const quarter = filterQuarter.value;
  const year = filterYear.value;
  const teacherId = currentProfile.role === 'academic' ? filterTeacher.value : '';

  let filtered = allExams.filter(e => {
    if (status && e.status !== status) return false;
    if (levelId && e.level_id !== levelId) return false;
    if (quarter && e.quarter !== quarter) return false;
    if (year && String(e.year) !== year) return false;
    if (teacherId && e.teacher_id !== teacherId) return false;
    if (search && !`${e.code} ${e.class_name} ${e.teacher_name}`.toLowerCase().includes(search)) return false;
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
  const exams = getFilteredExams();
  const isTeacher = currentProfile.role === 'teacher';
  const colspan = isTeacher ? 4 : 5;
  const paginationContainer = document.getElementById('paginationContainer');

  if (exams.length === 0) {
    examsBody.innerHTML = `<tr><td colspan="${colspan}"><div class="empty-state"><div class="icon">⌗</div><h3>No exams found</h3><p>${allExams.length === 0 ? 'Create your first exam to get started.' : 'Try adjusting your filters.'}</p>${allExams.length === 0 ? '<a href="create.html" class="btn btn--primary">+ Create Exam</a>' : ''}</div></td></tr>`;
    paginationContainer.style.display = 'none';
    return;
  }

  const totalPages = Math.ceil(exams.length / ROWS_PER_PAGE);
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const start = (currentPage - 1) * ROWS_PER_PAGE, end = start + ROWS_PER_PAGE;
  const pageExams = exams.slice(start, end);

  examsBody.innerHTML = pageExams.map(exam => {
    const windowState = getWindowStatus(exam);
    const isArchived = exam.status === 'archived';
    const teacherCell = isTeacher ? '' : `<td>${esc(exam.teacher_name)}</td>`;

    return `<tr>
      <td>
        <div class="code-cell">
          <span>${esc(exam.code)}</span>
          <button class="row-btn" style="padding:0.15rem 0.4rem;font-size:0.58rem;" data-copy-code="${esc(exam.code)}" title="Copy code">⎘</button>
          ${exam.status === 'active' ? `<button class="row-btn" style="padding:0.15rem 0.4rem;font-size:0.58rem;" data-share-id="${exam.id}" title="Share with class">⤢</button>` : ''}
        </div>
      </td>
      <td>
        <div style="font-weight:500;color:var(--navy);margin-bottom:0.2rem;">${esc(exam.class_name)}</div>
        <div style="font-size:0.78rem;color:var(--navy-l);">${esc(exam.level_name)} · ${esc(exam.type)}</div>
      </td>
      ${teacherCell}
      <td>
        <span class="chip ${windowState}" style="display:inline-block;margin-bottom:0.3rem;">${windowState === 'live' ? 'Live Now' : windowState}</span>
        <div style="font-size:0.78rem;color:var(--navy-l);">${formatDate(exam.available_from)}</div>
        <div style="font-size:0.78rem;color:var(--navy-l);opacity:0.75;">→ ${formatDate(exam.available_until)}</div>
      </td>
      <td><span class="chip ${exam.status}">${exam.status}</span></td>
      <td><div class="row-actions">
        <a href="submissions.html?id=${exam.id}" class="row-btn">Submissions</a>
        <a href="edit.html?id=${exam.id}" class="row-btn">Edit</a>
        ${isArchived
          ? `<button class="row-btn unarchive" data-status-id="${exam.id}" data-status-value="active">Restore</button>`
          : `<button class="row-btn archive" data-status-id="${exam.id}" data-status-value="archived">Archive</button>`}
      </div></td>
    </tr>`;
  }).join('');

  if (exams.length > ROWS_PER_PAGE) {
    paginationContainer.style.display = 'flex';
    document.getElementById('currentPageNum').textContent = currentPage;
    document.getElementById('totalPageNum').textContent = totalPages;
    document.getElementById('rowsInfo').textContent = `Showing ${start + 1}–${Math.min(end, exams.length)} of ${exams.length}`;
    document.getElementById('prevBtn').disabled = currentPage === 1;
    document.getElementById('nextBtn').disabled = currentPage === totalPages;
  } else {
    paginationContainer.style.display = 'none';
  }
}

examsBody.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('[data-copy-code]');
  if (copyBtn) { navigator.clipboard.writeText(copyBtn.dataset.copyCode).then(() => showToast(`Code ${copyBtn.dataset.copyCode} copied to clipboard`, 'success')); return; }
  const shareBtn = e.target.closest('[data-share-id]');
  if (shareBtn) return openShareModal(shareBtn.dataset.shareId);
  const statusBtn = e.target.closest('[data-status-id]');
  if (statusBtn) return quickStatusChange(statusBtn.dataset.statusId, statusBtn.dataset.statusValue);
});

document.getElementById('prevBtn').addEventListener('click', () => {
  if (currentPage > 1) { currentPage--; renderTable(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
});
document.getElementById('nextBtn').addEventListener('click', () => {
  const exams = getFilteredExams();
  const totalPages = Math.ceil(exams.length / ROWS_PER_PAGE);
  if (currentPage < totalPages) { currentPage++; renderTable(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
});

// ===== SHARE MODAL =====
function buildEntryUrl(code) {
  const url = new URL('enter-code.html', window.location.href);
  url.searchParams.set('code', code);
  return url.toString();
}

function openShareModal(examId) {
  const exam = allExams.find(e => e.id === examId);
  if (!exam) return;
  const entryUrl = buildEntryUrl(exam.code);

  document.getElementById('shareModalTitle').textContent = `${exam.class_name} — ${exam.type}`;
  document.getElementById('shareModalSub').textContent = 'Project this screen so students can scan or type';
  document.getElementById('shareCodeBig').innerHTML = exam.code.split('-').join('<br>-<br>');
  document.getElementById('shareUrl').textContent = entryUrl.replace(/\?.*$/, '');
  document.getElementById('shareWindow').innerHTML = `Open <strong>${formatDate(exam.available_from)}</strong> &nbsp;→&nbsp; <strong>${formatDate(exam.available_until)}</strong>`;

  const qrBox = document.getElementById('shareQrBox');
  qrBox.innerHTML = '';
  if (typeof QRCode !== 'undefined') {
    new QRCode(qrBox, { text: entryUrl, width: 260, height: 260, colorDark: '#0C2340', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
  } else {
    qrBox.innerHTML = '<div style="padding:2rem;color:var(--red);font-family:var(--serif);font-style:italic;">QR code library could not be loaded. Students can still enter the code manually.</div>';
  }
  openModal('shareModal');
}

function closeShareModal() {
  closeModal('shareModal');
  document.getElementById('shareQrBox').innerHTML = '';
}
document.getElementById('shareCloseBtn').addEventListener('click', closeShareModal);
document.getElementById('shareModal').addEventListener('click', (e) => { if (e.target.id === 'shareModal') closeShareModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.getElementById('shareModal').classList.contains('open')) closeShareModal(); });

async function quickStatusChange(id, newStatus) {
  const exam = allExams.find(e => e.id === id);
  if (!exam) return;
  const verb = newStatus === 'archived' ? 'archive' : 'restore';
  if (!confirm(`Are you sure you want to ${verb} "${exam.class_name}" (${exam.code})?`)) return;
  try {
    const { error } = await db.from('exams').update({ status: newStatus }).eq('id', id);
    if (error) throw error;
    exam.status = newStatus;
    updateStats();
    renderTable();
    showToast(`Exam ${verb}d successfully`, 'success');
  } catch (err) {
    showToast(`Failed to ${verb}: ${err.message}`, 'error');
  }
}

// ===== FILTER PERSISTENCE =====
const FILTER_STORAGE_KEY = 'examDashboardFilters';

function saveFilterState() {
  const state = {
    search: searchEl.value, status: filterStatus.value, level: filterLevel.value,
    quarter: filterQuarter.value, year: filterYear.value, teacher: filterTeacher?.value || '',
    sortBy, sortDir,
  };
  try { localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

function restoreFilterState() {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.search != null) searchEl.value = s.search;
    if (s.status != null) filterStatus.value = s.status;
    if (s.level != null) filterLevel.value = s.level;
    if (s.quarter != null) filterQuarter.value = s.quarter;
    if (s.year != null) filterYear.value = s.year;
    if (s.teacher != null && filterTeacher) filterTeacher.value = s.teacher;
    if (s.sortBy) sortBy = s.sortBy;
    if (s.sortDir) sortDir = s.sortDir;
    currentPage = 1;
    document.querySelectorAll('th[data-sort]').forEach(t => {
      if (t.dataset.sort === sortBy) { t.classList.add('sorted'); t.querySelector('.sort-arrow').textContent = sortDir === 'asc' ? '↑' : '↓'; }
      else { t.classList.remove('sorted'); t.querySelector('.sort-arrow').textContent = '↕'; }
    });
  } catch (e) { /* ignore */ }
}

[searchEl, filterStatus, filterLevel, filterQuarter, filterYear, filterTeacher].forEach(el => {
  if (!el) return;
  el.addEventListener('input', () => { currentPage = 1; saveFilterState(); renderTable(); });
  el.addEventListener('change', () => { currentPage = 1; saveFilterState(); renderTable(); });
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
    saveFilterState();
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
    document.getElementById('pageStamp').textContent = 'My Exams';
    document.getElementById('pageTitle').innerHTML = 'My <em>Exams</em>';
    document.getElementById('pageSub').textContent = 'Manage, edit, and archive the exams you have created';
    document.getElementById('teacherFilterField').style.display = 'none';
    document.getElementById('filtersContainer').classList.add('no-teacher');
    document.getElementById('thTeacher').style.display = 'none';
  } else {
    document.getElementById('teacherFilterField').style.display = 'flex';
  }

  await loadAllData();
})();
