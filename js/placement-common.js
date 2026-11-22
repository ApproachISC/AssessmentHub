// Shared helpers for the Placement Test staff pages (dashboard, codes, editor).
// The student page (js/pages/placement-take.js) does not import this file.

import { SUPABASE_URL } from './config.js';

export const AUDIO_BUCKET = 'placement-audio';
export const SOUND_CHECK_PATH = 'system/sound-check.mp3';
export const SOUND_CHECK_URL = `${SUPABASE_URL}/storage/v1/object/public/${AUDIO_BUCKET}/${SOUND_CHECK_PATH}`;

export const SECTION_TYPES = {
  listening:    { label: 'Listening',    stimulus: 'audio',   group: 'Recording', qtypes: ['multiple_choice', 'true_false'] },
  reading:      { label: 'Reading',      stimulus: 'passage', group: 'Text',      qtypes: ['multiple_choice', 'true_false'] },
  language_use: { label: 'Language Use', stimulus: null,      group: 'Questions', qtypes: ['multiple_choice', 'true_false'] },
  writing:      { label: 'Writing',      stimulus: 'prompt',  group: 'Task',      qtypes: ['essay'] },
};
export const QTYPE_LABEL = { multiple_choice: 'Multiple choice', true_false: 'True / False', essay: 'Essay' };
export const SCORED_TYPES = ['multiple_choice', 'true_false'];

export const DEFAULT_INSTRUCTIONS = {
  listening: [
    'You will hear some recordings. Each recording has one or more questions.',
    'You can play each recording 2 times, and you can pause it.',
    'Press play to unlock the answers for each recording.',
  ],
  reading: [
    'Read each text. The text stays on the left while you answer its questions on the right.',
    'Paragraphs are numbered. Some questions ask about a specific paragraph.',
  ],
  language_use: ['Choose the word or phrase that best completes each sentence.'],
  writing: [
    'Read the task on the left. Choose one topic, then write your answer.',
    'Spell check is turned off, and you cannot paste text.',
  ],
};

export const DEFAULT_SCALE = [
  { min: 0, max: 0, group: 'Basic', level: 'Pre A1' },
  { min: 1, max: 11, group: 'Basic', level: 'A1' },
  { min: 12, max: 17, group: 'Basic', level: 'A2' },
  { min: 18, max: 23, group: 'Independent', level: 'A2+' },
  { min: 24, max: 36, group: 'Independent', level: 'B1' },
  { min: 37, max: 49, group: 'Independent', level: 'B1+' },
  { min: 50, max: 55, group: 'Proficient', level: 'B2' },
  { min: 56, max: 61, group: 'Proficient', level: 'B2+' },
  { min: 62, max: 70, group: 'Proficient', level: 'C1' },
];

// Short random ids. Ids only need to be unique inside one test; they link answers to questions.
export function newId(prefix) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789', r = crypto.getRandomValues(new Uint8Array(6));
  return prefix + [...r].map(n => a[n % a.length]).join('');
}

export function newSection(type) {
  const t = SECTION_TYPES[type];
  return {
    id: newId('s_'), type, title: t.label, instructions: [...DEFAULT_INSTRUCTIONS[type]],
    groups: t.stimulus ? [] : [{ id: newId('g_'), stimulus: null, questions: [] }],
  };
}

export function newGroup(type) {
  const kind = SECTION_TYPES[type].stimulus;
  const stimulus = kind === 'audio' ? { kind, title: '', src: null, maxPlays: 2, transcript: '' }
    : kind === 'passage' ? { kind, title: '', source: '', paragraphs: [] }
    : kind === 'prompt' ? { kind, title: '', text: [] }
    : null;
  return { id: newId('g_'), stimulus, questions: [newQuestion(SECTION_TYPES[type].qtypes[0])] };
}

export function newQuestion(type) {
  if (type === 'essay') return { id: newId('q_'), type, prompt: 'Choose one topic and write about it.', topics: [], min_words: 120, max_words: 250 };
  if (type === 'true_false') return { id: newId('q_'), type, prompt: '', answer: null };
  return { id: newId('q_'), type: 'multiple_choice', prompt: '', options: ['', '', '', ''], answer: null };
}

export function newDefinition() {
  return { sections: ['listening', 'reading', 'language_use'].map(newSection) };
}

export function countQuestions(def) {
  let total = 0, scored = 0;
  (def?.sections || []).forEach(s => (s.groups || []).forEach(g => (g.questions || []).forEach(q => {
    total++; if (SCORED_TYPES.includes(q.type)) scored++;
  })));
  return { total, scored, sections: (def?.sections || []).length };
}

// Placement scale check. Returns { errors: [], warnings: [] }.
export function checkScale(scale, scoredCount) {
  const errors = [], warnings = [];
  const rows = (scale || []).map(r => ({ ...r, min: Number(r.min), max: Number(r.max) })).sort((a, b) => a.min - b.min);
  if (!rows.length) { errors.push('The placement scale is empty.'); return { errors, warnings }; }
  rows.forEach(r => {
    if (!Number.isInteger(r.min) || !Number.isInteger(r.max) || r.min < 0 || r.max < r.min) errors.push(`Scale row "${r.level || '?'}" has an invalid score range.`);
    if (!String(r.level || '').trim()) errors.push('Every scale row needs a level.');
  });
  if (rows[0].min !== 0) errors.push('The placement scale must start at 0.');
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].min <= rows[i - 1].max) errors.push(`Scale rows "${rows[i - 1].level}" and "${rows[i].level}" overlap.`);
    else if (rows[i].min > rows[i - 1].max + 1) errors.push(`There is a gap in the scale between ${rows[i - 1].max} and ${rows[i].min}.`);
  }
  const top = rows[rows.length - 1].max;
  if (scoredCount != null && top !== scoredCount) {
    warnings.push(`The scale goes up to ${top}, but the test has ${scoredCount} scored question${scoredCount === 1 ? '' : 's'}.`);
  }
  return { errors: [...new Set(errors)], warnings };
}

// Content check used by the editor and before activating a test.
// errors block activation; warnings don't.
export function validateTest(def, scale) {
  const errors = [], warnings = [];
  const ids = new Set();
  const dup = id => { if (ids.has(id)) errors.push(`Duplicate id "${id}". Re-upload the JSON with unique ids.`); ids.add(id); };
  const sections = def?.sections || [];
  if (!sections.length) errors.push('Add at least one section.');
  sections.forEach((s, si) => {
    const sName = `${s.title || SECTION_TYPES[s.type]?.label || 'Section'} (section ${si + 1})`;
    dup(s.id);
    if (!SECTION_TYPES[s.type]) errors.push(`${sName}: unknown section type "${s.type}".`);
    const qs = (s.groups || []).flatMap(g => g.questions || []);
    if (!qs.length) errors.push(`${sName} has no questions.`);
    (s.groups || []).forEach((g, gi) => {
      dup(g.id);
      const st = g.stimulus, gName = `${sName}, ${SECTION_TYPES[s.type]?.group || 'group'} ${gi + 1}`;
      if (st?.kind === 'audio' && !st.src) errors.push(`${gName}: upload the audio file.`);
      if (st?.kind === 'audio' && !st.title) warnings.push(`${gName}: the recording has no title.`);
      if (st?.kind === 'passage' && !(st.paragraphs || []).some(p => p.trim())) errors.push(`${gName}: the text is empty.`);
      if (st?.kind === 'prompt' && !(st.text || []).some(p => p.trim())) warnings.push(`${gName}: the writing task has no instructions.`);
      if (st && !(g.questions || []).length) errors.push(`${gName} has no questions.`);
      (g.questions || []).forEach((q, qi) => {
        dup(q.id);
        const qName = `${gName}, question ${qi + 1}`;
        if (!String(q.prompt || '').trim()) errors.push(`${qName}: the question is empty.`);
        if (q.type === 'multiple_choice') {
          const opts = q.options || [];
          if (opts.length < 2) errors.push(`${qName}: add at least 2 options.`);
          if (opts.some(o => !String(o).trim())) errors.push(`${qName}: an option is empty.`);
          if (!(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < opts.length)) errors.push(`${qName}: mark the correct answer.`);
        } else if (q.type === 'true_false') {
          if (q.answer !== 0 && q.answer !== 1) errors.push(`${qName}: mark True or False as correct.`);
        } else if (q.type === 'essay') {
          if (q.min_words && q.max_words && Number(q.min_words) > Number(q.max_words)) errors.push(`${qName}: minimum words is more than maximum.`);
          if ((q.topics || []).some(t => !String(t).trim())) errors.push(`${qName}: a topic is empty.`);
        } else errors.push(`${qName}: unknown question type "${q.type}".`);
      });
    });
  });
  const sc = checkScale(scale, countQuestions(def).scored);
  return { errors: [...errors, ...sc.errors], warnings: [...warnings, ...sc.warnings] };
}

export function takeUrl(params) {
  const u = new URL('take.html', location.href);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  return u.href;
}

export function fmtDuration(sec) {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60), s = sec % 60;
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : m ? `${m} min` : `${s} s`;
}

// Proctoring events worth flagging on a submission.
export function proctorFlags(p) {
  const tab = p?.tab_switches || 0, blur = p?.window_blur_events || 0, fs = p?.fullscreen_exits || 0;
  const parts = [tab && `${tab} tab switch${tab === 1 ? '' : 'es'}`, blur && `${blur} window blur${blur === 1 ? '' : 's'}`, fs && `${fs} fullscreen exit${fs === 1 ? '' : 's'}`].filter(Boolean);
  return { total: tab + blur + fs, text: parts.join(', ') };
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
