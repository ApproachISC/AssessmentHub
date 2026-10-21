import { db } from '../supabase-client.js';
import { requireAuth } from '../auth.js';
import { renderNavbar, showToast } from '../ui.js';
import { loadPeople, personName, formatDay } from '../evaluation-common.js';
import { normalizeFullEvaluation, renderEvaluationPaper } from '../evaluation-paper.js';

function showError(title, message) {
  document.getElementById('authLoading').style.display = 'none';
  document.getElementById('errorTitle').textContent = title;
  document.getElementById('errorMessage').textContent = message;
  document.getElementById('errorScreen').style.display = 'block';
}

(async () => {
  const auth = await requireAuth();
  if (!auth) return;
  const profile = auth.profile;
  const isAcademic = profile.role === 'academic';
  renderNavbar(document.getElementById('navbarContainer'), { profile, active: 'evaluations' });

  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  if (!id) return showError('No evaluation selected', 'Open an evaluation from the Evaluations dashboard.');

  try {
    // RLS: only the evaluator and academic staff can read the full row
    const { data: ev, error } = await db.from('evaluations').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!ev) {
      // the evaluatee lands here from an old link → send them to their filtered view
      const { data: received } = await db.rpc('get_received_evaluation', { p_id: id });
      if (received) { window.location.replace(`received.html?id=${id}`); return; }
      return showError('Evaluation not found', 'It may have been deleted, or you don\'t have access to it.');
    }

    const [people, cRes, tRes] = await Promise.all([
      loadPeople(),
      db.from('classes').select('name').eq('id', ev.class_id).maybeSingle(),
      db.from('evaluation_templates').select('name').eq('id', ev.template_id).maybeSingle(),
    ]);
    const evaluateeName = personName(people, ev.evaluatee_id);
    const data = normalizeFullEvaluation(ev, {
      templateName: tRes.data?.name,
      evaluateeName,
      evaluatorName: personName(people, ev.evaluator_id),
      className: cRes.data?.name || '—',
    });
    renderEvaluationPaper(document.getElementById('paperRoot'), data);
    document.title = `Evaluation: ${evaluateeName} — ${formatDay(ev.class_date)}`;

    const isOwn = ev.evaluator_id === profile.id;
    if (ev.status === 'draft' && isOwn) {
      const c = document.getElementById('continueBtn');
      c.href = `edit.html?id=${ev.id}`;
      c.style.display = '';
    }
    if (ev.status === 'finalized' && isAcademic) document.getElementById('reopenBtn').style.display = '';
    if (isAcademic) document.getElementById('deleteBtn').style.display = '';
    document.getElementById('finalizedNotice').classList.toggle('show', params.get('finalized') === '1' && ev.status === 'finalized');

    document.getElementById('printBtn').addEventListener('click', () => window.print());

    document.getElementById('reopenBtn').addEventListener('click', async () => {
      if (!confirm(`Reopen this evaluation of ${evaluateeName}?\n\nIt goes back to draft so ${personName(people, ev.evaluator_id)} can edit it. Both signatures are cleared, and the teacher won't see it until it's finalized again.`)) return;
      const { error: rErr } = await db.rpc('reopen_evaluation', { p_id: ev.id });
      if (rErr) return showToast('Failed: ' + rErr.message, 'error');
      showToast('Evaluation reopened', 'success');
      setTimeout(() => location.replace(`view.html?id=${ev.id}`), 600);
    });

    document.getElementById('deleteBtn').addEventListener('click', async () => {
      if (!confirm(`Permanently delete this ${ev.status === 'finalized' ? 'FINALIZED ' : ''}evaluation of ${evaluateeName}?\n\nThis cannot be undone.`)) return;
      const { data: del, error: dErr } = await db.from('evaluations').delete().eq('id', ev.id).select('id');
      if (dErr || !del?.length) return showToast('Delete failed: ' + (dErr?.message || 'not allowed'), 'error');
      window.location.href = 'dashboard.html';
    });

    document.getElementById('authLoading').style.display = 'none';
    document.getElementById('content').style.display = 'block';
  } catch (err) {
    showError('Could not load evaluation', err.message);
  }
})();
