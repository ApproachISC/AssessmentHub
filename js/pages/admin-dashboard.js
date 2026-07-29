import { db } from '../supabase-client.js';
import { SUPABASE_URL } from '../config.js';
import { requireAuth, requireRole } from '../auth.js';
import { renderNavbar, showToast, esc, openModal, closeModal, initTabs } from '../ui.js';

let currentUser = null;
let currentProfile = null;
let allClasses = [];
let allLevels = [];
let allUsers = [];
let editContext = null;

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ===========================================================
// CLASSES
// ===========================================================
async function loadClasses() {
  const { data, error } = await db.from('classes').select('*').order('name');
  if (error) {
    document.getElementById('classesBody').innerHTML =
      `<tr><td colspan="4"><div class="empty-state"><h3>Could not load</h3><p>${esc(error.message)}</p></div></td></tr>`;
    return;
  }
  allClasses = data || [];
  document.getElementById('countClasses').textContent = allClasses.filter(c => c.is_active).length;
  renderClasses();
}

function renderClasses() {
  const body = document.getElementById('classesBody');
  if (allClasses.length === 0) {
    body.innerHTML = `<tr><td colspan="4"><div class="empty-state">
      <div class="icon">⌗</div><h3>No classes yet</h3>
      <p>Add your first class using the form above.</p>
    </div></td></tr>`;
    return;
  }
  body.innerHTML = allClasses.map(c => `
    <tr class="${c.is_active ? '' : 'inactive'}">
      <td>${esc(c.name)}</td>
      <td><span class="chip ${c.is_active ? 'active' : 'deactivated'}">${c.is_active ? 'Active' : 'Inactive'}</span></td>
      <td>${formatDate(c.created_at)}</td>
      <td>
        <div class="row-actions">
          <button class="row-btn" data-edit-class="${c.id}">Edit</button>
          ${c.is_active
            ? `<button class="row-btn danger" data-toggle-class="${c.id}" data-active="false">Deactivate</button>`
            : `<button class="row-btn success" data-toggle-class="${c.id}" data-active="true">Activate</button>`}
        </div>
      </td>
    </tr>`).join('');
}

document.getElementById('addClassBtn').addEventListener('click', async () => {
  const name = document.getElementById('newClassName').value.trim();
  if (!name) return showToast('Class name is required', 'error');
  const btn = document.getElementById('addClassBtn');
  btn.disabled = true;
  try {
    const { error } = await db.from('classes').insert({ name });
    if (error) throw error;
    document.getElementById('newClassName').value = '';
    showToast('Class added', 'success');
    await loadClasses();
  } catch (err) {
    showToast(err.code === '23505' ? 'A class with that name already exists' : err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

function editClass(id) {
  const cls = allClasses.find(c => c.id === id);
  if (!cls) return;
  openEditModal({
    title: 'Edit Class',
    sub: 'Update the class name',
    fields: [{ name: 'name', label: 'Class Name', type: 'text', value: cls.name, required: true }],
    onSave: async (values) => {
      const { error } = await db.from('classes').update({ name: values.name.trim() }).eq('id', id);
      if (error) throw error;
      await loadClasses();
      showToast('Class updated', 'success');
    }
  });
}

async function toggleClass(id, active) {
  try {
    const { error } = await db.from('classes').update({ is_active: active }).eq('id', id);
    if (error) throw error;
    showToast(active ? 'Class activated' : 'Class deactivated', 'success');
    await loadClasses();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('classesBody').addEventListener('click', (e) => {
  const editBtn = e.target.closest('[data-edit-class]');
  if (editBtn) return editClass(editBtn.dataset.editClass);
  const toggleBtn = e.target.closest('[data-toggle-class]');
  if (toggleBtn) return toggleClass(toggleBtn.dataset.toggleClass, toggleBtn.dataset.active === 'true');
});

// ===========================================================
// LEVELS
// ===========================================================
async function loadLevels() {
  const { data, error } = await db.from('levels').select('*').order('display_order');
  if (error) {
    document.getElementById('levelsBody').innerHTML =
      `<tr><td colspan="4"><div class="empty-state"><h3>Could not load</h3><p>${esc(error.message)}</p></div></td></tr>`;
    return;
  }
  allLevels = data || [];
  document.getElementById('countLevels').textContent = allLevels.filter(l => l.is_active).length;
  renderLevels();
}

function renderLevels() {
  const body = document.getElementById('levelsBody');
  if (allLevels.length === 0) {
    body.innerHTML = `<tr><td colspan="4"><div class="empty-state">
      <div class="icon">⌗</div><h3>No levels yet</h3><p>Add your first level using the form above.</p>
    </div></td></tr>`;
    return;
  }
  body.innerHTML = allLevels.map(l => `
    <tr class="${l.is_active ? '' : 'inactive'}">
      <td style="font-family: var(--mono); color: var(--navy-l);">${l.display_order}</td>
      <td style="font-weight: 500;">${esc(l.name)}</td>
      <td><span class="chip ${l.is_active ? 'active' : 'deactivated'}">${l.is_active ? 'Active' : 'Inactive'}</span></td>
      <td>
        <div class="row-actions">
          <button class="row-btn" data-edit-level="${l.id}">Edit</button>
          ${l.is_active
            ? `<button class="row-btn danger" data-toggle-level="${l.id}" data-active="false">Deactivate</button>`
            : `<button class="row-btn success" data-toggle-level="${l.id}" data-active="true">Activate</button>`}
        </div>
      </td>
    </tr>`).join('');
}

document.getElementById('addLevelBtn').addEventListener('click', async () => {
  const name = document.getElementById('newLevelName').value.trim();
  const order = parseInt(document.getElementById('newLevelOrder').value, 10) || 0;
  if (!name) return showToast('Level name is required', 'error');
  const btn = document.getElementById('addLevelBtn');
  btn.disabled = true;
  try {
    const { error } = await db.from('levels').insert({ name, display_order: order });
    if (error) throw error;
    document.getElementById('newLevelName').value = '';
    document.getElementById('newLevelOrder').value = '';
    showToast('Level added', 'success');
    await loadLevels();
  } catch (err) {
    showToast(err.code === '23505' ? 'A level with that name already exists' : err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

function editLevel(id) {
  const lvl = allLevels.find(l => l.id === id);
  if (!lvl) return;
  openEditModal({
    title: 'Edit Level',
    sub: 'Update the level name and display order',
    fields: [
      { name: 'name', label: 'Level Name', type: 'text', value: lvl.name, required: true },
      { name: 'display_order', label: 'Display Order', type: 'number', value: lvl.display_order, required: true }
    ],
    onSave: async (values) => {
      const { error } = await db.from('levels').update({
        name: values.name.trim(),
        display_order: parseInt(values.display_order, 10) || 0
      }).eq('id', id);
      if (error) throw error;
      await loadLevels();
      showToast('Level updated', 'success');
    }
  });
}

async function toggleLevel(id, active) {
  try {
    const { error } = await db.from('levels').update({ is_active: active }).eq('id', id);
    if (error) throw error;
    showToast(active ? 'Level activated' : 'Level deactivated', 'success');
    await loadLevels();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('levelsBody').addEventListener('click', (e) => {
  const editBtn = e.target.closest('[data-edit-level]');
  if (editBtn) return editLevel(editBtn.dataset.editLevel);
  const toggleBtn = e.target.closest('[data-toggle-level]');
  if (toggleBtn) return toggleLevel(toggleBtn.dataset.toggleLevel, toggleBtn.dataset.active === 'true');
});

// ===========================================================
// USERS / TEACHERS
// ===========================================================
async function loadUsers() {
  const { data, error } = await db.from('profiles')
    .select('*').order('created_at', { ascending: false });
  if (error) {
    document.getElementById('usersBody').innerHTML =
      `<tr><td colspan="6"><div class="empty-state"><h3>Could not load</h3><p>${esc(error.message)}</p></div></td></tr>`;
    return;
  }
  allUsers = data || [];
  document.getElementById('countUsers').textContent = allUsers.filter(u => u.is_active).length;
  renderUsers();
}

function renderUsers() {
  const body = document.getElementById('usersBody');
  if (allUsers.length === 0) {
    body.innerHTML = `<tr><td colspan="6"><div class="empty-state">
      <div class="icon">⌗</div><h3>No users yet</h3>
      <p>Send your first invitation using the form above.</p>
    </div></td></tr>`;
    return;
  }
  body.innerHTML = allUsers.map(u => {
    let statusChip;
    if (!u.is_active) {
      statusChip = '<span class="chip deactivated">Deactivated</span>';
    } else if (!u.first_login_at) {
      statusChip = '<span class="chip pending">Pending</span>';
    } else {
      statusChip = '<span class="chip active">Active</span>';
    }
    const isPending = !u.first_login_at && u.is_active;
    const isSelf = u.id === currentUser.id;

    let actions = '';
    if (!isSelf) {
      if (isPending) {
        actions += `<button class="row-btn" data-resend="${u.id}">Resend</button>`;
        actions += `<button class="row-btn danger" data-delete-pending="${u.id}">Delete</button>`;
      } else if (u.is_active) {
        actions += `<button class="row-btn danger" data-toggle-user="${u.id}" data-active="false">Deactivate</button>`;
      } else {
        actions += `<button class="row-btn success" data-toggle-user="${u.id}" data-active="true">Reactivate</button>`;
      }
    } else {
      actions = '<span class="self-note">that&rsquo;s you</span>';
    }

    return `
      <tr class="${u.is_active ? '' : 'inactive'}">
        <td style="font-weight: 500;">${esc(u.full_name || '—')}</td>
        <td>${esc(u.email)}</td>
        <td><span class="chip role ${u.role}">${u.role === 'academic' ? 'Academic' : 'Teacher'}</span></td>
        <td>${statusChip}</td>
        <td>${formatDate(u.invited_at)}</td>
        <td><div class="row-actions">${actions}</div></td>
      </tr>`;
  }).join('');
}

// ===== INVITE =====
document.getElementById('inviteBtn').addEventListener('click', async () => {
  const email = document.getElementById('inviteEmail').value.trim();
  const role = document.getElementById('inviteRole').value;
  if (!email) return showToast('Email is required', 'error');

  const btn = document.getElementById('inviteBtn');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const { data: { session } } = await db.auth.getSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/invite-user`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, role })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Invite failed');

    document.getElementById('inviteEmail').value = '';
    showToast(`Invitation sent to ${email}`, 'success');
    await loadUsers();
  } catch (err) {
    showToast(err.message || 'Invite failed', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Invite';
  }
});

async function resendInvite(userId, email) {
  if (!confirm(`Resend the invitation email to ${email}?`)) return;
  try {
    const { data: { session } } = await db.auth.getSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/manage-user`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ action: 'resend_invite', email })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Resend failed');
    showToast(`Invitation resent to ${email}`, 'success');
    await loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deletePending(userId, email) {
  if (!confirm(`Delete the pending invitation for ${email}?\n\nThis cannot be undone.`)) return;
  try {
    const { data: { session } } = await db.auth.getSession();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/manage-user`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ action: 'delete_pending', user_id: userId })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Delete failed');
    showToast('Invitation deleted', 'success');
    await loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function toggleUser(id, active) {
  const verb = active ? 'reactivate' : 'deactivate';
  const user = allUsers.find(u => u.id === id);
  if (!confirm(`${verb.charAt(0).toUpperCase() + verb.slice(1)} ${user?.full_name || user?.email}?`)) return;
  try {
    const { error } = await db.from('profiles').update({ is_active: active }).eq('id', id);
    if (error) throw error;
    showToast(`User ${verb}d`, 'success');
    await loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('usersBody').addEventListener('click', (e) => {
  const resendBtn = e.target.closest('[data-resend]');
  if (resendBtn) {
    const u = allUsers.find(x => x.id === resendBtn.dataset.resend);
    return resendInvite(resendBtn.dataset.resend, u?.email || '');
  }
  const deleteBtn = e.target.closest('[data-delete-pending]');
  if (deleteBtn) {
    const u = allUsers.find(x => x.id === deleteBtn.dataset.deletePending);
    return deletePending(deleteBtn.dataset.deletePending, u?.email || '');
  }
  const toggleBtn = e.target.closest('[data-toggle-user]');
  if (toggleBtn) return toggleUser(toggleBtn.dataset.toggleUser, toggleBtn.dataset.active === 'true');
});

// ===========================================================
// EXAMS / ASSESSMENTS COUNT
// ===========================================================
async function loadExamsCount() {
  const { count } = await db.from('exams').select('*', { count: 'exact', head: true });
  document.getElementById('countExams').textContent = count ?? '—';
}

async function loadAssessmentsCount() {
  const { count } = await db.from('assessments').select('*', { count: 'exact', head: true });
  document.getElementById('countAssessments').textContent = count ?? '—';
}

// ===========================================================
// GENERIC EDIT MODAL
// ===========================================================
function openEditModal({ title, sub, fields, onSave }) {
  editContext = { onSave };
  document.getElementById('editModalTitle').textContent = title;
  document.getElementById('editModalSub').textContent = sub;
  const fieldsContainer = document.getElementById('editFields');
  fieldsContainer.innerHTML = fields.map(f => `
    <div class="field">
      <label for="edit_${f.name}">${esc(f.label)}</label>
      <input type="${f.type}" id="edit_${f.name}" name="${f.name}" value="${esc(f.value)}" ${f.required ? 'required' : ''}>
    </div>
  `).join('');
  openModal('editModal');
}

function closeEditModal() {
  closeModal('editModal');
  editContext = null;
}

document.getElementById('editCancelBtn').addEventListener('click', closeEditModal);

document.getElementById('editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editContext) return;
  const values = {};
  e.target.querySelectorAll('input').forEach(i => values[i.name] = i.value);
  try {
    await editContext.onSave(values);
    closeEditModal();
  } catch (err) {
    showToast(err.message || 'Save failed', 'error');
  }
});

document.getElementById('editModal').addEventListener('click', (e) => {
  if (e.target.id === 'editModal') closeEditModal();
});

// ===========================================================
// INIT
// ===========================================================
(async () => {
  const auth = await requireAuth();
  if (!auth) return;
  if (!requireRole(auth.profile, ['academic'])) return;

  currentUser = auth.session.user;
  currentProfile = auth.profile;

  renderNavbar(document.getElementById('navbarContainer'), { profile: currentProfile, active: 'admin' });
  initTabs(document.getElementById('tabs'));

  document.getElementById('authLoading').style.display = 'none';
  document.getElementById('page').style.display = 'block';

  await Promise.all([
    loadClasses(),
    loadLevels(),
    loadUsers(),
    loadExamsCount(),
    loadAssessmentsCount()
  ]);
})();
