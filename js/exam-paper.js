// Renders a published exam as a print-friendly paper document (questions + answer key).
// Shared by the teacher print view (js/pages/exam-print.js).
import { esc } from './ui.js';

function questionBody(q) {
  switch (q.type) {
    case 'multiple_choice':
      return `<div class="paper-q-body">${esc(q.prompt)}</div>
        <ul class="paper-options">${(q.options || []).map(o =>
          `<li>${esc(String(o.key).toUpperCase())}) ${esc(o.text)}</li>`).join('')}</ul>`;

    case 'true_false':
      return `<div class="paper-q-body">${esc(q.prompt)} &nbsp; ( T / F )</div>`;

    case 'inline_choice': {
      const choice = `(${(q.options || []).join(' / ')})`;
      return `<div class="paper-q-body">${esc(q.prompt).replace('{choice}', choice)}</div>`;
    }

    case 'fill_blank':
      return `<div class="paper-q-body">${esc(q.prompt).replace('{blank}', '<span class="paper-blank-line"></span>')}</div>`;

    case 'fill_blank_multi': {
      let html = esc(q.prompt);
      (q.blanks || []).forEach(() => { html = html.replace('{blank}', '<span class="paper-blank-line"></span>'); });
      return `<div class="paper-q-body">${html}</div>`;
    }

    case 'matching': {
      const rightList = (q.right_items || []).map(r => `${esc(r.key)}) ${esc(r.text)}`).join('&nbsp;&nbsp;&nbsp;');
      const rows = (q.left_items || []).map(l =>
        `<li><span class="paper-blank-line paper-blank-line--sm"></span> ${esc(l.id)}) ${esc(l.text)}</li>`).join('');
      return `<div class="paper-q-body">${esc(q.prompt)}</div>
        <div class="paper-q-note">${rightList}</div>
        <ul class="paper-options">${rows}</ul>`;
    }

    case 'categorization': {
      const cats = (q.categories || []).map(c => esc(c.label)).join(', ');
      const rows = (q.items || []).map(it =>
        `<li><span class="paper-blank-line paper-blank-line--sm"></span> ${esc(it)}</li>`).join('');
      return `<div class="paper-q-body">${esc(q.prompt)}</div>
        <div class="paper-q-note">Categories: ${cats}</div>
        <ul class="paper-options">${rows}</ul>`;
    }

    case 'sentence_order':
      return `<div class="paper-q-body">${esc(q.prompt || '')}<br>
        <em>${(q.words || []).map(esc).join(' / ')}</em>
        <div class="paper-writing-line"></div></div>`;

    case 'short_answer':
    case 'writing_prompt':
      return `<div class="paper-q-body">${esc(q.prompt)}
        <div class="paper-writing-line"></div><div class="paper-writing-line"></div><div class="paper-writing-line"></div></div>`;

    case 'pool_writing': {
      const required = q.required_count || (q.word_pool || []).length;
      const pool = (q.word_pool || []).map(esc).join(', ');
      let lines = '';
      for (let i = 1; i <= required; i++) lines += `<div class="paper-writing-line"></div>`;
      return `<div class="paper-q-body">${esc(q.prompt)}
        <div class="paper-q-note">Word bank: ${pool}</div>${lines}</div>`;
    }

    case 'image_label': {
      const img = q.image?.url ? `<img src="${esc(q.image.url)}" alt="${esc(q.image.alt || '')}">` : '';
      const rows = (q.labels || []).map(l =>
        `<li>${esc(l.label)}: <span class="paper-blank-line"></span></li>`).join('');
      return `<div class="paper-q-body">${esc(q.prompt)}${img}</div><ul class="paper-options">${rows}</ul>`;
    }

    case 'image_match': {
      const img = q.image?.url ? `<img src="${esc(q.image.url)}" alt="${esc(q.image.alt || '')}">` : '';
      const rows = (q.items || []).map(it =>
        `<li>${esc(it)}: <span class="paper-blank-line"></span></li>`).join('');
      return `<div class="paper-q-body">${esc(q.prompt)}${img}</div><ul class="paper-options">${rows}</ul>`;
    }

    default:
      return `<div class="paper-q-body">${esc(q.prompt || '')}</div>`;
  }
}

function answerKeyRow(q, num) {
  let answer;
  switch (q.type) {
    case 'multiple_choice': {
      const opt = (q.options || []).find(o => o.key === q.answer);
      answer = `${esc(String(q.answer || '—').toUpperCase())}${opt ? ` — ${esc(opt.text)}` : ''}`;
      break;
    }
    case 'true_false':
      answer = q.answer === 'T' ? 'True' : q.answer === 'F' ? 'False' : '—';
      break;
    case 'inline_choice':
      answer = esc(q.answer || '—');
      break;
    case 'fill_blank':
      answer = [q.answer, ...(q.accepted_answers || [])].filter(Boolean).map(esc).join(' / ') || '—';
      break;
    case 'fill_blank_multi':
      answer = (q.blanks || []).map(b => esc(b.answer || '—')).join('; ') || '—';
      break;
    case 'matching': {
      const rightByKey = Object.fromEntries((q.right_items || []).map(r => [r.key, r.text]));
      const leftById = Object.fromEntries((q.left_items || []).map(l => [l.id, l.text]));
      answer = Object.entries(q.answers || {}).map(([leftId, rightKey]) =>
        `${esc(leftById[leftId] || leftId)} → ${esc(rightByKey[rightKey] || rightKey)}`).join('; ') || '—';
      break;
    }
    case 'categorization': {
      const catById = Object.fromEntries((q.categories || []).map(c => [c.id, c.label]));
      answer = Object.entries(q.answers || {}).map(([item, catId]) =>
        `${esc(item)} → ${esc(catById[catId] || catId)}`).join('; ') || '—';
      break;
    }
    case 'sentence_order':
      answer = esc(q.expected || '—');
      break;
    case 'short_answer':
      answer = q.expected_answer ? esc(q.expected_answer) : `Manually graded${q.rubric ? ` — ${esc(q.rubric)}` : ''}`;
      break;
    case 'writing_prompt':
      answer = `Manually graded${q.rubric ? ` — ${esc(q.rubric)}` : ''}`;
      break;
    case 'pool_writing':
      answer = `Manually graded — must use ${q.required_count || (q.word_pool || []).length} word(s) from the bank`;
      break;
    case 'image_label':
      answer = (q.labels || []).map(l => `${esc(l.label)}: ${esc(l.answer || '—')}`).join('; ') || '—';
      break;
    case 'image_match':
      answer = Object.entries(q.answers || {}).map(([item, region]) => `${esc(item)}: ${esc(region)}`).join('; ') || '—';
      break;
    default:
      answer = '—';
  }
  const pts = q.points ? ` (${q.points} pt${q.points === 1 ? '' : 's'})` : '';
  return `<div class="paper-answer-row"><strong>${num}.</strong> ${answer}${pts}</div>`;
}

// meta: { title, code, className, levelName, teacherName, instructions }
export function renderExamPaper(examDef, meta) {
  let num = 0;
  const answerRows = [];
  const sectionsHtml = (examDef.sections || []).map(section => {
    const passageHtml = section.passage?.content
      ? `<div class="paper-passage">${esc(section.passage.content)}</div>` : '';
    const questionsHtml = (section.questions || []).map(q => {
      num++;
      answerRows.push(answerKeyRow(q, num));
      const pts = q.points ? `<span class="paper-q-points"> (${q.points} pt${q.points === 1 ? '' : 's'})</span>` : '';
      return `<div class="paper-q">
        <div class="paper-q-head">${num}.${pts}</div>
        ${questionBody(q)}
      </div>`;
    }).join('');

    return `<div class="paper-section">
      ${section.title ? `<div class="paper-section-title">${esc(section.title)}</div>` : ''}
      ${section.instructions ? `<div class="paper-section-instructions">${esc(section.instructions)}</div>` : ''}
      ${passageHtml}
      ${questionsHtml}
    </div>`;
  }).join('');

  return `
    <div class="paper-header">
      <h1>${esc(meta.title)}</h1>
      <div class="paper-meta">
        <span><strong>Class:</strong> ${esc(meta.className)}</span>
        <span><strong>Level:</strong> ${esc(meta.levelName)}</span>
        <span><strong>Teacher:</strong> ${esc(meta.teacherName)}</span>
        <span><strong>Name: </strong> <span class="paper-blank-line" style="min-width:200px;"></span></span>
        <span><strong>Date: </strong> <span class="paper-blank-line" style="min-width:100px;"></span></span>
      </div>
      ${meta.instructions ? `<div class="paper-instructions">${esc(meta.instructions)}</div>` : ''}
    </div>
    ${sectionsHtml}
    <div class="paper-answer-key">
      <div class="paper-answer-key-title">Answer Key — ${esc(meta.code)}</div>
      ${answerRows.join('')}
    </div>
  `;
}
