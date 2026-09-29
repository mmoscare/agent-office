import { h, toast } from './dom';
import { copyTextNow } from './terminal-clipboard';

// A command to paste into PowerShell: the command in a dark box with a Copy button, and which
// folder to run it in when that matters. Used by the manual and the Git board.

/** Puts text on the clipboard. The synchronous copy runs first: awaiting the async API spends the user gesture, and plain http off localhost never had that API. */
export async function copyText(text: string): Promise<boolean> {
  if (copyTextNow(text)) return true;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface CodeBox {
  el: HTMLElement;
  /** Change the command shown (and copied). */
  set(text: string): void;
}

export function codeBox(text: string, dir?: string): CodeBox {
  let current = text;
  const pre = h('pre', {}, text);
  const btn = h('button.btn.manual-copy', { type: 'button', title: 'Copy, to paste into PowerShell' }, '📋 Copy');
  btn.addEventListener('click', async () => {
    const ok = await copyText(current);
    btn.textContent = ok ? '✓ Copied' : 'Select it instead';
    if (!ok) toast("Couldn't copy here: select the text and press Ctrl+C", 'warn');
    setTimeout(() => (btn.textContent = '📋 Copy'), 1500);
  });
  const el = h('div.manual-code', {}, dir ? h('div.manual-dir', { title: dir }, '📁 Run in ', h('code', {}, dir)) : null, h('div.manual-code-box', {}, pre, btn));
  return {
    el,
    set(t: string) {
      current = t;
      pre.textContent = t;
    },
  };
}
