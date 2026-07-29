import { requireAuth } from '../auth.js';
import { renderNavbar, showToast } from '../ui.js';

const colors = [
  { name: 'Navy', value: '#0C2340' },
  { name: 'Gold', value: '#AE9142' },
  { name: 'Navy Light', value: '#143865' },
  { name: 'Blue', value: '#1368CE' },
  { name: 'Gold Bright', value: '#D39F10' },
  { name: 'Amber', value: '#B45309' },
  { name: 'Red', value: '#DC3545' },
  { name: 'Green', value: '#26890C' },
  { name: 'Black', value: '#000000' },
];

let currentColor = '#0C2340';
let colorOptionsEl, customColorInput, inputEl, downloadBtn, copyBtn, previewBox;

function waitForQRCode(callback) {
  if (typeof QRCode !== 'undefined') callback();
  else setTimeout(() => waitForQRCode(callback), 100);
}

function selectColor(color, btn) {
  currentColor = color;
  customColorInput.value = color;
  document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  updateQR();
}

function updateQR() {
  const text = inputEl.value.trim();
  if (!text) {
    previewBox.innerHTML = '<div class="qr-placeholder">Your QR code will appear here</div>';
    downloadBtn.disabled = true;
    copyBtn.disabled = true;
    return;
  }

  previewBox.innerHTML = '';
  downloadBtn.disabled = false;
  copyBtn.disabled = false;

  new QRCode(previewBox, {
    text, width: 256, height: 256,
    colorDark: currentColor, colorLight: 'transparent',
    correctLevel: QRCode.CorrectLevel.H,
  });

  setTimeout(() => {
    const canvas = previewBox.querySelector('canvas');
    if (canvas) {
      makeTransparent(canvas);
      addMarginsAndRadius(canvas);
    }
  }, 100);
}

function makeTransparent(canvas) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) data[i + 3] = 0;
  }
  ctx.putImageData(imageData, 0, 0);
}

function addMarginsAndRadius(originalCanvas) {
  const margin = 12, radius = 8;
  const newSize = originalCanvas.width + margin * 2;
  const newCanvas = document.createElement('canvas');
  newCanvas.width = newSize;
  newCanvas.height = newSize;
  const ctx = newCanvas.getContext('2d');

  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(newSize - radius, 0);
  ctx.quadraticCurveTo(newSize, 0, newSize, radius);
  ctx.lineTo(newSize, newSize - radius);
  ctx.quadraticCurveTo(newSize, newSize, newSize - radius, newSize);
  ctx.lineTo(radius, newSize);
  ctx.quadraticCurveTo(0, newSize, 0, newSize - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(originalCanvas, margin, margin);

  originalCanvas.width = newCanvas.width;
  originalCanvas.height = newCanvas.height;
  originalCanvas.getContext('2d').drawImage(newCanvas, 0, 0);
}

function initializeApp() {
  colorOptionsEl = document.getElementById('colorOptions');
  customColorInput = document.getElementById('customColor');
  inputEl = document.getElementById('qrInput');
  downloadBtn = document.getElementById('downloadBtn');
  copyBtn = document.getElementById('copyBtn');
  previewBox = document.getElementById('qrPreviewBox');

  colors.forEach((color, index) => {
    const btn = document.createElement('button');
    btn.className = 'color-btn' + (index === 0 ? ' selected' : '');
    btn.style.backgroundColor = color.value;
    btn.title = color.name;
    btn.addEventListener('click', () => selectColor(color.value, btn));
    colorOptionsEl.appendChild(btn);
  });

  customColorInput.addEventListener('change', (e) => {
    currentColor = e.target.value;
    updateQR();
    document.querySelectorAll('.color-btn').forEach(btn => btn.classList.remove('selected'));
  });

  inputEl.addEventListener('input', updateQR);

  downloadBtn.addEventListener('click', () => {
    if (!inputEl.value.trim()) return;
    const canvas = previewBox.querySelector('canvas');
    if (canvas) {
      const link = document.createElement('a');
      link.href = canvas.toDataURL('image/png');
      link.download = 'qr-code.png';
      link.click();
    }
  });

  copyBtn.addEventListener('click', () => {
    if (!inputEl.value.trim()) return;
    const canvas = previewBox.querySelector('canvas');
    if (!canvas) return;
    canvas.toBlob((blob) => {
      navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        .then(() => showToast('QR code copied to clipboard!', 'success'))
        .catch(() => showToast('Failed to copy QR code', 'error'));
    });
  });
}

// ===== INIT =====
(async () => {
  const auth = await requireAuth();
  if (!auth) return;
  renderNavbar(document.getElementById('navbarContainer'), { profile: auth.profile });
  waitForQRCode(initializeApp);
})();
