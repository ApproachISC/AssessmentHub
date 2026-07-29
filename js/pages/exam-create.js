import { db } from '../supabase-client.js';
import { requireAuth } from '../auth.js';
import { renderNavbar, showToast, esc } from '../ui.js';

const QUARTER_CODES = { WINTER: 'WT', SPRING: 'SP', SUMMER: 'SM', FALL: 'FA' };
const TYPE_CODES = { 'MIDTERM': 'MT', 'FINAL EXAM': 'FE' };
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
const typeEl = document.getElementById('type');
const codeDisplay = document.getElementById('codeDisplay');
const codeStatus = document.getElementById('codeStatus');
const regenerateBtn = document.getElementById('regenerateBtn');
const submitBtn = document.getElementById('submitBtn');
const form = document.getElementById('examForm');

function generateRandomSuffix() {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALPHANUM[Math.floor(Math.random() * ALPHANUM.length)];
  return s;
}
function buildCode(year, quarter, type, suffix) {
  return `${year}${QUARTER_CODES[quarter]}-${TYPE_CODES[type]}${suffix}`;
}
function setStatus(state, message) {
  codeStatus.style.display = 'flex';
  codeStatus.className = 'code-status ' + state;
  codeStatus.textContent = message;
}
function clearCode() {
  currentCode = null;
  codeIsAvailable = false;
  codeDisplay.textContent = 'Fill in Year, Quarter, and Type';
  codeDisplay.className = 'code-display placeholder';
  codeStatus.style.display = 'none';
  regenerateBtn.disabled = true;
  updateSubmitState();
}

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
        (teachersRes.data || []).map(t => `<option value="${t.id}">${esc(t.full_name || t.email)}${t.role === 'academic' ? ' (Academic)' : ''}</option>`).join('');
      teacherHelpEl.textContent = 'You can assign this exam to any active user.';
    } else {
      teacherIdEl.innerHTML = `<option value="${currentProfile.id}" selected>${esc(currentProfile.full_name || currentProfile.email)}</option>`;
      teacherIdEl.disabled = true;
      teacherHelpEl.textContent = 'Teachers can only create exams assigned to themselves.';
      teacherHelpEl.classList.add('locked');
    }

    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('content').style.display = 'block';
  } catch (err) {
    showToast('Could not load form data: ' + err.message, 'error');
  }
}

async function checkCodeUnique(code) {
  const { data, error } = await db.from('exams').select('code').eq('code', code).maybeSingle();
  if (error) throw error;
  return !data;
}

async function generateAndVerifyCode() {
  const year = yearEl.value, quarter = quarterEl.value, type = typeEl.value;
  if (!year || !quarter || !type) { clearCode(); return; }

  setStatus('checking', 'Generating and verifying code…');
  codeDisplay.className = 'code-display';
  regenerateBtn.disabled = true;

  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = generateRandomSuffix();
    const code = buildCode(year, quarter, type, suffix);
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

function updateSubmitState() {
  const allFilled = classIdEl.value && levelIdEl.value && teacherIdEl.value &&
    yearEl.value && quarterEl.value && typeEl.value &&
    document.getElementById('availableFrom').value && document.getElementById('availableUntil').value &&
    codeIsAvailable;
  submitBtn.disabled = !allFilled;
}

[yearEl, quarterEl, typeEl].forEach(el => el.addEventListener('change', generateAndVerifyCode));
form.querySelectorAll('input, select, textarea').forEach(el => {
  el.addEventListener('input', updateSubmitState);
  el.addEventListener('change', updateSubmitState);
});
regenerateBtn.addEventListener('click', generateAndVerifyCode);

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
    class_id: classIdEl.value,
    level_id: levelIdEl.value,
    teacher_id: teacherId,
    year: parseInt(yearEl.value, 10),
    quarter: quarterEl.value,
    type: typeEl.value,
    available_from: from.toISOString(),
    available_until: until.toISOString(),
    status: document.getElementById('status').value,
    notes: document.getElementById('notes').value.trim() || null,
    created_by: currentProfile.id,
  };

  try {
    const { data, error } = await db.from('exams').insert(payload).select().single();
    if (error) throw error;
    // Redirect straight to the edit page so the teacher can upload the JSON content
    window.location.href = `edit.html?id=${data.id}&new=true`;
  } catch (err) {
    if (err.code === '23505') {
      showToast('That code was just taken. Generating a new one…', 'error');
      await generateAndVerifyCode();
    } else {
      showToast('Failed to save: ' + (err.message || 'Unknown error'), 'error');
    }
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Exam';
  }
});

// ===== INIT =====
(async () => {
  const auth = await requireAuth();
  if (!auth) return;
  currentProfile = auth.profile;
  renderNavbar(document.getElementById('navbarContainer'), { profile: currentProfile, active: 'exams' });
  await loadLookupData();
})();
