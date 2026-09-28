// The Receptionist's email (see server/mailroom.ts): the window where an admin gives her a mailbox,
// and her reminders until someone does. She pops up in the corner when you arrive and every couple
// of hours after that ("Remind me tomorrow" puts her off for the day), stands at her kiosk tapping
// her foot, and keeps a chip on the top bar, until her email is set up, or while it's broken.

import { MAIL_NAG_EVERY_MS, MAIL_NAG_SNOOZE_MS, MAIL_PRESETS, mailNeedsYou, presetFor, presetForAddress, type MailPresetId, type MailSettingsView, type MailState } from '../../shared/mail';
import { notifyPermission } from '../notify';
import { store } from '../state';
import { h, openModal, timeAgo, toast } from './dom';
import { confirmDialog } from './prompt';

/** How her mailbox stands, in a line. */
export function mailStatusText(s: MailState): string {
  if (!s.configured) return s.remindersOff ? "📧 Email isn't set up (and she's been asked not to mention it)." : "📧 She can't read email yet: nobody has set up her mailbox.";
  if (s.status === 'error') return `⚠️ ${s.address}: ${s.error ?? "her mailbox isn't working"}`;
  const bits = [`✅ ${s.address}`, s.checkedAt ? `checked ${timeAgo(s.checkedAt)}` : 'checking…'];
  if (s.received) bits.push(`${s.received} received`);
  if (s.sent) bits.push(`${s.sent} sent`);
  const line = bits.join(' · ');
  return s.sendError ? `${line}\n⚠️ She can't send email: ${s.sendError}` : line;
}

async function api(body?: Record<string, unknown>, method: 'GET' | 'POST' | 'DELETE' = body ? 'POST' : 'GET'): Promise<any> {
  const res = await fetch('/api/mail', { method, credentials: 'same-origin', cache: 'no-store', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await res.json().catch(() => null);
  if (!res.ok && !data?.error) throw new Error(`The office said ${res.status}`);
  return { ...data, status: res.status };
}

let opened = false;

/** The Receptionist's email window: set up (admins), or how it stands. */
export function openMailSetup() {
  if (opened) return;
  opened = true;
  const body = h('div.body.mail-setup');
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close' }, '✕');
  const el = h('div.modal', { role: 'dialog', 'aria-label': 'The Receptionist’s email', style: 'width:min(720px,100%)' }, h('header', {}, h('h2', {}, '💁‍♀️ The Receptionist’s email'), close), body);
  const status = h('p.mail-status');
  const paintStatus = () => (status.textContent = mailStatusText(store.mail));
  const off = store.on('mail', paintStatus);
  const modal = openModal(el, { doing: '📧 setting up email', onClose: () => { opened = false; off(); } });
  close.addEventListener('click', () => modal.close());
  paintStatus();
  body.append(status, h('p.note', {}, 'Loading…'));
  void api().then((r) => {
    if (r.error) throw new Error(r.error);
    body.replaceChildren(status, ...(r.admin ? form(r.settings ?? undefined, r.floors ?? [], modal.close) : readOnly()));
  }).catch((e) => body.replaceChildren(status, h('p.err', {}, (e as Error).message)));
}

function readOnly(): HTMLElement[] {
  return [
    h('p', {}, 'Give the Receptionist a mailbox and you can email her work from anywhere: she reads it, hands it to the agents or puts it on 📒 To Do Next, and writes back when it’s done.'),
    h('p.note', {}, store.mail.configured ? `Email her at ${store.mail.address}.` : 'Only an admin can set it up: ask one to open this window.'),
  ];
}

/** The setup form for admins. */
function form(saved: MailSettingsView | undefined, floors: { id: string; name: string }[], done: () => void): HTMLElement[] {
  const input = (attrs: Record<string, string | number | boolean>) => h('input', { spellcheck: 'false', autocomplete: 'off', ...attrs }) as HTMLInputElement;
  const check = (label: string, on: boolean) => {
    const box = input({ type: 'checkbox' });
    box.checked = on;
    return { box, row: h('label.mail-check', {}, box, ` ${label}`) };
  };
  const provider = h('select', { 'aria-label': 'Provider' }, ...Object.entries(MAIL_PRESETS).map(([id, p]) => h('option', { value: id }, p.label)), h('option', { value: 'custom' }, 'Another provider')) as HTMLSelectElement;
  const address = input({ type: 'email', placeholder: 'your.receptionist@gmail.com', 'aria-label': 'Her address' });
  const pass = input({ type: 'password', placeholder: saved?.passSet ? '•••••••• saved · paste to replace' : 'the app password', 'aria-label': 'App password' });
  const help = h('p.mail-help');
  const imapHost = input({ type: 'text', 'aria-label': 'Incoming (IMAP) server' });
  const imapPort = input({ type: 'number', min: 1, max: 65535, 'aria-label': 'IMAP port' });
  const smtpHost = input({ type: 'text', 'aria-label': 'Outgoing (SMTP) server' });
  const smtpPort = input({ type: 'number', min: 1, max: 65535, 'aria-label': 'SMTP port' });
  const smtpSecurity = h('select', { 'aria-label': 'SMTP security' }, h('option', { value: 'tls' }, 'TLS (465)'), h('option', { value: 'starttls' }, 'STARTTLS (587)')) as HTMLSelectElement;
  const user = input({ type: 'text', placeholder: 'the same as her address', 'aria-label': 'Login name' });
  const owners = h('textarea', { rows: 2, placeholder: 'you@example.com, partner@example.com', 'aria-label': 'Who can email her' }) as HTMLTextAreaElement;
  const only = check('Ignore mail from anyone else (it stays unread in her mailbox)', saved?.onlyOwners ?? true);
  const floor = h('select', { 'aria-label': 'Default floor' }, h('option', { value: '' }, floors[0] ? `${floors[0].name} (the first floor)` : 'The first floor'), ...floors.map((f) => h('option', { value: f.id }, f.name))) as HTMLSelectElement;
  const triage = check('Hand new mail to her right away (she wakes up and deals with it)', saved?.autoTriage ?? true);
  const away = check('Email me when a worker needs me and nobody’s in the office (reply to answer it)', saved?.awayAlerts ?? true);
  const brief = check('Send me a morning briefing at', saved ? !!saved.briefing : true);
  const briefAt = input({ type: 'time', 'aria-label': 'Briefing time' });
  briefAt.value = saved?.briefing || '08:00';
  const result = h('p.mail-result', { role: 'status', 'aria-live': 'polite' });

  const fill = (id: MailPresetId | 'custom') => {
    provider.value = id;
    const p = id === 'custom' ? undefined : MAIL_PRESETS[id];
    if (p) {
      imapHost.value = p.imap.host;
      imapPort.value = String(p.imap.port);
      smtpHost.value = p.smtp.host;
      smtpPort.value = String(p.smtp.port);
      smtpSecurity.value = p.smtp.security;
    }
    help.replaceChildren(
      p ? `${p.help} ` : 'Type her provider’s IMAP and SMTP servers below, and an app password (or her password, if the provider has no app passwords).',
      ...(p?.link ? [h('a', { href: p.link, target: '_blank', rel: 'noopener' }, 'Make one ↗')] : []),
    );
    advanced.open = id === 'custom';
  };
  const advanced = h('details.mail-advanced', {},
    h('summary', {}, 'Server settings'),
    h('div.mail-grid', {},
      h('label', {}, 'Incoming (IMAP)'), h('div.mail-pair', {}, imapHost, imapPort),
      h('label', {}, 'Outgoing (SMTP)'), h('div.mail-pair', {}, smtpHost, smtpPort, smtpSecurity),
      h('label', {}, 'Login name'), user,
    ),
  ) as HTMLDetailsElement;

  if (saved) {
    address.value = saved.address;
    user.value = saved.user === saved.address ? '' : saved.user;
    owners.value = saved.owners.join(', ');
    floor.value = saved.floor;
    fill(presetFor(saved.imap.host));
    imapHost.value = saved.imap.host;
    imapPort.value = String(saved.imap.port);
    smtpHost.value = saved.smtp.host;
    smtpPort.value = String(saved.smtp.port);
    smtpSecurity.value = saved.smtp.security;
  } else fill('gmail');
  provider.addEventListener('change', () => fill(provider.value as MailPresetId | 'custom'));
  address.addEventListener('change', () => {
    const guess = presetForAddress(address.value);
    if (guess && provider.value !== guess) fill(guess);
  });
  // The well-known ports say how they're secured; any other port keeps whatever was chosen.
  smtpPort.addEventListener('change', () => {
    if (smtpPort.value === '465') smtpSecurity.value = 'tls';
    else if (smtpPort.value === '587' || smtpPort.value === '25') smtpSecurity.value = 'starttls';
  });

  const settings = () => ({
    address: address.value.trim(),
    pass: pass.value,
    user: user.value.trim(),
    imap: { host: imapHost.value.trim(), port: Number(imapPort.value) },
    smtp: { host: smtpHost.value.trim(), port: Number(smtpPort.value), security: smtpSecurity.value },
    owners: owners.value,
    onlyOwners: only.box.checked,
    floor: floor.value,
    autoTriage: triage.box.checked,
    awayAlerts: away.box.checked,
    briefing: brief.box.checked ? briefAt.value : '',
  });
  const buttons: HTMLButtonElement[] = [];
  const busy = (on: boolean) => buttons.forEach((b) => (b.disabled = on));
  const say = (text: string, level: 'ok' | 'warn' | 'err' = 'ok') => {
    result.textContent = text;
    result.className = `mail-result ${level}`;
  };
  const test = h('button.btn', { type: 'button', onclick: async () => {
    busy(true);
    say('Trying her mailbox…');
    try {
      const r = await api({ action: 'test', settings: settings() });
      if (r.error) say(r.error, 'err');
      else if (r.imap) say(`Reading mail didn't work: ${r.imap}`, 'err');
      else if (r.smtp) say(`Reading works, but sending didn't: ${r.smtp}`, 'warn');
      else say('✅ Both work: she can read and send mail.');
    } catch (e) {
      say((e as Error).message, 'err');
    }
    busy(false);
  } }, '🔌 Test') as HTMLButtonElement;
  const save = h('button.btn.primary', { type: 'button', onclick: async () => {
    busy(true);
    say('Signing her in…');
    try {
      const r = await api({ action: 'save', settings: settings() });
      if (!r.ok) say(r.error ?? 'Not saved', 'err');
      else {
        say(r.warning ? `Saved. ${r.warning}` : saved ? '✅ Saved.' : `✅ She's set up. A welcome email with the how-to is on its way to ${settings().owners.split(/[\s,;]+/)[0]}.`, r.warning ? 'warn' : 'ok');
        pass.value = '';
        toast(r.warning ? '📧 Her email is saved, with a warning' : '💁‍♀️ The Receptionist can read her email now');
      }
    } catch (e) {
      say((e as Error).message, 'err');
    }
    busy(false);
  } }, saved ? 'Save' : '💁‍♀️ Save and set her up') as HTMLButtonElement;
  buttons.push(test, save);
  const actions: HTMLElement[] = [test, save];
  if (saved) {
    const remove = h('button.btn.danger', { type: 'button', onclick: () => confirmDialog('Take her mailbox away?', 'She stops reading and sending email, and the office forgets the password. Mail already in the tray stays there.', 'Take it away', async () => {
      await api(undefined, 'DELETE').catch(() => undefined);
      done();
      toast('📧 The Receptionist’s mailbox is gone');
    }) }, 'Remove') as HTMLButtonElement;
    buttons.push(remove);
    actions.push(remove);
  }
  let quiet: HTMLButtonElement | null = null;
  if (!saved) {
    const button = h('button.btn.link', { type: 'button' }, store.mail.remindersOff ? 'Start reminding everyone again' : 'Stop reminding everyone to set this up') as HTMLButtonElement;
    button.addEventListener('click', async () => {
      const off = !store.mail.remindersOff;
      await api({ action: 'reminders', off }).catch(() => undefined);
      button.textContent = off ? 'Start reminding everyone again' : 'Stop reminding everyone to set this up';
    });
    quiet = button;
  }
  return [
    h('p.mail-tip', {}, '💡 Give her a mailbox of her own (a new Gmail address works well), then email that address from your own. She only acts on mail from the people you list, and only ever writes back to them.'),
    h('h4', {}, 'Her mailbox'),
    h('div.mail-grid', {}, h('label', {}, 'Provider'), provider, h('label', {}, 'Her address'), address, h('label', {}, 'App password'), pass),
    help,
    advanced,
    h('h4', {}, 'Who can email her'),
    owners,
    only.row,
    h('h4', {}, 'What she does'),
    h('div.mail-grid', {}, h('label', {}, 'Mail that doesn’t say which floor'), floor),
    triage.row,
    away.row,
    h('label.mail-check', {}, brief.box, ' Send me a morning briefing at ', briefAt),
    h('p.note', {}, 'Tips for your emails: start the subject with todo: or queue: to skip her and file it straight away; pick a floor with [floor] at the start of the subject, or with a +floor after her name in the address. Replies to her “done” and “needs you” emails go straight to that worker.'),
    h('div.mail-actions', {}, ...actions),
    result,
    ...(quiet ? [quiet] : []),
  ];
}

const SNOOZE_KEY = 'agent-office.mailNagSnoozedUntil';
const DESKTOP_KEY = 'agent-office.mailNagDesktopAt';
const stored = (key: string) => {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
};
const store_ = (key: string, value: number) => {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // private window: she'll ask again next time
  }
};

/**
 * Her reminders in the corner of the screen: a card when you arrive (after a few seconds) and again
 * every couple of hours while her email still isn't set up (or isn't working). "Remind me tomorrow"
 * puts her off for most of a day. With the office in a background tab, she sends a desktop
 * notification instead, at most once a day, if notifications are on.
 */
export function mountMailNag(opts: { desktop: () => boolean }) {
  let card: HTMLElement | null = null;
  let lastShown = 0;
  const hide = () => {
    card?.remove();
    card = null;
  };
  const words = (why: 'setup' | 'broken') => why === 'setup'
    ? 'I can’t read your email yet! Set up my mailbox and you can email me work from anywhere. I’ll hand it out to the agents and write back when it’s done.'
    : `I couldn’t get into my mailbox: ${store.mail.error ?? 'something’s wrong with it'}. Can someone take a look?`;
  const show = (why: 'setup' | 'broken') => {
    lastShown = Date.now();
    if (document.hidden) {
      if (opts.desktop() && notifyPermission() === 'granted' && Date.now() - stored(DESKTOP_KEY) > MAIL_NAG_SNOOZE_MS) {
        store_(DESKTOP_KEY, Date.now());
        try {
          const n = new Notification('💁‍♀️ The Receptionist', { body: words(why), icon: '/favicon.svg', tag: 'mail-nag' });
          n.onclick = () => {
            window.focus();
            n.close();
            openMailSetup();
          };
        } catch {
          // no notifications here
        }
      }
      return;
    }
    hide();
    const text = h('p', {}, words(why));
    card = h('div.mail-nag', { role: 'status' },
      h('div.mail-nag-who', {}, h('span.mail-nag-face', { 'aria-hidden': 'true' }, '💁‍♀️'), h('b', {}, 'The Receptionist'), h('button.mail-nag-x', { type: 'button', 'aria-label': 'Not now', title: 'Not now', onclick: hide }, '✕')),
      text,
      h('div.mail-nag-actions', {},
        h('button.btn.primary', { type: 'button', onclick: () => { hide(); openMailSetup(); } }, why === 'setup' ? '📧 Set up my email' : '📧 Email settings'),
        h('button.btn', { type: 'button', onclick: () => { store_(SNOOZE_KEY, Date.now() + MAIL_NAG_SNOOZE_MS); hide(); toast('💁‍♀️ Okay, I’ll ask again tomorrow'); } }, 'Remind me tomorrow'),
      ),
    );
    document.getElementById('hud')?.append(card) ?? document.body.append(card);
  };
  const check = () => {
    const why = mailNeedsYou(store.mail);
    if (!why) return hide();
    if (card) {
      const p = card.querySelector('p');
      if (p) p.textContent = words(why);
      return;
    }
    if (!store.floor || Date.now() < stored(SNOOZE_KEY) || Date.now() - lastShown < MAIL_NAG_EVERY_MS) return;
    show(why);
  };
  store.on('mail', () => (mailNeedsYou(store.mail) ? undefined : hide()));
  setTimeout(check, 8_000);
  setInterval(check, 60_000);
  return { check, hide };
}
