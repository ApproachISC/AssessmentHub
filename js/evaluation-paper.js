// Renders an evaluation as a print-friendly document (screen + "Save as PDF").
// Shared by evaluation/view.html (evaluator / academic: full record) and
// evaluation/received.html (evaluatee: only what get_received_evaluation() returned).
import { esc } from './ui.js';
import { formatDay, formatStamp, formatGrade, gradeBand, scoreLabel, sectionLetter, NOT_OBSERVED } from './evaluation-common.js';

// Normalized shape:
// { templateName, evaluateeName, evaluatorName, className, classDate, status,
//   def: { scale, max_points_per_item, pass_mark, grade_bands, detail_fields },
//   details, grade, earned, possible,
//   sections: [{ id, title, shared, items: [{ id, text, score, note }] }],
//   comments: [{ id, label, text, shared }],
//   selfReflection, evaluatorSignedAt, evaluateeSignedAt, showSharing }

export function normalizeFullEvaluation(ev, { templateName, evaluateeName, evaluatorName, className }) {
  const def = ev.template_snapshot || {};
  const r = ev.responses || {};
  const shared = ev.shared_sections || [];
  return {
    templateName, evaluateeName, evaluatorName, className,
    classDate: ev.class_date,
    status: ev.status,
    def,
    details: r.details || {},
    grade: ev.grade,
    earned: ev.points_earned,
    possible: ev.points_possible,
    sections: (def.sections || []).map((s, si) => ({
      id: s.id, letter: sectionLetter(si), title: s.title, shared: shared.includes(s.id),
      items: (s.items || []).map(it => ({ id: it.id, text: it.text, score: r.scores?.[it.id], note: r.notes?.[it.id] })),
    })),
    comments: (def.comment_fields || []).map(f => ({ id: f.id, label: f.label, text: r.comments?.[f.id], shared: shared.includes(f.id) })),
    selfReflection: ev.self_reflection,
    evaluatorSignedAt: ev.evaluator_signed_at,
    evaluateeSignedAt: ev.evaluatee_signed_at,
    showSharing: true,
  };
}

export function normalizeReceivedEvaluation(d) {
  return {
    templateName: d.template_name,
    evaluateeName: d.evaluatee_name,
    evaluatorName: d.evaluator_name,
    className: d.class_name,
    classDate: d.class_date,
    status: 'finalized',
    def: {
      scale: d.scale, max_points_per_item: d.max_points_per_item, pass_mark: d.pass_mark,
      grade_bands: d.grade_bands, detail_fields: d.detail_fields,
    },
    details: d.details || {},
    grade: d.grade,
    sections: (d.sections || []).map(s => ({ ...s, letter: s.position ? sectionLetter(s.position - 1) : '', shared: true })),
    comments: (d.comments || []).map(c => ({ ...c, shared: true })),
    selfReflection: d.self_reflection,
    evaluatorSignedAt: d.evaluator_signed_at,
    evaluateeSignedAt: d.evaluatee_signed_at,
    showSharing: false,
  };
}

function multiline(text) {
  return esc(text).replace(/\n/g, '<br>');
}

export function renderEvaluationPaper(root, e, { reflectionSlot = false } = {}) {
  const def = e.def;
  const max = Number(def.max_points_per_item ?? 4);
  const pass = Number(def.pass_mark ?? 70);
  const band = gradeBand(def, e.grade == null ? null : Number(e.grade));
  const passed = e.grade != null && Number(e.grade) >= pass;
  let n = 0;

  const detailRows = (def.detail_fields || [])
    .filter(f => e.details[f.id] !== undefined && e.details[f.id] !== '')
    .map(f => `<span><strong>${esc(f.label)}:</strong> ${esc(e.details[f.id])}</span>`).join('');

  const sectionsHtml = e.sections.map(s => {
    let earned = 0, possible = 0;
    s.items.forEach(it => { if (typeof it.score === 'number') { earned += it.score; possible += max; } });
    return `
      <div class="paper-section eval-paper-section">
        <div class="paper-section-title eval-paper-section-title">
          <span>${s.letter ? `${esc(s.letter)}. ` : ''}${esc(s.title)}</span>
          <span class="eval-paper-subtotal">${earned}/${possible}${possible !== s.items.length * max ? ` <small>(of ${s.items.length * max})</small>` : ''}
            ${e.showSharing ? `<span class="eval-shared-tag${s.shared ? ' on' : ''}">${s.shared ? 'Shared' : 'Private'}</span>` : ''}</span>
        </div>
        <table class="eval-paper-table">
          <thead><tr><th style="width:28px;">#</th><th>Criterion</th><th style="width:120px;">Score</th></tr></thead>
          <tbody>
            ${s.items.map(it => {
              n++;
              return `<tr>
                <td>${n}</td>
                <td>${esc(it.text)}${it.note ? `<div class="eval-paper-note">${multiline(it.note)}</div>` : ''}</td>
                <td class="${it.score === NOT_OBSERVED ? 'eval-paper-no' : ''}">${esc(scoreLabel(def, it.score))}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }).join('');

  const commentsHtml = e.comments.filter(c => c.text && c.text.trim()).map(c => `
    <div class="eval-paper-comment">
      <div class="eval-paper-comment-label">${esc(c.label)}
        ${e.showSharing ? `<span class="eval-shared-tag${c.shared ? ' on' : ''}">${c.shared ? 'Shared' : 'Private'}</span>` : ''}</div>
      <div>${multiline(c.text)}</div>
    </div>`).join('');

  const reflectionHtml = reflectionSlot
    ? '<div id="reflectionSlot"></div>'
    : (e.selfReflection ? `
      <div class="eval-paper-comment">
        <div class="eval-paper-comment-label">Teacher's self-reflection</div>
        <div>${multiline(e.selfReflection)}</div>
      </div>` : '');

  root.innerHTML = `
    <div class="paper-header">
      <div class="eval-paper-brand">${esc(e.templateName || 'Evaluation')}</div>
      <h1>${esc(e.evaluateeName)}</h1>
      <div class="paper-meta">
        <span><strong>Class:</strong> ${esc(e.className)}</span>
        <span><strong>Class date:</strong> ${formatDay(e.classDate)}</span>
        <span><strong>Evaluator:</strong> ${esc(e.evaluatorName)}</span>
        ${detailRows}
      </div>
    </div>

    <div class="eval-paper-grade">
      <div>
        <div class="eval-paper-grade-label">Final grade</div>
        <div class="eval-paper-grade-value">${formatGrade(e.grade)}<small>/100</small></div>
      </div>
      <div class="eval-paper-grade-side">
        ${e.grade != null ? `<div><strong>${esc(band || '')}</strong> · ${passed ? 'Passing' : `Below the pass mark (${pass})`}</div>` : ''}
        ${e.possible != null ? `<div>${e.earned}/${e.possible} points</div>` : ''}
        ${e.status === 'draft' ? '<div class="eval-paper-draft">DRAFT — not finalized</div>' : ''}
      </div>
    </div>

    ${sectionsHtml || (e.showSharing ? '' : '<p class="paper-instructions">The evaluator did not share any section details. Your final grade is shown above.</p>')}

    ${commentsHtml || reflectionHtml ? `<div class="paper-section"><div class="paper-section-title">Comments</div>${commentsHtml}${reflectionHtml}</div>` : ''}

    <div class="paper-section eval-paper-signatures">
      <div class="paper-section-title">Signatures</div>
      <div class="eval-sig-grid">
        <div class="eval-sig"><div class="eval-sig-role">Evaluator</div><div class="eval-sig-name">${esc(e.evaluatorName)}</div>
          <div class="eval-sig-stamp">${e.evaluatorSignedAt ? `Signed electronically · ${formatStamp(e.evaluatorSignedAt)}` : 'Not signed'}</div></div>
        <div class="eval-sig"><div class="eval-sig-role">Teacher evaluated</div><div class="eval-sig-name">${esc(e.evaluateeName)}</div>
          <div class="eval-sig-stamp" id="evaluateeSigStamp">${e.evaluateeSignedAt ? `Read and signed electronically · ${formatStamp(e.evaluateeSignedAt)}` : 'Not signed yet'}</div></div>
      </div>
    </div>`;
}
