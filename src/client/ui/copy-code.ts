import { h, toast } from './dom';

// A command to paste into PowerShell: the command in a dark box with a Copy button, and which
// folder to run it in when that matters. Used by the manual and the Git board.

/** Puts text on the clipboard; the old way where the async clipboard isn't allowed (plain http off localhost). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: 'position:fixed;left:-9999px;top:0', 'aria-hidden': 'true' }) as HTMLTextAreaElement;
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
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
