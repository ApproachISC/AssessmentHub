// Placement Test dashboard (placement/dashboard.html) — academics only.
import { db } from '../supabase-client.js';
import { requireAuth, requireRole } from '../auth.js';
import { renderNavbar, showToast, esc, openModal, closeModal } from '../ui.js';
import { countQuestions, newDefinition, takeUrl, fmtDate, AUDIO_BUCKET, SOUND_CHECK_PATH, SOUND_CHECK_URL } from '../placement-common.js';

const $ = id => document.getElementById(id);
let profile = null, tests = [], codeStats = {};

async function load() {
  const [tRes, cRes] = await Promise.all([
    db.from('placement_tests').select('id, title, status, definition, updated_at, source_test_id').order('updated_at', { ascending: false }),
    db.from('placement_codes').select('test_id, status'),
  ]);
  if (tRes.error) throw tRes.error;
  if (cRes.error) throw cRes.error;
  tests = tRes.data || [];
  codeStats = {};
  (cRes.data || []).forEach(c => {
    const s = codeStats[c.test_id] ||= { unused: 0, in_progress: 0, submitted: 0 };
    s[c.status]++;
  });
  render();
}

function render() {
  const all = Object.values(codeStats);
  $('statTests').textContent = tests.length;
  $('statActive').textContent = tests.filter(t => t.status === 'active').length;
  $('statProgress').textContent = all.reduce((n, s) => n + s.in_progress, 0);
  $('statSubmitted').textContent = all.reduce((n, s) => n + s.submitted, 0);

  if (!tests.length) {
    $('testsBody').innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="icon">⌗</div><h3>No placement tests yet</h3><p>Create your first test to get started.</p></div></td></tr>';
    return;
  }
  const byId = Object.fromEntries(tests.map(t => [t.id, t]));
  $('testsBody').innerHTML = tests.map(t => {
    const n = countQuestions(t.definition), c = codeStats[t.id] || { unused: 0, in_progress: 0, submitted: 0 };
    const attempts = c.in_progress + c.submitted;
    const src = t.source_test_id && byId[t.source_test_id];
    const statusBtn = t.status === 'archived'
      ? `<button class="row-btn unarchive" data-act="restore" data-id="${t.id}">Restore</button>`
      : `<button class="row-btn archive" data-act="archive" data-id="${t.id}">Archive</button>`;
    return `<tr>
      <td><a class="pl-title-link" href="edit.html?id=${t.id}">${esc(t.title)}</a>
        ${src ? `<div class="field-help">Copy of ${esc(src.title)}</div>` : ''}
        ${attempts ? '<div class="field-help">🔒 Questions locked (taken by students)</div>' : ''}</td>
      <td><span class="chip ${t.status === 'active' ? 'active' : t.status}">${t.status}</span></td>
      <td>${n.scored} scored${n.total > n.scored ? ` + ${n.total - n.scored} writing` : ''}<div class="field-help">${n.sections} sections</div></td>
      <td>${c.unused} unused · ${c.in_progress} taking · ${c.submitted} submitted</td>
      <td>${fmtDate(t.updated_at)}</td>
      <td><div class="row-actions">
        <a class="row-btn" href="edit.html?id=${t.id}">Edit</a>
        <a class="row-btn" href="${takeUrl({ preview: t.id })}" target="_blank" rel="noopener">Preview ↗</a>
        <a class="row-btn" href="codes.html?test=${t.id}">Codes</a>
        <a class="row-btn" href="results.html?test=${t.id}">Results${attempts ? ` (${attempts})` : ''}</a>
        <button class="row-btn" data-act="duplicate" data-id="${t.id}">Duplicate</button>
        ${statusBtn}
        ${!attempts && t.status === 'draft' ? `<button class="row-btn archive" data-act="delete" data-id="${t.id}">Delete</button>` : ''}
      </div></td></tr>`;
  }).join('');
}

$('testsBody').addEventListener('click', async e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const t = tests.find(x => x.id === b.dataset.id);
  if (!t) return;
  b.disabled = true;
  try {
    if (b.dataset.act === 'duplicate') {
      const { data, error } = await db.rpc('placement_duplicate_test', { p_test_id: t.id, p_title: null });
      if (error) throw error;
      showToast('Copy created as a draft.', 'success');
      location.href = `edit.html?id=${data}`;
      return;
    }
    if (b.dataset.act === 'archive') {
      if (!confirm(`Archive "${t.title}"? Students who already started can finish, but new codes will not work.`)) return;
      await setStatus(t, 'archived');
    }
    if (b.dataset.act === 'restore') await setStatus(t, 'draft');
    if (b.dataset.act === 'delete') {
      if (!confirm(`Delete "${t.title}" and its unused codes? This cannot be undone.`)) return;
      const { error } = await db.from('placement_tests').delete().eq('id', t.id);
      if (error) throw error;
      showToast('Test deleted.', 'success');
    }
    await load();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Something went wrong.', 'error', 6000);
  } finally { b.disabled = false; }
});

async function setStatus(t, status) {
  const { error } = await db.from('placement_tests').update({ status }).eq('id', t.id);
  if (error) throw error;
  showToast(status === 'archived' ? 'Test archived.' : 'Test restored as a draft.', 'success');
}

// ---- new test
$('newBtn').onclick = () => { openModal('newModal'); $('newTitle').select(); };
$('newCancel').onclick = () => closeModal('newModal');
$('newForm').addEventListener('submit', async e => {
  e.preventDefault();
  const title = $('newTitle').value.trim();
  if (!title) return;
  const { data, error } = await db.from('placement_tests')
    .insert({ title, definition: newDefinition(), created_by: profile.id }).select('id').single();
  if (error) { showToast(error.message, 'error', 6000); return; }
  location.href = `edit.html?id=${data.id}`;
});

// ---- sound check audio (one file for every test)
async function checkSoundFile() {
  try {
    const r = await fetch(`${SOUND_CHECK_URL}?t=${Date.now()}`, { method: 'HEAD' });
    if (r.ok) { $('scAudio').src = `${SOUND_CHECK_URL}?t=${Date.now()}`; $('scStatus').textContent = 'Uploaded. Students hear this file.'; }
    else $('scStatus').textContent = 'Not uploaded yet. Until then, the browser reads the sound check message aloud.';
  } catch { $('scStatus').textContent = 'Could not check the file.'; }
}
$('scFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  $('scStatus').textContent = 'Uploading…';
  const { error } = await db.storage.from(AUDIO_BUCKET).upload(SOUND_CHECK_PATH, f, { upsert: true, contentType: f.type || 'audio/mpeg', cacheControl: '60' });
  e.target.value = '';
  if (error) { $('scStatus').textContent = 'Upload failed.'; showToast(error.message, 'error', 6000); return; }
  showToast('Sound check audio updated.', 'success');
  checkSoundFile();
});

(async function init() {
  const auth = await requireAuth();
  if (!auth || !requireRole(auth.profile, ['academic'])) return;
  profile = auth.profile;
  renderNavbar($('navbarContainer'), { profile, active: 'admin' });
  try { await load(); } catch (err) {
    console.error(err);
    $('testsBody').innerHTML = `<tr><td colspan="6"><div class="empty-state"><h3>Could not load placement tests</h3><p>${esc(err.message || '')}</p><p>Have migrations 017 and 018 been run?</p></div></td></tr>`;
  }
  $('authLoading').style.display = 'none';
  $('page').style.display = 'block';
  checkSoundFile();
})();
