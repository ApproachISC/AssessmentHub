import { db } from '../supabase-client.js';
import { requireAuth } from '../auth.js';
import { renderNavbar, showToast, esc, openModal, closeModal } from '../ui.js';
import { renderDefinitionResults } from '../question-engine.js';

const QUARTER_CODES = { WINTER: 'WT', SPRING: 'SP', SUMMER: 'SM', FALL: 'FA' };
const TYPE_CODES = { 'MIDTERM': 'MT', 'FINAL EXAM': 'FE' };
const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

let currentProfile = null;
let items = []; // normalized list across both tables
let previewItem = null;

function generateRandomSuffix() {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALPHANUM[Math.floor(Math.random() * ALPHANUM.length)];
  return s;
}

async function loadLibrary() {
  const [assessRes, examRes, classesRes, levelsRes, teachersRes] = await Promise.all([
    db.from('assessments').select('*').eq('shared', true).order('created_at', { ascending: false }),
    db.from('exams').select('*').eq('shared', true).order('created_at', { ascending: false }),
    db.from('classes').select('id, name'),
    db.from('levels').select('id, name'),
    db.from('profiles').select('id, full_name, email'),
  ]);
  if (assessRes.error) throw assessRes.error;
  if (examRes.error) throw examRes.error;

  const classes = classesRes.data || [];
  const levels = levelsRes.data || [];
  const teachers = teachersRes.data || [];
  const className = id => classes.find(c => c.id === id)?.name || '—';
  const levelName = id => levels.find(l => l.id === id)?.name || '—';
  const teacherName = id => { const t = teachers.find(t => t.id === id); return t?.full_name || t?.email || '—'; };

  const assessments = (assessRes.data || []).map(a => ({
    kind: 'assessment', id: a.id, code: a.code, title: a.title || a.code,
    class_name: className(a.class_id), level_name: levelName(a.level_id), teacher_name: teacherName(a.teacher_id),
    quarter: a.quarter, year: a.year, definition: a.assessment_definition, raw: a,
  }));
  const exams = (examRes.data || []).map(e => ({
    kind: 'exam', id: e.id, code: e.code, title: e.type,
    class_name: className(e.class_id), level_name: levelName(e.level_id), teacher_name: teacherName(e.teacher_id),
    quarter: e.quarter, year: e.year, definition: e.exam_definition, raw: e,
  }));

  items = [...assessments, ...exams].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

function getFiltered() {
  const search = document.getElementById('search').value.toLowerCase().trim();
  const type = document.getElementById('filterType').value;
  return items.filter(it => {
    if (type && it.kind !== type) return false;
    if (search && !`${it.title} ${it.code} ${it.class_name} ${it.teacher_name}`.toLowerCase().includes(search)) return false;
    return true;
  });
}

function renderGrid() {
  const grid = document.getElementById('libraryGrid');
  const filtered = getFiltered();
  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state"><div class="icon">⌗</div><h3>Nothing shared yet</h3><p>${items.length === 0 ? 'When a teacher marks an assessment or exam as shared, it will appear here.' : 'Try adjusting your search or filter.'}</p></div>`;
    return;
  }
  grid.innerHTML = filtered.map(it => `
    <div class="library-card">
      <div class="library-card-top">
        <div class="library-card-title">${esc(it.title)}</div>
        <span class="badge ${it.kind === 'assessment' ? 'badge--assessment' : 'badge--exam'}">${it.kind === 'assessment' ? 'Assessment' : 'Exam'}</span>
      </div>
      <div class="library-card-meta">
        <span>${esc(it.class_name)} · ${esc(it.level_name)}</span>
        <span>${esc(it.quarter)} ${it.year}</span>
        <span>Shared by ${esc(it.teacher_name)}</span>
      </div>
      <div class="library-card-actions">
        <button class="btn btn--secondary btn--sm" data-preview-id="${it.id}" data-preview-kind="${it.kind}">Preview</button>
        <button class="btn btn--primary btn--sm" data-copy-id="${it.id}" data-copy-kind="${it.kind}">Copy to My Account</button>
      </div>
    </div>`).join('');
}

function openPreview(id, kind) {
  const item = items.find(it => it.id === id && it.kind === kind);
  if (!item) return;
  previewItem = item;
  document.getElementById('previewStamp').textContent = item.kind === 'assessment' ? 'Assessment Preview' : 'Exam Preview';
  document.getElementById('previewTitle').innerHTML = `<em>${esc(item.title)}</em>`;
  document.getElementById('previewSub').textContent = `${item.class_name} · ${item.level_name} · ${item.quarter} ${item.year} · Shared by ${item.teacher_name}`;
  const body = document.getElementById('previewBody');
  if (!item.definition || !item.definition.sections) {
    body.innerHTML = '<p style="color:var(--muted);font-style:italic;">No content yet.</p>';
  } else {
    renderDefinitionResults(body, item.definition, {}, {});
  }
  openModal('previewModal');
}

document.getElementById('libraryGrid').addEventListener('click', (e) => {
  const previewBtn = e.target.closest('[data-preview-id]');
  if (previewBtn) return openPreview(previewBtn.dataset.previewId, previewBtn.dataset.previewKind);
  const copyBtn = e.target.closest('[data-copy-id]');
  if (copyBtn) return copyToMyAccount(copyBtn.dataset.copyId, copyBtn.dataset.copyKind);
});

document.getElementById('previewCloseBtn').addEventListener('click', () => closeModal('previewModal'));
document.getElementById('previewModal').addEventListener('click', (e) => { if (e.target.id === 'previewModal') closeModal('previewModal'); });
document.getElementById('previewCopyBtn').addEventListener('click', () => {
  if (previewItem) copyToMyAccount(previewItem.id, previewItem.kind);
});

async function copyToMyAccount(id, kind) {
  const item = items.find(it => it.id === id && it.kind === kind);
  if (!item) return;
  if (!confirm(`Copy "${item.title}" to your account? You'll get an independent draft copy you can edit freely.`)) return;

  try {
    const year = item.year, quarter = item.quarter;
    let newCode = null;
    if (kind === 'assessment') {
      for (let i = 0; i < 5; i++) {
        const candidate = `${year}${QUARTER_CODES[quarter]}-AS${generateRandomSuffix()}`;
        const { data } = await db.from('assessments').select('code').eq('code', candidate).maybeSingle();
        if (!data) { newCode = candidate; break; }
      }
      if (!newCode) throw new Error('Could not generate a unique code. Try again.');
      const src = item.raw;
      const { error } = await db.from('assessments').insert({
        code: newCode, title: src.title ? `${src.title} (copy)` : null,
        class_id: src.class_id, level_id: src.level_id, teacher_id: currentProfile.id,
        year, quarter, type: 'ASSESSMENT', results_visibility: src.results_visibility,
        available_from: src.available_from, available_until: src.available_until,
        status: 'draft', notes: src.notes, created_by: currentProfile.id,
        assessment_definition: src.assessment_definition, shared: false,
        proctoring_settings: src.proctoring_settings,
      });
      if (error) throw error;
    } else {
      const typeCode = TYPE_CODES[item.raw.type] || 'MT';
      for (let i = 0; i < 5; i++) {
        const candidate = `${year}${QUARTER_CODES[quarter]}-${typeCode}${generateRandomSuffix()}`;
        const { data } = await db.from('exams').select('code').eq('code', candidate).maybeSingle();
        if (!data) { newCode = candidate; break; }
      }
      if (!newCode) throw new Error('Could not generate a unique code. Try again.');
      const src = item.raw;
      const { error } = await db.from('exams').insert({
        code: newCode, class_id: src.class_id, level_id: src.level_id, teacher_id: currentProfile.id,
        year, quarter, type: src.type, available_from: src.available_from, available_until: src.available_until,
        status: 'draft', notes: src.notes, created_by: currentProfile.id,
        exam_definition: src.exam_definition, shared: false, proctoring_settings: src.proctoring_settings,
      });
      if (error) throw error;
    }

    closeModal('previewModal');
    showToast(`Copied as ${newCode} — find it in your ${kind === 'assessment' ? 'Assessments' : 'Exams'} dashboard as a draft.`, 'success');
  } catch (err) {
    showToast('Copy failed: ' + err.message, 'error');
  }
}

['search', 'filterType'].forEach(id => {
  document.getElementById(id).addEventListener('input', renderGrid);
  document.getElementById(id).addEventListener('change', renderGrid);
});

// ===== INIT =====
(async () => {
  const auth = await requireAuth();
  if (!auth) return;
  currentProfile = auth.profile;
  renderNavbar(document.getElementById('navbarContainer'), { profile: currentProfile });

  try {
    await loadLibrary();
    renderGrid();
  } catch (err) {
    document.getElementById('libraryGrid').innerHTML = `<p style="color:var(--red);">Could not load shared library: ${esc(err.message)}</p>`;
  }
  document.getElementById('authLoading').style.display = 'none';
  document.getElementById('page').style.display = 'block';
})();
