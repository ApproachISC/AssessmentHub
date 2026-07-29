import { db } from '../supabase-client.js';
import { esc } from '../ui.js';

const boxes = [...document.querySelectorAll('.pin-box')];
const pinContainer = document.getElementById('pinContainer');
let isChecking = false;

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function shakePin() {
  pinContainer.classList.remove('shake');
  void pinContainer.offsetWidth;
  pinContainer.classList.add('shake');
  setTimeout(() => pinContainer.classList.remove('shake'), 400);
}
function showPanel(type, label, title, message, detail = '') {
  const p = document.getElementById('statusPanel');
  p.className = 'status-panel active ' + type;
  document.getElementById('statusLabel').textContent = label;
  document.getElementById('statusTitle').textContent = title;
  document.getElementById('statusMessage').textContent = message;
  document.getElementById('statusDetail').innerHTML = detail;
}

function getCurrentCode() {
  const chars = Array.from(boxes).map(b => b.value.toUpperCase()).join('');
  if (chars.length !== 12) return null;
  // Format: YYYYQQ-TTXXXX (positions 0-5, then 6-11 with hyphen between)
  return `${chars.slice(0, 6)}-${chars.slice(6)}`;
}

function checkIfComplete() {
  const code = getCurrentCode();
  if (code && !isChecking) verifyCode(code);
}

boxes.forEach((box, idx) => {
  box.addEventListener('input', (e) => {
    let val = e.target.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (val.length > 1) {
      const rem = val.slice(0, 12 - idx);
      [...rem].forEach((ch, i) => { if (boxes[idx + i]) boxes[idx + i].value = ch; });
      boxes[Math.min(idx + rem.length, 11)]?.focus();
    } else {
      box.value = val;
      box.classList.toggle('filled', !!val);
      if (val && idx < 11) boxes[idx + 1].focus();
    }
    checkIfComplete();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && idx > 0) { boxes[idx - 1].value = ''; boxes[idx - 1].classList.remove('filled'); boxes[idx - 1].focus(); }
    if (e.key === 'ArrowLeft' && idx > 0) boxes[idx - 1].focus();
    if (e.key === 'ArrowRight' && idx < 11) boxes[idx + 1].focus();
  });
  box.addEventListener('focus', () => box.select());
  box.addEventListener('paste', (e) => {
    e.preventDefault();
    const pasted = (e.clipboardData?.getData('text') || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    [...pasted.slice(0, 12)].forEach((ch, i) => { if (boxes[i]) { boxes[i].value = ch; boxes[i].classList.add('filled'); } });
    boxes[Math.min(pasted.length, 11)].focus();
    checkIfComplete();
  });
});

function clearCode() {
  boxes.forEach(b => { b.value = ''; b.classList.remove('filled'); });
  document.getElementById('statusPanel').className = 'status-panel';
  document.getElementById('actions').style.display = 'none';
  isChecking = false;
  boxes[0].focus();
}
document.getElementById('tryAgainBtn').addEventListener('click', clearCode);

async function verifyCode(code) {
  isChecking = true;
  showPanel('checking', 'Checking', 'Verifying…', '');
  try {
    const { data: exam, error } = await db.from('assessments').select('*').eq('code', code).maybeSingle();
    if (error) throw error;
    if (!exam) {
      shakePin();
      showPanel('error', 'Invalid Code', 'Code not recognized', 'That code does not match any assessment. Please check it and try again.');
      document.getElementById('actions').style.display = 'flex';
      isChecking = false;
      return;
    }

    // Fetch teacher and class separately — Supabase can't auto-join teacher_id
    // because it references auth.users (not a public table).
    const [teacherRes, classRes] = await Promise.all([
      db.from('profiles').select('full_name, email').eq('id', exam.teacher_id).maybeSingle(),
      db.from('classes').select('name').eq('id', exam.class_id).maybeSingle(),
    ]);
    const now = new Date(), from = new Date(exam.available_from), until = new Date(exam.available_until);
    const className = classRes.data?.name || '—', teacherName = teacherRes.data?.full_name || teacherRes.data?.email || '—';

    if (exam.status === 'draft') {
      showPanel('error', 'Not Published', 'Not available yet', 'This assessment has not been published.');
      document.getElementById('actions').style.display = 'flex'; isChecking = false; return;
    }
    if (exam.status === 'archived') {
      showPanel('closed', 'Archived', 'No longer available', 'This assessment has been archived.');
      document.getElementById('actions').style.display = 'flex'; isChecking = false; return;
    }
    if (now < from) {
      showPanel('upcoming', 'Upcoming', 'Not open yet', 'This assessment is not open yet.',
        `<span><strong>Class</strong>${esc(className)}</span><span><strong>Teacher</strong>${esc(teacherName)}</span><span><strong>Opens</strong>${formatDate(exam.available_from)}</span>`);
      document.getElementById('actions').style.display = 'flex'; isChecking = false; return;
    }
    if (now > until) {
      showPanel('closed', 'Closed', 'Window has ended', `This assessment closed on ${formatDate(exam.available_until)}.`);
      document.getElementById('actions').style.display = 'flex'; isChecking = false; return;
    }
    if (!exam.assessment_definition?.sections) {
      showPanel('error', 'Not Ready', 'No questions yet', 'This assessment has no questions. Contact your teacher.');
      document.getElementById('actions').style.display = 'flex'; isChecking = false; return;
    }
    showPanel('checking', 'Access Granted', 'Loading…', 'Taking you to the assessment…');
    setTimeout(() => { window.location.href = `page.html?code=${encodeURIComponent(exam.code)}`; }, 700);
  } catch (err) {
    showPanel('error', 'Error', 'Could not verify', err.message || 'Check your connection.');
    document.getElementById('actions').style.display = 'flex';
    isChecking = false;
  }
}

// URL pre-fill from QR code scan
function prefillFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('code');
  if (!raw) { boxes[0].focus(); return; }
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length !== 12) { boxes[0].focus(); return; }
  for (let i = 0; i < 12; i++) { boxes[i].value = cleaned[i]; boxes[i].classList.add('filled'); }
  checkIfComplete();
}
prefillFromUrl();
