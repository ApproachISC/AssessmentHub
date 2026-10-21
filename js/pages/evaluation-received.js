import { db } from '../supabase-client.js';
import { requireAuth } from '../auth.js';
import { renderNavbar, showToast, esc, refreshEvaluationBadge } from '../ui.js';
import { formatDay, formatStamp } from '../evaluation-common.js';
import { normalizeReceivedEvaluation, renderEvaluationPaper } from '../evaluation-paper.js';

const SAVE_DELAY_MS = 1200;

let evalId = null, data = null;
let saveTimer = null, saving = false, dirty = false;

function showError(title, message) {
  document.getElementById('authLoading').style.display = 'none';
  document.getElementById('errorTitle').textContent = title;
  document.getElementById('errorMessage').textContent = message;
  document.getElementById('errorScreen').style.display = 'block';
}

function renderReflection() {
  const slot = document.getElementById('reflectionSlot');
  if (data.evaluatee_signed_at) {
    slot.innerHTML = data.self_reflection ? `
      <div class="eval-paper-comment">
        <div class="eval-paper-comment-label">Your self-reflection</div>
        <div>${esc(data.self_reflection).replace(/\n/g, '<br>')}</div>
      </div>` : '';
    return;
  }
  slot.innerHTML = `
    <div class="eval-paper-comment no-print">
      <div class="eval-paper-comment-label">Your self-reflection <span style="font-weight:400;color:var(--muted);">(optional)</span></div>
      <p class="field-help" style="margin-bottom:0.4rem;">What went well in the part you led? What would you change next time?</p>
      <textarea class="reviewer-notes-input" id="reflectionInput" rows="5">${esc(data.self_reflection || '')}</textarea>
      <div class="eval-save-status" id="reflectionStatus">${data.self_reflection ? 'Saved' : ''}</div>
    </div>
    <div class="eval-paper-comment print-only" id="reflectionPrintWrap"><div class="eval-paper-comment-label">Your self-reflection</div><div id="reflectionPrint"></div></div>`;
  // printed copy of the textarea (textareas clip long text on paper)
  const syncPrint = () => {
    const text = document.getElementById('reflectionInput').value.trim();
    document.getElementById('reflectionPrint').innerHTML = esc(text).replace(/\n/g, '<br>');
    document.getElementById('reflectionPrintWrap').classList.toggle('empty', !text);
  };
  syncPrint();
  document.getElementById('reflectionInput').addEventListener('input', () => {
    syncPrint();
    dirty = true;
    document.getElementById('reflectionStatus').textContent = 'Unsaved changes…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveReflection, SAVE_DELAY_MS);
  });
}

async function saveReflection() {
  clearTimeout(saveTimer);
  if (saving) { saveTimer = setTimeout(saveReflection, SAVE_DELAY_MS); return false; }
  if (!dirty) return true;
  const input = document.getElementById('reflectionInput');
  if (!input) return true;
  saving = true;
  dirty = false;
  const status = document.getElementById('reflectionStatus');
  status.textContent = 'Saving…';
  try {
    const { error } = await db.rpc('save_evaluation_reflection', { p_id: evalId, p_text: input.value });
    if (error) throw error;
    data.self_reflection = input.value.trim() || null;
    status.textContent = `Saved ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    return true;
  } catch (err) {
    dirty = true;
    status.textContent = 'Not saved — ' + err.message;
    return false;
  } finally {
    saving = false;
  }
}

async function sign() {
  if (!confirm('Sign this evaluation?\n\nThis records that you have read it, with today\'s date and time. Your self-reflection will be locked.')) return;
  const btn = document.getElementById('signBtn');
  btn.disabled = true;
  try {
    while (saving) await new Promise(r => setTimeout(r, 100));
    if (!(await saveReflection())) throw new Error('Could not save your reflection');
    const { error } = await db.rpc('sign_evaluation_as_evaluatee', { p_id: evalId });
    if (error) throw error;
    data.evaluatee_signed_at = new Date().toISOString();
    document.getElementById('evaluateeSigStamp').textContent = `Read and signed electronically · ${formatStamp(data.evaluatee_signed_at)}`;
    document.getElementById('signBox').style.display = 'none';
    renderReflection();
    refreshEvaluationBadge();
    showToast('Signed — thank you', 'success');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
    btn.disabled = false;
  }
}

(async () => {
  const auth = await requireAuth();
  if (!auth) return;
  renderNavbar(document.getElementById('navbarContainer'), { profile: auth.profile, active: 'evaluations' });

  evalId = new URLSearchParams(location.search).get('id');
  if (!evalId) return showError('No evaluation selected', 'Open an evaluation from the Evaluations page.');

  try {
    // Server-side filtered: only the grade + sections the evaluator shared
    const { data: d, error } = await db.rpc('get_received_evaluation', { p_id: evalId });
    if (error) throw error;
    if (!d) return showError('Evaluation not available', 'It may not be finalized yet, or it isn\'t about you.');
    data = d;

    renderEvaluationPaper(document.getElementById('paperRoot'), normalizeReceivedEvaluation(d), { reflectionSlot: true });
    renderReflection();
    document.title = `My Evaluation — ${formatDay(d.class_date)}`;
    document.getElementById('signBox').style.display = d.evaluatee_signed_at ? 'none' : 'block';
    document.getElementById('signBtn').addEventListener('click', sign);
    document.getElementById('printBtn').addEventListener('click', () => window.print());
    window.addEventListener('beforeunload', e => { if (dirty) { saveReflection(); e.preventDefault(); e.returnValue = ''; } });

    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('content').style.display = 'block';
  } catch (err) {
    showError('Could not load evaluation', err.message);
  }
})();
