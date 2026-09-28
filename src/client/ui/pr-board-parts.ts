import { h } from './dom';

/**
 * The building blocks of the Pull Requests board (ui/boards.ts, ui/unshipped-list.ts): a section
 * pinned to the cork, and the index-card row every PR and unshipped branch is drawn as. Their look
 * is in style.css under "Pull Requests board".
 */

type Child = Node | string | null | undefined | false;

/** A status pill: icon and word, tinted with the status colour (`st` is its key, e.g. 'failing'). */
export function pill(st: string, icon: string, label: string, hint?: string): HTMLElement {
  return h('span.prb-pill', { class: `st-${st}`, title: hint }, h('span', { 'aria-hidden': 'true' }, icon), label);
}

/** +12 -3, in the diff colours. */
export function diffStat(added = 0, deleted = 0): HTMLElement {
  return h('span.prb-diff', { title: `${added} lines added, ${deleted} removed` }, h('span.add', {}, `+${added}`), h('span.del', {}, `-${deleted}`));
}

export interface RowParts {
  /** Stays the same across redraws, so keyboard focus can come back to it. */
  key: string;
  /** Status key for the stripe down its left edge. */
  st: string;
  pill: Node;
  /** "#24", or "repo#24" on a floor of several. */
  ref?: string;
  title: string;
  meta: Child[];
  /** Top right: usually when it last changed. */
  when?: string;
  /** Bottom right: a button or where its recovery stands. */
  action?: Node;
  compact?: boolean;
  label: string;
  onOpen?: () => void;
}

/** One card on the board. Enter or Space opens it, like a click. */
export function row(p: RowParts): HTMLElement {
  const open = p.onOpen;
  return h(
    'li.prb-row',
    {
      class: `st-${p.st}${p.compact ? ' compact' : ''}${open ? ' openable' : ''}`,
      'data-key': p.key,
      tabindex: 0,
      role: open ? 'button' : undefined,
      'aria-label': p.label,
      onclick: open ? () => open() : undefined,
      onkeydown: open
        ? (((e: KeyboardEvent) => {
            if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
            e.preventDefault();
            open();
          }) as EventListener)
        : undefined,
    },
    h('div.prb-head', {}, p.pill, p.ref ? h('span.prb-ref', {}, p.ref) : '', h('span.prb-title', {}, p.title)),
    p.when ? h('span.prb-when', {}, p.when) : '',
    p.compact ? '' : h('div.prb-meta', {}, ...p.meta.filter((m): m is Node | string => !!m).map((m) => (typeof m === 'string' ? h('span', {}, m) : m))),
    p.action ? h('div.prb-action', { onclick: ((e: Event) => e.stopPropagation()) as EventListener }, p.action) : '',
  );
}

/** A repository's name above its rows, on a floor of several. */
export function repoHeading(repo: string, count: number): HTMLElement {
  return h('li.prb-repo', { 'aria-hidden': 'true' }, h('span', {}, `📁 ${repo}`), h('span.prb-count', {}, String(count)));
}

/** Rows standing in while the first answer loads. */
export function skeletonRows(n = 2): HTMLElement[] {
  return Array.from({ length: n }, () => h('li.prb-row.prb-skel', { 'aria-hidden': 'true' }, h('div.prb-head', {}, h('span.bar.short'), h('span.bar')), h('div.prb-meta', {}, h('span.bar.tiny'))));
}

export function emptyRow(icon: string, text: string, sub?: string): HTMLElement {
  return h('li.prb-empty', {}, h('span.big', { 'aria-hidden': 'true' }, icon), h('b', {}, text), sub ? h('small', {}, sub) : '');
}

export interface SectionParts {
  id: string;
  /** Tints its header: 'needs', 'unshipped', 'progress' or 'done'. */
  tone: string;
  icon: string;
  title: string;
  count: number;
  hint?: string;
  tools?: Node[];
  rows: Node[];
}

/** A section of the board: a paper panel with a tinted header and its rows. */
export function section(p: SectionParts): HTMLElement {
  return h(
    'section.prb-section',
    { class: `tone-${p.tone}`, id: p.id, 'aria-label': `${p.title}: ${p.count}` },
    h('h3', {}, h('span.prb-icon', { 'aria-hidden': 'true' }, p.icon), h('span.prb-name', {}, p.title), h('span.prb-count', {}, String(p.count)), p.hint ? h('span.prb-hint', {}, p.hint) : '', ...(p.tools ?? [])),
    h('ul.prb-rows', {}, ...p.rows),
  );
}
