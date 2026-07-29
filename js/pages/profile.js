import { db } from '../supabase-client.js';
import { requireAuth } from '../auth.js';
import { renderNavbar } from '../ui.js';

const errorAlert = document.getElementById('errorAlert');
const successAlert = document.getElementById('successAlert');
const nameForm = document.getElementById('nameForm');
const passwordForm = document.getElementById('passwordForm');
const fullNameInput = document.getElementById('fullName');
const currentPasswordInput = document.getElementById('currentPassword');
const newPasswordInput = document.getElementById('newPassword');
const confirmPasswordInput = document.getElementById('confirmPassword');
const nameSubmitBtn = document.getElementById('nameSubmitBtn');
const passwordSubmitBtn = document.getElementById('passwordSubmitBtn');
const backLink = document.getElementById('backLink');

let currentUser = null;

function showError(msg) {
  errorAlert.textContent = msg;
  errorAlert.classList.add('show');
  successAlert.classList.remove('show');
}
function showSuccess(msg) {
  successAlert.textContent = msg;
  successAlert.classList.add('show');
  errorAlert.classList.remove('show');
}

function checkPasswordRules() {
  const pwd = newPasswordInput.value;
  const length = pwd.length >= 8;
  const letter = /[a-zA-Z]/.test(pwd);
  const number = /[0-9]/.test(pwd);
  document.getElementById('ruleLength').classList.toggle('met', length);
  document.getElementById('ruleLetter').classList.toggle('met', letter);
  document.getElementById('ruleNumber').classList.toggle('met', number);
  return length && letter && number;
}
newPasswordInput.addEventListener('input', checkPasswordRules);

// ===== INIT =====
(async () => {
  const auth = await requireAuth();
  if (!auth) return;
  const { session, profile } = auth;
  currentUser = { ...session.user, ...profile };

  renderNavbar(document.getElementById('navbarContainer'), { profile });

  document.getElementById('emailDisplay').textContent = session.user.email;
  document.getElementById('fullNameDisplay').textContent = profile.full_name;
  document.getElementById('roleDisplay').textContent = profile.role === 'academic' ? 'Academic' : 'Teacher';

  if (profile.created_at) {
    document.getElementById('createdDisplay').textContent = new Date(profile.created_at)
      .toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  fullNameInput.value = profile.full_name;
  backLink.href = profile.role === 'academic' ? 'admin-dashboard.html' : 'exam/dashboard.html';
})();

// ===== CHANGE NAME =====
nameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (fullNameInput.value.trim().length < 2) { showError('Full name must be at least 2 characters.'); return; }

  nameSubmitBtn.disabled = true;
  nameSubmitBtn.textContent = 'Updating…';
  errorAlert.classList.remove('show');

  try {
    const { error } = await db.from('profiles').update({ full_name: fullNameInput.value.trim() }).eq('id', currentUser.id);
    if (error) throw error;
    document.getElementById('fullNameDisplay').textContent = fullNameInput.value.trim();
    showSuccess('Name updated successfully.');
  } catch (err) {
    showError(err.message || 'Failed to update name. Please try again.');
  } finally {
    nameSubmitBtn.textContent = 'Update Name';
    nameSubmitBtn.disabled = false;
  }
});

// ===== CHANGE PASSWORD =====
passwordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!checkPasswordRules()) { showError('New password does not meet all requirements.'); return; }
  if (newPasswordInput.value !== confirmPasswordInput.value) { showError('New passwords do not match.'); return; }

  passwordSubmitBtn.disabled = true;
  passwordSubmitBtn.textContent = 'Changing…';
  errorAlert.classList.remove('show');

  try {
    const { error: signInError } = await db.auth.signInWithPassword({ email: currentUser.email, password: currentPasswordInput.value });
    if (signInError) throw new Error('Current password is incorrect.');

    const { error: updateError } = await db.auth.updateUser({ password: newPasswordInput.value });
    if (updateError) throw updateError;

    showSuccess('Password changed successfully. You may need to sign in again.');
    passwordForm.reset();
    document.getElementById('ruleLength').classList.remove('met');
    document.getElementById('ruleLetter').classList.remove('met');
    document.getElementById('ruleNumber').classList.remove('met');
    passwordSubmitBtn.textContent = 'Change Password';
    passwordSubmitBtn.disabled = false;

    setTimeout(async () => {
      await db.auth.signOut();
      window.location.href = 'login.html';
    }, 2000);
  } catch (err) {
    showError(err.message || 'Failed to change password. Please try again.');
    passwordSubmitBtn.textContent = 'Change Password';
    passwordSubmitBtn.disabled = false;
  }
});
