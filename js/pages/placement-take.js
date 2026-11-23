// Placement Test — student page (placement/take.html).
//
// Flow: start screen (name + email + code) → placement_start RPC (starts or resumes)
//       → sections one by one (forward only) → placement_submit RPC.
// Everything the student does is saved with placement_autosave (debounced after each
// action + a heartbeat every 5 s that also counts time). The server never sends the
// answer key or audio transcripts, scores at submit, and closes the attempt on time-up.
//
// Preview (?preview=<testId>): academics load the test directly; nothing is saved,
// proctoring is off, and audio without a file is read by the browser's voice.

import { db } from '../supabase-client.js';
import { SUPABASE_URL } from '../config.js';
import { createProctor, isAppleMobile } from '../proctoring.js';

/* ===================================================================== CONSTANTS */
const SOUND_CHECK = {
  src: `${SUPABASE_URL}/storage/v1/object/public/placement-audio/system/sound-check.mp3`,
  text: 'This is a sound check. If you can hear this message clearly, your headphones are working.',
};
const CODE_RE = /^[A-HJKMNP-Z2-9]{3}-[A-HJKMNP-Z2-9]{3}$/;
const ERRORS = {
  invalid_input: 'Check your full name and email.',
  invalid_code: 'This code is not valid. Check the code on your paper or ask a staff member.',
  test_unavailable: 'This test is not open right now. Ask a staff member.',
  code_used: 'This code has already been used. Ask a staff member for a new code.',
  email_mismatch: 'This code is already being used with a different email. Type the email you used before.',
  email_not_assigned: 'This code was sent to a different email address. Use the email where you received the code.',
  time_up: 'The time for this test has ended, and your answers were submitted.',
};
const SPLIT_KINDS = { passage: true, prompt: true };
const STIM_LABEL = { audio: 'Recording', passage: 'Text', prompt: 'Writing task' };
const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z"/></svg>';
const ICON_LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="1"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>';

const params = new URLSearchParams(location.search);
const PREVIEW_ID = params.get('preview');
const PREVIEW = !!PREVIEW_ID;

/* ===================================================================== HELPERS */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normCode = v => { const s = String(v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); return s.length > 3 ? s.slice(0, 3) + '-' + s.slice(3) : s; };
const wordCount = t => (String(t || '').trim().match(/\S+/g) || []).length;
const show = (el, on = true) => el.classList.toggle('hidden', !on);
const local = {
  key: code => `placement.${code}`,
  get(code) { try { return JSON.parse(localStorage.getItem(this.key(code))) || null; } catch { return null; } },
  set(code, v) { try { localStorage.setItem(this.key(code), JSON.stringify(v)); } catch { /* private mode */ } },
  del(code) { try { localStorage.removeItem(this.key(code)); } catch { /* ignore */ } },
};
function restartAnim(el) { el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap'); }
let toastT;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; show(t);
  restartAnim(t); clearTimeout(toastT); toastT = setTimeout(() => show(t, false), 3800);
}

/* ===================================================================== STATE */
let TEST = null;      // { id, title, settings, sections }
let FLAT = [];        // per section: [{ group, q, gi, qi }]
let proctor = null;
let S = {
  code: '', token: '', fullName: '', email: '',
  si: 0, pos: 0, phase: 'intro', answers: {}, skipped: {}, played: {}, plays: {}, soundOk: {},
  stimGroup: null, timeUsedMs: 0, lastTick: 0, tick: null, ticks: 0, warned: false,
  active: false, finishing: false,
};

function loadTest(t) {
  TEST = { id: t.id, title: t.title, settings: t.settings || {}, sections: t.definition?.sections || [],
           scale: t.placement_scale || null };   // scale: preview only (live pages get the levels with the result)
  TEST.settings.proctoring = TEST.settings.proctoring || {};
  FLAT = TEST.sections.map(sec => {
    const out = [];
    (sec.groups || []).forEach((g, gi) => (g.questions || []).forEach((q, qi) => out.push({ group: g, q, gi, qi })));
    return out;
  });
}
const stimGroups = sec => sec.groups.filter(g => g.stimulus);
const curItem = () => FLAT[S.si][S.pos];
const progress = () => ({ si: S.si, pos: S.pos, phase: S.phase, skipped: S.skipped, played: S.played, plays: S.plays, soundOk: S.soundOk });

/* ===================================================================== SAVING */
let saveTimer = null, saving = false, saveAgain = false;

function setSave(state) {
  const el = $('save');
  if (PREVIEW) return;
  show(el);
  el.className = 'save' + (state === 'saving' ? ' saving' : state === 'offline' ? ' offline' : '');
  el.textContent = state === 'saving' ? 'Saving…' : state === 'offline' ? 'Offline – retrying' : 'Saved';
}

// Local backup: survives a lost connection + refresh on the same device.
function backup() {
  if (PREVIEW || !S.code) return;
  local.set(S.code, { fullName: S.fullName, email: S.email, answers: S.answers, progress: progress(), at: Date.now() });
}

function queueSave(delay = 800) {
  if (PREVIEW || !S.active) return;
  backup();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, delay);
}

async function saveNow() {
  if (PREVIEW || !S.active || !S.token || S.finishing) return;   // while submitting, submit() owns the session
  if (saving) { saveAgain = true; return; }
  saving = true; setSave('saving');
  try {
    const { data, error } = await db.rpc('placement_autosave', {
      p_code: S.code, p_token: S.token, p_answers: S.answers, p_progress: progress(),
      p_proctoring: proctor ? proctor.buildPayload() : null,
      p_time_used_seconds: Math.floor(S.timeUsedMs / 1000),
    });
    if (error) throw error;
    if (!data?.ok) {
      if (data?.time_up) { endFromServer('time', data.result); return; }
      if (data?.error === 'session_invalid') {
        // Closed on the server (staff force-submitted it, or time ran out) → show the result.
        const mine = await fetchMyResult();
        if (mine) { endFromServer(mine.timed_out ? 'time' : 'closed', mine.result); return; }
        halt('Test opened somewhere else', 'This test was opened on another device or tab, so this page stopped saving. Your saved answers are safe. To continue here, reload the page and type your email and code again.');
        return;
      }
    } else {
      setSave('saved');
      if (data.time_used_seconds * 1000 > S.timeUsedMs) S.timeUsedMs = data.time_used_seconds * 1000;  // server is the reference
    }
  } catch (err) {
    console.warn('Autosave failed:', err);
    setSave('offline');
  } finally {
    saving = false;
    if (saveAgain) { saveAgain = false; saveNow(); }
  }
}

/* ===================================================================== QUESTION TYPES */
// Add a new type here (render / bind / answered) and in the editor.
const QTYPES = {
  multiple_choice: {
    options: q => q.options || [], keys: 'ABCDEF', choice: true,
    render(q) { return choiceHTML('opts', this.options(q), this.keys, '', null, optionOrder(q)); },
    bind(q) { bindChoice(q); }, answered: v => v != null,
  },
  true_false: {
    options: () => ['True', 'False'], keys: 'TF', choice: true,
    render(q) { return choiceHTML('opts', this.options(q), this.keys, ' tf'); },
    bind(q) { bindChoice(q); }, answered: v => v != null,
  },
  essay: {   // value: { topic: index|null, text }
    choice: false,
    render(q, v) {
      v = v || {};
      const min = q.min_words, max = q.max_words;
      const range = min && max ? `${min}–${max} words` : min ? `at least ${min} words` : '';
      const hasTopics = q.topics && q.topics.length;
      return (hasTopics ? '<p class="sub" id="topicLbl">1. Choose one topic</p>' + choiceHTML('topicOpts', q.topics, '123456789', '', 'topicLbl') : '') +
        `<p class="sub${hasTopics ? ' gap' : ''}"><label for="essay" style="display:inline">${hasTopics ? '2. Write your essay' : 'Write your essay'}</label></p>` +
        `<textarea id="essay" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" data-gramm="false">${esc(v.text || '')}</textarea>` +
        `<div class="wc"><span id="wcCount"></span>${range ? `<span>Aim for ${range}</span>` : ''}</div>`;
    },
    bind(q) {
      const ta = $('essay');
      ta.addEventListener('paste', e => { e.preventDefault(); toast('Pasting is turned off. Please type your answer.'); });
      ta.addEventListener('drop', e => e.preventDefault());
      ta.addEventListener('input', () => setAnswer(q, { ...(S.answers[q.id] || {}), text: ta.value }, 2000));
      if ($('topicOpts')) [...$('topicOpts').children].forEach(b => { b.onclick = () => {
        setAnswer(q, { ...(S.answers[q.id] || {}), topic: +b.dataset.k });
        if (!ta.value) ta.focus();
      }; });
      paintEssay(q);
    },
    answered(v, q) { return !!(v && v.text && v.text.trim() && (!q.topics || !q.topics.length || v.topic != null)); },
  },
};
const T = q => QTYPES[q.type] || QTYPES.multiple_choice;
const optionsOf = q => T(q).options ? T(q).options(q) : [];
const isAnswered = q => T(q).answered(S.answers[q.id], q);

// order[p] = original option index shown at position p. Answers are always stored as the ORIGINAL index.
function choiceHTML(id, opts, keys, extra, labelledby, order) {
  order = order || opts.map((_, k) => k);
  return `<div class="opts${extra}" id="${id}" role="radiogroup" aria-labelledby="${labelledby || 'qtext'}">` +
    order.map((k, p) => `<button type="button" class="opt" role="radio" data-k="${k}"><span class="k">${keys[p]}</span><span>${esc(opts[k])}</span></button>`).join('') +
    '</div>';
}

// Shuffled option order, fixed per code + question so it stays the same after a resume.
function optionOrder(q) {
  const n = (q.options || []).length, order = [...Array(n).keys()];
  if (!TEST.settings.shuffle_options || q.shuffle === false) return order;
  let h = 2166136261;
  for (const ch of `${S.code}|${q.id}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const rnd = () => { h = (h + 0x6D2B79F5) | 0; let t = Math.imul(h ^ (h >>> 15), 1 | h); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  return order;
}

function bindChoice(q) { [...$('opts').children].forEach(b => { b.onclick = () => setAnswer(q, +b.dataset.k); }); paintChoice(q); }
function paintOpts(box, sel, locked) {
  [...box.children].forEach(b => {
    const k = +b.dataset.k;
    b.disabled = locked;
    b.classList.toggle('sel', k === sel);
    b.classList.toggle('dim', sel != null && k !== sel);
    b.setAttribute('aria-checked', k === sel ? 'true' : 'false');
  });
}

function setAnswer(q, v, delay) {
  const was = isAnswered(q);
  S.answers[q.id] = v;
  if (T(q).choice) paintChoice(q); else paintEssay(q);
  paintNext(q);
  if (was !== isAnswered(q)) renderTabs();
  queueSave(delay);
}
function paintChoice(q) {
  paintOpts($('opts'), S.answers[q.id], isLocked());
  $('qtext').innerHTML = promptHTML(q, S.answers[q.id]);
}
function paintEssay(q) {
  const v = S.answers[q.id] || {}, n = wordCount(v.text), box = $('wcCount'), ta = $('essay');
  if ($('topicOpts')) {
    paintOpts($('topicOpts'), v.topic, false);
    ta.disabled = v.topic == null;
    ta.placeholder = v.topic == null ? 'Choose a topic first.' : 'Start writing here…';
  }
  box.className = q.max_words && n > q.max_words ? 'over' : q.min_words && n >= q.min_words ? 'good' : '';
  box.innerHTML = `<b>${n}</b> ${n === 1 ? 'word' : 'words'}${q.max_words && n > q.max_words ? ' · over the limit' : ''}`;
}
function paintNext(q) {
  const btn = $('next'), answered = isAnswered(q), locked = isLocked(), skip = !!TEST.settings.allow_skip;
  const skipping = !answered && skip;
  btn.disabled = locked || (!answered && !skip);
  btn.textContent = skipping ? 'Skip question' : btn.dataset.label;
  btn.className = 'btn' + (skipping ? ' ghost' : '');
}
function promptHTML(q, sel) {
  const parts = String(q.prompt || '').split('___');
  if (parts.length === 1) return esc(q.prompt);
  const fill = sel != null && T(q).choice ? esc(optionsOf(q)[sel]) : '&nbsp;';
  return parts.map(esc).join(`<span class="blank">${fill}</span>`);
}
// Listening rule: answers stay locked until the student presses play on that recording.
function isLocked() {
  const it = curItem(), stim = it.group.stimulus;
  return !!(stim && stim.kind === 'audio' && !S.played[it.group.id]);
}

/* ===================================================================== AUDIO */
const canTTS = () => 'speechSynthesis' in window;
function pickVoice(i) {
  const v = canTTS() ? speechSynthesis.getVoices().filter(x => /^en(-|_|$)/i.test(x.lang)) : [];
  return v.length ? v[i % v.length] : null;
}
if (canTTS()) speechSynthesis.getVoices();

// Recording player: file (stimulus.src) or, in preview only, the script read by the browser.
const Player = (() => {
  let st = null, audio = null, gen = 0, el = null, onPlay = null;
  const fmt = s => (isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
  const hasScript = () => Array.isArray(st.stim.script) && st.stim.script.length && canTTS();

  function mount(stim, root, opts) {
    stop();
    // Preview only: the editor's staff transcript ("Speaker: text" per line) becomes a script to read aloud.
    if (!stim.script && stim.transcript) {
      stim = { ...stim, script: stim.transcript.split(/\n+/).map(l => l.trim()).filter(Boolean).map(l => {
        const m = l.match(/^([^:]{1,24}):\s*(.+)$/);
        return m ? { speaker: m[1], text: m[2] } : { speaker: 'Narrator', text: l };
      }) };
    }
    el = root; onPlay = opts.onPlay;
    st = { stim, max: stim.maxPlays || 2, used: opts.used || 0, playing: false, started: false, finished: false, prog: 0, line: 0, broken: false };
    st.total = hasScript() ? stim.script.reduce((n, l) => n + l.text.length, 0) : 0;
    if (stim.src) {
      const a = audio = new Audio(stim.src); a.preload = 'auto';
      // Every handler checks it still belongs to the current recording: a previous player that was
      // just stopped can still fire events (clearing its src fires "error"), which must not touch this one.
      const mine = () => audio === a;
      a.ontimeupdate = () => { if (!mine()) return; st.prog = a.duration ? a.currentTime / a.duration : 0; paint(); };
      a.onloadedmetadata = () => { if (mine()) paint(); };
      a.onended = () => { if (mine()) ended(); };
      a.onerror = () => { if (!mine()) return; st.broken = true; st.playing = false; paint(); onPlay(st.used); };   // never block the questions
    } else {
      audio = null;
      if (!hasScript()) { st.broken = true; onPlay(st.used); }
    }
    el.querySelector('.pbtn').onclick = toggle;
    paint();
  }
  const charsBefore = i => st.stim.script.slice(0, i).reduce((n, l) => n + l.text.length, 0);

  function toggle() {
    if (!st || st.broken) return;
    if (st.playing) pause();
    else if (st.started && !st.finished) resume();
    else if (st.used < st.max) start();
  }
  function start() {
    st.used++; st.started = true; st.finished = false; st.prog = 0; st.line = 0; st.playing = true;
    if (audio) { audio.currentTime = 0; audio.play().catch(() => { st.playing = false; paint(); }); } else speakLine();
    onPlay(st.used);
    paint();
  }
  function pause() {
    st.playing = false;
    if (audio) audio.pause();
    else { gen++; speechSynthesis.cancel(); st.prog = charsBefore(st.line) / st.total; }
    paint();
  }
  function resume() { st.playing = true; if (audio) audio.play().catch(() => {}); else speakLine(); paint(); }
  function ended() { st.playing = false; st.finished = true; st.prog = 1; paint(); }
  function speakLine() {
    const g = ++gen, line = st.stim.script[st.line];
    const speakers = [...new Set(st.stim.script.map(l => l.speaker))], si = speakers.indexOf(line.speaker);
    const u = new SpeechSynthesisUtterance(line.text), voice = pickVoice(si);
    if (voice) u.voice = voice;
    u.lang = 'en-US'; u.rate = 0.92; u.pitch = si % 2 ? 1.2 : 1;
    const base = charsBefore(st.line);
    u.onboundary = e => { if (g !== gen) return; st.prog = (base + e.charIndex) / st.total; paint(); };
    u.onend = () => {
      if (g !== gen) return;
      st.line++; st.prog = charsBefore(st.line) / st.total;
      if (st.line < st.stim.script.length) speakLine(); else ended();
    };
    speechSynthesis.speak(u);
  }
  function stop() {
    gen++;
    if (canTTS()) speechSynthesis.cancel();
    if (audio) {
      const a = audio; audio = null;
      a.onerror = a.onended = a.ontimeupdate = a.onloadedmetadata = null;
      a.pause(); a.removeAttribute('src'); a.load();   // release the file without firing an error
    }
    st = null;
  }
  function paint() {
    if (!st || !el) return;
    const btn = el.querySelector('.pbtn'), left = st.max - st.used;
    btn.disabled = st.broken || !(st.playing || (st.started && !st.finished) || left > 0);
    btn.innerHTML = st.playing ? ICON_PAUSE : ICON_PLAY;
    btn.classList.toggle('playing', st.playing);
    btn.classList.toggle('cue', !st.started && st.used === 0 && !st.broken);
    btn.setAttribute('aria-label', st.playing ? 'Pause recording' : (st.started && !st.finished ? 'Continue recording' : 'Play recording'));
    el.querySelector('.pbar i').style.width = `${(st.prog * 100).toFixed(1)}%`;
    let status;
    if (st.broken) status = 'This recording could not be loaded. Raise your hand and tell a staff member.';
    else if (audio && audio.duration && (st.started || st.used)) status = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
    else if (st.playing) status = 'Playing…';
    else if (st.started && !st.finished) status = 'Paused';
    else if (st.finished || st.used > 0) status = left > 0 ? 'You can play it once more.' : 'Finished';
    else status = 'Press play to start';
    el.querySelector('.pstat').textContent = status;
    el.querySelector('.plays').innerHTML = (left > 0 ? `${left} of ${st.max} plays left` : 'No plays left') +
      Array.from({ length: st.max }, (_, i) => `<i class="${i < left ? 'on' : ''}"></i>`).join('');
  }
  return { mount, stop };
})();

// Sound check: the standard file; falls back to the browser's voice if the file can't play.
const SoundCheck = (() => {
  let audio = null, gen = 0;
  function speak(g, onEnd) {
    if (!canTTS()) { onEnd(); return; }
    const u = new SpeechSynthesisUtterance(SOUND_CHECK.text), v = pickVoice(0);
    if (v) u.voice = v;
    u.lang = 'en-US'; u.rate = 0.95;
    u.onend = () => { if (g === gen) onEnd(); };
    speechSynthesis.speak(u);
  }
  function play(onEnd) {
    stop();
    const g = gen;
    audio = new Audio(SOUND_CHECK.src);
    audio.onended = () => { if (g === gen) onEnd(); };
    audio.onerror = () => { if (g === gen) speak(g, onEnd); };
    audio.play().catch(() => { if (g === gen) speak(g, onEnd); });
  }
  function stop() { gen++; if (audio) { audio.pause(); audio.src = ''; audio = null; } if (canTTS()) speechSynthesis.cancel(); }
  return { play, stop };
})();

/* ===================================================================== TIMER */
// Counts only while this page is open. The server keeps its own count from the heartbeats.
function startTimer() {
  show($('timer'), !!TEST.settings.timed);
  S.lastTick = Date.now();
  tickTimer();
  S.tick = setInterval(tickTimer, 1000);
}
function tickTimer() {
  const now = Date.now();
  S.timeUsedMs += Math.min(now - S.lastTick, 3000);   // a sleeping laptop or frozen tab doesn't burn time
  S.lastTick = now;
  if (++S.ticks % 5 === 0) saveNow();                  // heartbeat
  if (!TEST.settings.timed) return;
  const limit = (TEST.settings.time_limit_minutes || 60) * 60000;
  const left = Math.max(0, Math.ceil((limit - S.timeUsedMs) / 1000));
  const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
  $('timerText').textContent = `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`;
  $('timer').classList.toggle('warn', left <= 300 && left > 60);
  $('timer').classList.toggle('crit', left <= 60);
  if (left <= 300 && left > 0 && !S.warned && TEST.settings.time_limit_minutes > 5) { S.warned = true; toast('5 minutes left'); }
  if (left === 0) submit(true);
}
function stopTimer() { clearInterval(S.tick); S.tick = null; show($('timer'), false); }

/* ===================================================================== RENDERING */
function renderTabs() {
  $('tabs').style.gridTemplateColumns = `repeat(${TEST.sections.length}, minmax(0,1fr))`;
  $('tabs').innerHTML = TEST.sections.map((sec, k) => {
    const items = FLAT[k], active = k === S.si, done = k < S.si;
    const answered = items.filter(it => isAnswered(it.q)).length;
    const unit = items.length === 1 ? ' task' : ' questions';
    let status;
    if (done) status = 'Completed';
    else if (active && S.phase === 'intro') status = `Starting · ${items.length}${unit}`;
    else if (active) status = `Question ${S.pos + 1} of ${items.length}`;
    else status = items.length + unit;
    const segs = items.map((it, i) => {
      const cls = active && S.phase === 'q' && i === S.pos ? 'now' : isAnswered(it.q) ? 'ans' : S.skipped[it.q.id] ? 'skip' : '';
      return `<i class="${cls}"></i>`;
    }).join('');
    return `<li class="tab${active ? ' active' : ''}${done ? ' done' : ''}"${active ? ' aria-current="step"' : ''}>` +
      `<div class="hd"><span class="num">${done ? '✓' : k + 1}</span><span class="nm">${esc(sec.title)}</span></div>` +
      `<div class="st">${status}<span class="sr">, ${answered} answered</span></div>` +
      `<div class="track" aria-hidden="true">${segs}</div></li>`;
  }).join('');
}

function render() {
  const sec = TEST.sections[S.si];
  renderTabs();
  if (S.phase === 'intro') {
    $('main').classList.remove('wide');
    $('stage').className = 'stage';
    show($('stim'), false);
    Player.stop(); S.stimGroup = null;
    renderIntro(sec);
    return;
  }
  const it = curItem(), stim = it.group.stimulus, split = !!(stim && SPLIT_KINDS[stim.kind]);
  $('main').classList.toggle('wide', split);
  $('stage').className = 'stage' + (split ? ' split' : '');
  if (S.stimGroup !== it.group.id) { S.stimGroup = it.group.id; renderStimulus(sec, it.group); }
  renderQuestion(sec, it);
}

function renderIntro(sec) {
  const n = FLAT[S.si].length, needsCheck = sec.type === 'listening';
  $('qcard').className = 'card brackets intro';
  $('qcard').innerHTML =
    `<div class="lbl">Section ${S.si + 1} of ${TEST.sections.length}</div>` +
    `<h2>${esc(sec.title)}</h2>` +
    `<p class="lede" style="margin-bottom:16px">${n}${n === 1 ? ' task' : ' questions'}</p>` +
    `<ul>${(sec.instructions || []).map(t => `<li>${esc(t)}</li>`).join('')}</ul>` +
    (needsCheck ? '<div class="soundcheck" id="sc"></div>' : '') +
    `<div class="row"><button class="btn gold" id="begin">Begin ${esc(sec.title)}</button>` +
    (needsCheck ? '<span class="note" id="beginNote"></span>' : '') + '</div>';
  $('begin').onclick = () => {
    SoundCheck.stop(); S.phase = 'q'; S.pos = 0;
    proctor?.logEvent('section_started', sec.title);
    queueSave(0); render(); window.scrollTo(0, 0);
  };
  if (needsCheck) renderSoundCheck(sec, 'idle');
  else $('begin').focus({ preventScroll: true });
  restartAnim($('qcard'));
}

// idle → playing → ask → (ok | help)
function renderSoundCheck(sec, state) {
  const box = $('sc'), ok = state === 'ok' || S.soundOk[sec.id];
  $('begin').disabled = !ok;
  if ($('beginNote')) $('beginNote').textContent = ok ? '' : 'Complete the sound check first.';
  box.className = 'soundcheck' + (ok ? ' ok' : '');
  if (ok) { box.innerHTML = `<div class="sc-done">${ICON_CHECK}<span>Sound check complete. Your audio is working.</span></div>`; return; }
  box.innerHTML =
    '<div class="sc-row">' +
      `<button type="button" class="pbtn small${state === 'idle' ? ' cue' : state === 'playing' ? ' playing' : ''}" id="scPlay" aria-label="Play sound check"${state === 'playing' ? ' disabled' : ''}>${ICON_PLAY}</button>` +
      `<div><b>Sound check</b><p>${state === 'playing' ? 'Playing… listen carefully.' : 'Put on your headphones and press play. You will hear a short message.'}</p></div>` +
    '</div>' +
    (state === 'ask' || state === 'help'
      ? '<div class="sc-ask"><span>Did you hear the message clearly?</span>' +
        '<button type="button" class="btn sm" id="scYes">Yes, I can hear it</button>' +
        '<button type="button" class="btn ghost sm" id="scNo">No</button></div>' : '') +
    (state === 'help'
      ? '<div class="sc-help"><b style="color:var(--navy)">Try this, then press play again:</b><ul class="tips">' +
        '<li>Check that your headphones are connected.</li><li>Turn up the volume on your device.</li>' +
        '<li>Make sure your device is not on mute.</li><li>If it still doesn’t work, raise your hand and ask a staff member.</li></ul></div>' : '');
  $('scPlay').onclick = () => {
    renderSoundCheck(sec, 'playing');
    SoundCheck.play(() => { if ($('sc')) { renderSoundCheck(sec, 'ask'); $('scYes').focus(); } });
  };
  if ($('scYes')) $('scYes').onclick = () => { S.soundOk[sec.id] = true; queueSave(); renderSoundCheck(sec, 'ok'); $('begin').focus(); };
  if ($('scNo')) $('scNo').onclick = () => { proctor?.logEvent('sound_check_failed'); renderSoundCheck(sec, 'help'); };
  if (state === 'idle') $('scPlay').focus({ preventScroll: true });
}

function qRange(group) {
  const first = FLAT[S.si].findIndex(x => x.group === group) + 1, last = first + group.questions.length - 1;
  return first === last ? String(first) : `${first}–${last}`;
}

function renderStimulus(sec, group) {
  const box = $('stim'), stim = group.stimulus;
  if (!stim) { show(box, false); Player.stop(); return; }
  show(box);
  const list = stimGroups(sec), n = list.indexOf(group) + 1, range = qRange(group), one = group.questions.length === 1;
  const head = `<div class="lbl">${STIM_LABEL[stim.kind] || 'Material'} ${n} of ${list.length}</div>`;
  if (stim.kind === 'audio') {
    box.className = 'card';
    box.innerHTML = head +
      '<div class="player"><button class="pbtn" type="button"></button>' +
        `<div class="pbody"><p class="ptitle">${esc(stim.title)}</p>` +
        '<div class="pbar" role="progressbar" aria-label="Recording progress"><i></i></div>' +
        '<div class="pmeta"><span class="pstat"></span><span class="plays"></span></div></div></div>' +
      `<p class="pinst">Listen to the recording, then answer ${one ? 'question' : 'questions'} ${range}.</p>`;
    Player.mount(stim, box, {
      used: S.plays[group.id] || 0,
      onPlay: used => {
        S.plays[group.id] = used;
        const first = !S.played[group.id];
        S.played[group.id] = true;
        proctor?.logEvent('audio_play', `${group.id} #${used}`);
        queueSave(0);
        if (first && S.phase === 'q' && curItem().group === group) unlockCurrent();
      },
    });
  } else {
    Player.stop();
    box.className = 'card passage';
    box.innerHTML = head + `<h2>${esc(stim.title)}</h2>` +
      (stim.kind === 'passage'
        ? (stim.source ? `<p class="src">${esc(stim.source)}</p>` : '') +
          (stim.paragraphs || []).map((p, i) => `<div class="para"><span class="pn">${i + 1}</span><p>${esc(p)}</p></div>`).join('') +
          `<p class="foot">${one ? `Question ${range} is` : `Questions ${range} are`} about this text.</p>`
        : (stim.text || []).map(p => `<p class="ptext">${esc(p)}</p>`).join(''));
  }
  box.scrollTop = 0;
  restartAnim(box);
}

function renderQuestion(sec, it) {
  const q = it.q, type = T(q), items = FLAT[S.si], last = S.pos === items.length - 1;
  let tag = sec.title;
  if (it.group.stimulus) {
    tag = `${STIM_LABEL[it.group.stimulus.kind] || 'Material'} ${stimGroups(sec).indexOf(it.group) + 1}` +
      (it.group.questions.length > 1 ? ` · question ${it.qi + 1} of ${it.group.questions.length}` : '');
  }
  const lastSection = S.si === TEST.sections.length - 1;
  const nextLabel = !last ? 'Next question' : lastSection ? 'Submit test' : `Finish ${sec.title}`;
  const locked = isLocked();

  $('qcard').className = 'card';
  $('qcard').innerHTML =
    `<div class="meta"><span class="tag">${esc(tag)}</span><span>Question ${S.pos + 1} of ${items.length}</span></div>` +
    '<p class="q" id="qtext"></p>' +
    (locked ? `<div class="locknote" id="locknote">${ICON_LOCK}<span>Press play on the recording above to unlock the answers.</span></div>` : '') +
    type.render(q, S.answers[q.id]) +
    `<div class="qfoot"><button class="btn" id="next" data-label="${esc(nextLabel)}">${esc(nextLabel)}</button>` +
      (last ? `<span class="note">${lastSection ? 'Your answers will be submitted.' : `You cannot come back to ${esc(sec.title)} after this.`}</span>` : '') +
    '</div>' +
    (type.choice ? `<div class="hint">Keyboard: press 1–${optionsOf(q).length} to choose, Enter to continue.</div>` : '');

  $('qtext').innerHTML = promptHTML(q, S.answers[q.id]);
  type.bind(q);
  $('next').onclick = next;
  paintNext(q);
  const focusEl = locked ? $('stim').querySelector('.pbtn')
    : type.choice ? $('opts').firstChild
    : ($('topicOpts') && S.answers[q.id]?.topic == null) ? $('topicOpts').firstChild : $('essay');
  if (focusEl && !focusEl.disabled) focusEl.focus({ preventScroll: true });
  restartAnim($('qcard'));
}

function unlockCurrent() {
  const q = curItem().q, note = $('locknote');
  if (note) note.remove();
  if (T(q).choice) paintChoice(q);
  paintNext(q);
}

function next() {
  const items = FLAT[S.si], q = items[S.pos].q;
  if (isLocked()) return;
  if (!isAnswered(q)) { if (!TEST.settings.allow_skip) return; S.skipped[q.id] = true; } else delete S.skipped[q.id];
  if (S.pos < items.length - 1) { S.pos++; queueSave(0); render(); return; }
  Player.stop(); S.stimGroup = null;
  if (S.si < TEST.sections.length - 1) {
    proctor?.logEvent('section_finished', TEST.sections[S.si].title);
    S.si++; S.pos = 0; S.phase = 'intro'; queueSave(0); render(); window.scrollTo(0, 0);
  } else submit(false);
}

/* ===================================================================== SUBMIT / END */
async function submit(timedOut) {
  if (S.finishing) return;
  S.finishing = true;
  Player.stop(); SoundCheck.stop(); clearTimeout(saveTimer);
  if (PREVIEW) { showDone(timedOut ? 'time' : 'submitted', previewResult()); return; }

  $('qcard').className = 'card';
  $('qcard').innerHTML = '<div class="loading"><div class="spin"></div><span>Sending your answers…</span></div>';
  show($('stim'), false);
  proctor?.logEvent(timedOut ? 'time_up' : 'test_submitted');
  try {
    const { data, error } = await db.rpc('placement_submit', {
      p_code: S.code, p_token: S.token, p_answers: S.answers,
      p_proctoring: proctor ? proctor.buildPayload() : null,
      p_time_used_seconds: Math.floor(S.timeUsedMs / 1000),
    });
    if (error) throw error;
    if (!data?.ok) {
      // Session no longer valid: the server already closed it (time-up, staff, an earlier submit
      // whose response was lost), or another device took over.
      const mine = await fetchMyResult();
      if (mine) { showDone(mine.timed_out || timedOut ? 'time' : 'submitted', mine.result); return; }
      if (timedOut) { showDone('time', null); return; }
      halt('Test opened somewhere else', 'This test was opened on another device or tab, so this page could not submit. Reload the page and type your email and code again to finish there.');
      return;
    }
    showDone(timedOut ? 'time' : 'submitted', data.result);
  } catch (err) {
    console.error('Submit failed:', err);
    S.finishing = false;
    $('qcard').innerHTML =
      '<div class="notice bad">We could not send your answers. Check your internet connection and try again. Your answers are saved on this device.</div>' +
      '<button class="btn gold" id="retry">Try again</button>';
    $('retry').onclick = () => submit(timedOut);
    $('retry').focus();
  }
}

// The server closed the attempt (time-up or staff). result: what placement_student_result returned.
function endFromServer(reason, result) {
  if (S.finishing && !S.active) return;
  S.finishing = true;
  showDone(reason, result);
}

// The page that submitted asks for its result again (needs the last session token).
async function fetchMyResult() {
  if (PREVIEW || !S.token) return null;
  try {
    const { data, error } = await db.rpc('placement_my_result', { p_code: S.code, p_token: S.token });
    if (error) throw error;
    return data?.ok ? data : null;
  } catch (err) {
    console.warn('Result lookup failed:', err);
    return null;
  }
}

// reason: 'submitted' | 'time' | 'closed' (staff closed it). result: { group, level, levels, submitted_at } or null.
function showDone(reason, result) {
  S.active = false;
  Player.stop(); SoundCheck.stop(); stopTimer();
  if (proctor) { proctor.stop(); proctor.exitFullscreen(); }
  show($('lockout'), false); show($('save'), false); show($('halt'), false);
  if (!PREVIEW) local.del(S.code);
  show($('test'), false); $('main').classList.remove('wide'); show($('done'));
  $('doneName').textContent = (S.fullName || '').split(/\s+/)[0] || 'you';
  $('doneLbl').textContent = reason === 'time' ? 'Time is up' : PREVIEW ? 'Preview finished' : 'Test submitted';
  const intro = reason === 'time' ? 'Time ran out, so your answers were submitted automatically.'
    : reason === 'closed' ? 'Your test was closed by a staff member, and your answers were submitted.'
    : 'You have finished the test.';
  $('doneLede').textContent = result
    ? `${PREVIEW ? 'Preview: nothing was saved. ' : ''}${intro} Here is your estimated level.`
    : PREVIEW ? 'This was a preview. Nothing was saved.'
    : `${intro} Your answers have been sent, and your teacher will tell you your level.`;
  paintResult(result);
  $('sumrows').innerHTML = TEST.sections.map((sec, k) => {
    const n = FLAT[k].length, a = FLAT[k].filter(it => isAnswered(it.q)).length;
    return `<div class="sumrow"><span>${esc(sec.title)}</span><b>${a} of ${n} answered</b></div>`;
  }).join('');
  if (PREVIEW) $('doneNote').innerHTML = '<a href="">Start the preview again</a>';
  window.scrollTo(0, 0);
}

/* ===================================================================== RESULT + CERTIFICATE */
// Estimated level only (never the score). Live: from the server. Preview: worked out here,
// the same way as placement_score + placement_band (correct MC/TF answers → test's scale).
const GROUP_USER = { basic: 'Basic user', independent: 'Independent user', proficient: 'Proficient user' };
const groupKey = g => String(g || '').toLowerCase().replace(/[^a-z]/g, '');

function previewResult() {
  if (TEST.settings.show_result === false || !Array.isArray(TEST.scale)) return null;
  const correct = FLAT.flat().filter(({ q }) =>
    (q.type === 'multiple_choice' || q.type === 'true_false') && q.answer != null &&
    S.answers[q.id] != null && JSON.stringify(S.answers[q.id]) === JSON.stringify(q.answer)).length;
  const scale = [...TEST.scale].sort((a, b) => a.min - b.min);
  const band = [...scale].reverse().find(b => correct >= b.min && correct <= b.max);
  if (!band) return null;
  return { group: band.group, level: band.level, levels: scale.map(b => ({ group: b.group, level: b.level })) };
}

function medalHTML(r, reveal) {
  return `<div class="medal g-${groupKey(r.group)}${reveal ? ' reveal' : ''}" role="img" aria-label="Estimated level ${esc(r.level)}, ${esc(r.group)}">` +
    '<svg viewBox="0 0 200 200" aria-hidden="true">' +
      '<circle class="m-tint" cx="100" cy="100" r="88"/><circle class="m-ring" cx="100" cy="100" r="88"/><circle class="m-face" cx="100" cy="100" r="72"/>' +
    '</svg>' +
    `<span class="m-level${r.level.length > 3 ? ' long' : ''}">${esc(r.level)}</span>` +
    `<span class="m-badge">${esc(r.group)}</span></div>`;
}

// Every level of the scale grouped and colored, the student's level filled.
function ladderHTML(r) {
  const groups = [];
  (r.levels || []).forEach(b => {
    let g = groups[groups.length - 1];
    if (!g || g.name !== b.group) groups.push(g = { name: b.group, levels: [] });
    if (!g.levels.includes(b.level)) g.levels.push(b.level);
  });
  return groups.map(g =>
    `<div class="lg g-${groupKey(g.name)}" style="flex:${g.levels.length}">` +
      `<div class="steps">${g.levels.map(l => `<span${l === r.level ? ' class="on"' : ''}>${esc(l)}</span>`).join('')}</div>` +
      `<div class="lgn">${esc(g.name)}</div></div>`).join('');
}

// "Listening, Reading and Language Use": the sections that count toward the level.
function scoredSections() {
  const n = TEST.sections.filter(s => s.type !== 'writing').map(s => s.title);
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : n[0] || 'multiple-choice';
}

function paintResult(r) {
  const ok = !!(r && r.level);
  show($('result'), ok);
  document.body.classList.toggle('print-cert', ok);
  if (!ok) return;
  const g = groupKey(r.group), user = GROUP_USER[g] || r.group;
  const hasWriting = TEST.sections.some(s => s.type === 'writing');
  const date = r.submitted_at ? new Date(r.submitted_at) : new Date();

  $('medalBox').innerHTML = medalHTML(r, true);
  $('rLevel').className = `rlevel g-${g}`;
  $('rLevel').innerHTML = `<span>${esc(r.level)}</span> · ${esc(user)}`;
  $('ladder').innerHTML = ladderHTML(r);
  show($('ladder'), !!(r.levels && r.levels.length));
  $('rNote').textContent = `This level comes from your ${scoredSections()} answers.` +
    (hasWriting ? ' A teacher will read your writing.' : '') + ' The academic team will confirm your final placement.';

  $('cName').textContent = S.fullName;
  $('cTest').textContent = TEST.title;
  $('cDate').textContent = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  $('cMedal').innerHTML = medalHTML(r, false);
  $('cGroup').className = `c-group g-${g}`;
  $('cGroup').textContent = user;
  $('cCode').textContent = S.code;
  $('cNote').textContent = `Estimated level based on the ${scoredSections()} sections of the placement test.` +
    (hasWriting ? ' Writing is assessed separately by a teacher.' : '') + ' Final placement is confirmed by the academic team.';
}

// "Save as PDF" through the browser's print dialog; the page title becomes the suggested file name.
$('certBtn').onclick = () => {
  const old = document.title;
  document.title = `Placement Test Result - ${S.fullName}`;
  window.addEventListener('afterprint', () => { document.title = old; }, { once: true });
  window.print();
};

function halt(title, msg) {
  S.active = false;
  Player.stop(); SoundCheck.stop(); stopTimer(); clearTimeout(saveTimer);
  if (proctor) { proctor.stop(); proctor.exitFullscreen(); }
  show($('lockout'), false);
  $('haltTitle').textContent = title; $('haltMsg').textContent = msg;
  show($('halt'));
  $('haltBtn').focus();
}
$('haltBtn').onclick = () => location.reload();

/* ===================================================================== PROCTORING */
let lastPaste = 0, lastCopy = 0, lastTabs = 0;
function setupProctor() {
  if (PREVIEW) return;
  proctor = createProctor({
    settings: TEST.settings.proctoring,
    onStateChange: s => {
      show($('lockout'), !!s.paused && S.active);
      if (s.tabSwitches > lastTabs && !document.hidden) { lastTabs = s.tabSwitches; toast('Leaving the test page is recorded.'); }
      if (s.pasteBlocked > lastPaste) { lastPaste = s.pasteBlocked; }
      if (s.copyBlocked > lastCopy) { lastCopy = s.copyBlocked; toast('Copying is not allowed during the test.'); }
      queueSave(1500);
    },
  });
}
$('resumeFs').onclick = () => proctor?.resumeFullscreen();

/* ===================================================================== START SCREEN */
const urlCode = normCode(params.get('code') || '');
let info = null;

function paintInfo(i) {
  info = i;
  show($('facts'), !!i);
  if (i) {
    $('testName').textContent = i.title;
    $('fSections').textContent = i.section_count;
    $('fQs').textContent = i.question_count;
    $('fTime').textContent = i.timed ? i.time_limit_minutes : 'No';
    $('fTimeL').textContent = i.timed ? 'minutes' : 'time limit';
  }
  const p = i?.proctoring || {};
  const fsOn = p.fullscreen_lock !== false, trackOn = p.tab_switch_tracking !== false || p.window_blur_tracking !== false;
  const rules = !i ? [] : [
    (i.section_types || []).includes('listening') ? 'Use headphones and find a quiet place. You will check your sound before the Listening section.' : null,
    'You cannot go back to a question after you continue.',
    i.allow_skip ? 'You can skip a question if you don’t know the answer.' : 'You must answer every question to continue.',
    `If you stop, you can continue later with the same email and code.${i.timed ? ' The timer stops while you are away.' : ''}`,
    i.timed ? 'When time runs out, the test is submitted automatically.' : null,
    !PREVIEW && fsOn ? 'The test opens in fullscreen. Leaving fullscreen pauses the test.' : null,
    !PREVIEW && trackOn ? 'Leaving the test page or window is recorded.' : null,
    'Do not use a dictionary, translator or any other help.',
  ].filter(Boolean);
  $('rules').innerHTML = rules.map(r => `<li>${esc(r)}</li>`).join('');
  const ackNeeded = !!i && !PREVIEW && (fsOn || trackOn);
  show($('ackRow'), ackNeeded);
  show($('appleNotice'), !!i && !PREVIEW && fsOn && isAppleMobile());
}

async function fetchInfo(code) {
  show($('infoLoading')); show($('infoError'), false);
  try {
    const { data, error } = await db.rpc('placement_test_info', { p_code: code });
    if (error) throw error;
    if (normCode($('code').value) !== code) return;   // the student kept typing
    paintInfo(data || null);
    if (data?.student_email) prefillAssigned(data);
    if (!data) { $('infoError').textContent = 'We could not find an open test for this code. Check the code or ask a staff member.'; show($('infoError')); }
  } catch (err) {
    console.warn('Test info failed:', err);
    $('infoError').textContent = 'We could not load the test. Check your internet connection and reload the page.';
    show($('infoError'));
  } finally { show($('infoLoading'), false); }
}

function prefillFromBackup(code) {
  const b = code && local.get(code);
  if (!b) return;
  if (!$('fullName').value) $('fullName').value = b.fullName || '';
  if (!$('email').value) $('email').value = b.email || '';
  $('go').textContent = 'Continue the test';
}

// Emailed codes belong to one student: fill in their name and lock the email.
// The name stays editable so a student can fix a spelling mistake.
function prefillAssigned(i) {
  const n = $('fullName'), m = $('email');
  if (!n.value) n.value = i.student_name || '';
  m.value = i.student_email; m.readOnly = true; m.setAttribute('aria-readonly', 'true');
  $('codeNote').textContent = 'Your name, email and code came with your link. Check your name, then start.';
  $('go').focus();
}

let infoTimer;
$('code').addEventListener('input', e => {
  if (e.target.readOnly) return;
  e.target.value = normCode(e.target.value);
  clearTimeout(infoTimer);
  const code = e.target.value;
  if (CODE_RE.test(code)) { infoTimer = setTimeout(() => fetchInfo(code), 300); prefillFromBackup(code); }
  else {
    paintInfo(null); show($('infoError'), false); $('go').textContent = 'Start the test';
    if ($('email').readOnly) { $('email').readOnly = false; $('email').removeAttribute('aria-readonly'); $('email').value = ''; }
  }
});

async function startLive() {
  const name = $('fullName').value.trim().replace(/\s+/g, ' '), email = $('email').value.trim(), code = normCode($('code').value);
  const fail = (msg, el) => { $('err').textContent = msg; if (el && !el.readOnly) el.focus(); };
  if (name.split(' ').length < 2) return fail('Type your full name (first and last name).', $('fullName'));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail('Type a valid email address.', $('email'));
  if (!CODE_RE.test(code)) return fail('Type your 6-character access code, for example ABC-123.', $('code'));
  if (!$('ackRow').classList.contains('hidden') && !$('ack').checked) return fail('Tick the box to confirm you understand the rules.', $('ack'));
  $('err').textContent = '';

  // Fullscreen must be requested while we still have the click's user activation.
  const p = info?.proctoring || {};
  const wantFs = p.fullscreen_lock !== false && !isAppleMobile();
  if (wantFs) {
    try { await document.documentElement.requestFullscreen(); }
    catch { return fail('Please allow fullscreen to start the test, then press the button again.'); }
  }

  $('go').disabled = true; $('go').textContent = 'Starting…';
  let data;
  try {
    const res = await db.rpc('placement_start', { p_code: code, p_email: email, p_full_name: name, p_user_agent: navigator.userAgent });
    if (res.error) throw res.error;
    data = res.data;
  } catch (err) {
    console.error('Start failed:', err);
    data = { error: 'network' };
  }
  $('go').disabled = false; $('go').textContent = 'Start the test';
  if (!data || data.error) {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    return fail(ERRORS[data?.error] || 'We could not start the test. Check your internet connection and try again.', $('code'));
  }

  loadTest(data.test);
  S.code = code; S.token = data.token; S.fullName = data.full_name; S.email = data.email;
  S.answers = data.answers || {};
  S.timeUsedMs = (data.time_used_seconds || 0) * 1000;
  const prog = data.progress || {};
  // Same device after a lost connection: the local copy can be ahead of the server.
  const b = local.get(code);
  if (b && b.email?.toLowerCase() === S.email.toLowerCase()) {
    S.answers = { ...S.answers, ...(b.answers || {}) };
    const bp = b.progress || {};
    if ((bp.si ?? -1) > (prog.si ?? 0) || ((bp.si ?? -1) === (prog.si ?? 0) && (bp.pos ?? -1) > (prog.pos ?? 0))) Object.assign(prog, bp);
  }
  Object.assign(S, {
    si: prog.si || 0, pos: prog.pos || 0, phase: prog.phase || 'intro',
    skipped: prog.skipped || {}, played: prog.played || {}, plays: prog.plays || {}, soundOk: prog.soundOk || {},
  });

  setupProctor();
  if (proctor) {
    proctor.restoreCounts(data.proctoring);
    lastTabs = proctor.tabSwitches; lastPaste = proctor.pasteBlocked; lastCopy = proctor.copyBlocked;
    proctor.logEvent(data.status === 'resumed' ? 'test_resumed' : 'test_started', S.fullName);
    proctor.start();
  }
  enterTest(data.status === 'resumed');
}

async function startPreview() {
  S.code = 'PRE-' + Math.random().toString(36).slice(2, 5).toUpperCase();   // only seeds the option shuffle
  S.fullName = 'Preview';
  enterTest(false);
}

function enterTest(resumed) {
  $('testName').textContent = TEST.title;
  $('who').textContent = S.fullName;
  show($('start'), false); show($('test'));
  S.active = true;
  if (!PREVIEW) setSave('saved');
  startTimer();
  render();
  if (resumed) toast('Welcome back. You can continue where you stopped.');
  queueSave(0);
}

$('go').onclick = () => (PREVIEW ? startPreview() : startLive());
$('startForm').addEventListener('submit', e => { e.preventDefault(); $('go').click(); });
['fullName', 'email', 'code'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('go').click(); } }));

async function init() {
  if (PREVIEW) {
    show($('previewBar'));
    show($('startForm'), false);
    $('go').textContent = 'Start preview';
    show($('infoLoading'));
    try {
      const { data: { session } } = await db.auth.getSession();
      if (!session) throw new Error('signin');
      const { data, error } = await db.from('placement_tests').select('id, title, settings, definition, placement_scale').eq('id', PREVIEW_ID).single();
      if (error || !data) throw error || new Error('missing');
      loadTest(data);
      const types = TEST.sections.map(s => s.type);
      paintInfo({
        title: TEST.title, timed: !!TEST.settings.timed, time_limit_minutes: TEST.settings.time_limit_minutes,
        allow_skip: !!TEST.settings.allow_skip, proctoring: TEST.settings.proctoring,
        section_count: TEST.sections.length, section_types: types, question_count: FLAT.reduce((n, s) => n + s.length, 0),
      });
      if (!FLAT.some(s => s.length)) { $('go').disabled = true; $('infoError').textContent = 'This test has no questions yet.'; show($('infoError')); }
    } catch (err) {
      $('go').disabled = true;
      $('infoError').innerHTML = err?.message === 'signin'
        ? 'Sign in as an academic to preview this test. <a href="../login.html">Sign in</a>'
        : 'This test could not be loaded for preview.';
      show($('infoError'));
    } finally { show($('infoLoading'), false); }
    return;
  }

  if (urlCode) {
    const f = $('code');
    f.value = urlCode; f.readOnly = true; f.setAttribute('aria-readonly', 'true');
    show($('codeLock')); $('codeNote').textContent = 'Your code came with your link.';
    prefillFromBackup(urlCode);
    if (CODE_RE.test(urlCode)) fetchInfo(urlCode);
    else { $('infoError').textContent = 'The code in this link is not valid. Ask a staff member for help.'; show($('infoError')); }
    $('fullName').focus();
  } else {
    $('fullName').focus();
  }
}
init();

/* ===================================================================== GLOBAL KEYS + LEAVE */
document.addEventListener('keydown', e => {
  if (!S.active || S.phase !== 'q' || S.finishing) return;
  if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  const q = curItem().q;
  if (!T(q).choice) return;
  if (/^[1-6]$/.test(e.key)) {
    const b = $('opts').children[+e.key - 1];
    if (b && !b.disabled) { b.click(); b.focus(); }
  } else if (e.key === 'Enter' && !$('next').disabled && !e.target.closest('.pbtn')) { e.preventDefault(); next(); }
});
window.addEventListener('pagehide', () => { if (S.active) { backup(); saveNow(); } });
window.addEventListener('beforeunload', e => { if (S.active && !PREVIEW) { backup(); e.preventDefault(); e.returnValue = ''; } });
