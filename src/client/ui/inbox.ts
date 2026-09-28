// The 📥 in-tray window: what came into the office from outside (notes, forwarded emails, files),
// each to read, file on To Do Next, queue for a worker, or put away. Admins open the door that
// lets things in from outside the office (POST /api/inbox with a token).

import type { InboxItem } from '../../shared/inbox';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, timeAgo, toast } from './dom';
import { confirmDialog } from './prompt';
import { providerPicker } from './provider';
import { mailStatusText, openMailSetup } from './mail';

export interface InboxActions {
  /** Ask the Receptionist to go through the tray. */
  triage(): void;
}

let opened = false;
export function openInbox(net: Net, actions: InboxActions) {
  if (opened) return;
  const floor = store.floor;
  const info = store.currentFloor();
  if (!floor || !info) return toast('Take the elevator to a floor first', 'warn');
  opened = true;
  const body = h('div.body.inbox');
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const triage = h('button.btn.primary', { type: 'button', title: 'The Receptionist reads every item and hands it out: the task queue, To Do Next, or the other agents', onclick: () => actions.triage() }, '💁‍♀️ Triage the tray');
  const el = h(
    'div.modal',
    { role: 'dialog', 'aria-label': 'In-tray', style: 'width:min(860px,100%)' },
    h('header', {}, h('h2', {}, '📥 In-tray'), triage, close),
    body,
    h('footer', {}, h('span.grow', {}, 'What came in from outside. File each item on 📒 To Do Next or the 📋 queue, or put it away in the archive.')),
  );

  // A note of your own, straight into the tray.
  const title = h('input', { type: 'text', placeholder: 'Title (optional)', 'aria-label': 'Note title', maxlength: 200 }) as HTMLInputElement;
  const text = h('textarea', { rows: 2, placeholder: 'Jot something down for the tray…', 'aria-label': 'Note' }) as HTMLTextAreaElement;
  const drop = h('button.btn.primary', { type: 'submit' }, 'Drop it in');
  const form = h('form.inbox-add', {}, title, text, drop) as HTMLFormElement;
  form.noValidate = true;
  const submit = () => {
    const t = text.value.trim();
    const heading = title.value.trim();
    if (!t && !heading) {
      text.focus();
      return;
    }
    net.send({ t: 'inbox.note', title: heading || undefined, text: t || heading });
    title.value = '';
    text.value = '';
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  const mailBox = h('div.inbox-mail');
  const folder = h('p.inbox-folder');
  const doorBox = h('div.inbox-door');
  const list = h('div');
  body.append(mailBox, form, folder, doorBox, list);
  const provider = providerPicker(store.project, 'inbox-provider', 'Queue with', 'queue');

  const copyButton = (value: string, label = 'Copy') =>
    h('button.btn.inbox-copy', { type: 'button', title: 'Copy to the clipboard', onclick: () => void navigator.clipboard?.writeText(value).then(() => toast('Copied'), () => toast('Could not copy', 'warn')) }, label);

  // Her email, first: the address to write to, or a push to set it up.
  let checking = false;
  const renderMail = () => {
    const m = store.mail;
    const settings = h('button.btn', { type: 'button', onclick: () => openMailSetup() }, m.configured ? '📧 Email settings' : '📧 Set up email');
    const now = h('button.btn', { type: 'button', disabled: checking, onclick: async () => {
      checking = true;
      renderMail();
      await fetch('/api/mail', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'check' }) }).catch(() => undefined);
      checking = false;
      renderMail();
    } }, checking ? 'Checking…' : 'Check now');
    mailBox.className = `inbox-mail ${!m.configured ? 'off' : m.status === 'error' ? 'err' : 'ok'}`;
    mailBox.replaceChildren(
      m.configured
        ? h('p', {}, h('b', {}, '📧 Email me work at '), h('code', {}, m.address ?? ''), copyButton(m.address ?? ''))
        : h('p', {}, h('b', {}, '📧 I can’t read email yet. '), 'Set up my mailbox and you can email me work from anywhere; I’ll hand it out and write back when it’s done.'),
      h('p.inbox-mail-status', {}, mailStatusText(m)),
      h('div.inbox-mail-actions', {}, settings, ...(m.configured ? [now] : [])),
    );
  };
  const fileUrl = (name: string) => `/api/inbox/file?floor=${encodeURIComponent(floor)}&name=${encodeURIComponent(name)}`;
  const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

  const row = (i: InboxItem): HTMLElement => {
    const icon = i.kind === 'note' ? (i.from?.endsWith(' · email') ? '📧' : '📝') : '📎';
    const meta = [i.from ? `from ${i.from}` : '', timeAgo(i.mtime), i.kind === 'file' ? size(i.size) : '', i.kind === 'note' && i.title !== i.name ? i.name : ''].filter(Boolean).join(' · ');
    const open = h('a.btn', { href: fileUrl(i.name), target: '_blank', rel: 'noopener', title: i.kind === 'note' ? 'Read the whole note' : 'Open the file' }, i.kind === 'note' ? '📖 Read' : '📎 Open');
    const plan = h('button.btn', { type: 'button', title: 'File it on the To Do Next board, and put it away', onclick: () => net.send({ t: 'inbox.plan', name: i.name }) }, '📒 To Do Next');
    const queue = h('button.btn', { type: 'button', title: 'Queue it as a task for a fresh worker, and put it away', onclick: () => {
      if (!provider.valid()) return;
      net.send({ t: 'inbox.queue', name: i.name, provider: provider.value(), model: provider.model(), effort: provider.effort() });
    } }, '📋 Queue');
    const archive = h('button.btn', { type: 'button', title: 'Put it away in the tray’s archive folder', 'aria-label': 'Archive', onclick: () => net.send({ t: 'inbox.archive', name: i.name }) }, '🗄️');
    return h(
      'li',
      {},
      h('div.inbox-main', {}, h('div.inbox-title', { title: i.name }, `${icon} ${i.title}`), i.preview ? h('div.inbox-preview', {}, i.preview) : null, h('div.inbox-meta', {}, meta)),
      h('div.inbox-actions', {}, open, plan, queue, archive),
    );
  };

  // The door: an admin makes a token (shown once) that lets things in from outside the office.
  let freshToken: string | undefined;
  const doorUrl = () => `${location.origin}/api/inbox?floor=${encodeURIComponent(floor)}`;
  const doorRequest = async (method: 'POST' | 'DELETE') => {
    const r = await fetch('/api/inbox/door', { method, credentials: 'same-origin' });
    const data = await r.json().catch(() => null);
    if (!r.ok) return toast(data?.error ?? 'The office said no', 'warn');
    freshToken = method === 'POST' ? data?.token : undefined;
    renderDoor();
  };
  const renderDoor = () => {
    const open = store.inbox.door;
    const url = doorUrl();
    const row: (HTMLElement | null)[] = [
      h('b', {}, open ? '🚪 The door is open' : '🚪 The door is closed'),
      h('span.inbox-door-note', {}, open ? 'Tools outside the office can drop notes and files in with the token.' : 'Open it to let a phone shortcut, a mail rule or a script drop things in from outside.'),
      store.me.admin ? h('button.btn', { type: 'button', onclick: () => void doorRequest('POST') }, open ? 'New token' : 'Open the door') : null,
      store.me.admin && open ? h('button.btn', { type: 'button', onclick: () => confirmDialog('Close the in-tray door?', 'The token stops working, and nothing outside the office can drop things in until an admin opens it again.', 'Close it', () => void doorRequest('DELETE')) }, 'Close the door') : null,
    ];
    const lines: HTMLElement[] = [h('div.inbox-door-row', {}, ...row)];
    if (freshToken) {
      const curl = `curl -X POST "${url}" -H "Authorization: Bearer ${freshToken}" -H "Content-Type: application/json" -d '{"title":"Call the dentist","text":"Tuesday or Thursday afternoon"}'`;
      const ps = `Invoke-RestMethod -Method Post -Uri "${url}" -Headers @{ Authorization = "Bearer ${freshToken}" } -ContentType "application/json" -Body '{"title":"Call the dentist","text":"Tuesday or Thursday afternoon"}'`;
      lines.push(
        h('p.inbox-door-note', {}, 'Your token, shown once. Keep it somewhere safe: ', h('code.inbox-token', {}, freshToken), copyButton(freshToken)),
        h('p.inbox-door-note', {}, 'A note from anywhere, with curl: ', copyButton(curl)),
        h('pre.inbox-code', {}, curl),
        h('p.inbox-door-note', {}, 'The same from PowerShell: ', copyButton(ps)),
        h('pre.inbox-code', {}, ps),
        h('p.inbox-door-note', {}, 'A plain text body becomes a note too (?title= and ?from= name it). A file goes in with its own Content-Type and an X-Filename header. The manual has the recipes.'),
      );
    } else if (open) {
      lines.push(h('p.inbox-door-note', {}, 'POST to ', h('code', {}, url), copyButton(url), ' with the token as the bearer token. Lost the token? An admin can make a new one; the old one stops working.'));
    }
    doorBox.replaceChildren(...lines);
  };

  const render = () => {
    const s = store.inbox;
    folder.replaceChildren(
      '📁 Files dropped in ',
      h('code', {}, s.dir),
      copyButton(s.dir),
      ' land in the tray too: notes as .md or .txt, anything else as a file. Point a synced folder at it and your phone can drop voice memos in.',
    );
    const items = s.items;
    list.replaceChildren(
      h('div.inbox-tools', {}, h('h4', {}, 'In the tray', h('span.count', {}, String(items.length))), provider.element),
      items.length ? h('ul.inbox-list', {}, ...items.map(row)) : h('div.queue-empty', {}, 'Nothing in the tray. Jot a note above, drop a file in the folder, or send one in through the door.'),
    );
    renderDoor();
  };

  const unsubs = [store.on('inbox', render), store.on('me', render), store.on('mail', renderMail), store.on('floor', () => { if (store.floor !== floor) modal.close(); })];
  renderMail();
  const tick = setInterval(render, 30_000);
  const modal = openModal(el, {
    doing: '📥 at the in-tray',
    onClose: () => {
      opened = false;
      unsubs.forEach((u) => u());
      clearInterval(tick);
    },
  });
  close.addEventListener('click', () => modal.close());
  render();
  setTimeout(() => text.focus(), 30);
}
