let stream = null, rafId = null, scanning = false;
let currentResult = '';
const history = [];

function ensureJsQR() {
  return new Promise((resolve, reject) => {
    if (typeof jsQR === 'function') { resolve(); return; }
    let attempts = 0;
    const iv = setInterval(() => {
      if (typeof jsQR === 'function') { clearInterval(iv); resolve(); }
      else if (++attempts > 40) { clearInterval(iv); reject(new Error('jsQR failed to load')); }
    }, 100);
  });
}

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const scanLine = document.getElementById('scan-line');
const overlayMsg = document.getElementById('overlay-msg');
const camBtn = document.getElementById('cam-btn');
const copyBtn = document.getElementById('copy-btn');
const openBtn = document.getElementById('open-btn');
const flash = document.getElementById('flash');
const resultBox = document.getElementById('result-box');
const resultText = document.getElementById('result-text');
const resultIcon = document.getElementById('result-icon');
const badge = document.getElementById('status-badge');

function setBadge(state) {
  const map = {
    idle: ['idle', 'ti-circle', 'Idle'],
    scanning: ['scanning', 'ti-ripple', 'Scanning'],
    found: ['found', 'ti-circle-check', 'Found'],
    error: ['error', 'ti-alert-circle', 'Error'],
  };
  badge.className = 'qrread-badge ' + map[state][0];
  badge.innerHTML = `<i class="ti ${map[state][1]}" aria-hidden="true"></i> ${map[state][2]}`;
}

function toggleCam() {
  stream ? stopCam() : startCam();
}

async function startCam() {
  const constraints = [
    { video: { facingMode: { exact: 'environment' } } },
    { video: { facingMode: 'environment' } },
    { video: true },
  ];
  for (const c of constraints) {
    try { stream = await navigator.mediaDevices.getUserMedia(c); break; }
    catch (e) { stream = null; }
  }

  if (!stream) {
    overlayMsg.innerHTML = '<i class="ti ti-alert-circle" aria-hidden="true" style="font-size:44px;opacity:0.6;color:var(--red)"></i><span>Camera access denied</span>';
    overlayMsg.style.display = 'flex';
    setBadge('error');
    return;
  }

  video.srcObject = stream;
  video.onloadedmetadata = async () => {
    try { await ensureJsQR(); } catch (e) {
      overlayMsg.innerHTML = '<i class="ti ti-alert-circle" aria-hidden="true" style="font-size:44px;opacity:0.6;color:var(--red)"></i><span>jsQR library failed to load</span>';
      overlayMsg.style.display = 'flex';
      setBadge('error');
      return;
    }
    scanning = true;
    tick();
  };
  camBtn.innerHTML = '<i class="ti ti-video-off" aria-hidden="true"></i> Stop Camera';
  camBtn.style.background = 'var(--red)';
  overlayMsg.style.display = 'none';
  scanLine.style.display = 'block';
  setBadge('scanning');
}

function stopCam() {
  scanning = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  video.srcObject = null;
  camBtn.innerHTML = '<i class="ti ti-video" aria-hidden="true"></i> Start Camera';
  camBtn.style.background = '';
  overlayMsg.innerHTML = '<i class="ti ti-camera-off" aria-hidden="true"></i><span>Camera stopped</span>';
  overlayMsg.style.display = 'flex';
  scanLine.style.display = 'none';
  setBadge('idle');
}

function tick() {
  if (!scanning) return;
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    if (code && code.data !== currentResult) onFound(code.data);
  }
  rafId = requestAnimationFrame(tick);
}

async function handleFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try { await ensureJsQR(); } catch (err) { showToast('jsQR library not loaded yet'); return; }
  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, img.width, img.height);
      const code = jsQR(imgData.data, imgData.width, imgData.height);
      if (code) onFound(code.data);
      else { showResult('No QR code detected in this image.', false); setBadge('error'); }
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

function onFound(data) {
  currentResult = data;
  flashEffect();
  showResult(data, true);
  addHistory(data);
  setBadge('found');
}

function showResult(text, found) {
  resultText.textContent = text;
  resultText.className = found ? 'found' : '';
  resultBox.className = found ? 'success' : '';
  resultIcon.className = found ? 'ti ti-circle-check' : 'ti ti-alert-triangle';
  copyBtn.style.display = found ? 'flex' : 'none';
  openBtn.style.display = found && /^https?:\/\//i.test(text) ? 'flex' : 'none';
}

function flashEffect() {
  flash.classList.add('pop');
  setTimeout(() => flash.classList.remove('pop'), 220);
}

function copyResult() {
  navigator.clipboard.writeText(currentResult).then(() => showToast('Copied to clipboard'));
}

function openCurrentLink() {
  window.open(currentResult, '_blank', 'noopener,noreferrer');
}

function showToast(msg) {
  const toast = document.getElementById('qrread-toast');
  document.getElementById('toast-text').textContent = msg;
  toast.style.opacity = 1;
  setTimeout(() => toast.style.opacity = 0, 2000);
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function addHistory(data) {
  if (history[0]?.data === data) return;
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  history.unshift({ data, ts });
  if (history.length > 5) history.pop();
  renderHistory();
}

function renderHistory() {
  const section = document.getElementById('history-section');
  const list = document.getElementById('history-list');
  section.style.display = history.length ? 'block' : 'none';
  list.innerHTML = history.map(({ data, ts }) => {
    const isUrl = /^https?:\/\//i.test(data);
    const icon = isUrl ? 'ti-link' : 'ti-text-size';
    return `<li>
      <i class="ti ${icon}" aria-hidden="true"></i>
      <span class="hist-text">${escHtml(data)}</span>
      <span class="hist-time">${ts}</span>
      ${isUrl ? `<button class="qrread-icon-btn" data-open-link="${escHtml(data)}" title="Open" aria-label="Open link"><i class="ti ti-external-link" aria-hidden="true"></i></button>` : ''}
    </li>`;
  }).join('');
}

function clearHistory() {
  history.length = 0;
  renderHistory();
  currentResult = '';
  resultText.textContent = 'Awaiting scan…';
  resultText.className = 'placeholder';
  resultBox.className = '';
  resultIcon.className = 'ti ti-qrcode';
  copyBtn.style.display = 'none';
  openBtn.style.display = 'none';
  if (!stream) setBadge('idle');
}

camBtn.addEventListener('click', toggleCam);
document.getElementById('file-input').addEventListener('change', handleFile);
copyBtn.addEventListener('click', copyResult);
openBtn.addEventListener('click', openCurrentLink);
document.getElementById('clear-history-btn').addEventListener('click', clearHistory);
document.getElementById('history-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-open-link]');
  if (btn) window.open(btn.dataset.openLink, '_blank', 'noopener,noreferrer');
});
