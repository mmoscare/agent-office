import type { WorkerInfo } from '../../shared/protocol';
import { h } from './dom';
import { briefLines } from './terminal-brief-model';
import './terminal-brief.css';

/**
 * The strip atop an agent's terminal: what you asked it and what it's working on, one line each,
 * with a toggle to read them in full. `onToggle` hands focus back to the terminal.
 */
export function terminalBrief(onToggle: () => void) {
  const rows = h('div.terminal-brief-rows');
  const toggle = h('button.terminal-brief-toggle', { type: 'button', 'aria-expanded': 'false', title: 'Show the full request and task' }, 'More');
  const element = h('section.terminal-brief.hidden', { 'aria-label': 'What you asked and what it is working on' }, rows, toggle);
  let expanded = false;
  let rendered: string | undefined;

  /** The toggle only shows when there's more to read than fits. */
  const measure = () => {
    if (expanded) return;
    toggle.hidden = ![...rows.querySelectorAll<HTMLElement>('.terminal-brief-text')].some((t) => t.scrollWidth > t.clientWidth + 1);
  };
  const ro = new ResizeObserver(measure);
  ro.observe(rows);

  toggle.addEventListener('click', () => {
    expanded = !expanded;
    element.classList.toggle('expanded', expanded);
    toggle.textContent = expanded ? 'Less' : 'More';
    toggle.setAttribute('aria-expanded', String(expanded));
    measure();
    onToggle();
  });

  return {
    element,
    refresh(w: Pick<WorkerInfo, 'kind' | 'status' | 'ask' | 'task' | 'activity'>) {
      const lines = briefLines(w);
      const key = JSON.stringify(lines);
      if (key === rendered) return;
      rendered = key;
      element.classList.toggle('hidden', !lines.length);
      rows.replaceChildren(
        ...lines.map((l) =>
          h('div.terminal-brief-row', { class: l.key }, h('span.terminal-brief-label', {}, l.label), h('span.terminal-brief-text', { title: l.text }, l.text)),
        ),
      );
      requestAnimationFrame(measure);
    },
    dispose() {
      ro.disconnect();
    },
  };
}
