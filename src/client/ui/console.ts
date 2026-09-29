import type { Net } from '../net';
import type { ServerMsg } from '../../shared/protocol';
import { h, openModal, toast, type Modal } from './dom';
import { newTerm } from './terminal';
import { bindTerminalClipboard, clipboardAction, isMac } from './terminal-clipboard';

let current: { modal: Modal; focus(): void; message(msg: ServerMsg): void } | undefined;

export function routeConsoleMessage(msg: ServerMsg) {
  current?.message(msg);
}

/** Available anywhere, without hiring a worker or occupying a desk. */
export function openConsole(net: Net) {
  if (current) {
    current.focus();
    return;
  }
  const { term, fit } = newTerm();
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close standalone terminal', title: 'Close view; keep the shell running' }, '×');
  const fresh = h('button.btn', { type: 'button', title: 'End this shell and start a new one in the current floor folder' }, 'New shell here');
  const status = h('span', {}, 'Connecting…');
  const host = h('div.term-host', {
    title: isMac()
      ? '⌘C copies the selection. ⌘V pastes. Hold ⌥ Option and drag if a program takes the mouse.'
      : 'Ctrl+C copies the selection. Ctrl+V pastes. Hold Shift and drag if a program takes the mouse.',
  });
  const el = h('div.modal.term', { role: 'dialog', 'aria-label': 'Standalone terminal' },
    h('header', {}, h('h2', {}, 'Terminal'), fresh, close),
    h('div', { style: 'padding:8px 16px;font-size:12px;overflow-wrap:anywhere;color:#e6e6f0' }, status), host,
    h('footer', {}, `Shell on the office computer. Use cd, cd .. or an absolute path. ${isMac() ? '⌘C copies a selection; ⌘V pastes.' : 'Ctrl+C copies a selection; Ctrl+V pastes.'} Closing this view keeps it running; disconnecting or restarting the office ends it.`),
  );
  let ready = false;
  let retry = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let size = '';
  const resize = () => {
    try { fit.fit(); } catch { return; }
    const next = `${term.cols}x${term.rows}`;
    if (ready && next !== size) {
      size = next;
      net.send({ t: 'console.resize', cols: term.cols, rows: term.rows });
    }
  };
  const attach = (fresh = false) => {
    ready = false;
    retry = false;
    status.textContent = 'Connecting…';
    resize();
    clearTimeout(timer);
    timer = setTimeout(() => {
      retry = true;
      status.textContent = 'Terminal unavailable. Reconnect, or restart Agent Office after active work finishes. Press Enter to retry.';
    }, 8000);
    net.send({ t: 'console.attach', cols: term.cols, rows: term.rows, fresh });
  };
  const observer = new ResizeObserver(resize);
  const unbindClipboard = bindTerminalClipboard(el, () => term, (message) => toast(message, 'warn'));
  const modal = openModal(el, {
    escCloses: false,
    backdropCloses: false,
    doing: 'in a terminal',
    onClose: () => {
      clearTimeout(timer);
      observer.disconnect();
      unbindClipboard();
      net.send({ t: 'console.detach' });
      current = undefined;
      term.dispose();
    },
  });
  current = {
    modal,
    focus: () => term.focus(),
    message: (msg) => {
      if (msg.t === 'welcome') attach();
      else if (msg.t === 'console.data') term.write(msg.data);
      else if (msg.t === 'console.snapshot') {
        clearTimeout(timer);
        retry = false;
        // The PTY already exists: allow replies to terminal queries while replaying its screen.
        ready = true;
        term.reset();
        term.resize(msg.cols, msg.rows);
        term.write(msg.data, () => {
          if (current?.modal !== modal) return;
          status.textContent = `Started in: ${msg.cwd}`;
          size = '';
          resize();
          term.focus();
        });
      } else if (msg.t === 'console.error' || msg.t === 'console.exited') {
        clearTimeout(timer);
        ready = false;
        retry = true;
        status.textContent = msg.t === 'console.error' ? `${msg.error} — press Enter to retry.` : 'Shell exited. Press Enter to start a new shell in the current floor folder.';
      }
    },
  };
  close.addEventListener('click', () => modal.close());
  fresh.addEventListener('click', () => { attach(true); term.focus(); });
  term.open(host);
  const mac = isMac();
  term.attachCustomKeyEventHandler((e) => (clipboardAction(e, term.hasSelection(), mac) ? false : true));
  term.onData(data => {
    if (retry && data === '\r') attach();
    else if (ready) net.send({ t: 'console.input', data });
  });
  observer.observe(host);
  attach();
  term.focus();
}
