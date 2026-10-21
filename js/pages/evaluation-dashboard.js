import { db } from '../supabase-client.js';
import { requireAuth } from '../auth.js';
import { renderNavbar, showToast, esc, openModal, closeModal, initTabs } from '../ui.js';
import {
  formatDay, todayISO, passMark, gradeChip, formatGrade, gradeBand,
  loadPeople, personName, downloadCsv,
} from '../evaluation-common.js';

const PAGE_SIZE = 20;

let currentProfile = null, isAcademic = false;
let allEvals = [], allTemplates = [], allClasses = [], allPeople = [];
let sortBy = 'class_date', sortDir = 'desc', currentPage = 1;

// ============================================================
// LOAD
// ============================================================
async function loadData() {
  try {
    const [eRes, tRes, cRes, people] = await Promise.all([
      db.from('evaluations')
        .select('id, template_id, template_snapshot, evaluator_id, evaluatee_id, class_id, class_date, status, grade, points_earned, points_possible, finalized_at, evaluatee_signed_at, created_at')
        .order('class_date', { ascending: false }),
      db.from('evaluation_templates').select('id, name, is_active, definition').order('name'),
      db.from('classes').select('id, name, is_active').order('name'),
      loadPeople(),
    ]);
    if (eRes.error) throw eRes.error;
    if (tRes.error) throw tRes.error;
    allTemplates = tRes.data || [];
    allClasses = cRes.data || [];
    allPeople = people;

    // RLS returns everything to academic staff and only their own evaluations to everyone else
    allEvals = (eRes.data || []).map(e => ({
      ...e,
      _evaluatee_name: personName(allPeople, e.evaluatee_id),
      _evaluator_name: personName(allPeople, e.evaluator_id),
      _class_name: allClasses.find(c => c.id === e.class_id)?.name || '—',
      _template_name: allTemplates.find(t => t.id === e.template_id)?.name || '—',
    }));

    if (isAcademic) {
      const evaluatorIds = [...new Set(allEvals.map(e => e.evaluator_id))];
      document.getElementById('filterEvaluator').innerHTML = '<option value="">All evaluators</option>' +
        evaluatorIds.map(id => ({ id, name: personName(allPeople, id) }))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    }

    document.getElementById('countWritten').textContent = allEvals.length;
    updateStats();
    renderTable();
  } catch (err) {
    document.getElementById('tableBody').innerHTML =
      `<tr><td colspan="7"><div class="empty-state"><h3>Could not load evaluations</h3><p>${esc(err.message)}</p></div></td></tr>`;
    showToast('Failed to load: ' + err.message, 'error');
  }
}

async function loadReceived() {
  const body = document.getElementById('receivedBody');
  const { data, error } = await db.rpc('list_received_evaluations');
  if (error) {
    body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><h3>Could not load</h3><p>${esc(error.message)}</p></div></td></tr>`;
    return;
  }
  const rows = data || [];
  const pending = rows.filter(r => !r.evaluatee_signed_at).length;
  document.getElementById('countReceived').textContent = pending ? `${rows.length} · ${pending} new` : rows.length;
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="icon">⌗</div><h3>No evaluations yet</h3><p>When a teacher finalizes an evaluation about you, it shows up here.</p></div></td></tr>`;
    return;
  }
  body.innerHTML = rows.map(r => `
    <tr>
      <td style="font-weight:600;color:var(--navy);">${formatDay(r.class_date)}</td>
      <td>${esc(r.class_name)}<div style="font-size:0.75rem;color:var(--muted);">${esc(r.template_name)}</div></td>
      <td>${esc(r.evaluator_name)}</td>
      <td>${gradeChip({ pass_mark: r.pass_mark }, r.grade)}</td>
      <td>${r.evaluatee_signed_at
        ? `<span class="chip submitted">Signed</span>`
        : `<span class="chip upcoming">New · needs signature</span>`}</td>
      <td><div class="row-actions"><a class="row-btn" href="received.html?id=${r.id}">Open</a></div></td>
    </tr>`).join('');
}

// ============================================================
// STATS / FILTERS / TABLE
// ============================================================
function updateStats() {
  const draft = allEvals.filter(e => e.status === 'draft').length;
  const final = allEvals.filter(e => e.status === 'finalized');
  const below = final.filter(e => e.grade != null && Number(e.grade) < passMark(e.template_snapshot)).length;
  document.getElementById('statTotal').textContent = allEvals.length;
  document.getElementById('statDraft').textContent = draft;
  document.getElementById('statFinal').textContent = final.length;
  document.getElementById('statBelow').textContent = below;
}

function getFiltered() {
  const search = document.getElementById('filterSearch').value.trim().toLowerCase();
  const status = document.getElementById('filterStatus').value;
  const from = document.getElementById('filterFrom').value;
  const to = document.getElementById('filterTo').value;
  const evaluator = isAcademic ? document.getElementById('filterEvaluator').value : '';
  const r = allEvals.filter(e => {
    if (status && e.status !== status) return false;
    if (from && e.class_date < from) return false;
    if (to && e.class_date > to) return false;
    if (evaluator && e.evaluator_id !== evaluator) return false;
    if (search && !`${e._evaluatee_name} ${e._evaluator_name} ${e._class_name}`.toLowerCase().includes(search)) return false;
    return true;
  });
  r.sort((a, b) => {
    let av = a[sortBy], bv = b[sortBy];
    if (sortBy === 'grade') { av = av == null ? -1 : Number(av); bv = bv == null ? -1 : Number(bv); }
    if (av == null) av = '';
    if (bv == null) bv = '';
    if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    return sortDir === 'asc' ? av - bv : bv - av;
  });
  return r;
}

function renderTable() {
  const filtered = getFiltered();
  const total = filtered.length;
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  if (currentPage > totalPages) currentPage = 1;
  const start = (currentPage - 1) * PAGE_SIZE, end = Math.min(start + PAGE_SIZE, total);
  const page = filtered.slice(start, end);
  const tbody = document.getElementById('tableBody');
  const cols = isAcademic ? 7 : 6;

  if (!page.length) {
    tbody.innerHTML = `<tr><td colspan="${cols}"><div class="empty-state"><div class="icon">⌗</div><h3>No evaluations found</h3><p>${allEvals.length === 0 ? 'Start your first evaluation after observing a class.' : 'Try adjusting your filters.'}</p></div></td></tr>`;
  } else {
    tbody.innerHTML = page.map(e => {
      const isOwn = e.evaluator_id === currentProfile.id;
      const canEdit = isOwn && e.status === 'draft';
      const canDelete = (isOwn && e.status === 'draft') || isAcademic;
      const statusChip = e.status === 'finalized'
        ? `<span class="chip submitted">Finalized</span>${e.evaluatee_signed_at ? '' : '<div class="eval-row-note">Awaiting teacher\'s signature</div>'}`
        : '<span class="chip draft">Draft</span>';
      return `<tr>
        <td style="font-weight:600;color:var(--navy);white-space:nowrap;">${formatDay(e.class_date)}</td>
        <td>${esc(e._evaluatee_name)}<div style="font-size:0.75rem;color:var(--muted);">${esc(e._template_name)}</div></td>
        <td>${esc(e._class_name)}</td>
        ${isAcademic ? `<td>${esc(e._evaluator_name)}</td>` : ''}
        <td>${statusChip}</td>
        <td>${e.status === 'finalized' ? gradeChip(e.template_snapshot, e.grade) : `<span style="color:var(--muted);font-size:0.8rem;">${e.grade != null ? formatGrade(e.grade) + ' so far' : '—'}</span>`}</td>
        <td><div class="row-actions">
          ${canEdit ? `<a href="edit.html?id=${e.id}" class="row-btn">Continue</a>` : `<a href="view.html?id=${e.id}" class="row-btn">View</a>`}
          ${canDelete ? `<button class="row-btn archive" data-delete-id="${e.id}">Delete</button>` : ''}
        </div></td>
      </tr>`;
    }).join('');
  }
  document.getElementById('resultInfo').textContent = total === allEvals.length ? `${total} evaluation${total === 1 ? '' : 's'}` : `${total} of ${allEvals.length} evaluations`;
  document.getElementById('pageInfo').textContent = total === 0 ? 'No results' : `${start + 1}–${end} of ${total}`;
  document.getElementById('prevPage').disabled = currentPage <= 1;
  document.getElementById('nextPage').disabled = currentPage >= totalPages;
  document.getElementById('paginationBar').style.display = totalPages > 1 ? 'flex' : 'none';
}

async function deleteEvaluation(id) {
  const e = allEvals.find(x => x.id === id);
  if (!e) return;
  const msg = e.status === 'finalized'
    ? `Permanently delete this FINALIZED evaluation of ${e._evaluatee_name} (${formatDay(e.class_date)})?\n\nThis cannot be undone.`
    : `Delete this draft evaluation of ${e._evaluatee_name} (${formatDay(e.class_date)})?`;
  if (!confirm(msg)) return;
  try {
    const { data, error } = await db.from('evaluations').delete().eq('id', id).select('id');
    if (error) throw error;
    if (!data?.length) throw new Error('Nothing was deleted — finalized evaluations can only be deleted by academic staff.');
    allEvals = allEvals.filter(x => x.id !== id);
    document.getElementById('countWritten').textContent = allEvals.length;
    updateStats();
    renderTable();
    showToast('Evaluation deleted', 'success');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

// ============================================================
// CSV EXPORT (filtered list; grades go to the school's other system)
// ============================================================
function exportCsv() {
  const rows = getFiltered();
  if (!rows.length) return showToast('Nothing to export with the current filters', 'error');
  const header = ['Class date', 'Teacher evaluated', 'Class', 'Evaluator', 'Form', 'Status', 'Grade (/100)', 'Rating', 'Pass', 'Points earned', 'Points possible', 'Finalized at', 'Teacher signed at'];
  const data = rows.map(e => {
    const finalized = e.status === 'finalized';
    return [
      e.class_date, e._evaluatee_name, e._class_name, e._evaluator_name, e._template_name,
      finalized ? 'Finalized' : 'Draft',
      finalized ? formatGrade(e.grade) : '',
      finalized ? (gradeBand(e.template_snapshot, Number(e.grade)) || '') : '',
      finalized && e.grade != null ? (Number(e.grade) >= passMark(e.template_snapshot) ? 'Yes' : 'No') : '',
      finalized ? e.points_earned : '', finalized ? e.points_possible : '',
      e.finalized_at ? new Date(e.finalized_at).toLocaleString('en-US') : '',
      e.evaluatee_signed_at ? new Date(e.evaluatee_signed_at).toLocaleString('en-US') : '',
    ];
  });
  downloadCsv(`evaluations-${todayISO()}.csv`, [header, ...data]);
}

// ============================================================
// NEW EVALUATION
// ============================================================
function openNewModal() {
  const active = allTemplates.filter(t => t.is_active);
  if (!active.length) return showToast('No evaluation forms are available yet. Ask the Academic team to create one.', 'error');
  document.getElementById('newTemplate').innerHTML = active.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  document.getElementById('newEvaluatee').innerHTML = '<option value="">— select a teacher —</option>' +
    allPeople.filter(p => p.is_active && p.id !== currentProfile.id)
      .map(p => `<option value="${p.id}">${esc(p.full_name)}</option>`).join('');
  document.getElementById('newClass').innerHTML = '<option value="">— class —</option>' +
    allClasses.filter(c => c.is_active).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  document.getElementById('newDate').value = todayISO();
  checkDuplicate();
  openModal('newModal');
}

function checkDuplicate() {
  const evaluatee = document.getElementById('newEvaluatee').value;
  const cls = document.getElementById('newClass').value;
  const date = document.getElementById('newDate').value;
  const dup = evaluatee && cls && date && allEvals.some(e =>
    e.evaluator_id === currentProfile.id && e.evaluatee_id === evaluatee && e.class_id === cls && e.class_date === date);
  document.getElementById('dupWarning').classList.toggle('show', !!dup);
}

async function createEvaluation() {
  const template_id = document.getElementById('newTemplate').value;
  const evaluatee_id = document.getElementById('newEvaluatee').value;
  const class_id = document.getElementById('newClass').value;
  const class_date = document.getElementById('newDate').value;
  if (!template_id || !evaluatee_id || !class_id || !class_date) return showToast('Please fill in all fields', 'error');
  const btn = document.getElementById('newSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const { data, error } = await db.from('evaluations')
      .insert({ template_id, evaluatee_id, class_id, class_date, responses: { details: {}, scores: {}, notes: {}, comments: {} } })
      .select('id').single();
    if (error) throw error;
    window.location.href = `edit.html?id=${data.id}`;
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Create & Start';
  }
}

// ============================================================
// EVENT WIRING
// ============================================================
document.getElementById('prevPage').addEventListener('click', () => { if (currentPage > 1) { currentPage--; renderTable(); } });
document.getElementById('nextPage').addEventListener('click', () => {
  if (currentPage < Math.ceil(getFiltered().length / PAGE_SIZE)) { currentPage++; renderTable(); }
});

['filterSearch', 'filterStatus', 'filterFrom', 'filterTo', 'filterEvaluator'].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener('input', () => { currentPage = 1; renderTable(); });
  el.addEventListener('change', () => { currentPage = 1; renderTable(); });
});

document.querySelectorAll('#panel-written th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (sortBy === col) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else { sortBy = col; sortDir = 'asc'; }
    document.querySelectorAll('#panel-written th[data-sort]').forEach(t => {
      t.classList.remove('sorted');
      t.querySelector('.sort-arrow').textContent = '↕';
    });
    th.classList.add('sorted');
    th.querySelector('.sort-arrow').textContent = sortDir === 'asc' ? '↑' : '↓';
    renderTable();
  });
});

document.getElementById('tableBody').addEventListener('click', (e) => {
  const delBtn = e.target.closest('[data-delete-id]');
  if (delBtn) deleteEvaluation(delBtn.dataset.deleteId);
});

document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);
document.getElementById('newEvalBtn').addEventListener('click', openNewModal);
document.getElementById('newCancelBtn').addEventListener('click', () => closeModal('newModal'));
document.getElementById('newModal').addEventListener('click', e => { if (e.target.id === 'newModal') closeModal('newModal'); });
document.getElementById('newSubmitBtn').addEventListener('click', createEvaluation);
['newEvaluatee', 'newClass', 'newDate'].forEach(id => document.getElementById(id).addEventListener('change', checkDuplicate));

// ============================================================
// INIT
// ============================================================
(async () => {
  const auth = await requireAuth();
  if (!auth) return;
  currentProfile = auth.profile;
  isAcademic = currentProfile.role === 'academic';

  renderNavbar(document.getElementById('navbarContainer'), { profile: currentProfile, active: 'evaluations' });
  initTabs(document.getElementById('tabs'));

  if (isAcademic) {
    document.getElementById('pageTitle').innerHTML = 'All <em>Evaluations</em>';
    document.getElementById('pageSub').textContent = 'Every evaluation across the institution';
    document.getElementById('tabWritten').firstChild.textContent = 'All evaluations ';
    document.getElementById('filterEvaluatorField').style.display = '';
    document.querySelectorAll('.academic-only').forEach(el => { el.style.display = ''; });
  }

  document.getElementById('authLoading').style.display = 'none';
  document.getElementById('page').style.display = 'block';

  await Promise.all([loadData(), loadReceived()]);

  if (new URLSearchParams(location.search).get('tab') === 'received') {
    document.querySelector('[data-panel="panel-received"]').click();
  }
})();
