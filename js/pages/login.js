import { db } from '../supabase-client.js';
import { redirectByRole } from '../auth.js';

const errorAlert = document.getElementById('errorAlert');
const successAlert = document.getElementById('successAlert');
const signInBtn = document.getElementById('signInBtn');

function showError(msg) {
  errorAlert.textContent = msg;
  errorAlert.classList.add('show');
  successAlert.classList.remove('show');
}

// If already logged in, redirect immediately.
(async () => {
  const { data: { session } } = await db.auth.getSession();
  if (session) {
    try { await redirectByRole(session.user.id); } catch (err) { showError(err.message); }
  }
})();

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  signInBtn.disabled = true;
  signInBtn.textContent = 'Signing in…';
  errorAlert.classList.remove('show');

  try {
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await redirectByRole(data.user.id);
  } catch (err) {
    showError(err.message || 'Sign-in failed. Please check your credentials.');
    signInBtn.disabled = false;
    signInBtn.textContent = 'Sign In';
  }
});
