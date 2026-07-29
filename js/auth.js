import { db } from './supabase-client.js';
import { basePath } from './config.js';

// Redirect based on role + setup status. Used right after sign-in and
// whenever an already-authenticated user lands on login.html.
export async function redirectByRole(userId) {
  const { data: profile, error } = await db.from('profiles')
    .select('role, is_active, full_name, first_login_at').eq('id', userId).single();

  if (error || !profile) {
    await db.auth.signOut();
    throw new Error('Could not load your profile. Contact the Academic team.');
  }
  if (!profile.is_active) {
    await db.auth.signOut();
    throw new Error('Your account has been deactivated. Contact the Academic team.');
  }
  if (!profile.full_name || !profile.first_login_at) {
    window.location.href = `${basePath()}setup-account.html`;
    return;
  }
  window.location.href = `${basePath()}${profile.role === 'academic' ? 'admin-dashboard.html' : 'exam/dashboard.html'}`;
}

// Call at the top of any protected page. Redirects to login.html if there's
// no session, and returns { session, profile } otherwise.
export async function requireAuth() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) {
    window.location.href = `${basePath()}login.html`;
    return null;
  }
  const { data: profile, error } = await db.from('profiles')
    .select('*').eq('id', session.user.id).single();
  if (error || !profile || !profile.is_active) {
    await db.auth.signOut();
    window.location.href = `${basePath()}login.html`;
    return null;
  }
  return { session, profile };
}

// Call after requireAuth() on pages restricted to specific roles (e.g. ['academic']).
export function requireRole(profile, roles) {
  if (!roles.includes(profile.role)) {
    window.location.href = `${basePath()}${profile.role === 'academic' ? 'admin-dashboard.html' : 'exam/dashboard.html'}`;
    return false;
  }
  return true;
}

export async function signOut() {
  await db.auth.signOut();
  window.location.href = `${basePath()}login.html`;
}
