import { WHATS_NEW_PAGE, byDay, markSeen, seenAt, seenKey, type ChangeNote, type WhatsNew } from '../../shared/whats-new';
import { store } from '../state';
import { h } from './dom';
import './whats-new.css';

/** How often an open page asks again while lines are being written or GitHub is being asked. */
const POLL_MS = 3000;

/** This browser's storage, when it has any it lets the page use. */
function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** What floor `id`'s New marks are kept under: its folder (see seenKey). */
const seenOf = (id: string) => seenKey(store.floors.find((f) => f.id === id) ?? { id });

export interface WhatsNewPage {
  el: HTMLElement;
  /** On screen: reads the list, and keeps asking while it's being written. */
  show(): void;
  /** Off screen, still open. */
  hide(): void;
  close(): void;
}

/**
 * The clipboard's ✨ What's new page: every change added to a floor, newest first under its day, in
 * plain words (see server/change-notes.ts). The floor you're on first, and any other from the picker.
 */
export function whatsNewPage(): WhatsNewPage {
  let floor = store.floor ?? store.floors[0]?.id ?? '';
  let show = WHATS_NEW_PAGE;
  let data: WhatsNew | undefined;
  let error = '';
  let active = false;
  let timer: number | undefined;
  let asked = 0;
  /** What this browser had seen of each floor (by seenKey) before this look: changes after it are marked new. */
  const before = new Map<string, number | undefined>();

  const picker = h('select.whats-new-floor', { 'aria-label': 'Which floor' });
  picker.addEventListener('change', () => {
    floor = picker.value;
    show = WHATS_NEW_PAGE;
    data = undefined;
    error = '';
    render();
    void load();
  });
  const status = h('span.whats-new-status', { role: 'status' });
  const notes = h('div.whats-new-notes');
  const older = h('button.btn.whats-new-older', { type: 'button' }, 'Show older');
  older.addEventListener('click', () => {
    show += WHATS_NEW_PAGE;
    older.disabled = true;
    void load();
  });
  const el = h('div.whats-new', {}, h('div.whats-new-bar', {}, picker, status), notes, older);

  const fillPicker = () => {
    const floors = store.floors;
    picker.hidden = floors.length < 2;
    picker.replaceChildren(
      ...floors.map((f) => h('option', { value: f.id, selected: f.id === floor }, `${f.repo || f.name}${f.id === store.floor ? ' (you are here)' : ''}`)),
    );
  };

  async function load() {
    clearTimeout(timer);
    const mine = ++asked;
    const f = floor;
    try {
      const res = await fetch(`/api/whats-new?floor=${encodeURIComponent(f)}&show=${show}`, { credentials: 'same-origin', cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (mine !== asked) return;
      if (!res.ok) throw new Error(body?.error || `The list couldn't be read (${res.status})`);
      data = body as WhatsNew;
      error = '';
      const key = seenOf(f);
      if (!before.has(key)) before.set(key, seenAt(storage(), key));
      if (data.notes[0]) markSeen(storage(), key, data.notes[0].at);
    } catch (err) {
      if (mine !== asked) return;
      error = (err as Error).message || "The list couldn't be read";
    }
    render();
    if (active && data && (data.writing || data.refreshing)) timer = window.setTimeout(() => void load(), POLL_MS);
  }

  function render() {
    fillPicker();
    const scroller = el.parentElement;
    const top = scroller?.scrollTop ?? 0;
    const seen = before.get(seenOf(floor));
    const n = data?.writing ?? 0;
    status.textContent = !data
      ? error
        ? ''
        : 'Reading the list…'
      : n
        ? `✍️ Putting ${n} ${n === 1 ? 'change' : 'changes'} in plain words…`
        : data.refreshing
          ? 'Checking GitHub for the latest…'
          : `${data.total} ${data.total === 1 ? 'change' : 'changes'} since the start`;
    const parts: HTMLElement[] = [];
    if (error) parts.push(h('p.whats-new-note.error', {}, error));
    if (data?.error) parts.push(h('p.whats-new-note.error', {}, data.error));
    if (data?.writer) parts.push(h('p.whats-new-note', {}, data.writer));
    if (data && !data.notes.length && !data.error) parts.push(h('p.empty', {}, data.refreshing ? 'Reading the list…' : 'Nothing has been added here yet.'));
    for (const { day, notes: today } of byDay(data?.notes ?? [])) {
      parts.push(h('section.whats-new-day', {}, h('h3', {}, day), h('ul', {}, ...today.map((c) => item(c, seen !== undefined && c.at > seen)))));
    }
    notes.replaceChildren(...parts);
    const more = data ? data.total - data.notes.length : 0;
    older.hidden = more <= 0;
    older.disabled = false;
    older.textContent = `Show older (${more} more)`;
    if (scroller) scroller.scrollTop = top;
  }

  const unsubs = (['floors', 'floor'] as const).map((topic) => store.on(topic, () => active && render()));
  return {
    el,
    show() {
      active = true;
      render();
      void load();
    },
    hide() {
      active = false;
      clearTimeout(timer);
    },
    close() {
      active = false;
      clearTimeout(timer);
      asked++;
      unsubs.forEach((u) => u());
    },
  };
}

function item(c: ChangeNote, fresh: boolean): HTMLElement {
  const time = new Date(c.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return h(
    'li.whats-new-item',
    { class: [fresh ? 'fresh' : '', c.plain ? '' : 'rough'].join(' ').trim() },
    h('p.whats-new-text', {}, c.text),
    h(
      'div.whats-new-meta',
      {},
      fresh ? h('span.whats-new-tag.fresh', {}, 'New') : null,
      c.author ? h('span.whats-new-tag.author', {}, 'From the original author') : null,
      c.plain ? null : h('span.whats-new-tag.rough', { title: "Claude hasn't put this one in plain words yet: this is its own title, tidied up." }, 'not yet rewritten'),
      c.repo ? h('span.whats-new-tag.repo', {}, c.repo) : null,
      h('span.whats-new-time', {}, time),
      c.url ? h('a.whats-new-details', { href: c.url, target: '_blank', rel: 'noopener noreferrer', title: c.title }, 'details') : null,
    ),
  );
}
