import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { Net } from '../net';
import { store } from '../state';
import { TERM_THEME } from '../world/laptop';
import { h, openModal, STATUS_LABEL, timeAgo, toast, type Modal } from './dom';
import { usageLabel, usageTitle } from './usage';
import type { ServerMsg } from '../../shared/protocol';
import { isAsleep } from '../../shared/status';
import { findLine } from '../../shared/search';
import { providerLabel, providerUsageNote, providerUsageState, resolvedProvider } from './provider';

/** A line to scroll to once the terminal has loaded: a search hit (see search.ts). */
export interface TerminalFind {
  /** What was searched for, as a searchKey. */
  needle: string;
  /** How many rows from the bottom of the worker's terminal the line was. */
  fromEnd: number;
}

let current: { workerId: string; modal: Modal; find(f: TerminalFind): void } | null = null;
const listeners = new Set<(msg: ServerMsg) => void>();

/** Main feeds every server message through here so open terminals can pick theirs. */
export function routeTerminalMessage(msg: ServerMsg) {
  listeners.forEach((fn) => fn(msg));
}

export function openTerminalFor(): string | null {
  return current?.workerId ?? null;
}

export function openTerminal(net: Net, workerId: string, onChanges?: () => void, find?: TerminalFind) {
  if (current?.workerId === workerId) {
    if (find) current.find(find);
    return;
  }
  current?.modal.close();
  const info = store.workers.get(workerId);
  if (!info) return;

  const dot = h('span.dot', { style: `background:${info.color}` });
  const title = h('h2', {}, info.kind === 'agent' ? `${providerLabel(info.provider, store.project)} · ${info.name}` : info.name);
  const pill = h('span.pill', {}, '');
  const cost = h('span.cost', {});
  const viewers = h('div.viewers', {});
  const modelsBtn = h('button.btn', {
    type: 'button',
    title: 'OpenCode models: Ctrl+X then M (use /models if custom bindings override it)',
    'aria-label': 'OpenCode models',
  }, '🧠 Models');
  const typed = h('span.typed', {});
  const changesBtn = h('button.btn', { type: 'button', title: 'What this worker changed: files, diff, commit, open a PR (C at the desk)' }, '🌿 Changes');
  const closeBtn = h('button.btn.close', { title: 'Leave terminal (Esc) · Ctrl+[ sends Esc to the terminal', 'aria-label': 'Close' }, '✕');
  const host = h('div.term-host');
  // An agent's window has a second tab: a plain shell in the same checkout, to look around beside
  // the agent (which branch, git status, run the tests) without typing into its session.
  const sideHost = h('div.term-host.hidden');
  const agentTab = h('button.gh-tab.on', { type: 'button', role: 'tab', 'aria-selected': 'true', title: "The worker's own session" }, `🤖 ${info.name}`);
  const shellTab = h('button.gh-tab', { type: 'button', role: 'tab', 'aria-selected': 'false', title: "A shell in this worker's checkout, beside it: check the branch, git status, run the tests (Ctrl+Shift+` switches tabs)" }, '🐚 Shell');
  const tabs = info.kind === 'agent' ? h('nav.gh-tabs.term-tabs', { role: 'tablist' }, agentTab, shellTab) : null;
  const el = h('div.modal.term', { role: 'dialog', 'aria-label': `${info.name} terminal` }, h('header', {}, dot, title, pill, cost, viewers, typed, modelsBtn, onChanges ? changesBtn : null, closeBtn), tabs, host, sideHost);

  const { term, fit } = newTerm();

  let ready = false;
  let lastSentSize = '';
  /**
   * Sizes the shared PTY to this window. Typing always claims it (latest typist wins); merely
   * opening or resizing the window only does when nobody else is watching, so a phone that is just
   * looking doesn't reflow the terminal under whoever is working.
   */
  const sendSize = (typing = false) => {
    if (!ready) return;
    if (!typing && (store.workers.get(workerId)?.viewers.length ?? 0) > 1) {
      const w = store.workers.get(workerId);
      if (w && (w.cols !== term.cols || w.rows !== term.rows)) term.resize(w.cols, w.rows);
      return;
    }
    try {
      fit.fit();
    } catch {
      return;
    }
    const key = `${term.cols}x${term.rows}`;
    const w = store.workers.get(workerId);
    if (w && (w.cols !== term.cols || w.rows !== term.rows) && key !== lastSentSize) {
      lastSentSize = key;
      net.send({ t: 'term.resize', workerId, cols: term.cols, rows: term.rows });
    }
  };

  const refresh = () => {
    const w = store.workers.get(workerId);
    if (!w) {
      modal.close();
      return;
    }
    title.textContent = [w.kind === 'agent' ? providerLabel(w.provider, store.project) : null, w.name, w.title, w.worktree && `🌿 ${w.worktree.branch}`].filter(Boolean).join(' · ');
    pill.className = `pill ${w.status}`;
    pill.textContent = STATUS_LABEL[w.status] ?? w.status;
    const workerProvider = w.kind === 'agent' ? resolvedProvider(w.provider, store.project) : undefined;
    const usageState = w.kind === 'agent' ? providerUsageState(w.provider, store.project, w.usage) : undefined;
    cost.textContent = w.kind !== 'agent' ? '' : usageState === 'tracked' && w.usage ? usageLabel(w.usage, workerProvider) : workerProvider === 'opencode' && usageState === 'waiting' ? 'waiting for metrics' : workerProvider === 'codex' && usageState === 'waiting' ? 'waiting for first report' : usageState === 'untracked' ? 'usage untracked' : '';
    cost.title = w.kind === 'agent' && w.usage ? usageTitle(w.usage, workerProvider) : w.kind === 'agent' ? providerUsageNote(workerProvider!) : '';
    viewers.textContent = w.viewers.length ? `👀 ${w.viewers.join(', ')}` : '';
    typed.textContent = w.lastInput ? `⌨️ ${w.lastInput.by}` : '';
    typed.title = w.lastInput ? `${w.lastInput.by} typed here last, ${timeAgo(w.lastInput.at)}` : '';
    const openCode = w.kind === 'agent' && resolvedProvider(w.provider, store.project) === 'opencode';
    modelsBtn.classList.toggle('hidden', !openCode);
    modelsBtn.toggleAttribute('disabled', !openCode || !ready || isAsleep(w.status));
    // Someone else resized the shared PTY (the latest typist wins): follow it so this view renders
    // correctly. Typing here fits the terminal back to this window and reclaims the size.
    const ptySize = `${w.cols}x${w.rows}`;
    if (ready && ptySize !== `${term.cols}x${term.rows}` && ptySize !== lastSentSize) {
      term.resize(w.cols, w.rows);
      lastSentSize = '';
    }
    shellTab.classList.toggle('live', !!w.side);
    sideSize();
  };

  /** Scrolls a search hit into view and lights it up for a few seconds. */
  const jumpTo = (f: TerminalFind) => {
    const buf = term.buffer.active;
    const row = findLine(buf, f.needle, f.fromEnd);
    if (row === undefined) return toast('That line has scrolled out of the terminal since', 'warn');
    let end = row;
    while (buf.getLine(end + 1)?.isWrapped) end++;
    // A marker follows the line when the terminal reflows, which it does as the window settles.
    const marker = term.registerMarker(row - (buf.baseY + buf.cursorY));
    if (!marker) return;
    const mark = term.registerDecoration({ marker, width: term.cols, height: end - row + 1, backgroundColor: TERM_THEME.yellow, foregroundColor: TERM_THEME.background });
    const scroll = () => {
      if (marker.line < 0) return;
      // xterm scrolls from where its scrollbar is, which lags behind a resize; from the top is exact.
      term.scrollLines(-term.buffer.active.length);
      term.scrollLines(Math.max(0, marker.line - Math.floor(term.rows / 3)));
    };
    scroll();
    // The window settles its size just after it opens; stay on the line through that.
    const follow = term.onResize(() => setTimeout(scroll, 50));
    setTimeout(() => follow.dispose(), 1500);
    setTimeout(() => {
      mark?.dispose();
      marker.dispose();
    }, 8000);
  };
  let pendingFind = find;

  /** The Shell tab's terminal, made the first time the tab opens. */
  let side: { term: Terminal; fit: FitAddon; ready: boolean } | null = null;
  let onSide = false;
  /**
   * Sizes the side shell. It's shared too, so typing claims it for this window and just looking
   * follows whoever typed last.
   */
  const sideSize = (typing = false) => {
    if (!side?.ready) return;
    const shell = store.workers.get(workerId)?.side;
    if (!shell) return;
    if (!typing) {
      if (shell.cols !== side.term.cols || shell.rows !== side.term.rows) side.term.resize(shell.cols, shell.rows);
      return;
    }
    try {
      side.fit.fit();
    } catch {
      return;
    }
    if (shell.cols !== side.term.cols || shell.rows !== side.term.rows) net.send({ t: 'side.resize', workerId, cols: side.term.cols, rows: side.term.rows });
  };
  /** Starts (or rejoins) the side shell, sized to this window. */
  const attachSide = () => {
    if (!side) return;
    side.ready = false;
    try {
      side.fit.fit();
    } catch {
      // not laid out yet: the server falls back to the worker's size
    }
    net.send({ t: 'side.attach', workerId, cols: side.term.cols, rows: side.term.rows });
  };
  const showTab = (shell: boolean) => {
    onSide = shell;
    agentTab.classList.toggle('on', !shell);
    shellTab.classList.toggle('on', shell);
    agentTab.setAttribute('aria-selected', String(!shell));
    shellTab.setAttribute('aria-selected', String(shell));
    host.classList.toggle('hidden', shell);
    sideHost.classList.toggle('hidden', !shell);
    if (shell && !side) {
      const made = newTerm();
      side = { ...made, ready: false };
      made.term.open(sideHost);
      made.term.attachCustomKeyEventHandler(keys);
      made.term.onData((data) => {
        if (!side?.ready) return;
        // The shell exited: a key starts a new one.
        if (!store.workers.get(workerId)?.side) return attachSide();
        sideSize(true);
        net.send({ t: 'side.input', workerId, data });
      });
      sideRo.observe(sideHost);
      attachSide();
    }
    if (shell) {
      sideSize();
      side?.term.focus();
    } else {
      sendSize();
      term.focus();
    }
  };
  agentTab.addEventListener('click', () => showTab(false));
  shellTab.addEventListener('click', () => showTab(true));
  /** Ctrl+] leaves the window; Ctrl+Shift+` flips between the agent and the shell. */
  const keys = (e: KeyboardEvent) => {
    if (e.type !== 'keydown' || !e.ctrlKey) return true;
    if (e.key === ']') {
      modal.close();
      return false;
    }
    if (tabs && e.shiftKey && (e.key === '~' || e.key === '`' || e.code === 'Backquote')) {
      showTab(!onSide);
      return false;
    }
    return true;
  };

  const onMsg = (msg: ServerMsg) => {
    if (msg.t === 'side.data' && msg.workerId === workerId) side?.term.write(msg.data);
    else if (msg.t === 'side.snapshot' && msg.workerId === workerId && side) {
      const s = side;
      s.term.reset();
      s.term.resize(msg.cols, msg.rows);
      s.term.write(msg.data, () => {
        s.ready = true;
        s.term.scrollToBottom();
        sideSize();
      });
    } else if (msg.t === 'side.error' && msg.workerId === workerId) {
      side?.term.write(`\r\n\x1b[31m${msg.error}\x1b[0m\r\n`);
      toast(msg.error, 'error');
    } else if (msg.t === 'term.data' && msg.workerId === workerId) term.write(msg.data);
    else if (msg.t === 'term.snapshot' && msg.workerId === workerId) {
      term.reset();
      term.resize(msg.cols, msg.rows);
      term.write(msg.data, () => {
        ready = true;
        sendSize();
        term.scrollToBottom();
        refresh();
        if (pendingFind) jumpTo(pendingFind);
        pendingFind = undefined;
      });
    }
  };
  listeners.add(onMsg);
  const unsub = store.on('workers', refresh);
  const ro = new ResizeObserver(() => sendSize());
  const sideRo = new ResizeObserver(() => sideSize());

  const modal = openModal(el, {
    backdropCloses: true,
    onClose: () => {
      listeners.delete(onMsg);
      unsub();
      ro.disconnect();
      sideRo.disconnect();
      net.send({ t: 'worker.detach', workerId });
      term.dispose();
      if (side) {
        net.send({ t: 'side.detach', workerId });
        side.term.dispose();
      }
      if (current?.modal === modal) current = null;
    },
  });
  current = {
    workerId,
    modal,
    find: (f) => {
      if (onSide) showTab(false);
      if (ready) jumpTo(f);
      else pendingFind = f;
    },
  };
  closeBtn.addEventListener('click', () => modal.close());
  changesBtn.addEventListener('click', () => {
    onChanges?.();
    modal.close();
  });

  term.open(host);
  term.attachCustomKeyEventHandler(keys);
  term.onData((data) => {
    sendSize(true);
    net.send({ t: 'term.input', workerId, data });
  });
  modelsBtn.addEventListener('click', () => {
    if (modelsBtn.hasAttribute('disabled')) return;
    if (onSide) showTab(false);
    sendSize(true);
    // OpenCode's native model picker is Ctrl+X, then M. Injecting the
    // control sequence preserves any draft already in the TUI input box.
    term.input('\x18m');
    term.focus();
  });

  ro.observe(host);
  refresh();
  net.send({ t: 'worker.attach', workerId });
  setTimeout(() => term.focus(), 50);
}

function newTerm(): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 14,
    lineHeight: 1.1,
    theme: TERM_THEME,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  return { term, fit };
}
