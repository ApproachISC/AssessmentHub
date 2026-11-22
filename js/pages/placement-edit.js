// Placement Test editor (placement/edit.html?id=<testId>) — academics only.
//
// The whole test lives in one model M = { title, status, settings, placement_scale, definition }.
// Inputs are bound with data-path="definition.sections.0.groups.1.questions.2.prompt" (path inside M)
// and data-kind (how to read the value). Structural buttons use data-act. Changes autosave.
// Once a student has started the test its questions are locked (enforced by the database);
// the name, settings and placement scale stay editable.

import { db } from '../supabase-client.js';
import { requireAuth, requireRole } from '../auth.js';
import { renderNavbar, showToast, esc } from '../ui.js';
import {
  SECTION_TYPES, QTYPE_LABEL, DEFAULT_SCALE, AUDIO_BUCKET,
  newId, newSection, newGroup, newQuestion, countQuestions, checkScale, validateTest, takeUrl,
} from '../placement-common.js';

const $ = id => document.getElementById(id);
const testId = new URLSearchParams(location.search).get('id');
const DEFAULT_SETTINGS = {
  timed: false, time_limit_minutes: 60, allow_skip: false, shuffle_options: true, show_result: true,
  proctoring: { fullscreen_lock: true, tab_switch_tracking: true, window_blur_tracking: true },
};
const clone = o => JSON.parse(JSON.stringify(o));

let M = null;
let locked = false, hasSubmitted = false, lastCheck = { errors: [], warnings: [] };
const openGroups = new Set();

/* ===================================================================== PATHS */
const getAt = path => path.split('.').reduce((o, k) => (o == null ? o : o[k]), M);
function setAt(path, val) {
  const ks = path.split('.'), last = ks.pop();
  const parent = ks.reduce((o, k) => (o[k] ??= {}), M);
  if (val === undefined) delete parent[last]; else parent[last] = val;
}
function readInput(el) {
  switch (el.dataset.kind) {
    case 'bool': return el.checked;
    case 'int': return el.value === '' ? null : parseInt(el.value, 10);
    case 'answer': return parseInt(el.value, 10);
    case 'noshuffle': return el.checked ? false : undefined;
    case 'lines': return el.value.split('\n').map(s => s.trim()).filter(Boolean);
    case 'paras': return el.value.split(/\n\s*\n/).map(s => s.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
    default: return el.value;
  }
}
function fillInput(el) {
  const v = getAt(el.dataset.path);
  if (el.dataset.kind === 'bool') el.checked = !!v; else el.value = v ?? '';
}

/* ===================================================================== SAVING */
let saveTimer = null, saving = false, saveAgain = false, dirty = false;
function saveState(s) {
  const el = $('saveState');
  el.className = 'pl-save ' + s;
  el.textContent = { saved: 'All changes saved', dirty: 'Unsaved changes…', saving: 'Saving…', failed: 'Not saved — will retry' }[s];
}
function changed({ side = true } = {}) {
  dirty = true; saveState('dirty');
  clearTimeout(saveTimer); saveTimer = setTimeout(save, 1200);
  if (side) scheduleSide();
}
async function save() {
  clearTimeout(saveTimer);
  if (!dirty) return true;
  if (saving) { saveAgain = true; return false; }
  saving = true; saveState('saving');
  const patch = { title: M.title.trim() || 'Untitled test', settings: M.settings, placement_scale: cleanScale() };
  if (!locked) patch.definition = M.definition;
  dirty = false;
  const { error } = await db.from('placement_tests').update(patch).eq('id', testId);
  saving = false;
  if (error) {
    dirty = true; saveState('failed');
    if (/locked/i.test(error.message)) { setLocked(true); showToast(error.message, 'error', 8000); }
    else { showToast(`Could not save: ${error.message}`, 'error', 6000); saveTimer = setTimeout(save, 5000); }
    return false;
  }
  if (saveAgain || dirty) { saveAgain = false; return save(); }
  saveState('saved');
  return true;
}
const cleanScale = () => M.placement_scale.map(r => ({ min: Number(r.min) || 0, max: Number(r.max) || 0, group: String(r.group || '').trim(), level: String(r.level || '').trim() }));

/* ===================================================================== RENDER: CONTENT */
const LOCK_ATTR = () => (locked ? ' disabled' : '');

function tools(path, i, len, what) {
  if (locked) return '';
  return `<span class="pl-tools">
    <button type="button" class="pl-ic" data-act="up" data-path="${path}"${i === 0 ? ' disabled' : ''} title="Move up" aria-label="Move ${what} up">↑</button>
    <button type="button" class="pl-ic" data-act="down" data-path="${path}"${i === len - 1 ? ' disabled' : ''} title="Move down" aria-label="Move ${what} down">↓</button>
    <button type="button" class="pl-ic danger" data-act="del" data-path="${path}" data-what="${what}" title="Delete" aria-label="Delete ${what}">✕</button>
  </span>`;
}

function render() {
  const secs = M.definition.sections;
  $('content').innerHTML = secs.length ? secs.map(secHTML).join('')
    : '<div class="empty-state"><h3>No sections yet</h3><p>Add a section below, or upload a JSON file.</p></div>';
  $('addSection').hidden = locked;
  $('jsonUpLabel').hidden = locked;
  $('content').querySelectorAll('[data-path]').forEach(el => { el.disabled = locked; });
  updateSide();
}

function secHTML(s, si) {
  const P = `definition.sections.${si}`, T = SECTION_TYPES[s.type] || SECTION_TYPES.language_use;
  let n = 0;   // question number inside the section (what students see)
  const groups = (s.groups || []).map((g, gi) => {
    const html = groupHTML(s, T, g, `${P}.groups.${gi}`, gi, s.groups.length, n);
    n += (g.questions || []).length;
    return html;
  }).join('');
  return `<section class="pl-sec">
    <div class="pl-sec-head">
      <span class="pl-num">${si + 1}</span>
      <span class="badge badge--neutral">${T.label}</span>
      <input type="text" class="pl-sec-title" data-path="${P}.title" value="${esc(s.title)}" aria-label="Section title">
      <span class="pl-count">${n} question${n === 1 ? '' : 's'}</span>
      ${tools(P, si, M.definition.sections.length, 'section')}
    </div>
    <div class="field"><label>Instructions for students <span class="field-help">(one per line, shown before the section starts)</span></label>
      <textarea rows="3" data-path="${P}.instructions" data-kind="lines">${esc((s.instructions || []).join('\n'))}</textarea></div>
    ${s.type === 'listening' ? '<div class="field-help pl-note">Students do the standard sound check before this section starts.</div>' : ''}
    ${groups}
    ${!locked && (T.stimulus || !(s.groups || []).length) ? `<button type="button" class="btn btn--secondary btn--sm" data-act="add-group" data-path="${P}">+ Add ${T.group.toLowerCase()}</button>` : ''}
  </section>`;
}

function groupHTML(s, T, g, GP, gi, glen, startN) {
  const qs = (g.questions || []).map((q, qi) => questionHTML(T, q, `${GP}.questions.${qi}`, qi, g.questions.length, startN + qi + 1)).join('');
  const addQ = locked ? '' : `<div class="pl-addq">${T.qtypes.map(t =>
    `<button type="button" class="btn btn--ghost btn--sm" data-act="add-q" data-path="${GP}" data-type="${t}">+ ${QTYPE_LABEL[t]}</button>`).join('')}</div>`;
  if (!g.stimulus) return `<div class="pl-group plain">${qs}${addQ}</div>`;
  const nq = (g.questions || []).length;
  const range = nq ? (nq === 1 ? `Q${startN + 1}` : `Q${startN + 1}–${startN + nq}`) : 'no questions';
  return `<details class="pl-group" data-id="${g.id}"${openGroups.has(g.id) ? ' open' : ''}>
    <summary>
      <span class="pl-gl">${T.group} ${gi + 1}</span>
      <span class="pl-gt">${esc(g.stimulus.title || 'Untitled')}</span>
      <span class="pl-gq">${range}</span>
      ${tools(GP, gi, glen, T.group.toLowerCase())}
    </summary>
    <div class="pl-group-body">${stimulusHTML(g.stimulus, `${GP}.stimulus`)}${qs}${addQ}</div>
  </details>`;
}

function stimulusHTML(st, SP) {
  if (st.kind === 'audio') {
    return `<div class="pl-stim">
      <div class="pl-grid2">
        <div class="field"><label>Recording title <span class="field-help">(students see it)</span></label><input type="text" data-path="${SP}.title" value="${esc(st.title)}"></div>
        <div class="field"><label>Plays allowed</label><input type="number" min="1" max="5" data-path="${SP}.maxPlays" data-kind="int" value="${st.maxPlays ?? 2}"></div>
      </div>
      <div class="pl-audio">
        ${st.src ? `<audio controls preload="none" src="${esc(st.src)}"></audio><span class="field-help">${esc(st.file_name || '')}</span>` : '<span class="pl-missing">No audio file yet</span>'}
        ${locked ? '' : `<label class="btn btn--secondary btn--sm"><input type="file" accept="audio/*" hidden data-upload="${SP}">${st.src ? 'Replace audio' : 'Upload audio'}</label>`}
      </div>
      <div class="field"><label>Transcript <span class="field-help">(staff only — never sent to students; read aloud in preview if there is no file)</span></label>
        <textarea rows="3" data-path="${SP}.transcript" placeholder="Student: Hi, I'd like to borrow these books…&#10;Librarian: No problem…">${esc(st.transcript || '')}</textarea></div>
    </div>`;
  }
  if (st.kind === 'passage') {
    return `<div class="pl-stim">
      <div class="pl-grid2">
        <div class="field"><label>Text title</label><input type="text" data-path="${SP}.title" value="${esc(st.title)}"></div>
        <div class="field"><label>Source <span class="field-help">(optional, e.g. "Magazine article")</span></label><input type="text" data-path="${SP}.source" value="${esc(st.source || '')}"></div>
      </div>
      <div class="field"><label>Text <span class="field-help">(leave an empty line between paragraphs — students see them numbered)</span></label>
        <textarea rows="9" class="pl-serif" data-path="${SP}.paragraphs" data-kind="paras">${esc((st.paragraphs || []).join('\n\n'))}</textarea></div>
    </div>`;
  }
  return `<div class="pl-stim">
    <div class="field"><label>Task title</label><input type="text" data-path="${SP}.title" value="${esc(st.title)}"></div>
    <div class="field"><label>Task instructions <span class="field-help">(empty line between paragraphs)</span></label>
      <textarea rows="4" class="pl-serif" data-path="${SP}.text" data-kind="paras">${esc((st.text || []).join('\n\n'))}</textarea></div>
  </div>`;
}

function questionHTML(T, q, QP, qi, qlen, num) {
  let body = '';
  if (q.type === 'multiple_choice') {
    const opts = q.options || [];
    body = `<div class="pl-opts">${opts.map((o, k) => `<div class="pl-opt">
        <input type="radio" name="ans_${q.id}" data-path="${QP}.answer" data-kind="answer" value="${k}"${q.answer === k ? ' checked' : ''} aria-label="Option ${'ABCDEF'[k]} is correct">
        <span class="pl-k">${'ABCDEF'[k]}</span>
        <input type="text" data-path="${QP}.options.${k}" value="${esc(o)}" placeholder="Option ${'ABCDEF'[k]}">
        ${!locked && opts.length > 2 ? `<button type="button" class="pl-ic" data-act="del-opt" data-path="${QP}" data-i="${k}" aria-label="Remove option ${'ABCDEF'[k]}">✕</button>` : ''}
      </div>`).join('')}</div>
      <div class="pl-qfoot">
        ${!locked && opts.length < 6 ? `<button type="button" class="btn btn--ghost btn--sm" data-act="add-opt" data-path="${QP}">+ Option</button>` : ''}
        <label class="check-row"><input type="checkbox" data-path="${QP}.shuffle" data-kind="noshuffle"${q.shuffle === false ? ' checked' : ''}> Keep this order (don't shuffle)</label>
        <span class="field-help">Select the circle next to the correct answer.</span>
      </div>`;
  } else if (q.type === 'true_false') {
    body = `<div class="pl-tf">${['True', 'False'].map((l, k) => `<label class="check-row"><input type="radio" name="ans_${q.id}" data-path="${QP}.answer" data-kind="answer" value="${k}"${q.answer === k ? ' checked' : ''}> ${l} is correct</label>`).join('')}</div>`;
  } else if (q.type === 'essay') {
    const topics = q.topics || [];
    body = `<div class="field-help" style="margin:0.4rem 0;">Topics the student chooses from (leave empty for no choice):</div>
      <div class="pl-opts">${topics.map((t, k) => `<div class="pl-opt"><span class="pl-k">${k + 1}</span>
        <input type="text" data-path="${QP}.topics.${k}" value="${esc(t)}" placeholder="Topic ${k + 1}">
        ${locked ? '' : `<button type="button" class="pl-ic" data-act="del-topic" data-path="${QP}" data-i="${k}" aria-label="Remove topic ${k + 1}">✕</button>`}</div>`).join('')}</div>
      ${locked ? '' : `<button type="button" class="btn btn--ghost btn--sm" data-act="add-topic" data-path="${QP}">+ Topic</button>`}
      <div class="pl-grid2" style="margin-top:0.6rem;">
        <div class="field"><label>Minimum words <span class="field-help">(guidance)</span></label><input type="number" min="0" data-path="${QP}.min_words" data-kind="int" value="${q.min_words ?? ''}"></div>
        <div class="field"><label>Maximum words <span class="field-help">(guidance)</span></label><input type="number" min="0" data-path="${QP}.max_words" data-kind="int" value="${q.max_words ?? ''}"></div>
      </div>`;
  }
  return `<div class="pl-q">
    <div class="pl-q-head"><span class="q-num">Q${num}</span><span class="badge badge--current">${QTYPE_LABEL[q.type] || q.type}</span>${tools(QP, qi, qlen, 'question')}</div>
    <textarea rows="2" data-path="${QP}.prompt" placeholder="${q.type === 'essay' ? 'Instruction above the writing box' : 'Question'}">${esc(q.prompt || '')}</textarea>
    ${body}
  </div>`;
}

/* ===================================================================== RENDER: SCALE + SIDEBAR */
function renderScale() {
  $('scaleBody').innerHTML = M.placement_scale.map((r, i) => `<tr>
    <td><input type="number" min="0" class="pl-mini" data-path="placement_scale.${i}.min" data-kind="int" value="${r.min ?? ''}" aria-label="From"></td>
    <td><input type="number" min="0" class="pl-mini" data-path="placement_scale.${i}.max" data-kind="int" value="${r.max ?? ''}" aria-label="To"></td>
    <td><input type="text" data-path="placement_scale.${i}.group" value="${esc(r.group || '')}" aria-label="Grouping level"></td>
    <td><input type="text" data-path="placement_scale.${i}.level" value="${esc(r.level || '')}" aria-label="Level"></td>
    <td style="text-align:right;"><button type="button" class="pl-ic danger" data-act="del-scale" data-i="${i}" aria-label="Remove row">✕</button></td>
  </tr>`).join('');
  $('recalcBtn').hidden = !hasSubmitted;
  scheduleSide();
}

let sideTimer;
function scheduleSide() { clearTimeout(sideTimer); sideTimer = setTimeout(updateSide, 250); }
function updateSide() {
  const c = countQuestions(M.definition), top = Math.max(...M.placement_scale.map(r => Number(r.max) || 0), 0);
  $('sumSections').textContent = c.sections;
  $('sumScored').textContent = c.scored;
  $('sumWriting').textContent = c.total - c.scored;
  $('sumScale').textContent = top;
  lastCheck = validateTest(M.definition, M.placement_scale);
  const items = [...lastCheck.errors.map(e => `<li class="fail">${esc(e)}</li>`), ...lastCheck.warnings.map(w => `<li class="warn">${esc(w)}</li>`)];
  $('validation').innerHTML = items.length
    ? items.slice(0, 15).join('') + (items.length > 15 ? `<li class="warn">…and ${items.length - 15} more</li>` : '')
    : '<li class="ok">Ready. No problems found.</li>';
  const sc = checkScale(M.placement_scale, c.scored), msgs = [...sc.errors, ...sc.warnings];
  $('scaleAlert').innerHTML = msgs.length ? `<div>${msgs.map(esc).join('<br>')}</div>` : '';
  $('scaleAlert').classList.toggle('show', !!msgs.length);
  $('scaleAlert').className = `alert ${sc.errors.length ? 'error' : 'warning'}${msgs.length ? ' show' : ''}`;
  $('minutesRow').style.display = M.settings.timed ? '' : 'none';
}

function setLocked(v) {
  locked = v;
  $('lockedAlert').classList.toggle('show', locked);
  render();
}

/* ===================================================================== EVENTS: INPUTS */
function onInput(e) {
  const el = e.target;
  if (!el.dataset || !el.dataset.path) return;
  if (el.disabled) return;
  setAt(el.dataset.path, readInput(el));
  if (el.dataset.path.endsWith('.stimulus.title')) {
    const t = el.closest('details')?.querySelector('.pl-gt');
    if (t) t.textContent = el.value || 'Untitled';
  }
  changed();
}
document.addEventListener('input', onInput);
document.addEventListener('change', e => { if (e.target.type === 'checkbox' || e.target.type === 'radio') onInput(e); });

document.addEventListener('toggle', e => {
  const d = e.target;
  if (d.matches?.('details.pl-group')) { if (d.open) openGroups.add(d.dataset.id); else openGroups.delete(d.dataset.id); }
}, true);

/* ===================================================================== EVENTS: STRUCTURE */
const WHAT = { section: 'this whole section and all its questions', question: 'this question' };
function parentOf(path) { const ks = path.split('.'), i = +ks.pop(); return [getAt(ks.join('.')), i]; }

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  if (b.closest('summary')) e.preventDefault();   // don't toggle the group
  const d = b.dataset;
  if (d.act === 'del-scale') {
    M.placement_scale.splice(+d.i, 1); renderScale(); changed(); return;
  }
  if (locked) return;
  switch (d.act) {
    case 'add-section': M.definition.sections.push(newSection(d.type)); break;
    case 'add-group': {
      const sec = getAt(d.path), g = newGroup(sec.type);
      sec.groups.push(g); openGroups.add(g.id); break;
    }
    case 'add-q': getAt(d.path).questions.push(newQuestion(d.type)); break;
    case 'up': case 'down': {
      const [arr, i] = parentOf(d.path), j = d.act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= arr.length) return;
      [arr[i], arr[j]] = [arr[j], arr[i]]; break;
    }
    case 'del': {
      const what = WHAT[d.what] || `this ${d.what} and its questions`;
      if (!confirm(`Delete ${what}?`)) return;
      const [arr, i] = parentOf(d.path); arr.splice(i, 1); break;
    }
    case 'add-opt': getAt(d.path).options.push(''); break;
    case 'del-opt': {
      const q = getAt(d.path), k = +d.i;
      q.options.splice(k, 1);
      if (q.answer === k) q.answer = null; else if (q.answer > k) q.answer--;
      break;
    }
    case 'add-topic': (getAt(d.path).topics ||= []).push(''); break;
    case 'del-topic': getAt(d.path).topics.splice(+d.i, 1); break;
    default: return;
  }
  render(); changed();
});

// Audio upload → public URL in the placement-audio bucket.
document.addEventListener('change', async e => {
  const input = e.target;
  if (!input.dataset?.upload || !input.files?.[0]) return;
  const f = input.files[0], stim = getAt(input.dataset.upload), label = input.closest('label');
  if (f.size > 50 * 1024 * 1024) { showToast('The file is larger than 50 MB. Please compress it.', 'error', 6000); input.value = ''; return; }
  const ext = (f.name.split('.').pop() || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp3';
  const key = `tests/${testId}/${newId('a_')}.${ext}`;
  label.classList.add('pl-busy'); label.lastChild.textContent = 'Uploading…';
  const { error } = await db.storage.from(AUDIO_BUCKET).upload(key, f, { contentType: f.type || 'audio/mpeg', cacheControl: '31536000' });
  if (error) { showToast(`Upload failed: ${error.message}`, 'error', 6000); render(); return; }
  stim.src = db.storage.from(AUDIO_BUCKET).getPublicUrl(key).data.publicUrl;
  stim.file_name = f.name;
  showToast('Audio uploaded.', 'success');
  render(); changed();
});

/* ===================================================================== EVENTS: HEADER, SCALE, STATUS, JSON */
$('scaleAdd').onclick = () => {
  const last = M.placement_scale[M.placement_scale.length - 1];
  const from = last ? (Number(last.max) || 0) + 1 : 0;
  M.placement_scale.push({ min: from, max: from, group: last?.group || '', level: '' });
  renderScale(); changed();
};
$('scaleReset').onclick = () => {
  if (!confirm('Replace the placement scale with the default (0–70, Pre A1 to C1)?')) return;
  M.placement_scale = clone(DEFAULT_SCALE); renderScale(); changed();
};
$('recalcBtn').onclick = async () => {
  if (!confirm('Apply the current scale to every student who already submitted this test?')) return;
  if (!(await save())) return;
  const { data, error } = await db.rpc('placement_recalculate', { p_test_id: testId });
  if (error) { showToast(error.message, 'error', 6000); return; }
  showToast(`Updated ${data} placement${data === 1 ? '' : 's'}.`, 'success');
};

$('status').addEventListener('change', async () => {
  const want = $('status').value, prev = M.status;
  if (want === 'active') {
    updateSide();
    if (lastCheck.errors.length) {
      $('status').value = prev;
      showToast(`Fix the ${lastCheck.errors.length} error${lastCheck.errors.length === 1 ? '' : 's'} in Validation before activating.`, 'error', 6000);
      $('validation').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  }
  if (!(await save())) { $('status').value = prev; return; }
  const { error } = await db.from('placement_tests').update({ status: want }).eq('id', testId);
  if (error) { $('status').value = prev; showToast(error.message, 'error', 6000); return; }
  M.status = want;
  showToast({ active: 'The test is active. Access codes now work.', draft: 'The test is a draft. Codes do not work.', archived: 'The test is archived.' }[want], 'success');
});

$('previewBtn').addEventListener('click', async e => {
  if (!dirty) return;                 // link opens normally
  e.preventDefault();
  const w = window.open('about:blank', '_blank');
  await save();
  if (w) w.location = $('previewBtn').href;
});

$('dupBtn').onclick = async () => {
  await save();
  const { data, error } = await db.rpc('placement_duplicate_test', { p_test_id: testId, p_title: null });
  if (error) { showToast(error.message, 'error', 6000); return; }
  location.href = `edit.html?id=${data}`;
};

$('jsonDown').onclick = () => {
  const out = { title: M.title, settings: M.settings, placement_scale: cleanScale(), definition: M.definition };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  a.download = `${M.title.replace(/[^\w]+/g, '-').toLowerCase() || 'placement-test'}.json`;
  a.click(); URL.revokeObjectURL(a.href);
};

$('jsonUp').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || locked) return;
  let obj;
  try { obj = JSON.parse(await f.text()); } catch { showToast('This file is not valid JSON.', 'error', 6000); return; }
  const def = obj.definition || (Array.isArray(obj.sections) ? { sections: obj.sections } : null);
  if (!def || !Array.isArray(def.sections)) { showToast('The JSON needs a "sections" list (or a "definition" with one).', 'error', 6000); return; }
  const extra = [obj.settings && 'settings', obj.placement_scale && 'placement scale'].filter(Boolean);
  if (!confirm(`Replace all sections and questions${extra.length ? ` and the ${extra.join(' and ')}` : ''} with the content of "${f.name}"?`)) return;
  def.sections.forEach(s => {
    s.id ||= newId('s_'); s.groups ||= []; s.instructions ||= [];
    s.groups.forEach(g => {
      g.id ||= newId('g_'); g.questions ||= []; g.stimulus ??= null;
      g.questions.forEach(q => { q.id ||= newId('q_'); if (q.answer === undefined && q.a !== undefined) { q.answer = q.a; delete q.a; } });
    });
  });
  M.definition = def;
  if (obj.settings) M.settings = { ...clone(DEFAULT_SETTINGS), ...obj.settings, proctoring: { ...DEFAULT_SETTINGS.proctoring, ...(obj.settings.proctoring || {}) } };
  if (Array.isArray(obj.placement_scale)) M.placement_scale = obj.placement_scale;
  document.querySelectorAll('aside [data-path]').forEach(fillInput);
  render(); renderScale(); changed();
  showToast('JSON loaded. Check the Validation panel.', 'success');
});

window.addEventListener('beforeunload', e => { if (dirty || saving) { save(); e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });

/* ===================================================================== INIT */
(async function init() {
  const auth = await requireAuth();
  if (!auth || !requireRole(auth.profile, ['academic'])) return;
  renderNavbar($('navbarContainer'), { profile: auth.profile, active: 'admin' });
  if (!testId) { location.href = 'dashboard.html'; return; }
  try {
    const { data, error } = await db.from('placement_tests').select('*').eq('id', testId).single();
    if (error) throw error;
    M = {
      title: data.title,
      status: data.status,
      settings: { ...clone(DEFAULT_SETTINGS), ...(data.settings || {}), proctoring: { ...DEFAULT_SETTINGS.proctoring, ...(data.settings?.proctoring || {}) } },
      placement_scale: Array.isArray(data.placement_scale) && data.placement_scale.length ? data.placement_scale : clone(DEFAULT_SCALE),
      definition: Array.isArray(data.definition?.sections) ? data.definition : { sections: [] },
    };
    const [lockRes, subRes] = await Promise.all([
      db.rpc('placement_test_locked', { p_test_id: testId }),
      db.from('placement_submissions').select('id', { count: 'exact', head: true }).eq('test_id', testId).eq('status', 'submitted'),
    ]);
    hasSubmitted = (subRes.count || 0) > 0;
    document.title = `${M.title} — Edit Placement Test`;
    $('status').value = M.status;
    $('previewBtn').href = takeUrl({ preview: testId });
    $('codesBtn').href = `codes.html?test=${testId}`;
    $('resultsBtn').href = `results.html?test=${testId}`;
    document.querySelectorAll('#title, aside [data-path]').forEach(fillInput);
    setLocked(!!lockRes.data);
    renderScale();
    saveState('saved');
  } catch (err) {
    console.error(err);
    $('authLoading').innerHTML = `<h2>Could not load this test</h2><p>${esc(err.message || '')}</p><a class="btn btn--secondary" href="dashboard.html">Back to Placement Tests</a>`;
    return;
  }
  $('authLoading').style.display = 'none';
  $('page').style.display = 'block';
})();
