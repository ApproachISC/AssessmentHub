// Shared question-type engine: grading + result rendering, used by both the
// Assessment and Exam systems' submission-review pages (and, later, by their
// student-facing taking pages too). Extended with authoring/editing helpers
// as each system's create/edit pages are migrated.
import { esc } from './ui.js';

// Case-insensitive, trimmed match against accepted_answers (falls back to
// `answer` when accepted_answers is empty). Shared by every fill-in/label
// type across both systems.
function checkAcceptedAnswer(value, answer, accepted) {
  if (value == null || value === '') return false;
  const v = String(value).trim().toLowerCase();
  const candidates = (accepted && accepted.length ? accepted : [answer]).filter(Boolean);
  return candidates.some(a => v === String(a).trim().toLowerCase());
}

// Manual-graded questions (Exam system only): the grade is whatever the
// teacher entered in `manualGrades[q.id]` (or, for pool_writing, the sum of
// `manualGrades['<qid>__<n>']` across its required sentences). `ungraded`
// distinguishes "not yet scored" from "scored zero".
function gradeManual(q, manualGrades) {
  const max = Number(q.points) || 0;
  const score = manualGrades[q.id];
  return { earned: score == null ? 0 : Number(score), max, allCorrect: false, allBlank: false, manual: true, ungraded: score == null };
}

function gradePoolWriting(q, manualGrades) {
  const max = Number(q.points) || 0;
  const required = q.required_count || 0;
  let earned = 0, ungraded = false;
  for (let i = 1; i <= required; i++) {
    const score = manualGrades[`${q.id}__${i}`];
    if (score == null) ungraded = true;
    else earned += Number(score);
  }
  return { earned, max, allCorrect: false, allBlank: false, manual: true, ungraded };
}

// ============================================================
// GRADING — most types are auto-graded; Exam-only types may be manual
// (writing_prompt, pool_writing, sentence_order, short_answer, or any type
// with `grading: "manual"` set) — pass the submission's `manualGrades` map
// (keyed by question id, or `<qid>__<n>` for pool_writing) for those.
// Returns {earned, max, allCorrect, allBlank[, manual, ungraded]}
// ============================================================
export function gradeQuestion(q, answers, manualGrades = {}) {
  const max = Number(q.points) || 0;
  const blank = () => ({ earned: 0, max, allCorrect: false, allBlank: true });
  const full = () => ({ earned: max, max, allCorrect: true, allBlank: false });
  const partial = (earned) => ({ earned, max, allCorrect: false, allBlank: false });
  const wrong = () => ({ earned: 0, max, allCorrect: false, allBlank: false });

  if (q.grading === 'manual') {
    if (q.type === 'pool_writing') return gradePoolWriting(q, manualGrades);
    return gradeManual(q, manualGrades);
  }

  switch (q.type) {
    case 'multiple_choice': {
      const v = answers[q.id];
      if (!v) return blank();
      return v === q.answer ? full() : wrong();
    }
    case 'multiple_select': {
      const given = answers[q.id] || [];
      if (!given.length) return blank();
      const correct = q.correct_answers || [];
      if (!correct.length) return blank();
      const perItem = max / correct.length;
      let earned = 0;
      correct.forEach(k => { if (given.includes(k)) earned += perItem; });
      const wrongCount = given.filter(k => !correct.includes(k)).length;
      earned = Math.max(0, Math.round((earned - wrongCount * perItem) * 100) / 100);
      return earned === max ? full() : earned > 0 ? partial(earned) : wrong();
    }
    case 'true_false': {
      const v = answers[q.id];
      if (!v) return blank();
      return String(v).toUpperCase() === String(q.answer).toUpperCase() ? full() : wrong();
    }
    case 'fill_blank': {
      const v = (answers[q.id] || '').trim().toLowerCase();
      if (!v) return blank();
      const cands = (q.accepted_answers?.length ? q.accepted_answers : [q.answer]).filter(Boolean);
      return cands.some(c => c.trim().toLowerCase() === v) ? full() : wrong();
    }
    case 'fill_blank_multi': {
      const blanks = q.blanks || [];
      if (!blanks.length) return blank();
      let earned = 0;
      blanks.forEach(b => {
        const v = (answers[b.id] || '').trim().toLowerCase();
        const cands = (b.accepted_answers?.length ? b.accepted_answers : [b.answer]).filter(Boolean);
        const bPts = Number(b.points) || (max / blanks.length);
        if (cands.some(c => c.trim().toLowerCase() === v)) earned += bPts;
      });
      earned = Math.round(earned * 100) / 100;
      const allBlank2 = blanks.every(b => !answers[b.id]);
      return allBlank2 ? blank() : earned >= max ? full() : earned > 0 ? partial(earned) : wrong();
    }
    case 'dropdown': {
      const v = answers[q.id];
      if (!v) return blank();
      return v === q.answer ? full() : wrong();
    }
    case 'matching': {
      const lefts = q.left_items || [];
      if (!lefts.length) return blank();
      const perItem = max / lefts.length;
      let earned = 0;
      lefts.forEach(l => { if (answers[`${q.id}__${l.id}`] === (q.answers || {})[l.id]) earned += perItem; });
      earned = Math.round(earned * 100) / 100;
      const anyAnswer = lefts.some(l => answers[`${q.id}__${l.id}`]);
      return !anyAnswer ? blank() : earned >= max ? full() : earned > 0 ? partial(earned) : wrong();
    }
    case 'drag_reorder': {
      const v = (answers[q.id] || '').trim().toLowerCase();
      if (!v) return blank();
      return v === (q.expected || '').trim().toLowerCase() ? full() : wrong();
    }
    case 'drag_categorize':
    // Exam's "categorization" is the same shape as Assessment's "drag_categorize"
    // (items[] + categories[] + answers{item: categoryId}) — same grading.
    case 'categorization': {
      const items = q.items || [];
      if (!items.length) return blank();
      const perItem = max / items.length;
      let earned = 0;
      items.forEach(it => { if (answers[`${q.id}__${it}`] === (q.answers || {})[it]) earned += perItem; });
      earned = Math.round(earned * 100) / 100;
      const anyAnswer = items.some(it => answers[`${q.id}__${it}`]);
      return !anyAnswer ? blank() : earned >= max ? full() : earned > 0 ? partial(earned) : wrong();
    }
    // Exam-only: single value compared against q.answer, same as multiple_choice.
    case 'inline_choice': {
      const v = answers[q.id];
      if (!v) return blank();
      return v === q.answer ? full() : wrong();
    }
    // Exam-only: image with clickable/labeled hotspots. labels[] each carry
    // their own answer/accepted_answers, keyed the same way as fill_blank_multi.
    case 'image_label': {
      const labels = q.labels || [];
      if (!labels.length) return blank();
      const perItem = max / labels.length;
      let earned = 0;
      labels.forEach(l => { if (checkAcceptedAnswer(answers[`${q.id}__${l.id}`], l.answer, l.accepted_answers)) earned += perItem; });
      earned = Math.round(earned * 100) / 100;
      const anyAnswer = labels.some(l => answers[`${q.id}__${l.id}`]);
      return !anyAnswer ? blank() : earned >= max ? full() : earned > 0 ? partial(earned) : wrong();
    }
    // Exam-only: match items to points/regions on an image — same shape as
    // drag_categorize/matching (items[] + answers{item: expectedKey}).
    case 'image_match': {
      const items = q.items || [];
      if (!items.length) return blank();
      const perItem = max / items.length;
      let earned = 0;
      items.forEach(it => { if (answers[`${q.id}__${it}`] === (q.answers || {})[it]) earned += perItem; });
      earned = Math.round(earned * 100) / 100;
      const anyAnswer = items.some(it => answers[`${q.id}__${it}`]);
      return !anyAnswer ? blank() : earned >= max ? full() : earned > 0 ? partial(earned) : wrong();
    }
    default:
      return blank();
  }
}

export function scoreDefinition(definition, answers) {
  let autoScore = 0, maxScore = 0;
  (definition?.sections || []).forEach(s => (s.questions || []).forEach(q => {
    const r = gradeQuestion(q, answers);
    autoScore += r.earned;
    maxScore += r.max;
  }));
  return { autoScore: Math.round(autoScore * 100) / 100, maxScore };
}

// Exam-side variant: some questions are manually graded, so auto/manual are
// tracked separately (manual score only counts once a grade has been entered).
export function scoreDefinitionWithManual(definition, answers, manualGrades = {}) {
  let auto = 0, manual = 0, max = 0;
  (definition?.sections || []).forEach(s => (s.questions || []).forEach(q => {
    const r = gradeQuestion(q, answers, manualGrades);
    max += r.max;
    if (q.grading === 'manual') { if (!r.ungraded) manual += r.earned; }
    else auto += r.earned;
  }));
  auto = Math.round(auto * 100) / 100;
  manual = Math.round(manual * 100) / 100;
  return { auto, manual, max, total: Math.round((auto + manual) * 100) / 100 };
}

// ============================================================
// RESULT RENDERING — read-only "student answer vs. correct answer" body,
// used on submission-review pages.
// ============================================================
function studentVal(v, isBlank, ok) {
  return `<span class="response-value ${isBlank ? 'blank' : ''} ${ok ? 'correct' : 'incorrect'}">${esc(v || '(blank)')}</span>`;
}

function renderBodyMC(c, q, a) {
  const given = a[q.id], correct = q.answer;
  c.innerHTML = `<div class="response-section">
    <div class="response-label">Student answer</div>
    ${(q.options || []).map(o => {
      const sel = o.key === given, isCorrect = o.key === correct;
      const style = sel && isCorrect ? 'background:var(--green-s);border-left:3px solid var(--green);'
        : sel ? 'background:var(--red-s);border-left:3px solid var(--red);'
        : isCorrect ? 'background:var(--green-s);border-left:3px solid var(--green);opacity:0.7;' : '';
      return `<div style="padding:0.45rem 0.75rem;margin-bottom:0.25rem;${style}">
        <strong style="margin-right:0.5rem;">${esc(o.key.toUpperCase())}</strong>${esc(o.text)}
        ${sel ? ' <em style="opacity:0.7;">(student)</em>' : ''}${isCorrect && !sel ? ' <em style="color:var(--green);">(correct)</em>' : ''}
      </div>`;
    }).join('')}
  </div>`;
}

function renderBodyMS(c, q, a) {
  const given = a[q.id] || [], correct = q.correct_answers || [];
  c.innerHTML = `<div class="response-section">
    <div class="response-label">Student selections</div>
    ${(q.options || []).map(o => {
      const sel = given.includes(o.key), isCorrect = correct.includes(o.key);
      const style = sel && isCorrect ? 'background:var(--green-s);border-left:3px solid var(--green);'
        : sel ? 'background:var(--red-s);border-left:3px solid var(--red);'
        : isCorrect && !sel ? 'background:var(--green-s);border-left:3px solid var(--green);opacity:0.7;' : '';
      return `<div style="padding:0.45rem 0.75rem;margin-bottom:0.25rem;${style}">
        <strong style="margin-right:0.5rem;">${esc(o.key.toUpperCase())}</strong>${esc(o.text)}
        ${sel ? ' <em style="opacity:0.7;">(selected)</em>' : ''}${isCorrect ? ' <em style="color:var(--green);">(correct)</em>' : ''}
      </div>`;
    }).join('')}
  </div>`;
}

function renderBodyTF(c, q, a) {
  const v = a[q.id], ok = String(v).toUpperCase() === String(q.answer).toUpperCase();
  c.innerHTML = `<div class="response-section"><div class="sub-row">
    <span class="sub-label">Answer</span>
    <div class="pair-grid">
      <div>${studentVal(v ? (v === 'T' ? 'True' : 'False') : null, !v, ok)}<span class="sub-mark ${ok ? 'correct' : 'incorrect'}">${ok ? '✓' : '✗'}</span></div>
      <div><span class="response-value expected">${q.answer === 'T' ? 'True' : 'False'}</span></div>
    </div>
  </div></div>`;
}

function renderBodyFB(c, q, a, r) {
  const v = a[q.id], ok = r.allCorrect;
  c.innerHTML = `<div class="response-section"><div class="sub-row"><span class="sub-label">Answer</span>${studentVal(v, !v, ok)}<span class="response-value expected">${esc(q.answer || '—')}</span><span class="sub-mark ${ok ? 'correct' : 'incorrect'}">${ok ? '✓' : '✗'}</span></div></div>`;
}

function renderBodyFBM(c, q, a) {
  const blanks = q.blanks || [];
  const rows = blanks.map(b => {
    const v = a[b.id];
    const cands = (b.accepted_answers?.length ? b.accepted_answers : [b.answer]).filter(Boolean);
    const ok = v && cands.some(ca => ca.trim().toLowerCase() === (v || '').trim().toLowerCase());
    return `<div class="sub-row"><span class="sub-label">${esc(b.id)}</span>${studentVal(v, !v, ok)}<span class="response-value expected">${esc(b.answer || '—')}</span><span class="sub-mark ${ok ? 'correct' : 'incorrect'}">${ok ? '✓' : '✗'}</span></div>`;
  }).join('');
  c.innerHTML = `<div class="response-section"><div class="response-label">Per-blank breakdown</div>${rows}</div>`;
}

function renderBodyDD(c, q, a, r) {
  const v = a[q.id], ok = r.allCorrect;
  c.innerHTML = `<div class="response-section"><div class="sub-row"><span class="sub-label">Selected</span>${studentVal(v, !v, ok)}<span class="response-value expected">${esc(q.answer || '—')}</span><span class="sub-mark ${ok ? 'correct' : 'incorrect'}">${ok ? '✓' : '✗'}</span></div></div>`;
}

function renderBodyMatching(c, q, a) {
  const rows = (q.left_items || []).map(l => {
    const given = a[`${q.id}__${l.id}`], expected = (q.answers || {})[l.id], ok = given === expected;
    return `<div class="sub-row">
      <span class="sub-label">${esc(l.id)}) ${esc(l.text)}</span>
      <div class="pair-grid">
        <div>${studentVal(given, !given, ok)}<span class="sub-mark ${ok ? 'correct' : 'incorrect'}">${ok ? '✓' : '✗'}</span></div>
        <div><span class="response-value expected">${esc(expected || '—')}</span></div>
      </div>
    </div>`;
  }).join('');
  c.innerHTML = `<div class="response-section"><div class="response-label">Matches</div>${rows}</div>`;
}

function renderBodyDragReorder(c, q, a, r) {
  const v = a[q.id], ok = r.allCorrect;
  c.innerHTML = `<div class="response-section"><div class="sub-row">
    <span class="sub-label">Order</span>
    <div class="pair-grid">
      <div>${studentVal(v, !v, ok)}<span class="sub-mark ${ok ? 'correct' : 'incorrect'}">${ok ? '✓' : '✗'}</span></div>
      <div><span class="response-value expected">${esc(q.expected || '—')}</span></div>
    </div>
  </div></div>`;
}

function renderBodyDragCategorize(c, q, a) {
  const rows = (q.items || []).map(it => {
    const given = a[`${q.id}__${it}`], expected = (q.answers || {})[it], ok = given === expected;
    const catLabel = id => (q.categories || []).find(cat => cat.id === id)?.label || id;
    return `<div class="sub-row">
      <span class="sub-label">${esc(it)}</span>
      <div class="pair-grid">
        <div>${studentVal(given ? catLabel(given) : null, !given, ok)}<span class="sub-mark ${ok ? 'correct' : 'incorrect'}">${ok ? '✓' : '✗'}</span></div>
        <div><span class="response-value expected">${esc(catLabel(expected || ''))}</span></div>
      </div>
    </div>`;
  }).join('');
  c.innerHTML = `<div class="response-section"><div class="response-label">Categories</div>${rows}</div>`;
}

// Exam-only: single-value dropdown, same read-only presentation as Assessment's "dropdown".
function renderBodyInlineChoice(c, q, a, r) {
  return renderBodyDD(c, q, a, r);
}

function renderBodyImageLabel(c, q, a) {
  const imageHtml = q.image?.url ? `<div class="question-image-wrap"><img src="${esc(q.image.url)}" alt="${esc(q.image.alt || '')}"></div>` : '';
  const rows = (q.labels || []).map(l => {
    const given = a[`${q.id}__${l.id}`];
    const ok = checkAcceptedAnswer(given, l.answer, l.accepted_answers);
    return `<div class="sub-row">
      <span class="sub-label">${esc(l.label || l.id)}</span>
      <div class="pair-grid">
        <div>${studentVal(given, !given, ok)}<span class="sub-mark ${ok ? 'correct' : 'incorrect'}">${ok ? '✓' : '✗'}</span></div>
        <div><span class="response-value expected">${esc(l.answer || '—')}</span></div>
      </div>
    </div>`;
  }).join('');
  c.innerHTML = `${imageHtml}<div class="response-section"><div class="response-label">Per-label breakdown</div>${rows}</div>`;
}

function renderBodyImageMatch(c, q, a) {
  const imageHtml = q.image?.url ? `<div class="question-image-wrap"><img src="${esc(q.image.url)}" alt="${esc(q.image.alt || '')}"></div>` : '';
  const rows = (q.items || []).map(it => {
    const given = a[`${q.id}__${it}`], expected = (q.answers || {})[it], ok = given === expected;
    return `<div class="sub-row">
      <span class="sub-label">${esc(it)}</span>
      <div class="pair-grid">
        <div>${studentVal(given, !given, ok)}<span class="sub-mark ${ok ? 'correct' : 'incorrect'}">${ok ? '✓' : '✗'}</span></div>
        <div><span class="response-value expected">${esc(expected || '—')}</span></div>
      </div>
    </div>`;
  }).join('');
  c.innerHTML = `${imageHtml}<div class="response-section"><div class="response-label">Per-item breakdown</div>${rows}</div>`;
}

// Manual-grade score input, shared by every manually-graded type below.
// The page hosting this must listen for `input` on `[data-grade-key]` and
// write into its own `manualGrades` state (see js/pages/exam-submission-detail.js).
function manualGradeInputHtml(key, max, score, rubric) {
  return `<div class="manual-grade">
    <label>Score</label>
    <input type="number" min="0" max="${max}" step="0.5" value="${score == null ? '' : score}" data-grade-key="${esc(key)}" placeholder="0">
    <span class="max-points">/ ${max}</span>
    ${rubric ? `<div class="rubric"><strong>Rubric</strong>${esc(rubric)}</div>` : ''}
  </div>`;
}

// Manual variant of fill_blank_multi: shows the per-blank breakdown for
// context (no auto ✓/✗ since the teacher grades the whole thing) plus one score input.
function renderBodyFBMultiManual(c, q, a, manualGrades) {
  const rows = (q.blanks || []).map(b => {
    const v = a[b.id];
    return `<div class="sub-row"><span class="sub-label">${esc(b.id)}</span>${studentVal(v, !v, true)}<span class="response-value expected">${esc(b.answer || '—')}</span></div>`;
  }).join('');
  c.innerHTML = `<div class="response-section"><div class="response-label">Per-blank breakdown</div>${rows}</div>` +
    manualGradeInputHtml(q.id, Number(q.points) || 0, manualGrades[q.id], q.rubric);
}

// short_answer / writing_prompt / sentence_order / manually-graded fill_blank:
// show the student's raw text plus (if present) a reference answer, then a score input.
function renderBodyManualSimple(c, q, a, manualGrades) {
  const v = a[q.id];
  const studentDisplay = (v == null || v === '') ? `<span class="response-value blank">No answer provided</span>` : `<span class="response-value">${esc(v)}</span>`;
  const reference = q.expected_answer || q.expected || q.answer;
  const expectedHtml = reference
    ? `<div style="margin-top:0.6rem;"><div class="response-label">Expected (for reference)</div><span class="response-value expected">${esc(reference)}</span></div>` : '';
  c.innerHTML = `<div class="response-section"><div class="response-label">Student Answer</div>${studentDisplay}${expectedHtml}</div>` +
    manualGradeInputHtml(q.id, Number(q.points) || 0, manualGrades[q.id], q.rubric);
}

// pool_writing: student writes `required_count` sentences using a shared word
// bank; each sentence is graded individually (manualGrades keyed `<qid>__<n>`).
function renderBodyPoolWriting(c, q, a, manualGrades) {
  const required = q.required_count || 0;
  const pointsPer = Number(q.points_per_sentence) || (Number(q.points) / Math.max(required, 1));
  const poolHtml = (q.word_pool || []).map(w => `<span style="font-family:var(--serif);font-style:italic;font-size:1rem;color:var(--navy-l);margin-right:1rem;">${esc(w)}</span>`).join('');

  let rows = '';
  for (let i = 1; i <= required; i++) {
    const key = `${q.id}__${i}`;
    const v = a[key];
    const score = manualGrades[key];
    const text = (v == null || v === '') ? `<span class="sub-pool-text blank">No sentence provided</span>` : `<span class="sub-pool-text">${esc(v)}</span>`;
    rows += `<div class="sub-pool-row">
      <span class="sub-pool-num">${String(i).padStart(2, '0')}</span>
      ${text}
      <div class="sub-pool-grade">
        <input type="number" min="0" max="${pointsPer}" step="0.5" value="${score == null ? '' : score}" data-grade-key="${esc(key)}" placeholder="0">
        <span class="max-points">/ ${pointsPer}</span>
      </div>
    </div>`;
  }
  c.innerHTML = `
    <div class="word-bank-box">
      <div class="response-label">Word bank</div>
      ${poolHtml}
    </div>
    ${q.rubric ? `<div class="rubric-box">${esc(q.rubric)}</div>` : ''}
    <div class="response-section"><div class="response-label">Sentences (graded individually)</div>${rows}</div>`;
}

// Types with a dedicated manual-grading body (raw response + score input, no auto ✓/✗).
const MANUAL_BODY_TYPES = ['fill_blank', 'fill_blank_multi', 'sentence_order', 'short_answer', 'writing_prompt', 'pool_writing'];

export function renderQuestionResultBody(container, q, answers, result, manualGrades = {}) {
  if (q.grading === 'manual' && MANUAL_BODY_TYPES.includes(q.type)) {
    if (q.type === 'fill_blank_multi') return renderBodyFBMultiManual(container, q, answers, manualGrades);
    if (q.type === 'pool_writing') return renderBodyPoolWriting(container, q, answers, manualGrades);
    return renderBodyManualSimple(container, q, answers, manualGrades);
  }
  switch (q.type) {
    case 'multiple_choice': renderBodyMC(container, q, answers); break;
    case 'multiple_select': renderBodyMS(container, q, answers); break;
    case 'true_false': renderBodyTF(container, q, answers); break;
    case 'fill_blank': renderBodyFB(container, q, answers, result); break;
    case 'fill_blank_multi': renderBodyFBM(container, q, answers); break;
    case 'dropdown': renderBodyDD(container, q, answers, result); break;
    case 'inline_choice': renderBodyInlineChoice(container, q, answers, result); break;
    case 'matching': renderBodyMatching(container, q, answers); break;
    case 'drag_reorder': renderBodyDragReorder(container, q, answers, result); break;
    case 'drag_categorize':
    case 'categorization': renderBodyDragCategorize(container, q, answers); break;
    case 'image_label': renderBodyImageLabel(container, q, answers); break;
    case 'image_match': renderBodyImageMatch(container, q, answers); break;
  }
  // A normally-auto-graded type can still be flagged for manual grading (e.g. the
  // AI exam importer sets `grading: "manual"` when it can't determine an answer
  // key). Show the auto comparison view above for context, plus a score input.
  if (q.grading === 'manual') {
    container.insertAdjacentHTML('beforeend', manualGradeInputHtml(q.id, Number(q.points) || 0, manualGrades[q.id], q.rubric));
  }
}

export function renderQuestionResult(q, answers, displayNumber, manualGrades = {}) {
  const result = gradeQuestion(q, answers, manualGrades);
  const qEl = document.createElement('div');
  qEl.className = 'question-block';
  let chip;
  if (q.grading === 'manual') {
    chip = result.ungraded ? '<span class="q-grade-chip manual">Awaiting Grade</span>' : '<span class="q-grade-chip manual">Manual</span>';
    qEl.classList.add('manual');
  } else if (result.allBlank) {
    chip = '<span class="q-grade-chip blank">Blank</span>';
  } else if (result.allCorrect) { chip = '<span class="q-grade-chip correct">Correct</span>'; qEl.classList.add('correct'); }
  else if (result.earned > 0) { chip = '<span class="q-grade-chip partial">Partial</span>'; qEl.classList.add('partial'); }
  else { chip = '<span class="q-grade-chip incorrect">Incorrect</span>'; qEl.classList.add('incorrect'); }

  const earnedDisplay = q.grading === 'manual' && result.ungraded ? `— / ${result.max}` : `${result.earned} / ${result.max}`;

  qEl.innerHTML = `
    <div class="q-header">
      <span class="q-id">${esc(String(displayNumber))}</span>
      <div class="q-prompt">${esc(q.prompt || '')}</div>
      <div class="q-meta">
        <span class="q-points-badge">${earnedDisplay}</span>
        ${chip}
      </div>
    </div>
    <div class="q-body" data-qid="${esc(q.id)}"></div>`;
  renderQuestionResultBody(qEl.querySelector('.q-body'), q, answers, result, manualGrades);
  return qEl;
}

// Re-renders just one question's grade chip + points badge after a manual
// score input changes, without re-rendering the whole (potentially large)
// response body. `container` is the page's sectionsContainer.
export function rerenderQuestionChip(container, q, answers, manualGrades) {
  const result = gradeQuestion(q, answers, manualGrades);
  const block = container.querySelector(`.q-body[data-qid="${CSS.escape(q.id)}"]`)?.parentElement;
  if (!block) return;
  const meta = block.querySelector('.q-meta');
  if (!meta) return;
  const chip = q.grading === 'manual'
    ? (result.ungraded ? '<span class="q-grade-chip manual">Awaiting Grade</span>' : '<span class="q-grade-chip manual">Manual</span>')
    : '';
  const earnedDisplay = q.grading === 'manual' && result.ungraded ? `— / ${result.max}` : `${result.earned} / ${result.max}`;
  meta.innerHTML = `<span class="q-points-badge">${earnedDisplay}</span>${chip}`;
}

// ============================================================
// AUTHORING — question type registry, stub factories, and validation
// shared by the Assessment (and later Exam) create/edit pages.
// ============================================================
export const VALID_QUESTION_TYPES = [
  'multiple_choice', 'multiple_select', 'true_false', 'fill_blank',
  'fill_blank_multi', 'dropdown', 'matching', 'drag_reorder', 'drag_categorize'
];

export const TYPE_INFO = {
  multiple_choice:   { label: 'Multiple Choice',     desc: 'Pick one correct answer from a list' },
  multiple_select:   { label: 'Multiple Select',     desc: 'Pick all correct answers (partial credit)' },
  true_false:        { label: 'True / False',        desc: 'A statement to mark T or F' },
  fill_blank:        { label: 'Fill in the Blank',   desc: 'One blank in a sentence' },
  fill_blank_multi:  { label: 'Multi-Blank',         desc: 'Multiple blanks in one sentence' },
  dropdown:          { label: 'Dropdown',            desc: 'Choose from a dropdown inside a sentence' },
  matching:          { label: 'Matching',            desc: 'Match left items with right items' },
  drag_reorder:      { label: 'Drag to Reorder',     desc: 'Drag word chips into the correct order' },
  drag_categorize:   { label: 'Drag to Categorize',  desc: 'Drag items into category columns' }
};

// Bulk CSV/XLSX import only supports the most tabular-friendly types.
export const BULK_IMPORT_TYPES = ['multiple_choice', 'true_false', 'fill_blank'];

// Exam system's own question-type registry — kept separate from Assessment's
// VALID_QUESTION_TYPES/TYPE_INFO above by design: the two systems' type sets
// have historically diverged (Exam has manually-graded types like
// writing_prompt/pool_writing/sentence_order and image-based types; Assessment
// has multiple_select/dropdown/drag_reorder/drag_categorize) and unifying the
// two editors' pickers is a separate decision, not part of this refactor.
export const EXAM_QUESTION_TYPES = [
  'multiple_choice', 'true_false', 'inline_choice', 'fill_blank',
  'fill_blank_multi', 'matching', 'categorization', 'sentence_order',
  'short_answer', 'writing_prompt', 'pool_writing', 'image_label', 'image_match',
];

export const EXAM_TYPE_INFO = {
  multiple_choice: { label: 'Multiple Choice', desc: 'Pick one correct option from a list' },
  true_false: { label: 'True / False', desc: 'A statement to mark T or F' },
  inline_choice: { label: 'Inline Choice', desc: 'Choose between two words inside a sentence' },
  fill_blank: { label: 'Fill in the Blank', desc: 'One blank in a sentence' },
  fill_blank_multi: { label: 'Multi-Blank', desc: 'Multiple blanks in one sentence' },
  matching: { label: 'Matching', desc: 'Match left items with right items' },
  categorization: { label: 'Categorization', desc: 'Sort items into categories' },
  sentence_order: { label: 'Sentence Order', desc: 'Reorder scrambled words (manual)' },
  short_answer: { label: 'Short Answer', desc: 'Brief written response (manual)' },
  writing_prompt: { label: 'Writing Prompt', desc: 'Open-ended writing (manual)' },
  pool_writing: { label: 'Pool Writing', desc: 'Pick N words and write a sentence with each (manual)' },
  image_label: { label: 'Image Label', desc: 'Label parts of an image' },
  image_match: { label: 'Image Match', desc: 'Match items to numbered regions of an image' },
};

export function generateQuestionId(examDef) {
  if (!examDef) return 'q1';
  let maxNum = 0, foundNumeric = false;
  (examDef.sections || []).forEach(s => (s.questions || []).forEach(q => {
    const m = String(q.id || '').match(/^q?(\d+)/i);
    if (m) { foundNumeric = true; const n = parseInt(m[1], 10); if (n > maxNum) maxNum = n; }
  }));
  if (foundNumeric) return `q${maxNum + 1}`;
  const count = (examDef.sections || []).reduce((sum, s) => sum + (s.questions?.length || 0), 0);
  return `q${count + 1}`;
}

export function generateSectionId(examDef) {
  if (!examDef) return 'section_1';
  const count = (examDef.sections || []).length;
  return `section_${count + 1}`;
}

export function makeQuestionStub(type, examDef) {
  const id = generateQuestionId(examDef);
  const base = { id, type, prompt: '', points: 1 };

  switch (type) {
    case 'multiple_choice':
      return { ...base, grading: 'auto',
        options: [{ key: 'a', text: '' }, { key: 'b', text: '' }, { key: 'c', text: '' }, { key: 'd', text: '' }],
        answer: '' };
    case 'multiple_select':
      return { ...base, grading: 'auto', points: 2,
        options: [{ key: 'a', text: '' }, { key: 'b', text: '' }, { key: 'c', text: '' }, { key: 'd', text: '' }],
        correct_answers: [] };
    case 'true_false':
      return { ...base, grading: 'auto', answer: 'T' };
    case 'fill_blank':
      return { ...base, grading: 'auto',
        prompt: 'I {blank} speak three languages.',
        answer: '', accepted_answers: [], case_sensitive: false };
    case 'fill_blank_multi':
      return { ...base, grading: 'auto',
        prompt: '{blank} you {blank} on the phone?',
        blanks: [
          { id: `${id}a`, answer: '', accepted_answers: [], points: 0.5 },
          { id: `${id}b`, answer: '', accepted_answers: [], points: 0.5 }
        ],
        case_sensitive: false };
    case 'dropdown':
      return { ...base, grading: 'auto',
        prompt: 'She {choice} to work every day.',
        options: ['', ''], answer: '' };
    case 'matching':
      return { ...base, grading: 'auto', points: 2,
        left_items: [{ id: '1', text: '' }, { id: '2', text: '' }],
        right_items: [{ key: 'A', text: '' }, { key: 'B', text: '' }],
        answers: {} };
    case 'drag_reorder':
      return { ...base, grading: 'auto', points: 2, words: [], expected: '' };
    case 'drag_categorize':
      return { ...base, grading: 'auto', points: 4,
        items: [],
        categories: [{ id: 'cat1', label: 'Category 1' }, { id: 'cat2', label: 'Category 2' }],
        answers: {} };
    // ---- Exam-only types ----
    case 'inline_choice':
      return { ...base, grading: 'auto', prompt: 'She {choice} to work every day.', answer: '' };
    case 'categorization':
      return { ...base, grading: 'auto', points: 4,
        items: [],
        categories: [{ id: 'cat1', label: 'Category 1' }, { id: 'cat2', label: 'Category 2' }],
        answers: {} };
    case 'sentence_order':
      return { ...base, grading: 'manual', points: 2, words: [], expected: '' };
    case 'short_answer':
      return { ...base, grading: 'manual', points: 2 };
    case 'writing_prompt':
      return { ...base, grading: 'manual', points: 10, rubric: '' };
    case 'pool_writing':
      return { ...base, grading: 'manual', points: 10, required_count: 3, points_per_sentence: null, word_pool: [], rubric: '' };
    case 'image_label':
      return { ...base, grading: 'auto', points: 4, image: null, labels: [] };
    case 'image_match':
      return { ...base, grading: 'auto', points: 4, image: null, items: [], answers: {} };
    default:
      return base;
  }
}

export function makeSectionStub(examDef) {
  return {
    id: generateSectionId(examDef),
    title: 'New Section',
    instructions: null,
    passage: null,
    questions: []
  };
}

export function validateAuthoredQuestion(q) {
  const errors = [];
  const warnings = [];

  if (!q.id) errors.push('Missing ID');
  if (!q.type || !VALID_QUESTION_TYPES.includes(q.type)) errors.push('Invalid question type');
  if (q.points == null || q.points < 0) errors.push('Invalid points');
  if (!q.prompt || !q.prompt.trim()) errors.push('Missing prompt');
  if (!['auto', 'manual'].includes(q.grading)) errors.push('Invalid grading mode');

  if (q.grading === 'auto') {
    switch (q.type) {
      case 'multiple_choice':
        if (!q.options?.length) errors.push('No options');
        if (!q.answer) warnings.push('No correct answer set');
        else if (!q.options?.find(o => o.key === q.answer)) errors.push('Answer does not match any option');
        break;
      case 'multiple_select':
        if (!q.options?.length) errors.push('No options');
        if (!q.correct_answers?.length) warnings.push('No correct answers set');
        break;
      case 'true_false':
        if (!q.answer || !['T', 'F', 'true', 'false'].includes(q.answer)) warnings.push('Answer should be T or F');
        break;
      case 'fill_blank':
        if (!q.answer) warnings.push('No correct answer set');
        break;
      case 'fill_blank_multi':
        if (!q.blanks?.length) errors.push('No blanks defined');
        else if (q.blanks.some(b => !b.answer)) warnings.push('Some blanks missing answers');
        break;
      case 'dropdown':
        if (!q.options?.length) errors.push('No options');
        if (!q.answer) warnings.push('No correct answer set');
        break;
      case 'matching':
        if (!q.left_items?.length || !q.right_items?.length) errors.push('Matching items incomplete');
        if (!q.answers || !Object.keys(q.answers).length) warnings.push('No answer key set');
        break;
      case 'drag_reorder':
        if (!q.words?.length) errors.push('No words defined');
        if (!q.expected) warnings.push('No expected order set');
        break;
      case 'drag_categorize':
        if (!q.items?.length || !q.categories?.length) errors.push('Items or categories missing');
        if (!q.answers || !Object.keys(q.answers).length) warnings.push('No category mapping set');
        break;
    }
  }

  return { errors, warnings };
}

export function renderDefinitionResults(container, definition, answers, manualGrades = {}) {
  if (!definition || !definition.sections) {
    container.innerHTML = '<p style="color:var(--navy-l);font-style:italic;">No question definition found.</p>';
    return;
  }
  container.innerHTML = '';
  let displayCounter = 0;
  (definition.sections || []).forEach((section, sIdx) => {
    const sectionEl = document.createElement('div');
    sectionEl.className = 'section-block';
    let passageHtml = '';
    if (section.passage?.content) {
      passageHtml = `<div class="section-passage" data-toggle-passage>${esc(section.passage.content)}</div>`;
    }
    sectionEl.innerHTML = `
      <div class="section-header">
        <div class="section-label">Section ${sIdx + 1} of ${definition.sections.length}</div>
        <div class="section-title-text">${esc(section.title || 'Untitled section')}</div>
        ${section.instructions ? `<div style="font-style:italic;font-family:var(--serif);color:var(--navy-l);margin-top:0.3rem;font-size:0.95rem;">${esc(section.instructions)}</div>` : ''}
        ${passageHtml}
      </div>
      <div class="section-questions"></div>`;
    container.appendChild(sectionEl);
    const passageEl = sectionEl.querySelector('[data-toggle-passage]');
    if (passageEl) passageEl.addEventListener('click', () => passageEl.classList.toggle('expanded'));
    const qContainer = sectionEl.querySelector('.section-questions');
    (section.questions || []).forEach(q => {
      displayCounter++;
      qContainer.appendChild(renderQuestionResult(q, answers, displayCounter, manualGrades));
    });
  });
}

// ============================================================
// TAKING MODE — interactive question rendering for student-facing pages
// (assessment/page.html, and later the Exam system's runner). Each question
// is rendered as a live input the student fills in, then read back out via
// collectQuestionAnswer(). Drag-based types (drag_reorder, drag_categorize)
// carry a small piece of state beyond the plain answers map — the current
// bank/answer arrangement — which the caller owns as `dragState`, an object
// keyed by question id (mirrors how `answers` is keyed by question/blank id).
// ============================================================

export function renderQuestionTaking(q, displayNumber, dragState, onDragChange) {
  const qEl = document.createElement('div');
  qEl.className = 'question';
  qEl.id = `q-${q.id}`;
  const numHtml = `<span class="q-number">${esc(String(displayNumber))}</span>`;
  const ptsHtml = q.points ? `<span class="q-points">${q.points} pt${q.points === 1 ? '' : 's'}</span>` : '';

  switch (q.type) {
    case 'multiple_choice':  renderTakingMC(qEl, q, numHtml, ptsHtml); break;
    case 'multiple_select':  renderTakingMS(qEl, q, numHtml, ptsHtml); break;
    case 'true_false':       renderTakingTF(qEl, q, numHtml, ptsHtml); break;
    case 'fill_blank':       renderTakingFB(qEl, q, numHtml, ptsHtml); break;
    case 'fill_blank_multi': renderTakingFBM(qEl, q, numHtml, ptsHtml); break;
    case 'dropdown':         renderTakingDD(qEl, q, numHtml, ptsHtml); break;
    case 'matching':         renderTakingMatching(qEl, q, numHtml, ptsHtml); break;
    case 'drag_reorder':     renderTakingDragReorder(qEl, q, numHtml, ptsHtml, dragState, onDragChange); break;
    case 'drag_categorize':  renderTakingDragCategorize(qEl, q, numHtml, ptsHtml, dragState, onDragChange); break;
    default:
      qEl.innerHTML = `<div class="q-prompt">${numHtml} <em class="q-unknown-type">Unknown type: ${esc(q.type)}</em></div>`;
  }
  return qEl;
}

function renderTakingMC(el, q, numHtml, ptsHtml) {
  el.innerHTML = `
    <div class="q-prompt">${numHtml}${esc(q.prompt)}${ptsHtml}</div>
    <div class="options">
      ${(q.options || []).map(o => `
        <label class="option">
          <input type="radio" name="${esc(q.id)}" value="${esc(o.key)}">
          <span class="option-letter">${esc(String(o.key).toUpperCase())}</span>
          <span>${esc(o.text)}</span>
        </label>`).join('')}
    </div>`;
}

function renderTakingMS(el, q, numHtml, ptsHtml) {
  el.innerHTML = `
    <div class="q-prompt">${numHtml}${esc(q.prompt)}${ptsHtml}</div>
    <div class="select-all-hint">Select all that apply.</div>
    <div class="options">
      ${(q.options || []).map(o => `
        <label class="option ms">
          <input type="checkbox" name="${esc(q.id)}" value="${esc(o.key)}">
          <span class="option-letter">${esc(String(o.key).toUpperCase())}</span>
          <span>${esc(o.text)}</span>
        </label>`).join('')}
    </div>`;
}

function renderTakingTF(el, q, numHtml, ptsHtml) {
  el.innerHTML = `
    <div class="tf-row">
      <span class="tf-num">${numHtml}</span>
      <div class="tf-statement">${esc(q.prompt)}${ptsHtml}</div>
      <div class="tf-buttons">
        <label><input type="radio" name="${esc(q.id)}" value="T">T</label>
        <label><input type="radio" name="${esc(q.id)}" value="F">F</label>
      </div>
    </div>`;
}

function renderTakingFB(el, q, numHtml, ptsHtml) {
  const inp = `<input type="text" class="blank-input" name="${esc(q.id)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">`;
  el.innerHTML = `<div class="q-prompt">${numHtml}${esc(q.prompt).replace('{blank}', inp)}${ptsHtml}</div>`;
}

function renderTakingFBM(el, q, numHtml, ptsHtml) {
  let html = esc(q.prompt);
  (q.blanks || []).forEach(b => {
    html = html.replace('{blank}', `<input type="text" class="blank-input" name="${esc(b.id)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">`);
  });
  el.innerHTML = `<div class="q-prompt">${numHtml}${html}${ptsHtml}</div>`;
}

function renderTakingDD(el, q, numHtml, ptsHtml) {
  const opts = (q.options || []).map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  const sel = `<span class="dropdown-inline"><select name="${esc(q.id)}"><option value="">— choose —</option>${opts}</select></span>`;
  el.innerHTML = `<div class="q-prompt">${numHtml}${esc(q.prompt).replace('{choice}', sel)}${ptsHtml}</div>`;
}

function renderTakingMatching(el, q, numHtml, ptsHtml) {
  const right = q.right_items || [];
  let gridHtml = '';
  (q.left_items || []).forEach(l => {
    const opts = right.map(r => `<option value="${esc(r.key)}">${esc(r.key)}) ${esc(r.text)}</option>`).join('');
    gridHtml += `<div class="match-left">${esc(l.id)}) ${esc(l.text)}</div>
      <div class="match-arrow">→</div>
      <div class="match-arrow-down">↓</div>
      <select name="${esc(q.id)}__${esc(l.id)}"><option value="">— select —</option>${opts}</select>`;
  });
  el.innerHTML = `<div class="q-prompt">${numHtml}${esc(q.prompt)}${ptsHtml}</div><div class="match-grid">${gridHtml}</div>`;
}

// ----- Drag-and-drop (drag_reorder / drag_categorize) -----
// Only one chip is ever being dragged at a time across the whole page, so a
// module-scoped `dragging` pointer (rather than something threaded through
// every call) matches how the original inline implementation worked.
let dragging = { word: null, qId: null, from: null, fromCat: null, type: null };
let touchState = { chip: null, clone: null, startX: 0, startY: 0 };

function onChipDragStart(e) {
  dragging = { word: e.target.dataset.word, qId: e.target.dataset.qid, from: 'bank', type: 'reorder' };
  e.target.classList?.add('dragging');
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
function onDcChipDragStart(e) {
  const catZone = e.target.closest?.('[data-cat]');
  dragging = { word: e.target.dataset.word, qId: e.target.dataset.qid, from: catZone ? 'cat' : 'bank', fromCat: catZone?.dataset.cat || null, type: 'categorize' };
  e.target.classList?.add('dragging');
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}

function onTouchStart(e) {
  touchState.chip = e.currentTarget;
  const rect = touchState.chip.getBoundingClientRect();
  const t = e.touches[0];
  touchState.startX = t.clientX - rect.left;
  touchState.startY = t.clientY - rect.top;
  touchState.clone = touchState.chip.cloneNode(true);
  touchState.clone.style.cssText = `position:fixed;z-index:999;opacity:0.8;pointer-events:none;left:${t.clientX - touchState.startX}px;top:${t.clientY - touchState.startY}px;`;
  document.body.appendChild(touchState.clone);
  const dc = touchState.chip.classList.contains('dc-chip');
  if (dc) onDcChipDragStart({ target: touchState.chip, dataTransfer: null });
  else onChipDragStart({ target: touchState.chip, dataTransfer: null });
}
function onTouchMove(e) {
  e.preventDefault();
  const t = e.touches[0];
  if (touchState.clone) { touchState.clone.style.left = (t.clientX - touchState.startX) + 'px'; touchState.clone.style.top = (t.clientY - touchState.startY) + 'px'; }
  document.querySelectorAll('.drag-answer,.drag-bank,.dc-drop,.dc-bank').forEach(z => z.classList.remove('over'));
  const el = document.elementFromPoint(t.clientX, t.clientY);
  const zone = el?.closest('.drag-answer,.drag-bank,.dc-drop,.dc-bank');
  if (zone) zone.classList.add('over');
}
function onTouchEnd(e) {
  if (touchState.clone) { touchState.clone.remove(); touchState.clone = null; }
  const t = e.changedTouches[0];
  const el = document.elementFromPoint(t.clientX, t.clientY);
  const zone = el?.closest('.drag-answer,.drag-bank,.dc-drop,.dc-bank');
  document.querySelectorAll('.drag-answer,.drag-bank,.dc-drop,.dc-bank').forEach(z => z.classList.remove('over'));
  if (zone) zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
  touchState = { chip: null, clone: null, startX: 0, startY: 0 };
}

function makeChip(word, qId) {
  const chip = document.createElement('div');
  chip.className = 'drag-chip';
  chip.textContent = word;
  chip.dataset.word = word;
  chip.dataset.qid = qId;
  chip.draggable = true;
  chip.addEventListener('dragstart', onChipDragStart);
  chip.addEventListener('touchstart', onTouchStart, { passive: true });
  chip.addEventListener('touchmove', onTouchMove, { passive: false });
  chip.addEventListener('touchend', onTouchEnd);
  return chip;
}
function makeDcChip(word, qId) {
  const chip = document.createElement('div');
  chip.className = 'dc-chip';
  chip.textContent = word;
  chip.dataset.word = word;
  chip.dataset.qid = qId;
  chip.draggable = true;
  chip.addEventListener('dragstart', onDcChipDragStart);
  chip.addEventListener('touchstart', onTouchStart, { passive: true });
  chip.addEventListener('touchmove', onTouchMove, { passive: false });
  chip.addEventListener('touchend', onTouchEnd);
  return chip;
}

function renderDragChipsInto(container, qId, ds, q) {
  if (!ds) return;
  const isCategorize = ds.catMap !== undefined;

  if (ds.bank !== undefined) {
    const bankEl = container.querySelector('#bank-' + CSS.escape(qId)) || container.querySelector('#dcbank-' + CSS.escape(qId));
    if (bankEl) {
      bankEl.innerHTML = '';
      if (ds.bank.length === 0) {
        bankEl.innerHTML = `<span class="drag-empty">${isCategorize ? 'All items placed' : 'All words placed'}</span>`;
      } else {
        ds.bank.forEach(word => bankEl.appendChild(isCategorize ? makeDcChip(word, qId) : makeChip(word, qId)));
      }
    }
  }

  if (ds.answer !== undefined) {
    const ansEl = container.querySelector('#answer-' + CSS.escape(qId));
    if (ansEl) {
      ansEl.innerHTML = '';
      if (ds.answer.length === 0) ansEl.innerHTML = '<span class="drag-empty">Drop words here to build your answer</span>';
      else ds.answer.forEach(word => ansEl.appendChild(makeChip(word, qId)));
    }
  }

  if (ds.catMap) {
    (q.categories || []).forEach(c => {
      const zone = container.querySelector(`#cat-${CSS.escape(qId)}-${CSS.escape(c.id)}`);
      if (zone) {
        zone.innerHTML = '';
        const items = ds.catMap[c.id] || [];
        if (items.length === 0) zone.innerHTML = '<span class="drag-empty dc-drop-empty">Drop here</span>';
        else items.forEach(word => zone.appendChild(makeDcChip(word, qId)));
      }
    });
  }
}

function setupDragZones(container, qId, type, dragState, q, onDragChange) {
  if (type === 'reorder') {
    const bankEl = container.querySelector('#bank-' + CSS.escape(qId));
    const ansEl = container.querySelector('#answer-' + CSS.escape(qId));
    [bankEl, ansEl].forEach(zone => {
      if (!zone) return;
      zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('over'));
      zone.addEventListener('drop', e => {
        e.preventDefault(); zone.classList.remove('over');
        if (dragging.qId !== qId) return;
        container.querySelector('.drag-chip.dragging')?.classList.remove('dragging');
        const ds = dragState[qId];
        const isAnswerZone = zone.id.startsWith('answer-');
        const isFromBank = dragging.from === 'bank';
        if (isAnswerZone && isFromBank) {
          ds.bank = ds.bank.filter(w => w !== dragging.word);
          ds.answer.push(dragging.word);
        } else if (!isAnswerZone && !isFromBank) {
          ds.answer = ds.answer.filter(w => w !== dragging.word);
          ds.bank.push(dragging.word);
        }
        renderDragChipsInto(container, qId, ds, q);
        onDragChange?.();
        dragging = {};
      });
    });
  } else {
    const bankEl = container.querySelector('#dcbank-' + CSS.escape(qId));
    if (bankEl) {
      bankEl.addEventListener('dragover', e => { e.preventDefault(); bankEl.classList.add('over'); });
      bankEl.addEventListener('dragleave', () => bankEl.classList.remove('over'));
      bankEl.addEventListener('drop', e => {
        e.preventDefault(); bankEl.classList.remove('over');
        if (dragging.qId !== qId || dragging.from !== 'cat') return;
        container.querySelector('.dc-chip.dragging')?.classList.remove('dragging');
        const ds = dragState[qId];
        ds.catMap[dragging.fromCat] = (ds.catMap[dragging.fromCat] || []).filter(w => w !== dragging.word);
        ds.bank.push(dragging.word);
        renderDragChipsInto(container, qId, ds, q);
        onDragChange?.();
        dragging = {};
      });
    }
    container.querySelectorAll(`[id^="cat-${CSS.escape(qId)}-"]`).forEach(zone => {
      zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('over'));
      zone.addEventListener('drop', e => {
        e.preventDefault(); zone.classList.remove('over');
        if (dragging.qId !== qId) return;
        container.querySelector('.dc-chip.dragging, .drag-chip.dragging')?.classList.remove('dragging');
        const catId = zone.dataset.cat;
        const ds = dragState[qId];
        if (dragging.from === 'bank') ds.bank = ds.bank.filter(w => w !== dragging.word);
        else if (dragging.from === 'cat') ds.catMap[dragging.fromCat] = (ds.catMap[dragging.fromCat] || []).filter(w => w !== dragging.word);
        if (!ds.catMap[catId]) ds.catMap[catId] = [];
        ds.catMap[catId].push(dragging.word);
        renderDragChipsInto(container, qId, ds, q);
        onDragChange?.();
        dragging = {};
      });
    });
  }
}

function renderTakingDragReorder(el, q, numHtml, ptsHtml, dragState, onDragChange) {
  const words = [...(q.words || [])].sort(() => Math.random() - 0.5);
  const qId = q.id;
  dragState[qId] = { bank: [...words], answer: [] };

  el.innerHTML = `
    <div class="q-prompt">${numHtml}${esc(q.prompt)}${ptsHtml}</div>
    <div class="drag-zone-wrap">
      <span class="drag-bank-label">Words (drag from here)</span>
      <div class="drag-bank" id="bank-${esc(qId)}"></div>
      <span class="drag-answer-label">Your answer (drag here)</span>
      <div class="drag-answer" id="answer-${esc(qId)}"></div>
    </div>`;

  renderDragChipsInto(el, qId, dragState[qId], q);
  setupDragZones(el, qId, 'reorder', dragState, q, onDragChange);
}

function renderTakingDragCategorize(el, q, numHtml, ptsHtml, dragState, onDragChange) {
  const qId = q.id;
  const items = [...(q.items || [])].sort(() => Math.random() - 0.5);
  const catMap = {};
  (q.categories || []).forEach(c => catMap[c.id] = []);
  dragState[qId] = { bank: [...items], catMap };

  const colsHtml = (q.categories || []).map(c => `
    <div>
      <div class="dc-col-head">${esc(c.label)}</div>
      <div class="dc-drop" id="cat-${esc(qId)}-${esc(c.id)}" data-cat="${esc(c.id)}"></div>
    </div>`).join('');

  el.innerHTML = `
    <div class="q-prompt">${numHtml}${esc(q.prompt)}${ptsHtml}</div>
    <span class="drag-bank-label">Items (drag into a category)</span>
    <div class="dc-bank" id="dcbank-${esc(qId)}"></div>
    <div class="dc-columns">${colsHtml}</div>`;

  renderDragChipsInto(el, qId, dragState[qId], q);
  setupDragZones(el, qId, 'categorize', dragState, q, onDragChange);
}

// Reads the current DOM state of a rendered question back into the shared
// `answers` map (and, for drag types, updates from `dragState`). Call this
// on every input/change event and before navigating away from a question.
//
// NOTE: fixes a bug present in the original inline implementation, where
// `dropdown` was grouped with the radio-input types and so its <select>
// value was never actually collected (the `input[name]:checked` selector
// never matches a <select>). Restoring a saved dropdown answer worked, but
// saving a freshly-picked one silently did not. Handled correctly here.
export function collectQuestionAnswer(q, container, answers, dragState) {
  if (!q || !container) return;
  if (q.type === 'multiple_choice' || q.type === 'true_false') {
    const checked = container.querySelector(`input[name="${CSS.escape(q.id)}"]:checked`);
    if (checked) answers[q.id] = checked.value;
  } else if (q.type === 'dropdown') {
    const sel = container.querySelector(`select[name="${CSS.escape(q.id)}"]`);
    if (sel && sel.value) answers[q.id] = sel.value;
  } else if (q.type === 'multiple_select') {
    const checked = [...container.querySelectorAll(`input[name="${CSS.escape(q.id)}"]:checked`)].map(i => i.value);
    if (checked.length) answers[q.id] = checked;
  } else if (q.type === 'fill_blank') {
    const inp = container.querySelector(`input[name="${CSS.escape(q.id)}"]`);
    if (inp?.value) answers[q.id] = inp.value;
  } else if (q.type === 'fill_blank_multi') {
    (q.blanks || []).forEach(b => {
      const inp = container.querySelector(`input[name="${CSS.escape(b.id)}"]`);
      if (inp?.value) answers[b.id] = inp.value;
    });
  } else if (q.type === 'matching') {
    (q.left_items || []).forEach(l => {
      const sel = container.querySelector(`select[name="${CSS.escape(q.id)}__${CSS.escape(l.id)}"]`);
      if (sel?.value) answers[`${q.id}__${l.id}`] = sel.value;
    });
  } else if (q.type === 'drag_reorder') {
    const ds = dragState[q.id];
    if (ds) answers[q.id] = ds.answer.join(' ');
  } else if (q.type === 'drag_categorize') {
    const ds = dragState[q.id];
    if (ds) {
      Object.entries(ds.catMap).forEach(([catId, items]) => {
        items.forEach(item => { answers[`${q.id}__${item}`] = catId; });
      });
    }
  }
}

// Bulk CSV/XLSX import for the Exam system — scoped to the most
// tabular-friendly of the 13 exam types. Kept as its own export (rather than
// reusing Assessment's BULK_IMPORT_TYPES) since the two systems' bulk-import
// column sets differ (exam's fill_blank/short_answer rows don't need
// multiple_select-style option columns Assessment doesn't have either, but
// the two lists are allowed to diverge independently going forward).
export const EXAM_BULK_IMPORT_TYPES = ['multiple_choice', 'true_false', 'fill_blank', 'short_answer'];

// Exam-side authoring validator — scoped to EXAM_QUESTION_TYPES and the
// exam's own per-type shape (manual types like short_answer/writing_prompt/
// pool_writing/sentence_order need different checks than Assessment's
// auto-only types, and exam has image-based types Assessment lacks). Kept
// separate from validateAuthoredQuestion by design — do not merge.
export function validateExamQuestion(q) {
  const errors = [];
  const warnings = [];

  if (!q.id) errors.push('Missing ID');
  if (!q.type || !EXAM_QUESTION_TYPES.includes(q.type)) errors.push('Invalid question type');
  if (q.points == null || q.points < 0) errors.push('Invalid points');
  if (!q.prompt || !q.prompt.trim()) errors.push('Missing prompt');
  if (!['auto', 'manual'].includes(q.grading)) errors.push('Invalid grading mode');

  if (q.grading === 'auto') {
    switch (q.type) {
      case 'multiple_choice':
        if (!q.options?.length) errors.push('No options');
        if (!q.answer) warnings.push('No correct answer set');
        else if (!q.options?.find(o => o.key === q.answer)) errors.push('Answer does not match any option');
        break;
      case 'true_false':
        if (!q.answer || !['T', 'F', 'true', 'false'].includes(q.answer)) warnings.push('Answer should be T or F');
        break;
      case 'inline_choice':
        if (!q.options?.length) errors.push('No options');
        if (!q.answer) warnings.push('No correct answer set');
        break;
      case 'fill_blank':
        if (!q.answer) warnings.push('No correct answer set');
        break;
      case 'fill_blank_multi':
        if (!q.blanks?.length) errors.push('No blanks defined');
        else if (q.blanks.some(b => !b.answer)) warnings.push('Some blanks missing answers');
        break;
      case 'matching':
        if (!q.left_items?.length || !q.right_items?.length) errors.push('Matching items incomplete');
        if (!q.answers || !Object.keys(q.answers).length) warnings.push('No answer key set');
        break;
      case 'categorization':
        if (!q.items?.length || !q.categories?.length) errors.push('Items or categories missing');
        if (!q.answers) warnings.push('No category mapping set');
        break;
      case 'image_label':
        if (!q.labels?.length) errors.push('No labels defined');
        if (!q.image?.url) warnings.push('Image not yet uploaded');
        break;
      case 'image_match':
        if (!q.items?.length || !q.image_regions?.length) errors.push('Items or regions missing');
        if (!q.image?.url) warnings.push('Image not yet uploaded');
        break;
    }
  } else {
    switch (q.type) {
      case 'sentence_order':
        if (!q.words?.length) errors.push('No scrambled words defined');
        break;
      case 'pool_writing':
        if (!q.word_pool?.length) errors.push('No word pool defined');
        if (!q.required_count) warnings.push('No required sentence count set');
        break;
    }
  }

  if (q.image && !q.image.url) warnings.push('Image not yet uploaded');

  return { errors, warnings };
}

// Populates a freshly-rendered question's DOM (and dragState, for drag
// types) from a previously-saved `answers` map — used when a student
// resumes an in-progress session.
export function restoreQuestionAnswer(q, container, answers, dragState) {
  if (!q || !container) return;

  if (q.type === 'drag_reorder' && answers[q.id]) {
    const answered = answers[q.id].split(' ').filter(Boolean);
    const allWords = q.words || [];
    const bank = allWords.filter(w => !answered.includes(w));
    dragState[q.id] = { bank, answer: answered };
    renderDragChipsInto(container, q.id, dragState[q.id], q);
    return;
  } else if (q.type === 'drag_categorize') {
    const ds = dragState[q.id];
    if (!ds) return;
    const placed = new Set();
    Object.entries(answers).forEach(([key, val]) => {
      if (key.startsWith(q.id + '__')) {
        const item = key.slice(q.id.length + 2);
        if (!ds.catMap[val]) ds.catMap[val] = [];
        if (!ds.catMap[val].includes(item)) ds.catMap[val].push(item);
        placed.add(item);
      }
    });
    ds.bank = (q.items || []).filter(i => !placed.has(i));
    renderDragChipsInto(container, q.id, ds, q);
    return;
  }

  // Standard form inputs — restore on the next tick since the question's
  // DOM was just injected via innerHTML on this one.
  setTimeout(() => {
    if (q.type === 'multiple_choice' || q.type === 'true_false') {
      const v = answers[q.id];
      if (v) { const el = container.querySelector(`input[name="${CSS.escape(q.id)}"][value="${CSS.escape(v)}"]`); if (el) el.checked = true; }
    } else if (q.type === 'dropdown') {
      const v = answers[q.id];
      if (v) { const el = container.querySelector(`select[name="${CSS.escape(q.id)}"]`); if (el) el.value = v; }
    } else if (q.type === 'multiple_select') {
      const vals = answers[q.id] || [];
      vals.forEach(v => { const el = container.querySelector(`input[name="${CSS.escape(q.id)}"][value="${CSS.escape(v)}"]`); if (el) el.checked = true; });
    } else if (q.type === 'fill_blank') {
      const v = answers[q.id];
      if (v) { const el = container.querySelector(`input[name="${CSS.escape(q.id)}"]`); if (el) el.value = v; }
    } else if (q.type === 'fill_blank_multi') {
      (q.blanks || []).forEach(b => { const v = answers[b.id]; if (v) { const el = container.querySelector(`input[name="${CSS.escape(b.id)}"]`); if (el) el.value = v; } });
    } else if (q.type === 'matching') {
      (q.left_items || []).forEach(l => { const v = answers[`${q.id}__${l.id}`]; if (v) { const el = container.querySelector(`select[name="${CSS.escape(q.id)}__${CSS.escape(l.id)}"]`); if (el) el.value = v; } });
    }
  }, 50);
}
