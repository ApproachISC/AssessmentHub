import { db } from '../supabase-client.js';
import { requireAuth } from '../auth.js';
import { renderNavbar, showToast, esc, openModal, closeModal } from '../ui.js';
import {
  NOT_OBSERVED, formatDay, maxPoints, passMark, computeGrade, sectionTotals,
  gradeBand, formatGrade, loadPeople, personName, sectionLetter,
} from '../evaluation-common.js';

const SAVE_DELAY_MS = 900;

let currentProfile = null;
let ev = null, def = null, people = [], classes = [];
let saveTimer = null, saving = false, dirty = false;

function showError(title, message) {
  document.getElementById('authLoading').style.display = 'none';
  document.getElementById('errorTitle').textContent = title;
  document.getElementById('errorMessage').textContent = message;
  document.getElementById('errorScreen').style.display = 'block';
}

// ============================================================
// RENDER
// ============================================================
function renderHeader() {
  const name = personName(people, ev.evaluatee_id);
  const cls = classes.find(c => c.id === ev.class_id)?.name || '—';
  document.getElementById('pageTitle').innerHTML = `${esc(name)} <em>· ${esc(cls)}</em>`;
  document.getElementById('bcTitle').textContent = `${name} — ${formatDay(ev.class_date)}`;
  document.title = `Evaluation: ${name} — Approach International Student Center`;
}

function renderDetails() {
  document.getElementById('detEvaluatee').innerHTML = people
    .filter(p => p.id !== currentProfile.id && (p.is_active || p.id === ev.evaluatee_id))
    .map(p => `<option value="${p.id}" ${p.id === ev.evaluatee_id ? 'selected' : ''}>${esc(p.full_name)}</option>`).join('');
  document.getElementById('detClass').innerHTML = classes
    .filter(c => c.is_active || c.id === ev.class_id)
    .map(c => `<option value="${c.id}" ${c.id === ev.class_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  document.getElementById('detDate').value = ev.class_date;

  const details = ev.responses.details || {};
  document.getElementById('detailFields').innerHTML = (def.detail_fields || []).map(f => `
    <div class="field${f.type === 'number' ? '' : ' full'}">
      <label for="det_${esc(f.id)}">${esc(f.label)}</label>
      <input type="${f.type === 'number' ? 'number' : 'text'}" ${f.type === 'number' ? 'min="0"' : ''}
        id="det_${esc(f.id)}" data-detail="${esc(f.id)}" value="${esc(details[f.id] ?? '')}">
    </div>`).join('');
}

function renderScale() {
  document.getElementById('scaleLegend').innerHTML = [...(def.scale || [])]
    .sort((a, b) => b.value - a.value)
    .map(s => `<div class="eval-scale-item"><span class="eval-scale-value">${s.value}</span><div><strong>${esc(s.label)}</strong><span>${esc(s.description || '')}</span></div></div>`)
    .join('') + (def.allow_not_observed !== false
      ? `<div class="eval-scale-item"><span class="eval-scale-value">NO</span><div><strong>Not observed</strong><span>No chance to show it in this lesson; left out of the grade</span></div></div>`
      : '');
  const items = (def.sections || []).reduce((n, s) => n + (s.items || []).length, 0);
  document.getElementById('scaleHelp').textContent =
    `${items} items × ${maxPoints(def)} points. Grade = points earned ÷ points possible × 100 (items marked "Not observed" are left out). Pass mark: ${passMark(def)}.`;
}

function scoreButtons(itemId) {
  const v = ev.responses.scores?.[itemId];
  const values = [...(def.scale || [])].map(s => Number(s.value)).sort((a, b) => b - a);
  const btns = values.map(val => {
    const label = def.scale.find(s => Number(s.value) === val)?.label || '';
    return `<button type="button" class="eval-score-btn${v === val ? ' selected' : ''}" data-item="${esc(itemId)}" data-score="${val}" title="${esc(label)}" aria-pressed="${v === val}">${val}</button>`;
  });
  if (def.allow_not_observed !== false) {
    btns.push(`<button type="button" class="eval-score-btn no${v === NOT_OBSERVED ? ' selected' : ''}" data-item="${esc(itemId)}" data-score="${NOT_OBSERVED}" title="Not observed" aria-pressed="${v === NOT_OBSERVED}">NO</button>`);
  }
  return `<div class="eval-score" role="group" aria-label="Score">${btns.join('')}</div>`;
}

function shareSwitch(id) {
  const on = ev.shared_sections.includes(id);
  return `<label class="eval-share" title="Let the teacher see this section once finalized">
    <span>Share with teacher</span>
    <span class="switch"><input type="checkbox" data-share="${esc(id)}" ${on ? 'checked' : ''}><span class="track"></span></span>
  </label>`;
}

function renderSections() {
  let n = 0;
  document.getElementById('sectionsRoot').innerHTML = (def.sections || []).map((s, si) => `
    <section class="panel eval-section" data-section="${esc(s.id)}">
      <div class="eval-section-head">
        <div>
          <div class="section-label">Section ${sectionLetter(si)}</div>
          <h3 class="section-title-text">${esc(s.title)}</h3>
        </div>
        <div class="eval-section-side">
          <span class="q-points-badge" data-section-total="${esc(s.id)}">—</span>
          ${shareSwitch(s.id)}
        </div>
      </div>
      <div class="eval-items">
        ${(s.items || []).map(it => {
          n++;
          const note = ev.responses.notes?.[it.id] || '';
          return `<div class="eval-item" data-item-row="${esc(it.id)}">
            <div class="eval-item-main">
              <span class="q-id">${n}</span>
              <div class="eval-item-text">${esc(it.text)}</div>
              ${scoreButtons(it.id)}
            </div>
            <div class="eval-item-note${note ? ' open' : ''}">
              <button type="button" class="eval-note-toggle" data-note-toggle="${esc(it.id)}">${note ? 'Note' : '+ Add note'}</button>
              <textarea class="reviewer-notes-input eval-note-input" data-note="${esc(it.id)}" rows="2" placeholder="What you saw (optional)">${esc(note)}</textarea>
            </div>
          </div>`;
        }).join('')}
      </div>
    </section>`).join('');
}

function renderComments() {
  const comments = ev.responses.comments || {};
  const fields = def.comment_fields || [];
  document.getElementById('commentsRoot').innerHTML = fields.length ? `
    <section class="panel eval-section">
      <div class="eval-section-head"><div><div class="section-label">Comments</div><h3 class="section-title-text">Comments and goals</h3></div></div>
      ${fields.map(f => `
        <div class="eval-comment">
          <div class="eval-comment-head"><label for="cm_${esc(f.id)}">${esc(f.label)}</label>${shareSwitch(f.id)}</div>
          ${f.hint ? `<p class="field-help">${esc(f.hint)}</p>` : ''}
          <textarea class="reviewer-notes-input" id="cm_${esc(f.id)}" data-comment="${esc(f.id)}" rows="3">${esc(comments[f.id] || '')}</textarea>
        </div>`).join('')}
    </section>` : '';
}

function updateSummary() {
  const scores = ev.responses.scores || {};
  const g = computeGrade(def, scores);
  const totalItems = (def.sections || []).reduce((n, s) => n + (s.items || []).length, 0);
  const answered = totalItems - g.unanswered;

  document.getElementById('gradeValue').textContent = formatGrade(g.grade);
  const band = gradeBand(def, g.grade);
  const bandEl = document.getElementById('gradeBand');
  if (g.grade == null) {
    bandEl.textContent = 'Score items to see the grade';
    bandEl.className = 'eval-grade-band';
  } else {
    const pass = g.grade >= passMark(def);
    bandEl.textContent = `${band || ''} · ${pass ? 'Passing' : `Below ${passMark(def)}`}`;
    bandEl.className = `eval-grade-band ${pass ? 'pass' : 'fail'}`;
  }
  document.getElementById('progressFill').style.width = `${totalItems ? answered / totalItems * 100 : 0}%`;
  document.getElementById('progressLabel').textContent = `${answered} of ${totalItems} items answered · ${g.earned}/${g.possible} points`;

  document.getElementById('sectionSummary').innerHTML = (def.sections || []).map((s, si) => {
    const t = sectionTotals(def, s, scores);
    document.querySelector(`[data-section-total="${CSS.escape(s.id)}"]`).textContent =
      t.possible === t.full ? `${t.earned}/${t.full}` : `${t.earned}/${t.possible} (of ${t.full})`;
    return `<div class="summary-row"><span class="label">${sectionLetter(si)}. ${esc(s.title)}</span><span class="value">${t.earned}/${t.possible || t.full}</span></div>`;
  }).join('');

  const sharedLabels = sharedSectionLabels();
  document.getElementById('shareSummary').innerHTML = sharedLabels.length
    ? `They'll see their final grade plus:<br>${sharedLabels.map(l => `• ${esc(l)}`).join('<br>')}`
    : 'Nothing is shared yet. They\'ll only see their final grade.';
}

function sharedSectionLabels() {
  return [
    ...(def.sections || []).map((s, si) => ({ s, si }))
      .filter(({ s }) => ev.shared_sections.includes(s.id))
      .map(({ s, si }) => `${sectionLetter(si)}. ${s.title}`),
    ...(def.comment_fields || []).filter(f => ev.shared_sections.includes(f.id)).map(f => f.label),
  ];
}

// ============================================================
// SAVE (debounced autosave of the editable columns only)
// ============================================================
function setSaveStatus(text, cls = '') {
  const el = document.getElementById('saveStatus');
  el.textContent = text;
  el.className = `eval-save-status ${cls}`;
}

function scheduleSave() {
  dirty = true;
  setSaveStatus('Unsaved changes…', 'pending');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
}

async function save() {
  clearTimeout(saveTimer);
  if (saving) { saveTimer = setTimeout(save, SAVE_DELAY_MS); return false; }
  if (!dirty) return true;
  saving = true;
  dirty = false;
  setSaveStatus('Saving…', 'pending');
  try {
    const { data, error } = await db.from('evaluations').update({
      evaluatee_id: ev.evaluatee_id,
      class_id: ev.class_id,
      class_date: ev.class_date,
      responses: ev.responses,
      shared_sections: ev.shared_sections,
    }).eq('id', ev.id).select('id, grade, updated_at');
    if (error) throw error;
    if (!data?.length) throw new Error('This evaluation is no longer editable (it may have been finalized).');
    setSaveStatus(`Saved ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`, 'ok');
    return true;
  } catch (err) {
    dirty = true;
    setSaveStatus('Not saved — ' + err.message, 'error');
    showToast('Save failed: ' + err.message, 'error');
    return false;
  } finally {
    saving = false;
  }
}

async function flushSave() {
  while (saving) await new Promise(r => setTimeout(r, 100));
  return save();
}

// ============================================================
// FINALIZE / DELETE
// ============================================================
function startFinalize() {
  const g = computeGrade(def, ev.responses.scores || {});
  if (g.unanswered > 0) {
    const first = (def.sections || []).flatMap(s => s.items || [])
      .find(it => typeof ev.responses.scores?.[it.id] !== 'number' && ev.responses.scores?.[it.id] !== NOT_OBSERVED);
    document.querySelectorAll('.eval-item.missing').forEach(el => el.classList.remove('missing'));
    (def.sections || []).flatMap(s => s.items || []).forEach(it => {
      const v = ev.responses.scores?.[it.id];
      if (typeof v !== 'number' && v !== NOT_OBSERVED) {
        document.querySelector(`[data-item-row="${CSS.escape(it.id)}"]`)?.classList.add('missing');
      }
    });
    document.querySelector(`[data-item-row="${CSS.escape(first.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return showToast(`${g.unanswered} item(s) still need a score (or "NO" for not observed)`, 'error', 5000);
  }
  if (g.possible === 0) return showToast('At least one item must be scored', 'error');

  const name = personName(people, ev.evaluatee_id);
  const band = gradeBand(def, g.grade);
  document.getElementById('finalizeSub').textContent =
    `${name} · ${formatDay(ev.class_date)} · Grade ${formatGrade(g.grade)}/100${band ? ` (${band})` : ''}`;
  const shared = sharedSectionLabels();
  document.getElementById('finalizeShare').innerHTML = shared.length
    ? `${esc(name)} will see the final grade and: <strong>${shared.map(esc).join(', ')}</strong>. Everything else stays private.`
    : `${esc(name)} will see <strong>only the final grade</strong>. No sections are shared.`;
  document.getElementById('finalizeAgree').checked = false;
  document.getElementById('finalizeConfirmBtn').disabled = true;
  openModal('finalizeModal');
}

async function confirmFinalize() {
  const btn = document.getElementById('finalizeConfirmBtn');
  btn.disabled = true;
  btn.textContent = 'Signing…';
  try {
    if (!(await flushSave())) throw new Error('Could not save the latest changes');
    const { error } = await db.rpc('finalize_evaluation', { p_id: ev.id });
    if (error) throw error;
    window.location.href = `view.html?id=${ev.id}&finalized=1`;
  } catch (err) {
    showToast('Failed: ' + err.message, 'error', 5000);
    btn.disabled = false;
    btn.textContent = 'Sign & Finalize';
  }
}

async function deleteDraft() {
  if (!confirm('Delete this draft evaluation? This cannot be undone.')) return;
  clearTimeout(saveTimer);
  dirty = false;
  const { data, error } = await db.from('evaluations').delete().eq('id', ev.id).select('id');
  if (error || !data?.length) return showToast('Delete failed: ' + (error?.message || 'not allowed'), 'error');
  window.location.href = 'dashboard.html';
}

// ============================================================
// EVENT WIRING
// ============================================================
function wireEvents() {
  document.getElementById('detEvaluatee').addEventListener('change', e => { ev.evaluatee_id = e.target.value; renderHeader(); scheduleSave(); });
  document.getElementById('detClass').addEventListener('change', e => { ev.class_id = e.target.value; renderHeader(); scheduleSave(); });
  document.getElementById('detDate').addEventListener('change', e => {
    if (!e.target.value) { e.target.value = ev.class_date; return; }
    ev.class_date = e.target.value; renderHeader(); scheduleSave();
  });

  const content = document.getElementById('content');
  content.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.detail) { ev.responses.details = { ...ev.responses.details, [t.dataset.detail]: t.value }; scheduleSave(); }
    else if (t.dataset.note) {
      ev.responses.notes = { ...ev.responses.notes };
      if (t.value.trim()) ev.responses.notes[t.dataset.note] = t.value; else delete ev.responses.notes[t.dataset.note];
      scheduleSave();
    } else if (t.dataset.comment) { ev.responses.comments = { ...ev.responses.comments, [t.dataset.comment]: t.value }; scheduleSave(); }
  });

  content.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.share) {
      const id = t.dataset.share;
      ev.shared_sections = t.checked
        ? [...new Set([...ev.shared_sections, id])]
        : ev.shared_sections.filter(x => x !== id);
      updateSummary();
      scheduleSave();
    }
  });

  content.addEventListener('click', e => {
    const btn = e.target.closest('.eval-score-btn');
    if (btn) {
      const id = btn.dataset.item;
      const val = btn.dataset.score === NOT_OBSERVED ? NOT_OBSERVED : Number(btn.dataset.score);
      ev.responses.scores = { ...ev.responses.scores };
      // clicking the selected score again clears it
      if (ev.responses.scores[id] === val) delete ev.responses.scores[id];
      else ev.responses.scores[id] = val;
      btn.closest('.eval-score').querySelectorAll('.eval-score-btn').forEach(b => {
        const on = (b.dataset.score === NOT_OBSERVED ? NOT_OBSERVED : Number(b.dataset.score)) === ev.responses.scores[id];
        b.classList.toggle('selected', on);
        b.setAttribute('aria-pressed', on);
      });
      btn.closest('.eval-item').classList.remove('missing');
      updateSummary();
      scheduleSave();
      return;
    }
    const toggle = e.target.closest('[data-note-toggle]');
    if (toggle) {
      const wrap = toggle.closest('.eval-item-note');
      wrap.classList.add('open');
      toggle.textContent = 'Note';
      wrap.querySelector('textarea').focus();
    }
  });

  document.getElementById('finalizeBtn').addEventListener('click', startFinalize);
  document.getElementById('deleteBtn').addEventListener('click', deleteDraft);
  document.getElementById('finalizeCancelBtn').addEventListener('click', () => closeModal('finalizeModal'));
  document.getElementById('finalizeModal').addEventListener('click', e => { if (e.target.id === 'finalizeModal') closeModal('finalizeModal'); });
  document.getElementById('finalizeAgree').addEventListener('change', e => { document.getElementById('finalizeConfirmBtn').disabled = !e.target.checked; });
  document.getElementById('finalizeConfirmBtn').addEventListener('click', confirmFinalize);

  window.addEventListener('beforeunload', e => {
    if (dirty || saving) { save(); e.preventDefault(); e.returnValue = ''; }
  });
}

// ============================================================
// INIT
// ============================================================
(async () => {
  const auth = await requireAuth();
  if (!auth) return;
  currentProfile = auth.profile;
  renderNavbar(document.getElementById('navbarContainer'), { profile: currentProfile, active: 'evaluations' });

  const id = new URLSearchParams(location.search).get('id');
  if (!id) return showError('No evaluation selected', 'Open an evaluation from the Evaluations dashboard.');

  try {
    const [eRes, cRes, p] = await Promise.all([
      db.from('evaluations').select('*').eq('id', id).maybeSingle(),
      db.from('classes').select('id, name, is_active').order('name'),
      loadPeople(),
    ]);
    if (eRes.error) throw eRes.error;
    if (!eRes.data) return showError('Evaluation not found', 'It may have been deleted, or you don\'t have access to it.');
    ev = eRes.data;
    // finalized, or someone else's (academic viewing) → read-only page
    if (ev.status !== 'draft' || ev.evaluator_id !== currentProfile.id) {
      window.location.replace(`view.html?id=${ev.id}`);
      return;
    }
    classes = cRes.data || [];
    people = p;
    def = ev.template_snapshot || {};
    ev.responses = { details: {}, scores: {}, notes: {}, comments: {}, ...(ev.responses || {}) };
    ev.shared_sections = ev.shared_sections || [];

    const { data: tpl } = await db.from('evaluation_templates').select('name').eq('id', ev.template_id).maybeSingle();
    document.getElementById('templateName').textContent = tpl?.name || 'Evaluation';
    document.getElementById('reopenedNotice').classList.toggle('show', !!ev.reopened_at);

    renderHeader();
    renderDetails();
    renderScale();
    renderSections();
    renderComments();
    updateSummary();
    wireEvents();

    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('content').style.display = 'block';
  } catch (err) {
    showError('Could not load evaluation', err.message);
  }
})();
