// Copy and paste in a terminal, the Windows Terminal way. xterm otherwise sends Ctrl+C and
// Ctrl+V to the program as control characters, and it also cancels the key, so the browser never
// fires copy or paste. On a Mac, ⌘C and ⌘V already work and Ctrl stays with the program.

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

/** The bit of a terminal the clipboard keys need. */
export interface ClipboardTerm {
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  focus(): void;
  element?: HTMLElement;
}

/**
 * Copies during the key that asked. Must run before any await: the async clipboard spends the
 * user gesture, and a later execCommand then fails (plain http off localhost never had the async
 * API). Returns whether the synchronous copy landed.
 */
export function copyTextNow(text: string): boolean {
  const previous = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:2em;height:2em;padding:0;border:none;outline:none;box-shadow:none;background:transparent;opacity:0';
  document.body.append(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
  return ok;
}

/**
 * Ctrl+C / Ctrl+V for an open terminal window, including when focus is on a button in that window
 * rather than the terminal itself. Installed on window (capture) so it runs before xterm cancels
 * the key. Ctrl+C with nothing selected is left alone, so it still interrupts the program.
 */
export function bindTerminalClipboard(modal: HTMLElement, getTerm: () => ClipboardTerm | undefined, onFail: (message: string) => void): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (!modal.isConnected) return;
    const top = document.getElementById('modal-root')?.lastElementChild;
    if (top && !top.contains(modal)) return;
    const term = getTerm();
    if (!term) return;
    const target = e.target;
    if (target instanceof HTMLElement && !term.element?.contains(target)) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
    }
    const action = clipboardAction(e, term.hasSelection(), isMac());
    if (!action) return;
    // Stop xterm seeing the key: its own handler would cancel it, which kills copy and paste.
    e.stopPropagation();
    if (action === 'paste') {
      term.focus();
      return;
    }
    const text = term.getSelection();
    if (!text) {
      e.preventDefault();
      return;
    }
    if (copyTextNow(text)) {
      // Cancel the key's own copy, or an empty DOM selection overwrites what just landed.
      e.preventDefault();
      term.focus();
      term.clearSelection();
      return;
    }
    const inTerm = e.target instanceof Node && !!term.element?.contains(e.target);
    if (inTerm) return;
    e.preventDefault();
    const write = navigator.clipboard?.writeText(text);
    if (!write) {
      term.focus();
      onFail("Couldn't copy here: right-click the selection and choose Copy");
      return;
    }
    void write.then(
      () => {
        term.focus();
        term.clearSelection();
      },
      () => {
        term.focus();
        onFail("Couldn't copy here: right-click the selection and choose Copy");
      },
    );
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
