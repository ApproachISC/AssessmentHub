// Placement Test — one student's attempt (placement/result.html?id=<submissionId>) — academics only.
// Shows every answer against the key, the server score + suggested level, writing for the teacher
// to grade (extra information only), proctoring, and lets the academic set the final level.
import { db } from '../supabase-client.js';
import { requireAuth, requireRole } from '../auth.js';
import { renderNavbar, showToast, esc } from '../ui.js';
import { SECTION_TYPES, fmtDateTime, fmtDuration } from '../placement-common.js';

const $ = id => document.getElementById(id);
const subId = new URLSearchParams(location.search).get('id');
let profile = null, sub = null, test = null, writing = {};

const KEYS = 'ABCDEF';
const optionsOf = q => (q.type === 'true_false' ? ['True', 'False'] : q.options || []);
const wordCount = t => (String(t || '').trim().match(/\S+/g) || []).length;
const scaleOptions = (sel, blankLabel) => `<option value="">${blankLabel}</option>` +
  (test.placement_scale || []).map((r, i) => `<option value="${i}"${sel === r.level ? ' selected' : ''}>${esc(r.group ? `${r.group} · ${r.level}` : r.level)}</option>`).join('');

function promptHTML(q, sel) {
  const parts = String(q.prompt || '').split('___');
  if (parts.length === 1) return esc(q.prompt);
  const fill = sel != null ? `<u>${esc(optionsOf(q)[sel] ?? '?')}</u>` : '_____';
  return parts.map(esc).join(fill);
}

function renderAnswers() {
  const answers = sub.answers || {}, prog = sub.progress || {}, skipped = prog.skipped || {}, plays = prog.plays || {};
  const html = (test.definition?.sections || []).map((sec, si) => {
    const T = SECTION_TYPES[sec.type] || {};
    let n = 0, correct = 0, total = 0;
    const groups = (sec.groups || []).map((g, gi) => {
      const st = g.stimulus;
      let head = '';
      if (st) {
        const extra = st.kind === 'audio' ? ` · played ${plays[g.id] || 0} of ${st.maxPlays || 2}` : '';
        head = `<div class="pl-rev-stim"><span class="pl-gl">${T.group || 'Group'} ${gi + 1}</span> <span class="pl-gt">${esc(st.title || '')}</span><span class="field-help">${extra}</span></div>`;
      }
      const qs = (g.questions || []).map(q => {
        n++;
        const v = answers[q.id];
        if (q.type === 'essay') return essayHTML(q, v, n);
        total++;
        const answered = v != null, ok = answered && v === q.answer;
        if (ok) correct++;
        const chip = !answered ? `<span class="q-grade-chip blank">${skipped[q.id] ? 'Skipped' : 'No answer'}</span>`
          : ok ? '<span class="q-grade-chip correct">Correct</span>' : '<span class="q-grade-chip incorrect">Incorrect</span>';
        const opts = optionsOf(q).map((o, k) => {
          const cls = k === q.answer ? 'key' : k === v ? 'wrong' : '';
          const mark = k === q.answer ? '✓' : k === v ? '✗' : '';
          return `<li class="${cls}"><span class="pl-k">${q.type === 'true_false' ? 'TF'[k] : KEYS[k]}</span><span>${esc(o)}</span>${k === v ? '<em>student</em>' : ''}<b>${mark}</b></li>`;
        }).join('');
        return `<div class="question-block ${!answered ? '' : ok ? 'correct' : 'incorrect'}">
          <div class="q-header"><span class="q-id">Q${n}</span><span class="q-prompt">${promptHTML(q, v)}</span><span class="q-meta">${chip}</span></div>
          <ul class="pl-optlist">${opts}</ul></div>`;
      }).join('');
      return head + qs;
    }).join('');
    const score = total ? `<span class="q-points-badge">${correct} / ${total} correct</span>` : '<span class="q-points-badge">Teacher graded</span>';
    return `<div class="card pl-rev-sec">
      <div class="card-header"><div><div class="section-label">Section ${si + 1} · ${esc(T.label || sec.type)}</div>
        <div class="card-title">${esc(sec.title)}</div></div>${score}</div>
      <div class="section-questions">${groups || '<p class="field-help">No questions.</p>'}</div></div>`;
  }).join('');
  $('answers').innerHTML = html || '<div class="card"><p>This test has no sections.</p></div>';
}

function essayHTML(q, v, n) {
  v = v || {};
  const g = writing[q.id] || {};
  const words = wordCount(v.text);
  const topic = q.topics?.length ? (v.topic != null ? `${v.topic + 1}. ${esc(q.topics[v.topic])}` : '<i>No topic chosen</i>') : '';
  return `<div class="question-block">
    <div class="q-header"><span class="q-id">Q${n}</span><span class="q-prompt">${esc(q.prompt)}</span>
      <span class="q-meta"><span class="q-points-badge">${words} words</span></span></div>
    ${topic ? `<div class="sub-row"><span class="sub-label">Topic</span><span>${topic}</span></div>` : ''}
    <div class="pl-essay">${v.text ? esc(v.text) : '<i>The student did not write anything.</i>'}</div>
    <div class="field-help" style="margin:0.4rem 0 0.8rem;">Guidance: ${q.min_words || 0}–${q.max_words || '∞'} words${q.max_words && words > q.max_words ? ' · over the limit' : q.min_words && words < q.min_words ? ' · under the minimum' : ''}</div>
    <div class="pl-grid2">
      <div class="field"><label>Writing level <span class="field-help">(extra information, does not change the score)</span></label>
        <select data-wlevel="${q.id}">${scaleOptions(g.level, 'Not graded yet')}</select></div>
      <div class="field"><label>Comment</label><textarea data-wcomment="${q.id}" class="reviewer-notes-input" rows="2">${esc(g.comment || '')}</textarea></div>
    </div></div>`;
}

function renderSide() {
  const sc = sub.scores, pl = sub.placement;
  $('pScore').textContent = sc ? sc.correct : '—';
  $('pTotal').textContent = sc ? ` / ${sc.total} correct` : sub.status === 'in_progress' ? 'scored at submit' : '';
  $('pSuggested').textContent = pl?.level ? `${pl.group ? `${pl.group} · ` : ''}${pl.level}` : (sc ? 'Outside the scale' : '—');
  $('pSections').innerHTML = (test.definition?.sections || []).filter(s => sc?.sections?.[s.id])
    .map(s => `<div class="summary-row"><span class="label">${esc(s.title)}</span><span class="value">${sc.sections[s.id].correct} / ${sc.sections[s.id].total}</span></div>`).join('');
  $('finalLevel').innerHTML = scaleOptions(sub.final_level || pl?.level || null, 'Choose a level');
  $('notes').value = sub.reviewer_notes || '';
  const done = sub.status === 'submitted';
  $('finalLevel').disabled = $('saveBtn').disabled = !done;
  $('reviewedInfo').textContent = sub.reviewed_at
    ? `Last saved ${fmtDateTime(sub.reviewed_at)}${sub.reviewer?.full_name ? ` by ${sub.reviewer.full_name}` : ''}.`
    : done ? 'Final level not saved yet.' : 'You can set the final level after the student submits.';

  const p = sub.proctoring || {};
  $('prTab').textContent = p.tab_switches || 0;
  $('prBlur').textContent = p.window_blur_events || 0;
  $('prFs').textContent = p.fullscreen_exits || 0;
  $('prPaste').textContent = `${p.paste_blocked || 0} / ${p.copy_blocked || 0}`;
  ['prTab', 'prBlur', 'prFs'].forEach(id => $(id).classList.toggle('pl-alert', +$(id).textContent > 0));
  const log = p.event_log || [];
  $('prLog').innerHTML = log.length ? log.map(e => `<li><span class="field-help">${fmtDateTime(e.ts)}</span> ${esc(e.type.replace(/_/g, ' '))}${e.detail ? ` — ${esc(e.detail)}` : ''}</li>`).join('') : '<li class="field-help">No events.</li>';
  $('forcePanel').hidden = sub.status !== 'in_progress';
}

function renderMeta() {
  $('studentName').textContent = sub.full_name;
  $('testName').textContent = test.title;
  $('resultsCrumb').href = `results.html?test=${test.id}`;
  $('mEmail').textContent = sub.email;
  $('mCode').textContent = sub.code;
  $('mStatus').innerHTML = `<span class="chip ${sub.status}">${sub.status === 'submitted' ? 'Submitted' : 'Taking now'}</span>`;
  $('mStarted').textContent = fmtDateTime(sub.started_at);
  $('mSubmitted').textContent = sub.submitted_at ? fmtDateTime(sub.submitted_at) : '—';
  $('mTime').textContent = fmtDuration(sub.time_used_seconds) + (sub.timed_out ? ' (time ran out)' : '');
  if (sub.status === 'in_progress') {
    const prog = sub.progress || {}, sec = test.definition?.sections?.[prog.si || 0];
    $('progressAlert').innerHTML = `<div><b>This student has not submitted yet.</b>Now on: ${esc(sec?.title || 'the start')}${prog.phase === 'q' ? `, question ${(prog.pos || 0) + 1}` : ''}. Last activity ${fmtDateTime(sub.last_seen_at)}. Answers below are what has been saved so far.</div>`;
    $('progressAlert').classList.add('show');
  }
}

async function load() {
  const { data, error } = await db.from('placement_submissions')
    .select('*, reviewer:profiles!placement_submissions_reviewed_by_fkey(full_name), test:placement_tests(id, title, definition, placement_scale)')
    .eq('id', subId).single();
  if (error) throw error;
  sub = data; test = data.test; writing = JSON.parse(JSON.stringify(sub.writing_grades || {}));
  renderMeta(); renderAnswers(); renderSide();
}

// writing grade inputs
document.addEventListener('change', e => {
  const id = e.target.dataset.wlevel;
  if (id) { const r = test.placement_scale[+e.target.value]; (writing[id] ||= {}).level = r ? r.level : null; }
});
document.addEventListener('input', e => {
  const id = e.target.dataset.wcomment;
  if (id) (writing[id] ||= {}).comment = e.target.value;
});

$('saveBtn').onclick = async () => {
  const r = test.placement_scale[+$('finalLevel').value];
  if (!r || $('finalLevel').value === '') { showToast('Choose the final level first.', 'error'); return; }
  $('saveBtn').disabled = true;
  const patch = {
    final_group: r.group || null, final_level: r.level, reviewer_notes: $('notes').value.trim() || null,
    writing_grades: writing, reviewed_by: profile.id, reviewed_at: new Date().toISOString(),
  };
  const { error } = await db.from('placement_submissions').update(patch).eq('id', subId);
  $('saveBtn').disabled = false;
  if (error) { showToast(error.message, 'error', 6000); return; }
  Object.assign(sub, patch, { reviewer: { full_name: profile.full_name } });
  renderSide();
  showToast('Review saved.', 'success');
};

$('forceBtn').onclick = async () => {
  if (!confirm(`Force-submit ${sub.full_name}'s test now? Their answers so far are scored, and the code cannot be used again.`)) return;
  $('forceBtn').disabled = true;
  const { error } = await db.rpc('placement_force_submit', { p_id: subId });
  if (error) { showToast(error.message, 'error', 6000); $('forceBtn').disabled = false; return; }
  showToast('Test submitted.', 'success');
  await load();
};

(async function init() {
  const auth = await requireAuth();
  if (!auth || !requireRole(auth.profile, ['academic'])) return;
  profile = auth.profile;
  renderNavbar($('navbarContainer'), { profile, active: 'admin' });
  if (!subId) { location.href = 'dashboard.html'; return; }
  try { await load(); } catch (err) {
    console.error(err);
    $('authLoading').innerHTML = `<h2>Could not load this attempt</h2><p>${esc(err.message || '')}</p><a class="btn btn--secondary" href="dashboard.html">Back to Placement Tests</a>`;
    return;
  }
  $('authLoading').style.display = 'none';
  $('page').style.display = 'block';
})();
