// Copy and paste in a worker's terminal, the Windows Terminal way. xterm otherwise sends Ctrl+C and
// Ctrl+V to the program as control characters, so nothing reaches the clipboard. On a Mac, ⌘C and
// ⌘V already work and Ctrl stays with the program.

export type ClipboardAction = 'copy' | 'paste';

export interface ClipboardKey {
  type: string;
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * What a key does to the clipboard, if anything:
 * - Ctrl+C copies while text is selected; with nothing selected it still interrupts the program.
 * - Ctrl+Shift+C always copies (it never interrupts).
 * - Ctrl+V and Ctrl+Shift+V paste.
 */
export function clipboardAction(e: ClipboardKey, hasSelection: boolean, mac: boolean): ClipboardAction | null {
  if (mac || e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return null;
  // The letter as typed; on a non-Latin layout (Cyrillic, Greek…) the key where C or V would be.
  const typed = e.key.toLowerCase();
  const k = /^[a-z]$/.test(typed) ? typed : e.code?.startsWith('Key') ? e.code.slice(3).toLowerCase() : typed;
  if (k === 'c') return e.shiftKey || hasSelection ? 'copy' : null;
  if (k === 'v') return 'paste';
  return null;
}

/** Whether this browser is on a Mac (or iPad/iPhone), where ⌘ is the clipboard key. */
export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}
