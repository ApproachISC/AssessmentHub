import { db } from '../supabase-client.js';
import { requireAuth } from '../auth.js';
import { renderNavbar, showToast, esc, openModal, closeModal } from '../ui.js';

const QUARTER_CODES = { WINTER: 'WT', SPRING: 'SP', SUMMER: 'SM', FALL: 'FA' };
const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PAGE_SIZE = 20;

let currentProfile = null, allAssessments = [], allClasses = [], allLevels = [], allTeachers = [];
let sortBy = 'available_from', sortDir = 'desc', currentPage = 1, copyingFrom = null;

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function formatDateForInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function generateRandomSuffix() {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALPHANUM[Math.floor(Math.random() * ALPHANUM.length)];
  return s;
}

async function loadData() {
  try {
    const [aRes, cRes, lRes, tRes] = await Promise.all([
      db.from('assessments').select('*').order('created_at', { ascending: false }),
      db.from('classes').select('*').order('name'),
      db.from('levels').select('*').order('display_order'),
      db.from('profiles').select('id,full_name,email,role,is_active').order('full_name'),
    ]);
    if (aRes.error) throw aRes.error;
    allClasses = cRes.data || [];
    allLevels = lRes.data || [];
    allTeachers = (tRes.data || []).filter(t => t.is_active);
    let raw = aRes.data || [];
    if (currentProfile.role === 'teacher') raw = raw.filter(a => a.teacher_id === currentProfile.id);
    allAssessments = raw.map(a => {
      const cls = allClasses.find(c => c.id === a.class_id);
      return { ...a, _class_name: cls?.name || '—' };
    });
    const years = [...new Set(allAssessments.map(a => a.year))].sort((a, b) => b - a);
    document.getElementById('filterYear').innerHTML = '<option value="">All years</option>' +
      years.map(y => `<option value="${y}">${y}</option>`).join('');
    if (currentProfile.role === 'academic') {
      document.getElementById('filterTeacher').innerHTML = '<option value="">All teachers</option>' +
        allTeachers.map(t => `<option value="${t.id}">${esc(t.full_name || t.email)}</option>`).join('');
    }
    updateStats();
    renderTable();
    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('page').style.display = 'block';
  } catch (err) {
    showToast('Failed to load: ' + err.message, 'error');
    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('page').style.display = 'block';
  }
}

function updateStats() {
  let active = 0, draft = 0, archived = 0;
  allAssessments.forEach(a => {
    if (a.status === 'active') active++;
    else if (a.status === 'draft') draft++;
    else archived++;
  });
  document.getElementById('statTotal').textContent = allAssessments.length;
  document.getElementById('statActive').textContent = active;
  document.getElementById('statDraft').textContent = draft;
  document.getElementById('statArchived').textContent = archived;
}

function getFiltered() {
  const search = document.getElementById('filterSearch').value.toLowerCase();
  const status = document.getElementById('filterStatus').value;
  const quarter = document.getElementById('filterQuarter').value;
  const year = document.getElementById('filterYear').value;
  const teacher = currentProfile.role === 'academic' ? document.getElementById('filterTeacher').value : '';
  let r = allAssessments.filter(a => {
    if (status && a.status !== status) return false;
    if (quarter && a.quarter !== quarter) return false;
    if (year && String(a.year) !== year) return false;
    if (teacher && a.teacher_id !== teacher) return false;
    if (search && !`${a.title || ''} ${a.code} ${a._class_name}`.toLowerCase().includes(search)) return false;
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

function getWindowStatus(a) {
  const now = new Date(), from = new Date(a.available_from), until = new Date(a.available_until);
  if (a.status === 'draft') return 'draft';
  if (a.status === 'archived') return 'archived';
  if (now < from) return 'upcoming';
  if (now > until) return 'closed';
  return 'live';
}

function renderTable() {
  const filtered = getFiltered();
  const total = filtered.length;
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  if (currentPage > totalPages) currentPage = 1;
  const start = (currentPage - 1) * PAGE_SIZE, end = Math.min(start + PAGE_SIZE, total);
  const page = filtered.slice(start, end);
  const tbody = document.getElementById('tableBody');

  if (!page.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="icon">⌗</div><h3>No assessments found</h3><p>${allAssessments.length === 0 ? 'Create your first assessment to get started.' : 'Try adjusting your filters.'}</p>${allAssessments.length === 0 ? '<a href="create.html" class="btn btn--primary">+ New Assessment</a>' : ''}</div></td></tr>`;
  } else {
    tbody.innerHTML = page.map(a => {
      const ws = getWindowStatus(a);
      const visLabel = { score_only: 'Score', full_breakdown: 'Full', none: 'Hidden' }[a.results_visibility] || '—';
      return `<tr>
        <td>
          <div style="font-weight:600;color:var(--navy);margin-bottom:0.3rem;">${esc(a.title || '—')}</div>
          <div style="display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap;">
            <span style="font-family:var(--mono);font-size:0.78rem;font-weight:700;letter-spacing:0.04em;color:var(--navy-l);">${esc(a.code)}</span>
            <button class="row-btn" style="padding:0.15rem 0.4rem;font-size:0.58rem;" data-copy-code="${esc(a.code)}" title="Copy code">⎘</button>
            ${ws === 'live' ? `<button class="row-btn" style="padding:0.15rem 0.4rem;font-size:0.58rem;" data-share-id="${a.id}" title="Share with class">⤢</button>` : ''}
          </div>
        </td>
        <td>
          <div style="font-weight:500;color:var(--navy);margin-bottom:0.2rem;">${esc(a._class_name)}</div>
          <div style="font-size:0.78rem;color:var(--navy-l);">${esc(a.quarter)} · ${a.year}</div>
        </td>
        <td>
          <span class="chip ${ws}">${ws}</span>
          <div style="font-size:0.7rem;color:var(--navy-l);margin-top:0.3rem;">Results: ${visLabel}</div>
        </td>
        <td style="font-size:0.8rem;color:var(--navy-l);">${formatDate(a.available_from)}<br><span style="opacity:0.7;">→ ${formatDate(a.available_until)}</span></td>
        <td><div class="row-actions">
          <a href="submissions.html?id=${a.id}" class="row-btn">Submissions</a>
          <a href="edit.html?id=${a.id}" class="row-btn">Edit</a>
          <button class="row-btn" data-copy-id="${a.id}">Copy</button>
          ${a.status === 'archived'
            ? `<button class="row-btn unarchive" data-status-id="${a.id}" data-status-value="active">Restore</button>`
            : `<button class="row-btn archive" data-status-id="${a.id}" data-status-value="archived">Archive</button>`}
        </div></td>
      </tr>`;
    }).join('');
  }
  document.getElementById('pageInfo').textContent = total === 0 ? 'No results' : `${start + 1}–${end} of ${total}`;
  document.getElementById('prevPage').disabled = currentPage <= 1;
  document.getElementById('nextPage').disabled = currentPage >= totalPages;
  document.getElementById('paginationBar').style.display = totalPages > 1 ? 'flex' : 'none';
}

async function quickStatus(id, newStatus) {
  const a = allAssessments.find(x => x.id === id);
  if (!a) return;
  if (!confirm(`${newStatus === 'archived' ? 'Archive' : 'Restore'} this assessment?`)) return;
  try {
    const { error } = await db.from('assessments').update({ status: newStatus }).eq('id', id);
    if (error) throw error;
    a.status = newStatus;
    updateStats();
    renderTable();
    showToast('Done', 'success');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => showToast(`Code ${text} copied`, 'success'));
}

function openCopyModal(id) {
  const a = allAssessments.find(x => x.id === id);
  if (!a) return;
  copyingFrom = a;
  document.getElementById('copyModalSub').textContent = `Copying: ${a.title || a.code} (${a._class_name})`;
  document.getElementById('copyClassId').innerHTML = '<option value="">— class —</option>' +
    allClasses.filter(c => c.is_active || c.id === a.class_id).map(c => `<option value="${c.id}" ${c.id === a.class_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  document.getElementById('copyLevelId').innerHTML = '<option value="">— level —</option>' +
    allLevels.filter(l => l.is_active || l.id === a.level_id).map(l => `<option value="${l.id}" ${l.id === a.level_id ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  if (currentProfile.role === 'academic') {
    document.getElementById('copyTeacherField').style.display = 'block';
    document.getElementById('copyTeacherId').innerHTML = '<option value="">— teacher —</option>' +
      allTeachers.map(t => `<option value="${t.id}" ${t.id === a.teacher_id ? 'selected' : ''}>${esc(t.full_name || t.email)}</option>`).join('');
  } else {
    document.getElementById('copyTeacherField').style.display = 'none';
  }
  document.getElementById('copyTitle').value = (a.title || '') + '';
  document.getElementById('copyYear').value = a.year;
  document.getElementById('copyQuarter').value = a.quarter;
  document.getElementById('copyFrom').value = formatDateForInput(a.available_from);
  document.getElementById('copyUntil').value = formatDateForInput(a.available_until);
  document.getElementById('copyVisibility').value = a.results_visibility || 'score_only';
  openModal('copyModal');
}

function closeCopyModal() {
  closeModal('copyModal');
  copyingFrom = null;
}

function buildEntryUrl(code) {
  const url = new URL('enter-code.html', window.location.href);
  url.searchParams.set('code', code);
  return url.toString();
}

function openShareModal(id) {
  const a = allAssessments.find(x => x.id === id);
  if (!a) return;
  const url = buildEntryUrl(a.code);
  document.getElementById('shareModalTitle').textContent = a.title || `${a._class_name} — Assessment`;
  document.getElementById('shareCodeBig').innerHTML = a.code.split('-').join('<br>-<br>');
  document.getElementById('shareUrl').textContent = url.replace(/\?.*$/, '');
  document.getElementById('shareWindow').innerHTML = `Open <strong>${formatDate(a.available_from)}</strong> &nbsp;→&nbsp; <strong>${formatDate(a.available_until)}</strong>`;
  const qrBox = document.getElementById('shareQrBox');
  qrBox.innerHTML = '';
  if (typeof QRCode !== 'undefined') {
    new QRCode(qrBox, { text: url, width: 260, height: 260, colorDark: '#0C2340', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
  }
  openModal('shareModal');
}

function closeShareModal() {
  closeModal('shareModal');
  document.getElementById('shareQrBox').innerHTML = '';
}

// ============================================================
// EVENT WIRING
// ============================================================
document.getElementById('prevPage').addEventListener('click', () => { if (currentPage > 1) { currentPage--; renderTable(); } });
document.getElementById('nextPage').addEventListener('click', () => {
  const f = getFiltered();
  if (currentPage < Math.ceil(f.length / PAGE_SIZE)) { currentPage++; renderTable(); }
});

['filterSearch', 'filterStatus', 'filterQuarter', 'filterYear', 'filterTeacher'].forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('input', () => { currentPage = 1; renderTable(); });
    el.addEventListener('change', () => { currentPage = 1; renderTable(); });
  }
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

document.getElementById('tableBody').addEventListener('click', (e) => {
  const copyCodeBtn = e.target.closest('[data-copy-code]');
  if (copyCodeBtn) return copyToClipboard(copyCodeBtn.dataset.copyCode);
  const shareBtn = e.target.closest('[data-share-id]');
  if (shareBtn) return openShareModal(shareBtn.dataset.shareId);
  const copyBtn = e.target.closest('[data-copy-id]');
  if (copyBtn) return openCopyModal(copyBtn.dataset.copyId);
  const statusBtn = e.target.closest('[data-status-id]');
  if (statusBtn) return quickStatus(statusBtn.dataset.statusId, statusBtn.dataset.statusValue);
});

document.getElementById('copyCancelBtn').addEventListener('click', closeCopyModal);
document.getElementById('copyModal').addEventListener('click', e => { if (e.target.id === 'copyModal') closeCopyModal(); });

document.getElementById('copySubmitBtn').addEventListener('click', async () => {
  if (!copyingFrom) return;
  const btn = document.getElementById('copySubmitBtn');
  const from = new Date(document.getElementById('copyFrom').value);
  const until = new Date(document.getElementById('copyUntil').value);
  if (until <= from) { showToast('"Until" must be after "From"', 'error'); return; }
  btn.disabled = true;
  btn.textContent = 'Creating…';
  const year = parseInt(document.getElementById('copyYear').value, 10);
  const quarter = document.getElementById('copyQuarter').value;
  let newCode = null;
  for (let i = 0; i < 5; i++) {
    const candidate = `${year}${QUARTER_CODES[quarter]}-AS${generateRandomSuffix()}`;
    const { data } = await db.from('assessments').select('code').eq('code', candidate).maybeSingle();
    if (!data) { newCode = candidate; break; }
  }
  if (!newCode) {
    showToast('Could not generate code. Try again.', 'error');
    btn.disabled = false;
    btn.textContent = 'Create Copy';
    return;
  }
  let teacherId = copyingFrom.teacher_id;
  if (currentProfile.role === 'academic') teacherId = document.getElementById('copyTeacherId').value || teacherId;
  if (currentProfile.role === 'teacher') teacherId = currentProfile.id;
  try {
    const { error } = await db.from('assessments').insert({
      code: newCode,
      title: document.getElementById('copyTitle').value.trim() || null,
      class_id: document.getElementById('copyClassId').value,
      level_id: document.getElementById('copyLevelId').value,
      teacher_id: teacherId,
      year, quarter,
      type: 'ASSESSMENT',
      results_visibility: document.getElementById('copyVisibility').value,
      available_from: from.toISOString(),
      available_until: until.toISOString(),
      status: 'draft',
      notes: copyingFrom.notes || null,
      created_by: currentProfile.id,
      assessment_definition: copyingFrom.assessment_definition || null,
    });
    if (error) throw error;
    closeCopyModal();
    showToast(`Copy created: ${newCode}`, 'success');
    await loadData();
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Copy';
  }
});

document.getElementById('shareCloseBtn').addEventListener('click', closeShareModal);
document.getElementById('shareModal').addEventListener('click', e => { if (e.target.id === 'shareModal') closeShareModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('shareModal').classList.contains('open')) closeShareModal();
});

// ============================================================
// INIT
// ============================================================
(async () => {
  const auth = await requireAuth();
  if (!auth) return;
  currentProfile = auth.profile;

  renderNavbar(document.getElementById('navbarContainer'), { profile: currentProfile, active: 'assessments' });

  if (currentProfile.role === 'academic') {
    document.getElementById('pageTitle').innerHTML = 'All <em>Assessments</em>';
    document.getElementById('filterTeacherField').style.display = 'inherit';
  }

  await loadData();
})();
