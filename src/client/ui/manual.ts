import { h, openModal } from './dom';
import { codeBox, type CodeBox } from './copy-code';
import { MANUAL, type ManualBlock, type ManualChapter } from './manual-content';

// The Office Manual: the book on the shelf in the boss office (world/bookshelf.ts), also in the ☰
// menu. Chapters down the left, one page at a time on the right. It opens where you left off.

const PAGE_KEY = 'agent-office.manualPage';
const PR_KEY = 'agent-office.manualPr';

/** A page's commands and the PR number filled into them (see `{PR}` in manual-content.ts). */
interface Page {
  pr: string;
  commands: { box: CodeBox; template: string }[];
}

function fill(template: string, pr: string): string {
  return template.split('{PR}').join(pr || 'PR_NUMBER');
}

/** `code` and **bold** in a line of text. */
function inline(text: string): (Node | string)[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).filter(Boolean).map((part) => {
    if (part.startsWith('`') && part.endsWith('`')) return h('code', {}, part.slice(1, -1));
    if (part.startsWith('**') && part.endsWith('**')) return h('b', {}, part.slice(2, -2));
    return part;
  });
}

function block(b: ManualBlock, page: Page): HTMLElement {
  if ('code' in b) {
    const box = codeBox(fill(b.code, page.pr), b.dir);
    page.commands.push({ box, template: b.code });
    return box.el;
  }
  if ('prNumber' in b) {
    const input = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'e.g. 22', 'aria-label': 'PR number', value: page.pr }) as HTMLInputElement;
    input.addEventListener('input', () => {
      page.pr = input.value.replace(/\D/g, '').slice(0, 7);
      if (input.value !== page.pr) input.value = page.pr;
      for (const c of page.commands) c.box.set(fill(c.template, page.pr));
      try {
        localStorage.setItem(PR_KEY, page.pr);
      } catch {
        // not remembered then
      }
    });
    return h('label.manual-pr', {}, h('span', {}, 'PR number'), input);
  }
  if ('p' in b) return h('p', {}, ...inline(b.p));
  if ('h' in b) return h('h4', {}, b.h);
  if ('list' in b) return h('ul', {}, ...b.list.map((t) => h('li', {}, ...inline(t))));
  if ('steps' in b) return h('ol', {}, ...b.steps.map((t) => h('li', {}, ...inline(t))));
  if ('note' in b) return h('p.manual-note', {}, ...inline(b.note));
  if ('checklist' in b) return h('ul.manual-checklist', {}, ...b.checklist.map((t) => h('li', {}, h('label', {}, h('input', { type: 'checkbox' }), h('span', {}, ...inline(t))))));
  return h(
    'div.manual-table',
    {},
    h('table', {}, h('thead', {}, h('tr', {}, ...b.table.head.map((c) => h('th', {}, c)))), h('tbody', {}, ...b.table.rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, ...inline(c))))))),
  );
}

function remembered(): string | undefined {
  try {
    return localStorage.getItem(PAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function openManual(chapterId?: string) {
  let index = Math.max(0, MANUAL.findIndex((c) => c.id === (chapterId ?? remembered())));
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const toc = h('nav.manual-toc', { 'aria-label': 'Chapters' });
  const page = h('article.manual-page', { tabindex: -1 });
  const prev = h('button.btn', { type: 'button' }, '← Previous');
  const next = h('button.btn', { type: 'button' }, 'Next →');
  const where = h('span.grow');
  const el = h(
    'div.modal.manual',
    { role: 'dialog', 'aria-label': 'Office Manual', tabindex: -1 },
    h('header', {}, h('h2', {}, '📘 Office Manual'), close),
    h('div.manual-body', {}, toc, page),
    h('footer', {}, where, prev, next),
  );

  const show = (i: number) => {
    index = Math.max(0, Math.min(MANUAL.length - 1, i));
    const ch: ManualChapter = MANUAL[index];
    try {
      localStorage.setItem(PAGE_KEY, ch.id);
    } catch {
      // Private windows: it just opens at the start next time.
    }
    toc.replaceChildren(
      ...MANUAL.map((c, j) =>
        h('button', { type: 'button', class: j === index ? 'on' : '', 'aria-current': j === index ? 'page' : undefined, onclick: () => show(j) }, h('span.manual-icon', {}, c.icon), c.title),
      ),
    );
    let pr = '';
    try {
      pr = localStorage.getItem(PR_KEY) ?? '';
    } catch {
      pr = '';
    }
    const state: Page = { pr, commands: [] };
    page.replaceChildren(h('h3', {}, `${ch.icon} ${ch.title}`), ...ch.blocks.map((b) => block(b, state)));
    page.scrollTop = 0;
    where.textContent = `Chapter ${index + 1} of ${MANUAL.length}`;
    prev.disabled = index === 0;
    next.disabled = index === MANUAL.length - 1;
  };

  prev.addEventListener('click', () => show(index - 1));
  next.addEventListener('click', () => show(index + 1));
  el.addEventListener('keydown', (e) => {
    // Arrow keys move the cursor in the PR box, not the page.
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'ArrowRight') show(index + 1);
    else return;
    e.preventDefault();
  });
  const modal = openModal(el, { doing: '📘 reading the manual' });
  close.addEventListener('click', () => modal.close());
  show(index);
  setTimeout(() => el.focus(), 30);
}
