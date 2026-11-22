// Placement Test results list (placement/results.html?test=<id>) — academics only.
import { db } from '../supabase-client.js';
import { requireAuth, requireRole } from '../auth.js';
import { renderNavbar, showToast, esc } from '../ui.js';
import { fmtDate, fmtDuration, proctorFlags } from '../placement-common.js';

const $ = id => document.getElementById(id);
const testId = new URLSearchParams(location.search).get('test');
let test = null, subs = [];

async function load() {
  const { data, error } = await db.from('placement_submissions')
    .select('id, code, full_name, email, status, started_at, submitted_at, time_used_seconds, timed_out, scores, placement, final_group, final_level, writing_grades, reviewed_at, proctoring')
    .eq('test_id', testId).order('started_at', { ascending: false });
  if (error) throw error;
  subs = data || [];
  const levels = [...new Set(subs.map(s => s.placement?.level).filter(Boolean))];
  const order = (test.placement_scale || []).map(r => r.level);
  levels.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  $('fLevel').innerHTML = '<option value="">All levels</option>' + levels.map(l => `<option>${esc(l)}</option>`).join('');
  render();
}

function filtered() {
  const q = $('search').value.trim().toLowerCase(), st = $('fStatus').value, rv = $('fReview').value, lv = $('fLevel').value;
  return subs.filter(s => (!st || s.status === st)
    && (!rv || (rv === 'done' ? !!s.final_level : s.status === 'submitted' && !s.final_level))
    && (!lv || s.placement?.level === lv)
    && (!q || `${s.full_name} ${s.email} ${s.code}`.toLowerCase().includes(q)));
}

function render() {
  const done = subs.filter(s => s.status === 'submitted');
  $('statSubmitted').textContent = done.length;
  $('statProgress').textContent = subs.filter(s => s.status === 'in_progress').length;
  $('statReviewed').textContent = subs.filter(s => s.final_level).length;
  const scored = done.filter(s => s.scores);
  $('statAvg').textContent = scored.length
    ? `${(scored.reduce((n, s) => n + Number(s.scores.correct), 0) / scored.length).toFixed(1)}` : '—';

  const list = filtered();
  $('rows').innerHTML = list.length ? list.map(s => {
    const flags = proctorFlags(s.proctoring);
    const sug = s.placement?.level ? `${esc(s.placement.level)}<div class="field-help">${esc(s.placement.group || '')}</div>` : (s.status === 'submitted' ? '<span class="field-help">Outside scale</span>' : '—');
    const fin = s.final_level
      ? `<b>${esc(s.final_level)}</b>${s.final_level !== s.placement?.level ? '<div class="field-help">changed</div>' : ''}`
      : (s.status === 'submitted' ? '<span class="chip upcoming">To review</span>' : '—');
    return `<tr>
      <td><a class="pl-title-link" href="result.html?id=${s.id}">${esc(s.full_name)}</a><div class="field-help">${esc(s.email)}</div></td>
      <td class="code-cell">${s.code}</td>
      <td><span class="chip ${s.status}">${s.status === 'submitted' ? 'Submitted' : 'Taking now'}</span></td>
      <td>${fmtDate(s.submitted_at || s.started_at)}</td>
      <td>${fmtDuration(s.time_used_seconds)}${s.timed_out ? '<div class="field-help">time ran out</div>' : ''}</td>
      <td>${s.scores ? `<b>${s.scores.correct}</b> / ${s.scores.total}` : '—'}</td>
      <td>${sug}</td>
      <td>${fin}</td>
      <td>${flags.total ? `<span class="chip flagged" title="${esc(flags.text)}">${flags.total} event${flags.total === 1 ? '' : 's'}</span>` : '—'}</td>
      <td><div class="row-actions">
        <a class="row-btn" href="result.html?id=${s.id}">${s.status === 'submitted' ? 'Review' : 'View'}</a>
        ${s.status === 'in_progress' ? `<button class="row-btn archive" data-force="${s.id}">Force submit</button>` : ''}
      </div></td></tr>`;
  }).join('') : `<tr><td colspan="10"><div class="empty-state"><p>${subs.length ? 'No students match the filters.' : 'No one has taken this test yet.'}</p></div></td></tr>`;
  $('countInfo').textContent = `${list.length} of ${subs.length} attempts shown`;
}

['search', 'fStatus', 'fReview', 'fLevel'].forEach(id => $(id).addEventListener('input', render));

$('rows').addEventListener('click', async e => {
  const b = e.target.closest('[data-force]');
  if (!b) return;
  const s = subs.find(x => x.id === b.dataset.force);
  if (!confirm(`Force-submit ${s.full_name}'s test now? Their answers so far are scored, and the code cannot be used again.`)) return;
  b.disabled = true;
  const { error } = await db.rpc('placement_force_submit', { p_id: s.id });
  if (error) { showToast(error.message, 'error', 6000); b.disabled = false; return; }
  showToast('Test submitted.', 'success');
  load();
});

$('csvBtn').onclick = () => {
  const secs = test.definition?.sections || [];
  const head = ['name', 'email', 'code', 'status', 'started_at', 'submitted_at', 'minutes_used', 'timed_out', 'correct', 'total',
    ...secs.map(s => `${s.title} correct`), 'suggested_group', 'suggested_level', 'final_group', 'final_level', 'writing_levels',
    'tab_switches', 'window_blur', 'fullscreen_exits'];
  const rows = filtered().map(s => [
    s.full_name, s.email, s.code, s.status, s.started_at, s.submitted_at || '', Math.round((s.time_used_seconds || 0) / 60), s.timed_out ? 'yes' : '',
    s.scores?.correct ?? '', s.scores?.total ?? '',
    ...secs.map(sec => s.scores?.sections?.[sec.id]?.correct ?? ''),
    s.placement?.group || '', s.placement?.level || '', s.final_group || '', s.final_level || '',
    Object.values(s.writing_grades || {}).map(w => w.level).filter(Boolean).join(' / '),
    s.proctoring?.tab_switches ?? 0, s.proctoring?.window_blur_events ?? 0, s.proctoring?.fullscreen_exits ?? 0,
  ]);
  const csv = [head, ...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = `placement-results-${test.title.replace(/[^\w]+/g, '-').toLowerCase()}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
};

(async function init() {
  const auth = await requireAuth();
  if (!auth || !requireRole(auth.profile, ['academic'])) return;
  renderNavbar($('navbarContainer'), { profile: auth.profile, active: 'admin' });
  if (!testId) { location.href = 'dashboard.html'; return; }
  try {
    const { data, error } = await db.from('placement_tests').select('id, title, placement_scale, definition').eq('id', testId).single();
    if (error) throw error;
    test = data;
    $('testTitle').innerHTML = `${esc(test.title)} <em>results</em>`;
    $('editLink').href = `edit.html?id=${testId}`;
    $('codesLink').href = `codes.html?test=${testId}`;
    await load();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Could not load results.', 'error', 6000);
  }
  $('authLoading').style.display = 'none';
  $('page').style.display = 'block';
})();
