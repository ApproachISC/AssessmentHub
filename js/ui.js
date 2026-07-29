import { signOut } from './auth.js';
import { basePath } from './config.js';

// ============================================================
// NAVBAR — renders the shared top nav into a container element.
// `active` is one of: 'assessments' | 'exams' | 'admin' | null
// ============================================================
export function renderNavbar(container, { profile, active = null } = {}) {
  const initials = (profile?.full_name || profile?.email || '?')
    .trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const isAcademic = profile?.role === 'academic';
  const base = basePath();

  container.innerHTML = `
    <div class="navbar" id="appNavbar">
      <div class="navbar-inner">
        <a class="navbar-brand" href="${base}${isAcademic ? 'admin-dashboard.html' : 'exam/dashboard.html'}">
          <img src="${base}images/gold-logo.png" alt="Approach International Student Center">
        </a>

        <nav class="navbar-links">
          <a href="${base}assessment/dashboard.html" class="navbar-link${active === 'assessments' ? ' active' : ''}">Assessments</a>
          <a href="${base}exam/dashboard.html" class="navbar-link${active === 'exams' ? ' active' : ''}">Exams</a>
          ${isAcademic ? `<a href="${base}admin-dashboard.html" class="navbar-link${active === 'admin' ? ' active' : ''}">Administration</a>` : ''}
        </nav>

        <div class="navbar-actions">
          <div class="navbar-profile">
            <button class="navbar-profile-btn" id="navProfileBtn">
              <span class="navbar-avatar">${initials}</span>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
            </button>
            <div class="navbar-profile-menu" id="navProfileMenu">
              <a href="${base}profile.html">Profile</a>
              <a href="${base}shared-library.html">Shared Library</a>
              <a href="${base}qr-generator.html" target="_blank">QR Code Generator ↗</a>
              <button type="button" id="navSignOutBtn" class="danger">Sign Out</button>
            </div>
          </div>
          <button class="navbar-burger" id="navBurgerBtn" aria-label="Menu">
            <svg class="icon-burger" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
            <svg class="icon-close" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
      </div>

      <div class="navbar-mobile-panel">
        <a href="${base}assessment/dashboard.html"${active === 'assessments' ? ' class="active"' : ''}>Assessments</a>
        <a href="${base}exam/dashboard.html"${active === 'exams' ? ' class="active"' : ''}>Exams</a>
        ${isAcademic ? `<a href="${base}admin-dashboard.html"${active === 'admin' ? ' class="active"' : ''}>Administration</a>` : ''}
        <a href="${base}profile.html">Profile</a>
      </div>
    </div>`;

  const navbar = container.querySelector('#appNavbar');
  const profileBtn = container.querySelector('#navProfileBtn');
  const profileMenu = container.querySelector('#navProfileMenu');
  const burgerBtn = container.querySelector('#navBurgerBtn');
  const signOutBtn = container.querySelector('#navSignOutBtn');

  profileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    profileMenu.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.navbar-profile')) profileMenu.classList.remove('open');
  });
  burgerBtn.addEventListener('click', () => navbar.classList.toggle('menu-open'));
  signOutBtn.addEventListener('click', () => signOut());
}

// ============================================================
// TOASTS
// ============================================================
let toastStack = null;
function getToastStack() {
  if (!toastStack) {
    toastStack = document.createElement('div');
    toastStack.className = 'toast-stack';
    document.body.appendChild(toastStack);
  }
  return toastStack;
}

export function showToast(message, type = 'info', durationMs = 3500) {
  const stack = getToastStack();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), durationMs);
}

// ============================================================
// MODALS — expects markup: <div class="modal-overlay" id="..."><div class="modal-box">...</div></div>
// ============================================================
export function openModal(idOrEl) {
  const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
  el?.classList.add('open');
}
export function closeModal(idOrEl) {
  const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
  el?.classList.remove('open');
}

// ============================================================
// TABS — wires up a .tabs / .tab-panel group given a container element
// ============================================================
export function initTabs(container) {
  container.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const panelId = tab.dataset.panel;
      container.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      container.parentElement.querySelectorAll('.tab-panel').forEach(p => {
        p.classList.toggle('active', p.id === panelId);
      });
    });
  });
}

// ============================================================
// ACCORDION — wires up .acc-item / .acc-header groups given a container
// ============================================================
export function initAccordion(container, { singleOpen = true } = {}) {
  container.querySelectorAll('.acc-header').forEach(header => {
    header.addEventListener('click', () => {
      const item = header.closest('.acc-item');
      const wasOpen = item.classList.contains('open');
      if (singleOpen) {
        container.querySelectorAll('.acc-item').forEach(i => i.classList.remove('open'));
      }
      item.classList.toggle('open', !wasOpen);
    });
  });
}

export function esc(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
