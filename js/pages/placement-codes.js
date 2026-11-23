// Placement Test access codes (placement/codes.html?test=<id>) — academics only.
// Printed codes are generated on the server (placement_generate_codes) so they are unique.
// Emailed codes are created and sent by the placement-email edge function (Brevo):
// one code per student, assigned to their name + email.
import { db } from '../supabase-client.js';
import { SUPABASE_URL } from '../config.js';
import { requireAuth, requireRole } from '../auth.js';
import { renderNavbar, showToast, esc } from '../ui.js';
import { takeUrl, fmtDate, fmtDateTime } from '../placement-common.js';

const $ = id => document.getElementById(id);
const testId = new URLSearchParams(location.search).get('test');
let test = null, codes = [];
const STATUS = { unused: ['Not used', 'draft'], in_progress: ['Taking now', 'in_progress'], submitted: ['Submitted', 'submitted'] };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_SEND = 300;

async function load() {
  const [cRes, sRes] = await Promise.all([
    db.from('placement_codes')
      .select('code, batch, status, created_at, used_at, student_name, student_email, emailed_at, email_count, email_error')
      .eq('test_id', testId).order('created_at', { ascending: false }).order('code'),
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
    (!q || c.code.toLowerCase().includes(q) ||
      `${c.student?.full_name || ''} ${c.student?.email || ''} ${c.student_name || ''} ${c.student_email || ''}`.toLowerCase().includes(q)));
}

const printable = c => c.status === 'unused' && !c.student_email;

function studentCell(c) {
  const name = c.student?.full_name || c.student_name, email = c.student?.email || c.student_email;
  if (!name && !email) return '—';
  let note = '';
  if (c.student_email) {
    note = c.email_error && !c.emailed_at ? '<div class="pl-sent-note fail">Email failed — use Resend</div>'
      : c.emailed_at ? `<div class="pl-sent-note">Emailed ${fmtDateTime(c.emailed_at)}${c.email_count > 1 ? ` · ${c.email_count}×` : ''}</div>`
      : '<div class="pl-sent-note">Not emailed yet</div>';
  }
  return `${esc(name || '—')}<div class="field-help">${esc(email || '')}</div>${note}`;
}

function renderRows() {
  const list = filtered();
  $('rows').innerHTML = list.length ? list.map(c => {
    const [label, chip] = STATUS[c.status];
    return `<tr><td class="code-cell">${c.code}</td><td>${esc(c.batch || '—')}</td><td>${fmtDate(c.created_at)}</td>
      <td><span class="chip ${chip}">${label}</span></td>
      <td>${studentCell(c)}</td>
      <td><div class="row-actions">
        ${c.student_email && c.status !== 'submitted' ? `<button class="row-btn" data-act="resend" data-code="${c.code}">${c.emailed_at ? 'Resend' : 'Send'}</button>` : ''}
        <button class="row-btn" data-act="copy" data-code="${c.code}">Copy link</button>
        ${c.status === 'unused' ? `<button class="row-btn archive" data-act="delete" data-code="${c.code}">Delete</button>` : ''}
      </div></td></tr>`;
  }).join('') : '<tr><td colspan="6"><div class="empty-state"><p>No codes match.</p></div></td></tr>';
  const unused = list.filter(c => c.status === 'unused').length, toPrint = list.filter(printable).length;
  $('countInfo').textContent = `${list.length} codes shown · ${unused} not used yet`;
  $('printBtn').disabled = !toPrint;
  $('printBtn').textContent = toPrint ? `Print ${toPrint} slip${toPrint === 1 ? '' : 's'}` : 'Print slips';
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
  if (b.dataset.act === 'resend') {
    const c = codes.find(x => x.code === code);
    if (!confirm(`Email code ${code} to ${c.student_name} <${c.student_email}>?`)) return;
    b.disabled = true;
    try {
      const res = await callEmail({ action: 'resend', codes: [code] });
      const r = res.results?.[0];
      if (r?.ok) showToast(`Code sent to ${r.email}.`, 'success');
      else showToast(`Could not send: ${r?.error || 'unknown error'}`, 'error', 8000);
      setQuota(res.left);
      await load();
    } catch (err) { showToast(err.message, 'error', 8000); }
    finally { b.disabled = false; }
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

// ===================================================================== EMAIL
let quotaLeft = null;   // emails left today on the Brevo plan; null = unknown / no daily limit

async function callEmail(payload) {
  const { data: { session } } = await db.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/placement-email`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { if (out.left != null) setQuota(out.left); throw new Error(out.error || `Email request failed (${res.status})`); }
  return out;
}

function setQuota(left) {
  if (left === undefined) return;
  quotaLeft = left;
  const q = $('quota');
  if (left == null) { q.textContent = 'Daily email allowance: unknown'; q.classList.remove('low'); }
  else {
    q.innerHTML = `<b>${left}</b> email${left === 1 ? '' : 's'} left today`;
    q.classList.toggle('low', left < 20);
  }
  renderReviewSummary();
}

async function loadQuota() {
  try { setQuota((await callEmail({ action: 'quota' })).left); }
  catch { setQuota(null); }
}

document.querySelectorAll('.pl-mode').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.pl-mode').forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', x === b); });
  $('modeOne').hidden = b.dataset.mode !== 'one';
  $('modeCsv').hidden = b.dataset.mode !== 'csv';
}));

function showResult(results) {
  const ok = results.filter(r => r.ok), bad = results.filter(r => !r.ok);
  const box = $('sendResult');
  box.hidden = false;
  box.className = 'pl-result' + (bad.length ? ' has-fail' : '');
  box.innerHTML = `<b>${ok.length} email${ok.length === 1 ? '' : 's'} sent.</b>` +
    (bad.length ? ` ${bad.length} failed. Their codes were created — fix the problem and use <b>Resend</b> in the list below.
      <ul>${bad.map(r => `<li>${esc(r.name)} &lt;${esc(r.email)}&gt; (${r.code}): ${esc(r.error || 'unknown error')}</li>`).join('')}</ul>` : '');
}

async function sendStudents(students, batch, btn) {
  if (quotaLeft != null && students.length > quotaLeft) {
    showToast(`Only ${quotaLeft} emails left today. Send fewer, or wait until tomorrow.`, 'error', 8000);
    return false;
  }
  if (test.status !== 'active' && !confirm(`This test is ${test.status}. Students can't start it until it is active. Send anyway?`)) return false;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const res = await callEmail({ action: 'send', test_id: testId, batch: batch || null, students });
    showResult(res.results || []);
    setQuota(res.left);
    await load();
    return true;
  } catch (err) {
    showToast(err.message, 'error', 8000);
    return false;
  } finally { btn.disabled = false; btn.textContent = label; }
}

// ---- one student
$('oneSend').onclick = async () => {
  const name = $('oneName').value.trim().replace(/\s+/g, ' '), email = $('oneEmail').value.trim().toLowerCase();
  if (name.split(' ').length < 2) { showToast('Type the student’s first and last name.', 'error'); $('oneName').focus(); return; }
  if (!EMAIL_RE.test(email)) { showToast('Type a valid email address.', 'error'); $('oneEmail').focus(); return; }
  const dup = codes.find(c => c.student_email === email && c.status !== 'submitted');
  if (dup && !confirm(`${email} already has code ${dup.code} for this test. Create and send a new code anyway?\n\n(To send the same code again, use Resend in the list.)`)) return;
  if (await sendStudents([{ name, email }], null, $('oneSend'))) { $('oneName').value = ''; $('oneEmail').value = ''; }
};
['oneName', 'oneEmail'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') $('oneSend').click(); }));

// ---- CSV import + review
let review = [];   // [{ name, email }]

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(Boolean));
}

function rowsToStudents(rows) {
  if (!rows.length) return [];
  const head = rows[0].map(h => h.toLowerCase());
  const find = re => head.findIndex(h => re.test(h));
  const iEmail = find(/e-?mail/);
  if (iEmail >= 0) {
    const iFirst = find(/first|given/), iLast = find(/last|surname|family/);
    const iName = find(/^(full ?name|name|student|student name)$/) >= 0 ? find(/^(full ?name|name|student|student name)$/) : find(/name/);
    return rows.slice(1).map(r => ({
      name: iFirst >= 0 && iLast >= 0 ? `${r[iFirst] || ''} ${r[iLast] || ''}` : (r[iName] || ''),
      email: r[iEmail] || '',
    }));
  }
  // No header: the cell with an @ is the email, the rest is the name.
  return rows.map(r => {
    const e = r.findIndex(c => c.includes('@'));
    return { name: r.filter((_, i) => i !== e).join(' '), email: e >= 0 ? r[e] : '' };
  });
}

function checkRow(r, i) {
  const name = r.name.trim().replace(/\s+/g, ' '), email = r.email.trim().toLowerCase();
  if (!name) return { err: 'Add the name', field: 'name' };
  if (name.split(' ').length < 2) return { err: 'Add the last name', field: 'name' };
  if (!EMAIL_RE.test(email)) return { err: 'Invalid email', field: 'email' };
  if (review.findIndex(x => x.email.trim().toLowerCase() === email) !== i) return { err: 'Duplicate email in this list', field: 'email' };
  const has = codes.find(c => c.student_email === email && c.status !== 'submitted');
  if (has) return { warn: `Already has code ${has.code} — a new one will be sent` };
  return {};
}

function renderReview() {
  $('review').hidden = !review.length;
  $('reviewRows').innerHTML = review.map((r, i) => `<tr data-i="${i}">
      <td>${i + 1}</td>
      <td><input data-f="name" value="${esc(r.name)}" aria-label="Full name, row ${i + 1}"></td>
      <td><input data-f="email" value="${esc(r.email)}" aria-label="Email, row ${i + 1}"></td>
      <td class="chk"></td>
      <td><button class="row-btn archive" data-del="${i}" type="button">Remove</button></td></tr>`).join('');
  updateChecks();
}

// Updates the check column in place (no re-render, so typing and tabbing keep focus).
function updateChecks() {
  $('reviewRows').querySelectorAll('tr').forEach(tr => {
    const i = +tr.dataset.i, c = checkRow(review[i], i);
    tr.classList.toggle('bad', !!c.err);
    tr.querySelectorAll('input').forEach(inp => inp.classList.toggle('bad', c.field === inp.dataset.f));
    tr.querySelector('.chk').innerHTML = c.err ? `<span class="err">${esc(c.err)}</span>`
      : c.warn ? `<span class="warn">${esc(c.warn)}</span>` : '<span class="ok">Ready</span>';
  });
  renderReviewSummary();
}

function renderReviewSummary() {
  if (!review.length) return;
  const bad = review.filter((r, i) => checkRow(r, i).err).length, ready = review.length - bad;
  const over = quotaLeft != null && ready > quotaLeft;
  $('reviewSummary').innerHTML = `<b>${review.length}</b> student${review.length === 1 ? '' : 's'} · <b>${ready}</b> ready` +
    (bad ? ` · <span class="err" style="color:var(--red);font-weight:700;">${bad} to fix</span>` : '') +
    (over ? ` · <span style="color:var(--red);font-weight:700;">only ${quotaLeft} emails left today</span>` : '') +
    (ready > MAX_SEND ? ` · <span style="color:var(--red);font-weight:700;">max ${MAX_SEND} at a time</span>` : '');
  $('reviewSend').disabled = !ready || bad > 0 || over || ready > MAX_SEND;
  $('reviewSend').textContent = bad ? 'Fix the rows marked in red' : `Send ${ready} email${ready === 1 ? '' : 's'}`;
}

$('reviewRows').addEventListener('input', e => {
  const inp = e.target.closest('input[data-f]');
  if (!inp) return;
  review[+inp.closest('tr').dataset.i][inp.dataset.f] = inp.value;
  updateChecks();
});
$('reviewRows').addEventListener('click', e => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  review.splice(+b.dataset.del, 1);
  renderReview();
});
$('addRow').onclick = () => {
  review.push({ name: '', email: '' });
  renderReview();
  $('reviewRows').querySelector('tr:last-child input')?.focus();
};
$('reviewCancel').onclick = () => {
  if (review.length && !confirm('Clear this list?')) return;
  review = []; $('csvFile').value = ''; renderReview();
};

$('csvFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const list = rowsToStudents(parseCsv(await f.text()));
    if (!list.length) { showToast('No students found in this file.', 'error'); return; }
    review = list;
    if (!$('emailBatch').value.trim()) $('emailBatch').value = f.name.replace(/\.[^.]+$/, '').slice(0, 60);
    $('sendResult').hidden = true;
    renderReview();
  } catch (err) {
    showToast(`Could not read the file: ${err.message}`, 'error', 6000);
  }
});

$('csvTemplate').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿name,email\r\nMaria Silva,maria.silva@example.com\r\n'], { type: 'text/csv' }));
  a.download = 'placement-students-template.csv';
  a.click(); URL.revokeObjectURL(a.href);
};

$('reviewSend').onclick = async () => {
  const students = review.map(r => ({ name: r.name.trim().replace(/\s+/g, ' '), email: r.email.trim().toLowerCase() }));
  if (!confirm(`Create ${students.length} codes and email them now?`)) return;
  if (await sendStudents(students, $('emailBatch').value.trim(), $('reviewSend'))) {
    review = []; $('csvFile').value = ''; renderReview();
  }
};

// ===================================================================== PRINTING
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
  const list = filtered().filter(printable);
  if (!list.length) return;
  buildSheets(list);
  setTimeout(() => window.print(), 300);   // let the QR images render
};
window.addEventListener('afterprint', () => { $('sheets').innerHTML = ''; });

$('csvBtn').onclick = () => {
  const lines = [['code', 'batch', 'created_at', 'status', 'student', 'email', 'emailed_at', 'link']].concat(
    filtered().map(c => [c.code, c.batch, c.created_at, STATUS[c.status][0], c.student?.full_name || c.student_name,
      c.student?.email || c.student_email, c.emailed_at, takeUrl({ code: c.code })]));
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
      $('statusAlert').innerHTML = `<div><b>This test is ${test.status === 'draft' ? 'a draft' : 'archived'}.</b>Codes only work while the test is active. You can still create, print and email them now.</div>`;
      $('statusAlert').classList.add('show');
    }
    await load();
    loadQuota();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not load the test.', 'error', 6000);
  }
  $('authLoading').style.display = 'none';
  $('page').style.display = 'block';
})();
