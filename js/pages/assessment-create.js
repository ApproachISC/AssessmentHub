import { db } from '../supabase-client.js';
import { requireAuth } from '../auth.js';
import { renderNavbar, showToast, esc } from '../ui.js';

const QUARTER_CODES = { WINTER: 'WT', SPRING: 'SP', SUMMER: 'SM', FALL: 'FA' };
const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

let currentProfile = null;
let currentCode = null;
let codeIsAvailable = false;

const classIdEl = document.getElementById('classId');
const levelIdEl = document.getElementById('levelId');
const teacherIdEl = document.getElementById('teacherId');
const teacherHelpEl = document.getElementById('teacherHelp');
const yearEl = document.getElementById('year');
const quarterEl = document.getElementById('quarter');
const codeDisplay = document.getElementById('codeDisplay');
const codeStatus = document.getElementById('codeStatus');
const regenerateBtn = document.getElementById('regenerateBtn');
const submitBtn = document.getElementById('submitBtn');
const form = document.getElementById('assessmentForm');
const resultsVisEl = document.getElementById('resultsVisibility');

function generateRandomSuffix() {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALPHANUM[Math.floor(Math.random() * ALPHANUM.length)];
  return s;
}

// Format: YYYYQQ-ASXXXX (AS is always fixed for assessments)
function buildCode(year, quarter, suffix) {
  return `${year}${QUARTER_CODES[quarter]}-AS${suffix}`;
}

function setStatus(state, message) {
  codeStatus.style.display = 'flex';
  codeStatus.className = 'code-status ' + state;
  codeStatus.textContent = message;
}

function clearCode() {
  currentCode = null;
  codeIsAvailable = false;
  codeDisplay.textContent = 'Fill in Year & Quarter';
  codeDisplay.className = 'code-display placeholder';
  codeStatus.style.display = 'none';
  regenerateBtn.disabled = true;
  updateSubmitState();
}

// ===== RESULTS VISIBILITY PREVIEW =====
const visibilityLabels = {
  score_only: 'Students will see their total score after submitting.',
  full_breakdown: 'Students will see their score and a full per-question breakdown after submitting.',
  none: 'Students will see a confirmation message only. Results are not shown.',
};
function updateVisibilityPreview() {
  document.getElementById('visibilityPreview').textContent = visibilityLabels[resultsVisEl.value] || '';
}
resultsVisEl.addEventListener('change', updateVisibilityPreview);
updateVisibilityPreview();

// ===== LOAD LOOKUP DATA =====
async function loadLookupData() {
  try {
    const [classesRes, levelsRes, teachersRes] = await Promise.all([
      db.from('classes').select('*').eq('is_active', true).order('name'),
      db.from('levels').select('*').eq('is_active', true).order('display_order'),
      db.from('profiles').select('id, full_name, email, role, is_active').eq('is_active', true).order('full_name'),
    ]);
    if (classesRes.error) throw classesRes.error;
    if (levelsRes.error) throw levelsRes.error;

    classIdEl.innerHTML = '<option value="">— select class —</option>' +
      (classesRes.data || []).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');

    levelIdEl.innerHTML = '<option value="">— select level —</option>' +
      (levelsRes.data || []).map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');

    if (currentProfile.role === 'academic') {
      teacherIdEl.innerHTML = '<option value="">— select teacher —</option>' +
        (teachersRes.data || []).map(t =>
          `<option value="${t.id}">${esc(t.full_name || t.email)}${t.role === 'academic' ? ' (Academic)' : ''}</option>`
        ).join('');
      teacherHelpEl.textContent = 'You can assign this assessment to any active user.';
    } else {
      teacherIdEl.innerHTML = `<option value="${currentProfile.id}" selected>${esc(currentProfile.full_name || currentProfile.email)}</option>`;
      teacherIdEl.disabled = true;
      teacherHelpEl.textContent = 'Teachers can only create assessments assigned to themselves.';
      teacherHelpEl.classList.add('locked');
    }

    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('content').style.display = 'block';
  } catch (err) {
    showToast('Could not load form data: ' + err.message, 'error');
  }
}

// ===== UNIQUENESS CHECK (assessments table only — separate namespace from exams) =====
async function checkCodeUnique(code) {
  const { data, error } = await db.from('assessments').select('code').eq('code', code).maybeSingle();
  if (error) throw error;
  return !data;
}

// ===== CODE GENERATION =====
async function generateAndVerifyCode() {
  const year = yearEl.value;
  const quarter = quarterEl.value;
  if (!year || !quarter) { clearCode(); return; }

  setStatus('checking', 'Generating and verifying code…');
  codeDisplay.className = 'code-display';
  regenerateBtn.disabled = true;

  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = generateRandomSuffix();
    const code = buildCode(year, quarter, suffix);
    codeDisplay.textContent = code;
    try {
      const isUnique = await checkCodeUnique(code);
      if (isUnique) {
        currentCode = code;
        codeIsAvailable = true;
        setStatus('available', '✓ Code is available');
        regenerateBtn.disabled = false;
        updateSubmitState();
        return;
      }
    } catch (err) {
      setStatus('taken', '⚠ Could not verify code. Check connection.');
      regenerateBtn.disabled = false;
      codeIsAvailable = false;
      updateSubmitState();
      return;
    }
  }
  setStatus('taken', '⚠ Could not generate a unique code. Try again.');
  regenerateBtn.disabled = false;
  codeIsAvailable = false;
  updateSubmitState();
}

// ===== VALIDATION =====
function updateSubmitState() {
  const allFilled =
    document.getElementById('title').value.trim() &&
    classIdEl.value && levelIdEl.value && teacherIdEl.value &&
    yearEl.value && quarterEl.value && resultsVisEl.value &&
    document.getElementById('availableFrom').value &&
    document.getElementById('availableUntil').value &&
    codeIsAvailable;
  submitBtn.disabled = !allFilled;
}

[yearEl, quarterEl].forEach(el => el.addEventListener('change', generateAndVerifyCode));
form.querySelectorAll('input, select, textarea').forEach(el => {
  el.addEventListener('input', updateSubmitState);
  el.addEventListener('change', updateSubmitState);
});
regenerateBtn.addEventListener('click', generateAndVerifyCode);

// ===== SUBMIT =====
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!codeIsAvailable || !currentCode) {
    showToast('Code is not yet verified. Please wait or regenerate.', 'error');
    return;
  }
  const from = new Date(document.getElementById('availableFrom').value);
  const until = new Date(document.getElementById('availableUntil').value);
  if (until <= from) {
    showToast('"Available Until" must be after "Available From".', 'error');
    return;
  }

  let teacherId = teacherIdEl.value;
  if (currentProfile.role === 'teacher') teacherId = currentProfile.id;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';

  const payload = {
    code: currentCode,
    title: document.getElementById('title').value.trim(),
    class_id: classIdEl.value,
    level_id: levelIdEl.value,
    teacher_id: teacherId,
    year: parseInt(yearEl.value, 10),
    quarter: quarterEl.value,
    type: 'ASSESSMENT',
    results_visibility: resultsVisEl.value,
    available_from: from.toISOString(),
    available_until: until.toISOString(),
    status: 'draft',
    notes: document.getElementById('notes').value.trim() || null,
    created_by: currentProfile.id,
  };

  try {
    const { data, error } = await db.from('assessments').insert(payload).select().single();
    if (error) throw error;
    document.getElementById('savedCode').textContent = data.code;
    document.getElementById('successTitle').textContent = data.title || 'Assessment Created';
    document.getElementById('editLink').href = `edit.html?id=${data.id}&new=true`;
    document.getElementById('successOverlay').classList.add('active');
  } catch (err) {
    if (err.code === '23505') {
      showToast('That code was just taken. Generating a new one…', 'error');
      await generateAndVerifyCode();
    } else {
      showToast('Failed to save: ' + (err.message || 'Unknown error'), 'error');
    }
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Assessment';
  }
});

document.getElementById('copyCodeBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('savedCode').textContent)
    .then(() => showToast('Code copied to clipboard', 'success'));
});

// ===== INIT =====
(async () => {
  const auth = await requireAuth();
  if (!auth) return;
  currentProfile = auth.profile;

  renderNavbar(document.getElementById('navbarContainer'), { profile: currentProfile, active: 'assessments' });

  await loadLookupData();
})();
