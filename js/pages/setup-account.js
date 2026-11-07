import { db } from '../supabase-client.js';

const loadingState = document.getElementById('loadingState');
const setupForm = document.getElementById('setupForm');
const errorState = document.getElementById('errorState');
const errorAlert = document.getElementById('errorAlert');
const submitBtn = document.getElementById('submitBtn');

const passwordEl = document.getElementById('password');
const confirmEl = document.getElementById('confirmPassword');
const fullNameEl = document.getElementById('fullName');

// Captured synchronously, before supabase-js consumes and clears the URL fragment.
const urlSaysRecovery = /(^|[#&?])type=recovery(&|$)/.test(window.location.hash + window.location.search);
let isReset = false;

// Fallback: the access token's `amr` claim records how the session was created.
function sessionIsRecovery(session) {
  try {
    const payload = JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return (payload.amr || []).some(a => a.method === 'recovery');
  } catch {
    return false;
  }
}

function applyResetMode(profile) {
  isReset = true;
  setupForm.querySelector('h1').innerHTML = 'Reset Your <em>Password</em>';
  setupForm.querySelector('.subtitle').textContent = 'Choose a new password for your account';
  submitBtn.textContent = 'Save New Password';
  if (profile?.full_name) fullNameEl.value = profile.full_name;
}

function showSetupError(msg) {
  errorAlert.textContent = msg;
  errorAlert.classList.add('show');
}

function showInviteError(msg) {
  loadingState.style.display = 'none';
  setupForm.style.display = 'none';
  document.getElementById('errorMessage').textContent = msg;
  errorState.style.display = 'block';
}

function checkPasswordRules() {
  const pwd = passwordEl.value;
  const length = pwd.length >= 8;
  const letter = /[a-zA-Z]/.test(pwd);
  const number = /[0-9]/.test(pwd);
  document.getElementById('ruleLength').classList.toggle('met', length);
  document.getElementById('ruleLetter').classList.toggle('met', letter);
  document.getElementById('ruleNumber').classList.toggle('met', number);
  return length && letter && number;
}

function updateSubmitState() {
  const ok = checkPasswordRules() && passwordEl.value === confirmEl.value && fullNameEl.value.trim().length >= 2;
  submitBtn.disabled = !ok;
}
passwordEl.addEventListener('input', updateSubmitState);
confirmEl.addEventListener('input', updateSubmitState);
fullNameEl.addEventListener('input', updateSubmitState);

// ===== ON LOAD: verify the invite session =====
// When the user clicks the magic link, Supabase picks up the auth tokens from the URL fragment automatically.
(async () => {
  const { data: { session }, error } = await db.auth.getSession();
  if (error || !session) {
    showInviteError('This invitation link is invalid or has expired. Please ask the Academic team for a new one.');
    return;
  }

  const recovery = urlSaysRecovery || sessionIsRecovery(session);

  try {
    const { data: profile } = await db.from('profiles')
      .select('role, full_name, first_login_at, is_active').eq('id', session.user.id).single();

    if (profile && !profile.is_active) {
      showInviteError('Your account has been deactivated. Contact the Academic team.');
      await db.auth.signOut();
      return;
    }
    if (recovery) {
      applyResetMode(profile);
    } else if (profile && profile.full_name && profile.first_login_at) {
      window.location.href = profile.role === 'academic' ? 'admin-dashboard.html' : 'exam/dashboard.html';
      return;
    }
  } catch (err) {
    // If profile lookup fails, fall through to setup form — better UX than blocking.
  }

  document.getElementById('email').value = session.user.email;
  updateSubmitState();
  loadingState.style.display = 'none';
  setupForm.style.display = 'block';
})();

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!checkPasswordRules()) { showSetupError('Password does not meet all requirements.'); return; }
  if (passwordEl.value !== confirmEl.value) { showSetupError('Passwords do not match.'); return; }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Setting up…';

  try {
    const { error: pwdErr } = await db.auth.updateUser({ password: passwordEl.value });
    if (pwdErr) throw pwdErr;

    const { data: { user } } = await db.auth.getUser();
    const updates = { full_name: fullNameEl.value.trim() };
    // Keep the original first-login timestamp when an existing user resets their password.
    const { data: current } = await db.from('profiles').select('first_login_at').eq('id', user.id).single();
    if (!current?.first_login_at) updates.first_login_at = new Date().toISOString();
    const { error: profErr } = await db.from('profiles').update(updates).eq('id', user.id);
    if (profErr) throw profErr;

    const { data: profile } = await db.from('profiles').select('role').eq('id', user.id).single();
    window.location.href = profile?.role === 'academic' ? 'admin-dashboard.html' : 'exam/dashboard.html';
  } catch (err) {
    showSetupError(err.message || 'Setup failed. Please try again.');
    submitBtn.disabled = false;
    submitBtn.textContent = isReset ? 'Save New Password' : 'Complete Setup';
  }
});
