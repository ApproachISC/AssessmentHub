// Placement Test access codes (placement/codes.html?test=<id>) — academics only.
// Codes are generated on the server (placement_generate_codes) so they are unique.
import { db } from '../supabase-client.js';
import { requireAuth, requireRole } from '../auth.js';
import { renderNavbar, showToast, esc } from '../ui.js';
import { takeUrl, fmtDate } from '../placement-common.js';

const $ = id => document.getElementById(id);
const testId = new URLSearchParams(location.search).get('test');
let test = null, codes = [];
const STATUS = { unused: ['Not used', 'draft'], in_progress: ['Taking now', 'in_progress'], submitted: ['Submitted', 'submitted'] };

async function load() {
  const [cRes, sRes] = await Promise.all([
    db.from('placement_codes').select('code, batch, status, created_at, used_at').eq('test_id', testId).order('created_at', { ascending: false }).order('code'),
    db.from('placement_submissions').select('code, full_name, email').eq('test_id', testId),
  ]);
  if (cRes.error) throw cRes.error;
  if (sRes.error) throw sRes.error;
  const who = Object.fromEntries((sRes.data || []).map(s => [s.code, s]));
  codes = (cRes.data || []).map(c => ({ ...c, student: who[c.code] || null }));
  const batches = [...new Set(codes.map(c => c.batch).filter(Boolean))];
  const cur = $('fBatch').value;
  $('fBatch').innerHTML = '<option value="">All batches</option>' + batches.map(b => `<option${b === cur ? ' selected' : ''}>${esc(b)}</option>`).join('');
  renderRows();
}

function filtered() {
  const q = $('search').value.trim().toLowerCase(), b = $('fBatch').value, st = $('fStatus').value;
  return codes.filter(c => (!b || c.batch === b) && (!st || c.status === st) &&
    (!q || c.code.toLowerCase().includes(q) || (c.student && `${c.student.full_name} ${c.student.email}`.toLowerCase().includes(q))));
}

function renderRows() {
  const list = filtered();
  $('rows').innerHTML = list.length ? list.map(c => {
    const [label, chip] = STATUS[c.status];
    return `<tr><td class="code-cell">${c.code}</td><td>${esc(c.batch || '—')}</td><td>${fmtDate(c.created_at)}</td>
      <td><span class="chip ${chip}">${label}</span></td>
      <td>${c.student ? `${esc(c.student.full_name)}<div class="field-help">${esc(c.student.email)}</div>` : '—'}</td>
      <td><div class="row-actions">
        <button class="row-btn" data-act="copy" data-code="${c.code}">Copy link</button>
        ${c.status === 'unused' ? `<button class="row-btn archive" data-act="delete" data-code="${c.code}">Delete</button>` : ''}
      </div></td></tr>`;
  }).join('') : '<tr><td colspan="6"><div class="empty-state"><p>No codes match.</p></div></td></tr>';
  const unused = list.filter(c => c.status === 'unused').length;
  $('countInfo').textContent = `${list.length} codes shown · ${unused} not used yet`;
  $('printBtn').disabled = !unused;
  $('printBtn').textContent = unused ? `Print ${unused} slip${unused === 1 ? '' : 's'}` : 'Print slips';
}

['search', 'fBatch', 'fStatus'].forEach(id => $(id).addEventListener('input', renderRows));

$('rows').addEventListener('click', async e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const code = b.dataset.code;
  if (b.dataset.act === 'copy') {
    try { await navigator.clipboard.writeText(takeUrl({ code })); showToast('Link copied.', 'success'); }
    catch { prompt('Copy this link:', takeUrl({ code })); }
  }
  if (b.dataset.act === 'delete') {
    if (!confirm(`Delete code ${code}? It will stop working.`)) return;
    const { error } = await db.from('placement_codes').delete().eq('code', code);
    if (error) { showToast(error.message, 'error', 6000); return; }
    showToast('Code deleted.', 'success');
    await load();
  }
});

$('gen').onclick = async () => {
  const n = Math.max(1, Math.min(500, Math.floor(+$('qty').value) || 0));
  $('qty').value = n;
  const batch = $('batch').value.trim();
  $('gen').disabled = true;
  try {
    const { data, error } = await db.rpc('placement_generate_codes', { p_test_id: testId, p_count: n, p_batch: batch || null });
    if (error) throw error;
    showToast(`${data.length} codes created.`, 'success');
    if (batch) { await load(); $('fBatch').value = batch; $('fStatus').value = 'unused'; renderRows(); }
    else await load();
  } catch (err) {
    showToast(err.message || 'Could not create codes.', 'error', 6000);
  } finally { $('gen').disabled = false; }
};

// ---- printing
function buildSheets(list) {
  const rows = +$('layout').value, per = rows * 2;
  const sheets = $('sheets');
  sheets.innerHTML = '';
  for (let p = 0; p < list.length; p += per) {
    const sheet = document.createElement('div');
    sheet.className = 'pl-sheet';
    sheet.style.setProperty('--rows', rows);
    list.slice(p, p + per).forEach(c => {
      const url = takeUrl({ code: c.code }), slip = document.createElement('div');
      slip.className = 'pl-slip' + (rows === 5 ? ' r5' : '');
      slip.innerHTML =
        '<div class="top"><img src="../images/black-logo.png" alt="Approach"><span>PLACEMENT TEST</span></div>' +
        '<div class="qr"></div>' +
        `<div class="body"><div class="tn">${esc(test.title)}</div>` +
          `<div class="cl">YOUR ACCESS CODE</div><div class="cd">${c.code}</div>` +
          `<ol><li>Scan the QR code${rows === 4 ? ` or open:<br><span class="url">${esc(url)}</span>` : '.'}</li>` +
          '<li>Type your full name and email.</li><li>Keep this paper. You need it to continue later.</li></ol></div>';
      new window.QRCode(slip.querySelector('.qr'), { text: url, width: 256, height: 256, colorDark: '#0C2340', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
      sheet.appendChild(slip);
    });
    sheets.appendChild(sheet);
  }
}
$('printBtn').onclick = () => {
  const list = filtered().filter(c => c.status === 'unused');
  if (!list.length) return;
  buildSheets(list);
  setTimeout(() => window.print(), 300);   // let the QR images render
};
window.addEventListener('afterprint', () => { $('sheets').innerHTML = ''; });

$('csvBtn').onclick = () => {
  const lines = [['code', 'batch', 'created_at', 'status', 'student', 'email', 'link']].concat(
    filtered().map(c => [c.code, c.batch, c.created_at, STATUS[c.status][0], c.student?.full_name, c.student?.email, takeUrl({ code: c.code })]));
  const csv = lines.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = `placement-codes-${test.title.replace(/[^\w]+/g, '-').toLowerCase()}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
};

(async function init() {
  const auth = await requireAuth();
  if (!auth || !requireRole(auth.profile, ['academic'])) return;
  renderNavbar($('navbarContainer'), { profile: auth.profile, active: 'admin' });
  if (!testId) { location.href = 'dashboard.html'; return; }
  try {
    const { data, error } = await db.from('placement_tests').select('id, title, status').eq('id', testId).single();
    if (error) throw error;
    test = data;
    $('testTitle').innerHTML = `${esc(test.title)} <em>codes</em>`;
    $('editLink').href = `edit.html?id=${test.id}`;
    $('resultsLink').href = `results.html?test=${test.id}`;
    if (test.status !== 'active') {
      $('statusAlert').innerHTML = `<div><b>This test is ${test.status === 'draft' ? 'a draft' : 'archived'}.</b>Codes only work while the test is active. You can still create and print them now.</div>`;
      $('statusAlert').classList.add('show');
    }
    await load();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not load the test.', 'error', 6000);
  }
  $('authLoading').style.display = 'none';
  $('page').style.display = 'block';
})();
