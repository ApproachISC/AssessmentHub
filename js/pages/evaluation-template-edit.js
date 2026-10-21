import { db } from '../supabase-client.js';
import { requireAuth, requireRole } from '../auth.js';
import { renderNavbar, showToast, esc } from '../ui.js';

const DEFAULT_DEFINITION = {
  pass_mark: 70,
  allow_not_observed: true,
  scale: [
    { value: 4, label: 'Exceeds', description: 'Does it consistently and without prompting' },
    { value: 3, label: 'Meets', description: 'Does it well most of the time' },
    { value: 2, label: 'Developing', description: 'Does it sometimes or needs reminders' },
    { value: 1, label: 'Needs improvement', description: 'Rarely does it, or does it poorly' },
    { value: 0, label: 'Not demonstrated', description: 'Expected but not seen' },
  ],
  grade_bands: [
    { min: 90, label: 'Excellent' }, { min: 80, label: 'Good' },
    { min: 70, label: 'Satisfactory' }, { min: 0, label: 'Needs improvement' },
  ],
  detail_fields: [],
  sections: [{ id: 'A', title: '', items: [{ id: 'A1', text: '' }] }],
  comment_fields: [{ id: 'strengths', label: 'Strengths observed' }, { id: 'improve', label: 'Areas to improve' }],
};

let tpl = null;     // existing row, or null when creating
let def = null;     // working copy of the definition

function showError(title, message) {
  document.getElementById('authLoading').style.display = 'none';
  document.getElementById('errorTitle').textContent = title;
  document.getElementById('errorMessage').textContent = message;
  document.getElementById('errorScreen').style.display = 'block';
}

// Ids only need to be unique within one definition; existing ids are kept on edit
function newId(prefix, taken) {
  let id;
  do { id = prefix + Math.random().toString(36).slice(2, 6).toUpperCase(); } while (taken.has(id));
  return id;
}
function allIds() {
  return new Set([
    ...def.sections.map(s => s.id),
    ...def.sections.flatMap(s => s.items.map(i => i.id)),
    ...def.detail_fields.map(f => f.id),
    ...def.comment_fields.map(f => f.id),
  ]);
}

function moveBtns(kind, idx, len, extra = '') {
  return `<div class="eval-builder-btns">
    <button type="button" class="row-btn" data-move="${kind}" data-idx="${idx}" data-dir="-1" ${extra} ${idx === 0 ? 'disabled' : ''} title="Move up">↑</button>
    <button type="button" class="row-btn" data-move="${kind}" data-idx="${idx}" data-dir="1" ${extra} ${idx === len - 1 ? 'disabled' : ''} title="Move down">↓</button>
    <button type="button" class="row-btn archive" data-remove="${kind}" data-idx="${idx}" ${extra} title="Remove">✕</button>
  </div>`;
}

// ============================================================
// RENDER
// ============================================================
function render() {
  document.getElementById('scaleList').innerHTML = def.scale.map((s, i) => `
    <div class="eval-builder-row">
      <input type="number" class="eval-builder-num" min="0" max="100" value="${esc(s.value)}" data-path="scale.${i}.value" aria-label="Points">
      <input type="text" value="${esc(s.label)}" data-path="scale.${i}.label" placeholder="Label" aria-label="Label" style="flex:0 0 180px;">
      <input type="text" value="${esc(s.description || '')}" data-path="scale.${i}.description" placeholder="What it looks like" aria-label="Description">
      ${moveBtns('scale', i, def.scale.length)}
    </div>`).join('');

  document.getElementById('bandList').innerHTML = def.grade_bands.map((b, i) => `
    <div class="eval-builder-row">
      <span class="eval-builder-prefix">From</span>
      <input type="number" class="eval-builder-num" min="0" max="100" value="${esc(b.min)}" data-path="grade_bands.${i}.min" aria-label="Minimum grade">
      <input type="text" value="${esc(b.label)}" data-path="grade_bands.${i}.label" placeholder="Label" aria-label="Label">
      ${moveBtns('band', i, def.grade_bands.length)}
    </div>`).join('');

  document.getElementById('detailList').innerHTML = def.detail_fields.length ? def.detail_fields.map((f, i) => `
    <div class="eval-builder-row">
      <input type="text" value="${esc(f.label)}" data-path="detail_fields.${i}.label" placeholder="Field label, e.g. Number of students" aria-label="Field label">
      <select data-path="detail_fields.${i}.type" style="flex:0 0 120px;" aria-label="Type">
        <option value="text" ${f.type !== 'number' ? 'selected' : ''}>Text</option>
        <option value="number" ${f.type === 'number' ? 'selected' : ''}>Number</option>
      </select>
      ${moveBtns('detail', i, def.detail_fields.length)}
    </div>`).join('') : '<p class="field-help">No extra fields.</p>';

  document.getElementById('sectionList').innerHTML = def.sections.map((s, si) => `
    <section class="panel eval-builder-section">
      <div class="eval-builder-row">
        <span class="section-label" style="flex:none;">Section ${si + 1}</span>
        <input type="text" value="${esc(s.title)}" data-path="sections.${si}.title" placeholder="Section title, e.g. Preparation and planning" aria-label="Section title" style="font-weight:700;">
        ${moveBtns('section', si, def.sections.length)}
      </div>
      <div class="eval-builder-items">
        ${s.items.map((it, ii) => `
          <div class="eval-builder-row">
            <span class="q-id">${ii + 1}</span>
            <input type="text" value="${esc(it.text)}" data-path="sections.${si}.items.${ii}.text" placeholder="Criterion, e.g. Arrives early with the room and materials ready" aria-label="Criterion">
            ${moveBtns('item', ii, s.items.length, `data-section="${si}"`)}
          </div>`).join('')}
      </div>
      <button type="button" class="row-btn" data-add="item" data-section="${si}" style="margin-top:0.5rem;">+ Item</button>
    </section>`).join('');

  document.getElementById('commentList').innerHTML = def.comment_fields.length ? def.comment_fields.map((f, i) => `
    <div class="eval-builder-row">
      <input type="text" value="${esc(f.label)}" data-path="comment_fields.${i}.label" placeholder="Box label, e.g. Goals for the next observation" aria-label="Comment box label">
      ${moveBtns('comment', i, def.comment_fields.length)}
    </div>`).join('') : '<p class="field-help">No comment boxes.</p>';

  updatePoints();
}

function maxScale() {
  const vals = def.scale.map(s => Number(s.value)).filter(v => !Number.isNaN(v));
  return vals.length ? Math.max(...vals) : 0;
}

function updatePoints() {
  const items = def.sections.reduce((n, s) => n + s.items.length, 0);
  const max = maxScale();
  const total = items * max;
  document.getElementById('totalPoints').textContent = total;
  document.getElementById('pointsHelp').innerHTML =
    `${items} item${items === 1 ? '' : 's'} × ${max} points. ` +
    (total === 100 ? 'Raw points equal the grade out of 100.' : 'The grade is always converted to a score out of 100.');
}

// ============================================================
// STATE UPDATES
// ============================================================
function setPath(path, value) {
  const parts = path.split('.');
  let obj = def;
  for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
  const key = parts[parts.length - 1];
  obj[key] = (key === 'value' || key === 'min') ? (value === '' ? '' : Number(value)) : value;
}

function listFor(kind, sectionIdx) {
  return {
    scale: def.scale, band: def.grade_bands, detail: def.detail_fields,
    section: def.sections, comment: def.comment_fields,
    item: def.sections[sectionIdx]?.items,
  }[kind];
}

function addEntry(kind, sectionIdx) {
  const taken = allIds();
  if (kind === 'scale') def.scale.push({ value: '', label: '', description: '' });
  if (kind === 'band') def.grade_bands.push({ min: '', label: '' });
  if (kind === 'detail') def.detail_fields.push({ id: newId('F', taken), label: '', type: 'text' });
  if (kind === 'comment') def.comment_fields.push({ id: newId('C', taken), label: '' });
  if (kind === 'section') def.sections.push({ id: newId('S', taken), title: '', items: [{ id: newId('I', taken), text: '' }] });
  if (kind === 'item') def.sections[sectionIdx].items.push({ id: newId('I', taken), text: '' });
  render();
}

// ============================================================
// SAVE
// ============================================================
function validate() {
  const name = document.getElementById('tplName').value.trim();
  if (!name) return 'Form name is required';
  if (def.scale.length < 2) return 'The rating scale needs at least 2 levels';
  if (def.scale.some(s => s.value === '' || Number.isNaN(Number(s.value)) || !String(s.label).trim())) return 'Every scale level needs points and a label';
  if (new Set(def.scale.map(s => Number(s.value))).size !== def.scale.length) return 'Scale levels must have different point values';
  if (maxScale() <= 0) return 'The highest scale level must be worth more than 0 points';
  if (def.grade_bands.some(b => b.min === '' || !String(b.label).trim())) return 'Every grade band needs a minimum and a label';
  if (def.detail_fields.some(f => !f.label.trim())) return 'Every detail field needs a label';
  if (!def.sections.length) return 'Add at least one section';
  if (def.sections.some(s => !s.title.trim())) return 'Every section needs a title';
  if (def.sections.some(s => !s.items.length)) return 'Every section needs at least one item';
  if (def.sections.some(s => s.items.some(i => !i.text.trim()))) return 'Every item needs text (remove empty ones)';
  if (def.comment_fields.some(f => !f.label.trim())) return 'Every comment box needs a label';
  const pass = Number(document.getElementById('tplPassMark').value);
  if (Number.isNaN(pass) || pass < 0 || pass > 100) return 'Pass mark must be between 0 and 100';
  return null;
}

function buildDefinition() {
  return {
    max_points_per_item: maxScale(),
    pass_mark: Number(document.getElementById('tplPassMark').value),
    allow_not_observed: document.getElementById('tplAllowNO').checked,
    scale: [...def.scale].map(s => ({ value: Number(s.value), label: s.label.trim(), description: (s.description || '').trim() }))
      .sort((a, b) => b.value - a.value),
    grade_bands: [...def.grade_bands].map(b => ({ min: Number(b.min), label: b.label.trim() }))
      .sort((a, b) => b.min - a.min),
    detail_fields: def.detail_fields.map(f => ({ id: f.id, label: f.label.trim(), type: f.type === 'number' ? 'number' : 'text' })),
    sections: def.sections.map(s => ({ id: s.id, title: s.title.trim(), items: s.items.map(i => ({ id: i.id, text: i.text.trim() })) })),
    comment_fields: def.comment_fields.map(f => ({ id: f.id, label: f.label.trim() })),
  };
}

async function save() {
  const problem = validate();
  if (problem) return showToast(problem, 'error', 5000);
  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const row = {
    name: document.getElementById('tplName').value.trim(),
    description: document.getElementById('tplDescription').value.trim() || null,
    definition: buildDefinition(),
  };
  try {
    if (tpl) {
      const { data, error } = await db.from('evaluation_templates').update(row).eq('id', tpl.id).select().single();
      if (error) throw error;
      tpl = data;
      showToast(`Saved (version ${tpl.version})`, 'success');
      document.getElementById('tplVersion').textContent = tpl.version;
      def = structuredClone(tpl.definition);
      render();
    } else {
      const { data, error } = await db.from('evaluation_templates').insert(row).select('id').single();
      if (error) throw error;
      showToast('Form created', 'success');
      window.location.replace(`template-edit.html?id=${data.id}`);
    }
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save form';
  }
}

async function toggleActive() {
  const next = !tpl.is_active;
  if (!confirm(next ? 'Activate this form? Teachers will be able to start new evaluations with it.' : 'Deactivate this form? Teachers can no longer start new evaluations with it. Existing evaluations are not affected.')) return;
  const { error } = await db.from('evaluation_templates').update({ is_active: next }).eq('id', tpl.id);
  if (error) return showToast('Failed: ' + error.message, 'error');
  tpl.is_active = next;
  renderStatus();
  showToast(next ? 'Form activated' : 'Form deactivated', 'success');
}

function renderStatus() {
  document.getElementById('tplStatus').innerHTML = tpl
    ? `<span class="chip ${tpl.is_active ? 'active' : 'archived'}">${tpl.is_active ? 'Active' : 'Inactive'}</span>`
    : 'Not saved yet';
  const t = document.getElementById('toggleActiveBtn');
  t.style.display = tpl ? '' : 'none';
  if (tpl) t.textContent = tpl.is_active ? 'Deactivate' : 'Activate';
}

// ============================================================
// EVENT WIRING
// ============================================================
function wireEvents() {
  const content = document.getElementById('content');
  content.addEventListener('input', e => {
    const p = e.target.dataset.path;
    if (!p) return;
    setPath(p, e.target.value);
    if (p.startsWith('scale.')) updatePoints();
  });
  content.addEventListener('change', e => {
    const p = e.target.dataset.path;
    if (p && e.target.tagName === 'SELECT') setPath(p, e.target.value);
  });
  content.addEventListener('click', e => {
    const add = e.target.closest('[data-add]');
    if (add) return addEntry(add.dataset.add, Number(add.dataset.section));
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const list = listFor(mv.dataset.move, Number(mv.dataset.section));
      const i = Number(mv.dataset.idx), j = i + Number(mv.dataset.dir);
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      return render();
    }
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const kind = rm.dataset.remove;
      const list = listFor(kind, Number(rm.dataset.section));
      const i = Number(rm.dataset.idx);
      if (kind === 'section' && !confirm('Remove this section and all its items?')) return;
      list.splice(i, 1);
      return render();
    }
  });
  document.getElementById('saveBtn').addEventListener('click', save);
  document.getElementById('toggleActiveBtn').addEventListener('click', toggleActive);
}

// ============================================================
// INIT
// ============================================================
(async () => {
  const auth = await requireAuth();
  if (!auth) return;
  if (!requireRole(auth.profile, ['academic'])) return;
  renderNavbar(document.getElementById('navbarContainer'), { profile: auth.profile, active: 'admin' });

  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  const copyFrom = params.get('copy');
  try {
    if (id || copyFrom) {
      const { data, error } = await db.from('evaluation_templates').select('*').eq('id', id || copyFrom).maybeSingle();
      if (error) throw error;
      if (!data) return showError('Form not found', 'It may have been deleted.');
      def = structuredClone(data.definition);
      if (id) {
        tpl = data;
        const { count } = await db.from('evaluations').select('id', { count: 'exact', head: true }).eq('template_id', id);
        if (count) {
          document.getElementById('inUseText').textContent =
            ` ${count} evaluation${count === 1 ? ' was' : 's were'} created with it. Changes only apply to evaluations started after you save.`;
          document.getElementById('inUseNotice').classList.add('show');
        }
        document.getElementById('pageTitle').innerHTML = `Edit <em>evaluation form</em>`;
        document.getElementById('bcTitle').textContent = data.name;
        document.getElementById('tplVersion').textContent = data.version;
      } else {
        document.getElementById('bcTitle').textContent = 'Copy';
      }
      document.getElementById('tplName').value = id ? data.name : `${data.name} (copy)`;
      document.getElementById('tplDescription').value = data.description || '';
    } else {
      def = structuredClone(DEFAULT_DEFINITION);
    }
    def.detail_fields ||= [];
    def.comment_fields ||= [];
    def.grade_bands ||= [];
    def.scale ||= [];
    def.sections ||= [];
    document.getElementById('tplPassMark').value = def.pass_mark ?? 70;
    document.getElementById('tplAllowNO').checked = def.allow_not_observed !== false;

    render();
    renderStatus();
    wireEvents();
    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('content').style.display = 'block';
  } catch (err) {
    showError('Could not load form', err.message);
  }
})();
