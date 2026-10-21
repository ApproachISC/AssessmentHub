// Shared helpers for the Evaluations section (evaluation/*.html).
// Grade math here mirrors public.evaluation_grade_parts() in db/014_evaluations.sql —
// the database is the source of truth for the stored grade; this is only the
// live preview while a draft is being filled in.
import { db } from './supabase-client.js';
import { esc } from './ui.js';

export const NOT_OBSERVED = 'NO';

export function formatDay(isoDate) {
  if (!isoDate) return '—';
  // class_date is a plain date (YYYY-MM-DD): build it in local time so it
  // doesn't shift a day back in timezones west of UTC
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatStamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function todayISO() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Sections are shown as A, B, C… by position (their ids are internal)
export function sectionLetter(index) {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

export function maxPoints(def) {
  return Number(def?.max_points_per_item ?? 4);
}

export function passMark(def) {
  return Number(def?.pass_mark ?? 70);
}

// { earned, possible, unanswered, grade }
export function computeGrade(def, scores = {}) {
  const max = maxPoints(def);
  let earned = 0, possible = 0, unanswered = 0;
  (def?.sections || []).forEach(s => (s.items || []).forEach(it => {
    const v = scores[it.id];
    if (typeof v === 'number') {
      earned += Math.min(Math.max(v, 0), max);
      possible += max;
    } else if (v !== NOT_OBSERVED) {
      unanswered++;
    }
  }));
  const grade = possible > 0 ? Math.round(earned / possible * 1000) / 10 : null;
  return { earned, possible, unanswered, grade };
}

export function sectionTotals(def, section, scores = {}) {
  const max = maxPoints(def);
  let earned = 0, possible = 0;
  (section.items || []).forEach(it => {
    const v = scores[it.id];
    if (typeof v === 'number') { earned += v; possible += max; }
  });
  return { earned, possible, full: (section.items || []).length * max };
}

export function gradeBand(def, grade) {
  if (grade == null) return null;
  const bands = [...(def?.grade_bands || [])].sort((a, b) => b.min - a.min);
  return bands.find(b => grade >= b.min)?.label || null;
}

export function formatGrade(grade) {
  if (grade == null) return '—';
  return Number.isInteger(Number(grade)) ? String(Number(grade)) : Number(grade).toFixed(1);
}

// Grade pill: "85 · Good" in green, or red when below the pass mark
export function gradeChip(def, grade) {
  if (grade == null) return '<span class="chip draft">No score</span>';
  const pass = Number(grade) >= passMark(def);
  const band = gradeBand(def, Number(grade));
  return `<span class="chip ${pass ? 'active' : 'flagged'}">${formatGrade(grade)}${band ? ' · ' + esc(band) : ''}</span>`;
}

export function scoreLabel(def, v) {
  if (v === NOT_OBSERVED) return 'Not observed';
  if (typeof v !== 'number') return '—';
  const s = (def?.scale || []).find(x => Number(x.value) === v);
  return s ? `${v} · ${s.label}` : String(v);
}

// Every active and inactive user's display name (profiles RLS hides other
// teachers from non-academic users, so this goes through an RPC).
export async function loadPeople() {
  const { data, error } = await db.rpc('list_evaluation_people');
  if (error) throw error;
  return data || [];
}

export function personName(people, id) {
  return people.find(p => p.id === id)?.full_name || '—';
}

export function downloadCsv(filename, rows) {
  const cell = v => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM so Excel opens accented names correctly
  const csv = '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
