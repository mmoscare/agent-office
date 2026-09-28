import type { ChangesState } from '../../shared/protocol';
import { h } from './dom';
import './changes-tabs.css';

/** Filter a shared folder's Changes view without changing which checkout an agent uses. */
export function changesRepositoryTabs(panelId: string, onSelect: () => void) {
  const element = h('div.changes-repository-tabs', { role: 'tablist', 'aria-label': 'Repositories', hidden: true });
  let selected: string | null = null;
  let rendered = '';

  function update(state: ChangesState) {
    const repositories = state.repositories ?? [];
    if (!repositories.some(r => r.path === selected)) selected = null;
    element.hidden = !repositories.length;
    const entries = repositories.length ? [
      { path: null, name: 'All repositories', count: state.files.length, error: undefined as string | undefined },
      ...repositories.map(r => ({ path: r.path, name: r.path, count: state.files.filter(f => f.path.startsWith(`${r.path}/`)).length, error: r.error })),
    ] : [];
    const key = JSON.stringify([selected, state.more, entries]);
    if (key === rendered) return;
    rendered = key;
    const hadFocus = element.contains(document.activeElement);
    element.replaceChildren(...entries.map(r => {
      const button = h('button.btn', {
        type: 'button', role: 'tab', 'aria-selected': String(selected === r.path),
        'aria-controls': panelId, tabindex: selected === r.path ? 0 : -1,
        title: r.error ? `${r.name}: ${r.error}` : `${r.count} listed changes${state.more ? '; the file list is limited' : ''}`,
        onclick: () => {
          if (selected === r.path) return;
          selected = r.path;
          onSelect();
        },
      }, h('span', {}, r.name), h('span.repository-count', {}, r.error ? '!' : `${r.count}${state.more ? '+' : ''}`));
      return button;
    }));
    if (hadFocus) element.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  }

  element.addEventListener('keydown', e => {
    // Keep the Changes window's file navigation from handling keys used on these tabs.
    if (['ArrowUp', 'ArrowDown', 'j', 'k'].includes(e.key)) e.stopPropagation();
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const buttons = [...element.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const i = buttons.findIndex(b => b === document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.click();
    element.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  });

  return {
    element, update,
    get selected() { return selected; },
    files: (state: ChangesState | null) => (state?.files ?? []).filter(f => selected === null || f.path.startsWith(`${selected}/`)),
    label: (file: string) => selected === null ? file : file.slice(selected.length + 1),
  };
}
