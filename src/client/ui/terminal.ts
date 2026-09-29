import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { Net } from '../net';
import { store } from '../state';
import { TERM_THEME } from '../world/laptop';
import { h, openModal, STATUS_LABEL, timeAgo, toast, type Modal } from './dom';
import { usageLabel, usageTitle } from './usage';
import { openModelUsage } from './model-usage';
import { testChangesButton } from './test-changes';
import { terminalBranches } from './terminal-branches';
import { terminalBrief } from './terminal-brief';
import { clipboardAction, isMac } from './terminal-clipboard';
import { copyText } from './copy-code';
import type { ServerMsg, WorkerInfo } from '../../shared/protocol';
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

/** How long someone shows as typing after the last word from their keyboard (they send one about every second). */
const TYPING_SHOWS_MS = 2500;

/** "Sam is typing…", "Sam and Ada are typing…", "Sam and 2 others are typing…". */
function typingLine(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names[0]} and ${names.length - 1} others are typing…`;
}

/** Up to two letters for someone's face: "Sam" -> "S", "Ada Lovelace" -> "AL". */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = (w: string | undefined) => (w ? Array.from(w)[0].toUpperCase() : '');
  return first(words[0]) + (words.length > 1 ? first(words[words.length - 1]) : '') || '?';
}

/** On a Mac ⌘C/⌘V are the clipboard and Ctrl+C/V belong to the program. */
const mac = isMac();

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

  const branches = terminalBranches();
  const brief = terminalBrief(() => (onSide ? side?.term : term)?.focus());
  const dot = h('span.dot', { style: `background:${info.color}` });
  const title = h('h2', {}, info.kind === 'agent' ? `${providerLabel(info.provider, store.project)} · ${info.name}` : info.name);
  const pill = h('span.pill', {}, '');
  const cost = h('span.cost', {});
  const usageBtn = h('button.btn', { type: 'button', title: 'Saved usage and cost across every floor' }, 'Usage & cost');
  usageBtn.addEventListener('click', openModelUsage);
  const viewers = h('div.viewers', {});
  const modelsBtn = h('button.btn', {
    type: 'button',
    title: 'OpenCode models: Ctrl+X then M (use /models if custom bindings override it)',
    'aria-label': 'OpenCode models',
  }, '🧠 Models');
  const typed = h('span.typed', {});
  const changesBtn = h('button.btn', { type: 'button', title: 'What this worker changed: files, diff, commit, open a PR (C at the desk)' }, '🌿 Changes');
  const closeBtn = h('button.btn.close', { title: 'Close terminal view · Esc stays inside the terminal', 'aria-label': 'Close terminal' }, '✕');
  const host = h('div.term-host');
  // An agent's window has a second tab: a plain shell in the same checkout, to look around beside
  // the agent (which branch, git status, run the tests) without typing into its session.
  const sideHost = h('div.term-host.hidden');
  const agentTab = h('button.gh-tab.on', { type: 'button', role: 'tab', 'aria-selected': 'true', title: "The worker's own session" }, `🤖 ${info.name}`);
  const shellTab = h('button.gh-tab', { type: 'button', role: 'tab', 'aria-selected': 'false', title: "A shell in this worker's checkout, beside it: check the branch, git status, run the tests (Ctrl+Shift+` switches tabs)" }, '🐚 Shell');
  const tabs = info.kind === 'agent' ? h('nav.gh-tabs.term-tabs', { role: 'tablist' }, agentTab, shellTab) : null;
  const test = info.kind === 'agent' ? testChangesButton(net, workerId, () => term.focus()) : null;
  const el = h('div.modal.term', { role: 'dialog', 'aria-label': `${info.name} terminal` }, h('header', {}, dot, title, pill, cost, viewers, typed, modelsBtn, info.kind === 'agent' ? usageBtn : null, test?.element ?? null, onChanges ? changesBtn : null, closeBtn), brief.element, branches.element, tabs, host, sideHost);

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

  /** Who else is typing here right now (PeerInfo ids), until when. */
  const typing = new Map<string, number>();
  /** The viewers' faces, and who's typing (or who typed last, once nobody is). */
  const renderPresence = (w: WorkerInfo) => {
    const now = Date.now();
    for (const [id, until] of typing) if (until <= now || !w.viewerIds.includes(id)) typing.delete(id);
    const people = viewersOf(w);
    viewers.replaceChildren(
      ...people.map((v) =>
        h(
          'span.avatar',
          { class: v.typing ? 'typing' : '', style: `background:${v.color}`, title: `${v.name}${v.you ? ' (you)' : ''}${v.typing ? ' · typing' : ''}` },
          initials(v.name),
        ),
      ),
    );
    viewers.title = people.length ? `In this terminal: ${people.map((v) => (v.you ? `${v.name} (you)` : v.name)).join(', ')}` : '';
    const typists = people.filter((v) => v.typing && !v.you).map((v) => v.name);
    typed.classList.toggle('now', typists.length > 0);
    if (typists.length) {
      typed.textContent = `✍️ ${typingLine(typists)}`;
      typed.title = '';
    } else {
      typed.textContent = w.lastInput ? `⌨️ ${w.lastInput.by}` : '';
      typed.title = w.lastInput ? `${w.lastInput.by} typed here last, ${timeAgo(w.lastInput.at)}` : '';
    }
  };
  /** Everyone in the terminal, one face per person however many windows they have it open in, you first. */
  const viewersOf = (w: WorkerInfo) => {
    const byName = new Map<string, { name: string; color: string; you: boolean; typing: boolean }>();
    for (const id of w.viewerIds) {
      const p = store.peers.get(id);
      if (!p) continue;
      const v = byName.get(p.name) ?? { name: p.name, color: p.color, you: false, typing: false };
      v.you ||= id === store.you;
      v.typing ||= typing.has(id);
      byName.set(p.name, v);
    }
    return [...byName.values()].sort((a, b) => Number(b.you) - Number(a.you));
  };
  // Typing stops showing a couple of seconds after the last keystroke.
  const typingTimer = setInterval(() => {
    const w = store.workers.get(workerId);
    if (w && typing.size) renderPresence(w);
  }, 500);
  /** Tells the others here you're typing, about once a second while you are. */
  let typingSentAt = 0;
  const sayTyping = () => {
    const now = Date.now();
    if (now - typingSentAt < 1000) return;
    typingSentAt = now;
    net.send({ t: 'term.typing', workerId });
  };

  const refresh = () => {
    test?.refresh();
    const w = store.workers.get(workerId);
    if (!w) {
      modal.close();
      return;
    }
    title.textContent = [w.kind === 'agent' ? providerLabel(w.provider, store.project) : null, w.name, w.title].filter(Boolean).join(' · ');
    brief.refresh(w);
    branches.refresh(w, store.project?.branch);
    pill.className = `pill ${w.status}`;
    pill.textContent = STATUS_LABEL[w.status] ?? w.status;
    const workerProvider = w.kind === 'agent' ? resolvedProvider(w.provider, store.project) : undefined;
    const usageState = w.kind === 'agent' ? providerUsageState(w.provider, store.project, w.usage) : undefined;
    cost.textContent = w.kind !== 'agent' ? '' : usageState === 'tracked' && w.usage ? usageLabel(w.usage, workerProvider) : workerProvider === 'opencode' && usageState === 'waiting' ? 'waiting for metrics' : workerProvider === 'codex' && usageState === 'waiting' ? 'waiting for first report' : usageState === 'untracked' ? 'usage untracked' : '';
    cost.title = w.kind === 'agent' && w.usage ? usageTitle(w.usage, workerProvider) : w.kind === 'agent' ? providerUsageNote(workerProvider!) : '';
    renderPresence(w);
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
  let side: { term: Terminal; fit: FitAddon; ready: boolean; failed?: boolean } | null = null;
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
    side.failed = false;
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
      made.term.attachCustomKeyEventHandler(keysFor(made.term));
      made.term.onData((data) => {
        // It couldn't start (the checkout was missing, the shell wouldn't run): a key tries again.
        if (side?.failed) return attachSide();
        if (!side?.ready) return;
        // The shell exited: a key starts a new one.
        if (!store.workers.get(workerId)?.side) return attachSide();
        sideSize(true);
        net.send({ t: 'side.input', workerId, data });
      });
      sideRo.observe(sideHost);
      attachSide();
    } else if (shell && side?.failed) attachSide();
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
  /**
   * Ctrl+Shift+` flips between the agent and the shell. Ctrl+C copies what's selected and Ctrl+V
   * pastes (see terminal-clipboard.ts). Every other key (Esc and Ctrl+] included) goes to the
   * terminal; the window is left through its ✕.
   */
  const keysFor = (t: Terminal) => (e: KeyboardEvent) => {
    const clip = clipboardAction(e, t.hasSelection(), mac);
    if (clip === 'copy') {
      e.preventDefault();
      const text = t.getSelection();
      // The selection stays until the copy lands, so the right-click fallback still has it.
      if (text)
        void copyText(text).then((ok) => {
          t.focus();
          if (ok) t.clearSelection();
          else toast("Couldn't copy here: right-click the selection and choose Copy", 'warn');
        });
      return false;
    }
    // Leave it to the browser, whose paste lands in xterm's own paste handling (bracketed, as typed).
    if (clip === 'paste') return false;
    if (e.type !== 'keydown' || !e.ctrlKey) return true;
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
      if (side) side.failed = true;
      side?.term.write(`\r\n\x1b[31m${msg.error} — press a key to try again\x1b[0m\r\n`);
      toast(msg.error, 'error');
    } else if (msg.t === 'term.data' && msg.workerId === workerId) term.write(msg.data);
    // Reconnected: the server forgot this window's place at the side shell, so take it back.
    else if (msg.t === 'welcome' && side) attachSide();
    else if (msg.t === 'term.typing' && msg.workerId === workerId) {
      typing.set(msg.id, Date.now() + TYPING_SHOWS_MS);
      const w = store.workers.get(workerId);
      if (w) renderPresence(w);
    } else if (msg.t === 'term.snapshot' && msg.workerId === workerId) {
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
  // A viewer's name or color can change while they're here.
  const unsubPeers = store.on('peers', () => {
    const w = store.workers.get(workerId);
    if (w) renderPresence(w);
  });
  const ro = new ResizeObserver(() => sendSize());
  const sideRo = new ResizeObserver(() => sideSize());

  const modal = openModal(el, {
    escCloses: false,
    backdropCloses: true,
    doing: `💻 in ${info.name}'s terminal`,
    onClose: () => {
      listeners.delete(onMsg);
      unsub();
      unsubPeers();
      clearInterval(typingTimer);
      ro.disconnect();
      branches.dispose();
      brief.dispose();
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

  el.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button, input, select, a')) return;
    (onSide ? side?.term : term)?.focus();
  });
  term.open(host);
  term.attachCustomKeyEventHandler(keysFor(term));
  term.onData((data) => {
    sendSize(true);
    net.send({ t: 'term.input', workerId, data });
  });
  // Only your own keys and pastes count as typing, not the terminal answering the program's queries.
  term.onKey(sayTyping);
  term.textarea?.addEventListener('input', sayTyping);
  term.textarea?.addEventListener('paste', sayTyping);
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

export function newTerm(): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 14,
    lineHeight: 1.1,
    theme: TERM_THEME,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    // A program that takes the mouse (OpenCode, vim) would get every drag: Shift-drag (⌥-drag on a
    // Mac) selects text anyway, to copy.
    macOptionClickForcesSelection: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  return { term, fit };
}
