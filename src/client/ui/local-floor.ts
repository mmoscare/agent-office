import type { LocalFolderListing } from '../../shared/local-folders';
import { h } from './dom';

/** Kept separate from the GitHub picker so upstream's clone flow can evolve independently. */
export function localFloorPicker(onAdded: (floor: string) => void, onBusy: (busy: boolean) => void) {
  let disposed = false;
  let adding = false;
  let browsing: AbortController | undefined;
  const input = h('input', { id: 'local-floor-path', type: 'text', placeholder: 'Paste a folder path, or browse', autocomplete: 'off', spellcheck: 'false', maxlength: 4096 }) as HTMLInputElement;
  const browse = h('button.btn', { type: 'button' }, 'Browse folders');
  const folders = h('div.folder-browser.hidden');
  const error = h('p.err', { role: 'alert' });
  const button = h('button.btn.primary', { type: 'button', disabled: true }, 'Open folder');
  const element = h('div.local-floor', {},
    h('label', { for: input.id }, 'Folder path'),
    h('div.repo-search', {}, input, browse),
    h('p.note', {}, 'Choose a folder on the computer running Agent Office. Workers on this floor will use that folder, including any repositories inside it.'),
    folders, error,
  );

  const list = async (dir = input.value.trim()) => {
    browsing?.abort();
    const controller = new AbortController();
    browsing = controller;
    error.textContent = '';
    browse.disabled = true;
    folders.classList.remove('hidden');
    folders.replaceChildren(h('p.note', { role: 'status' }, 'Loading folders…'));
    try {
      const response = await fetch(`/api/folders?dir=${encodeURIComponent(dir)}`, { credentials: 'same-origin', signal: controller.signal });
      const data = await response.json() as LocalFolderListing & { error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Could not browse this folder');
      if (disposed || controller.signal.aborted) return;
      input.value = data.dir;
      button.disabled = adding;
      const up = h('button.btn', { type: 'button', disabled: data.parent === null }, '↑ Up one folder');
      up.addEventListener('click', () => { if (data.parent) void list(data.parent); });
      const rows = data.folders.map(folder => {
        const row = h('button.folder-row', { type: 'button', title: folder.dir }, '📁 ', folder.name);
        row.addEventListener('click', () => void list(folder.dir));
        return row;
      });
      folders.replaceChildren(up, h('div.folder-list', {}, ...(rows.length ? rows : [h('p.note', {}, 'No subfolders. You can open this folder.')])));
      if (data.truncated) folders.append(h('p.note', {}, 'Showing the first 500 folders. Paste a full path to open another one.'));
    } catch (err) {
      if (disposed || controller.signal.aborted) return;
      folders.replaceChildren();
      error.textContent = (err as Error).message;
    } finally {
      if (browsing === controller) {
        browsing = undefined;
        browse.disabled = adding;
      }
    }
  };

  const open = async () => {
    const dir = input.value.trim();
    if (!dir || adding) return;
    browsing?.abort();
    adding = true;
    onBusy(true);
    input.disabled = browse.disabled = button.disabled = true;
    folders.querySelectorAll('button').forEach(el => { el.disabled = true; });
    button.textContent = 'Opening…';
    error.textContent = '';
    try {
      const response = await fetch('/api/floors/local', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir }) });
      const data = await response.json() as { floor?: string; error?: string };
      if (!response.ok || !data.floor) throw new Error(data.error ?? 'Could not open this folder');
      if (!disposed) onAdded(data.floor);
    } catch (err) {
      if (!disposed) error.textContent = (err as Error).message;
    } finally {
      adding = false;
      onBusy(false);
      input.disabled = browse.disabled = false;
      button.disabled = !input.value.trim();
      button.textContent = 'Open folder';
      // A failed open can be corrected by typing or browsing again.
      if (!disposed && folders.childElementCount) folders.replaceChildren();
    }
  };
  input.addEventListener('input', () => { browsing?.abort(); error.textContent = ''; button.disabled = !input.value.trim() || adding; });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void open(); }
  });
  browse.addEventListener('click', () => void list());
  button.addEventListener('click', () => void open());
  return { element, button, focus: () => input.focus(), dispose: () => { disposed = true; browsing?.abort(); } };
}
