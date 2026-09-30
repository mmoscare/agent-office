// Reminder sticky notes on the wall beside the To Do board. One list per person for the whole
// building (see server/stickies.ts), so the same notes are on every floor. The browser applies each
// change straight away and lets the office's copy win when it comes back.

import { FLOOR } from './layout.js';

export const STICKY_COLORS = {
  yellow: { paper: '#fff3a0', edge: '#e0b400', ink: '#3d3510' },
  pink: { paper: '#ffd0e0', edge: '#e07098', ink: '#4a2030' },
  blue: { paper: '#c9e7ff', edge: '#4aa3e0', ink: '#1a3048' },
  green: { paper: '#d4f5c8', edge: '#5cb85c', ink: '#1e3a1e' },
  orange: { paper: '#ffe0b8', edge: '#e09030', ink: '#4a3010' },
  purple: { paper: '#e6d4ff', edge: '#a070e0', ink: '#2e2048' },
} as const;
export type StickyColor = keyof typeof STICKY_COLORS;

export const STICKY_TEXT_MAX = 280;
/** Notes a list keeps, at most. */
export const STICKY_LIMIT = 24;
export const STICKY_W_MIN = 0.55;
export const STICKY_W_MAX = 1.7;
export const STICKY_H_MIN = 0.45;
export const STICKY_H_MAX = 1.35;
/** How far a nudge in the editor moves a note, in meters. */
export const STICKY_NUDGE = 0.12;

/**
 * Where reminders hang: the north wall, above and just beside the issues / To Do board (see BOARDS
 * in layout.ts). `u` is x along that wall; `y` is height above the floor.
 */
export const STICKY_ZONE = { u0: -16.6, u1: -8.15, y0: 4.5, y1: 6.45 } as const;

/** The + that adds a note, just right of the row above the board. */
export const STICKY_ADD_AT = { u: -8.55, y: 5.32, size: 0.42 } as const;

export interface StickyNote {
  id: string;
  text: string;
  color: StickyColor;
  /** Center along the north wall. */
  u: number;
  /** Center height above the floor. */
  y: number;
  w: number;
  h: number;
  /** Put away for now: still saved, not on the wall until you show it again. */
  hidden: boolean;
  at: number;
}

export type StickyAction =
  | { action: 'add'; id: string; text: string; color: StickyColor; u: number; y: number; w: number; h: number }
  | { action: 'edit'; id: string; text: string }
  | { action: 'color'; id: string; color: StickyColor }
  | { action: 'resize'; id: string; w: number; h: number }
  | { action: 'move'; id: string; u: number; y: number }
  | { action: 'hide'; id: string; hidden: boolean }
  | { action: 'remove'; id: string };

const ID_RE = /^[a-z0-9]{6,32}$/;

export function isStickyColor(value: unknown): value is StickyColor {
  return typeof value === 'string' && value in STICKY_COLORS;
}

export function newStickyId(): string {
  return Array.from({ length: 12 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 1000) / 1000;

const cleanText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim();
  return text && text.length <= STICKY_TEXT_MAX ? text : null;
};

const num = (value: unknown, lo: number, hi: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? round(clamp(value, lo, hi)) : null;

/** Slides a note so its whole face stays in the strip above the To Do board. */
export function clampSticky(u: number, y: number, w: number, h: number): { u: number; y: number } {
  const hw = w / 2;
  const hh = h / 2;
  const uMin = STICKY_ZONE.u0 + hw;
  const uMax = STICKY_ZONE.u1 - hw;
  const yMin = STICKY_ZONE.y0 + hh;
  const yMax = STICKY_ZONE.y1 - hh;
  return {
    u: round(clamp(u, Math.min(uMin, uMax), Math.max(uMin, uMax))),
    y: round(clamp(y, Math.min(yMin, yMax), Math.max(yMin, yMax))),
  };
}

/** A free spot above the board for a new note, or a slight stagger when the row is full. */
export function nextStickySpot(items: readonly StickyNote[], w = 1.05, h = 0.82): { u: number; y: number } {
  const slots = [
    [-13.72, 5.32],
    [-12.38, 5.32],
    [-11.04, 5.32],
    [-9.7, 5.32],
    [-15.45, 5.15],
    [-15.45, 4.85],
  ] as const;
  const shown = items.filter((s) => !s.hidden);
  for (const [u, y] of slots) {
    const at = clampSticky(u, y, w, h);
    const blocked = shown.some((s) => Math.abs(s.u - at.u) < (s.w + w) / 2 - 0.08 && Math.abs(s.y - at.y) < (s.h + h) / 2 - 0.08);
    if (!blocked) return at;
  }
  const n = shown.length;
  return clampSticky(-13.72 + (n % 4) * 0.16, 5.32 - Math.floor(n / 4) * 0.1, w, h);
}

/**
 * The four reminders already on the wall. Names are spelled the way they were asked for.
 * The third request was two jobs, so it is two notes.
 */
export const STICKY_PRESETS: readonly Omit<StickyNote, 'at'>[] = [
  { id: 'post45times', text: 'POST 4-5 TIMES A DAY (remember camillla arajuo)', color: 'yellow', u: -13.72, y: 5.32, w: 1.2, h: 1.02, hidden: false },
  { id: 'dailyrecap1', text: 'DAILY RECAP VID (see paper cluluoud)', color: 'pink', u: -12.38, y: 5.32, w: 1.2, h: 1.02, hidden: false },
  { id: 'viralshort1', text: 'Make the viral short', color: 'blue', u: -11.04, y: 5.32, w: 1.2, h: 1.02, hidden: false },
  { id: 'sierradesk1', text: 'Show futures traders desk. Sierra chart.', color: 'green', u: -9.7, y: 5.32, w: 1.2, h: 1.02, hidden: false },
];

export function presetStickies(now = Date.now()): StickyNote[] {
  return STICKY_PRESETS.map((p) => ({ ...p, at: now }));
}

/** Where a note hangs, just off the north wall, facing into the room. */
export function stickyPose(u: number, y: number): { x: number; y: number; z: number; rotY: number } {
  return { x: u, y, z: FLOOR.minZ + 0.14, rotY: 0 };
}

/** A change a browser sent, if it is one. Sizes and places are pulled into range. */
export function checkStickyAction(raw: unknown): StickyAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== 'string' || !ID_RE.test(a.id)) return null;
  const id = a.id;
  switch (a.action) {
    case 'add': {
      const text = cleanText(a.text);
      const w = num(a.w, STICKY_W_MIN, STICKY_W_MAX);
      const h = num(a.h, STICKY_H_MIN, STICKY_H_MAX);
      if (!text || !isStickyColor(a.color) || w === null || h === null || typeof a.u !== 'number' || typeof a.y !== 'number') return null;
      const at = clampSticky(a.u, a.y, w, h);
      return { action: 'add', id, text, color: a.color, w, h, ...at };
    }
    case 'edit': {
      const text = cleanText(a.text);
      return text ? { action: 'edit', id, text } : null;
    }
    case 'color':
      return isStickyColor(a.color) ? { action: 'color', id, color: a.color } : null;
    case 'resize': {
      const w = num(a.w, STICKY_W_MIN, STICKY_W_MAX);
      const h = num(a.h, STICKY_H_MIN, STICKY_H_MAX);
      return w !== null && h !== null ? { action: 'resize', id, w, h } : null;
    }
    case 'move':
      return typeof a.u === 'number' && Number.isFinite(a.u) && typeof a.y === 'number' && Number.isFinite(a.y) ? { action: 'move', id, u: a.u, y: a.y } : null;
    case 'hide':
      return typeof a.hidden === 'boolean' ? { action: 'hide', id, hidden: a.hidden } : null;
    case 'remove':
      return { action: 'remove', id };
    default:
      return null;
  }
}

/** A note read back from disk, if it is one. */
export function checkStickyItem(raw: unknown): StickyNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const text = cleanText(t.text);
  const w = num(t.w, STICKY_W_MIN, STICKY_W_MAX);
  const h = num(t.h, STICKY_H_MIN, STICKY_H_MAX);
  if (typeof t.id !== 'string' || !ID_RE.test(t.id) || !text || !isStickyColor(t.color) || w === null || h === null) return null;
  if (typeof t.u !== 'number' || !Number.isFinite(t.u) || typeof t.y !== 'number' || !Number.isFinite(t.y)) return null;
  if (typeof t.at !== 'number' || !Number.isFinite(t.at)) return null;
  const at = clampSticky(t.u, t.y, w, h);
  return { id: t.id, text, color: t.color, ...at, w, h, hidden: t.hidden === true, at: t.at };
}

function samePlace(a: StickyNote, u: number, y: number, w: number, h: number): boolean {
  return a.u === u && a.y === y && a.w === w && a.h === h;
}

/**
 * The list after `a`. The same list back when it changes nothing (a note that's already gone, a
 * name that's taken). Past the limit, the oldest hidden note goes first.
 */
export function applySticky(items: readonly StickyNote[], a: StickyAction, now = Date.now()): readonly StickyNote[] {
  const was = items.find((t) => t.id === a.id);
  let next: StickyNote[];
  switch (a.action) {
    case 'add': {
      if (was) return items;
      const w = clamp(a.w, STICKY_W_MIN, STICKY_W_MAX);
      const h = clamp(a.h, STICKY_H_MIN, STICKY_H_MAX);
      const at = clampSticky(a.u, a.y, w, h);
      next = [...items, { id: a.id, text: a.text, color: a.color, ...at, w, h, hidden: false, at: now }];
      break;
    }
    case 'edit':
      if (!was || was.text === a.text) return items;
      next = items.map((t) => (t === was ? { ...t, text: a.text } : t));
      break;
    case 'color':
      if (!was || was.color === a.color) return items;
      next = items.map((t) => (t === was ? { ...t, color: a.color } : t));
      break;
    case 'resize': {
      if (!was) return items;
      const w = clamp(a.w, STICKY_W_MIN, STICKY_W_MAX);
      const h = clamp(a.h, STICKY_H_MIN, STICKY_H_MAX);
      const at = clampSticky(was.u, was.y, w, h);
      if (samePlace(was, at.u, at.y, w, h)) return items;
      next = items.map((t) => (t === was ? { ...t, ...at, w, h } : t));
      break;
    }
    case 'move': {
      if (!was) return items;
      const at = clampSticky(a.u, a.y, was.w, was.h);
      if (was.u === at.u && was.y === at.y) return items;
      next = items.map((t) => (t === was ? { ...t, ...at } : t));
      break;
    }
    case 'hide':
      if (!was || was.hidden === a.hidden) return items;
      next = items.map((t) => (t === was ? { ...t, hidden: a.hidden } : t));
      break;
    case 'remove':
      if (!was) return items;
      next = items.filter((t) => t !== was);
      break;
  }
  while (next.length > STICKY_LIMIT) {
    const oldest = [...next].sort((x, y) => Number(y.hidden) - Number(x.hidden) || x.at - y.at)[0];
    next = next.filter((t) => t !== oldest);
  }
  return next;
}
