import { db } from '../supabase-client.js';
import { esc } from '../ui.js';

const boxes = document.querySelectorAll('.pin-box');
const pinContainer = document.getElementById('pinContainer');
const statusPanel = document.getElementById('statusPanel');
const statusLabel = document.getElementById('statusLabel');
const statusTitle = document.getElementById('statusTitle');
const statusMessage = document.getElementById('statusMessage');
const statusDetail = document.getElementById('statusDetail');
const clearBtn = document.getElementById('clearBtn');
const actions = document.getElementById('actions');

let isChecking = false;

function getCurrentCode() {
  const chars = Array.from(boxes).map(b => b.value.toUpperCase()).join('');
  if (chars.length !== 12) return null;
  return `${chars.slice(0, 6)}-${chars.slice(6)}`;
}

function clearPanel() {
  statusPanel.className = 'status-panel';
  statusDetail.style.display = 'none';
  actions.style.display = 'none';
  pinContainer.classList.remove('error');
}

function showPanel(state, label, title, message, detail = null) {
  statusPanel.className = 'status-panel active ' + state;
  statusLabel.textContent = label;
  statusTitle.textContent = title;
  statusMessage.innerHTML = message;
  if (detail) { statusDetail.innerHTML = detail; statusDetail.style.display = 'flex'; }
  else statusDetail.style.display = 'none';
}

function formatDateTime(iso) {
  const d = new Date(iso);
  const dateStr = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${dateStr} at ${timeStr}`;
}

function shakePin() {
  pinContainer.classList.add('shake', 'error');
  setTimeout(() => pinContainer.classList.remove('shake'), 400);
}

function clearAllBoxes() {
  boxes.forEach(b => b.value = '');
  pinContainer.classList.remove('error');
  boxes[0].focus();
  clearPanel();
}
clearBtn.addEventListener('click', clearAllBoxes);

boxes.forEach((box, idx) => {
  box.addEventListener('input', (e) => {
    let val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    e.target.value = val;
    pinContainer.classList.remove('error');
    if (statusPanel.classList.contains('error')) clearPanel();
    if (val && idx < boxes.length - 1) boxes[idx + 1].focus();
    checkIfComplete();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !e.target.value && idx > 0) { boxes[idx - 1].focus(); boxes[idx - 1].value = ''; }
    else if (e.key === 'ArrowLeft' && idx > 0) { e.preventDefault(); boxes[idx - 1].focus(); }
    else if (e.key === 'ArrowRight' && idx < boxes.length - 1) { e.preventDefault(); boxes[idx + 1].focus(); }
  });
  box.addEventListener('paste', (e) => {
    e.preventDefault();
    const pasted = (e.clipboardData || window.clipboardData).getData('text');
    const cleaned = pasted.toUpperCase().replace(/[^A-Z0-9]/g, '');
    for (let i = 0; i < cleaned.length && (idx + i) < boxes.length; i++) boxes[idx + i].value = cleaned[i];
    boxes[Math.min(idx + cleaned.length, boxes.length - 1)].focus();
    pinContainer.classList.remove('error');
    checkIfComplete();
  });
  box.addEventListener('focus', () => box.select());
});

function checkIfComplete() {
  const code = getCurrentCode();
  if (code && !isChecking) verifyCode(code);
}

async function verifyCode(code) {
  isChecking = true;
  showPanel('checking', 'Verifying', '', '<span class="spinner" style="display:inline-block;width:18px;height:18px;margin-right:0.5rem;vertical-align:middle;"></span>Looking up your exam…');

  try {
    const { data, error } = await db.from('exams')
      .select(`*, classes:class_id (name), teacher:teacher_id (full_name, email)`)
      .eq('code', code).maybeSingle();
    if (error) throw error;

    if (!data) {
      shakePin();
      showPanel('error', 'Invalid Code', 'Code not recognized', 'Please check the code with your teacher and try again.');
      actions.style.display = 'flex';
      isChecking = false;
      return;
    }
    handleExamStatus(data);
  } catch (err) {
    showPanel('error', 'Connection Error', 'Could not verify your code',
      `Please check your internet connection and try again.<br><small style="color:var(--navy-l);">${esc(err.message || '')}</small>`);
    actions.style.display = 'flex';
    isChecking = false;
  }
}

function handleExamStatus(exam) {
  const now = new Date(), from = new Date(exam.available_from), until = new Date(exam.available_until);

  if (exam.status === 'archived') {
    shakePin();
    showPanel('error', 'Unavailable', 'This exam is no longer available', 'This exam has been archived and can no longer be taken. Please contact your teacher.');
    actions.style.display = 'flex'; isChecking = false; return;
  }
  if (exam.status === 'draft') {
    shakePin();
    showPanel('error', 'Not Yet Published', 'This exam is not ready', 'Your teacher has not yet published this exam. Please check back later or contact them.');
    actions.style.display = 'flex'; isChecking = false; return;
  }
  if (now < from) {
    const className = exam.classes?.name || '—';
    const teacherName = exam.teacher?.full_name || exam.teacher?.email || '—';
    const detail = `
      <span><strong style="display:block;margin-bottom:0.2rem;">Class</strong>${esc(className)}</span>
      <span><strong style="display:block;margin-bottom:0.2rem;">Teacher</strong>${esc(teacherName)}</span>
      <span><strong style="display:block;margin-bottom:0.2rem;">Type</strong>${esc(exam.type)}</span>`;
    showPanel('upcoming', 'Upcoming', 'This exam is not available yet',
      `Your exam will be available on <strong style="color:var(--navy);font-style:normal;font-weight:700;">${formatDateTime(exam.available_from)}</strong>.<br>Please return at that time.`, detail);
    actions.style.display = 'flex'; isChecking = false; return;
  }
  if (now > until) {
    showPanel('closed', 'Closed', 'This exam window has ended',
      `This exam closed on <strong style="color:var(--navy);font-style:normal;font-weight:700;">${formatDateTime(exam.available_until)}</strong>.<br>Please contact your teacher if you need to take it.`);
    actions.style.display = 'flex'; isChecking = false; return;
  }
  if (!exam.exam_definition || !exam.exam_definition.sections) {
    shakePin();
    showPanel('error', 'Not Ready', 'This exam has no questions yet', 'Your teacher has not yet uploaded the exam content. Please contact them.');
    actions.style.display = 'flex'; isChecking = false; return;
  }

  showPanel('checking', 'Granted', 'Code accepted', `<span class="spinner" style="display:inline-block;width:18px;height:18px;margin-right:0.5rem;vertical-align:middle;"></span>Loading your exam…`);
  setTimeout(() => { window.location.href = `page.html?code=${encodeURIComponent(exam.code)}`; }, 800);
}

// ===== PREFILL FROM URL (QR scan) =====
function prefillFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('code');
  if (!raw) { boxes[0].focus(); return; }
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length !== 12) { boxes[0].focus(); return; }
  for (let i = 0; i < 12; i++) boxes[i].value = cleaned[i];
  checkIfComplete();
}
prefillFromUrl();
