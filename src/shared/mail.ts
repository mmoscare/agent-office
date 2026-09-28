// The Receptionist's mailbox (see server/mailroom.ts): what the browser knows about it, the setup
// form's shape, and the providers the form fills in for you.

export type MailSecurity = 'tls' | 'starttls';

export interface MailServer {
  host: string;
  port: number;
}

/** Her mailbox's settings as an admin sees them in the setup form: everything but the password. */
export interface MailSettingsView {
  /** Her address: the one people email tasks to. */
  address: string;
  /** The name her emails come from. */
  name: string;
  imap: MailServer;
  smtp: MailServer & { security: MailSecurity };
  /** The mailbox's sign-in name (usually her address). */
  user: string;
  /** Whether a password is saved; the password itself never leaves the office's machine. */
  passSet: boolean;
  /** The people allowed to email her work: their mail is acted on. */
  owners: string[];
  /** Mail from anyone else is left unread in the mailbox instead of landing in the tray. */
  onlyOwners: boolean;
  /** The floor mail goes to when it doesn't say which ('' is the first floor). */
  floor: string;
  /** New mail is handed to the Receptionist to deal with right away. */
  autoTriage: boolean;
  /** "HH:MM" for a morning briefing email, or '' for none. */
  briefing: string;
  /** Email the owner when a worker has been waiting on someone for a while and nobody's in the office. */
  awayAlerts: boolean;
  by?: string;
  at?: number;
}

/** What the setup form sends: the view, with a password to replace the saved one (blank keeps it). */
export type MailSettingsInput = Partial<Omit<MailSettingsView, 'passSet' | 'by' | 'at' | 'owners'>> & { pass?: string; owners?: string[] | string };

/** Her mailbox, as everyone in the office sees it (no settings, no password). */
export interface MailState {
  configured: boolean;
  /** Her address, to email her at. */
  address?: string;
  name?: string;
  /** off: not set up. ok: the last check worked. error: it didn't (see error). */
  status: 'off' | 'ok' | 'checking' | 'error';
  error?: string;
  checkedAt?: number;
  /** When the last mail came in. */
  lastMailAt?: number;
  /** Since she was set up: mail taken in, mail left alone (unknown senders, automatic mail), mail sent. */
  received: number;
  ignored: number;
  sent: number;
  /** Why her last email didn't go out, when it didn't. */
  sendError?: string;
  /** An admin asked her to stop reminding everyone to set her up. */
  remindersOff?: boolean;
  autoTriage?: boolean;
  briefing?: string;
  awayAlerts?: boolean;
}

export const MAIL_OFF: MailState = { configured: false, status: 'off', received: 0, ignored: 0, sent: 0 };

/** What the Receptionist is told about her mailbox in her brief and by office-inbox. */
export interface MailBrief {
  configured: boolean;
  address?: string;
  /** What's wrong with it, when something is. */
  problem?: string;
}

export interface MailPreset {
  label: string;
  imap: MailServer;
  smtp: MailServer & { security: MailSecurity };
  /** Where to make the app password, and what to know. */
  help: string;
  link?: string;
}

export const MAIL_PRESETS: Record<'gmail' | 'icloud' | 'fastmail' | 'yahoo' | 'outlook', MailPreset> = {
  gmail: {
    label: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993 },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    help: 'Turn on 2-Step Verification for her Google account, then make an app password and paste its 16 letters here.',
    link: 'https://myaccount.google.com/apppasswords',
  },
  icloud: {
    label: 'iCloud Mail',
    imap: { host: 'imap.mail.me.com', port: 993 },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    help: 'Make an app-specific password under Sign-In and Security at account.apple.com. If the sign-in is refused, try the part of the address before the @ as the login name.',
    link: 'https://account.apple.com',
  },
  fastmail: {
    label: 'Fastmail',
    imap: { host: 'imap.fastmail.com', port: 993 },
    smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
    help: 'Make an app password with IMAP and SMTP access under Settings → Privacy & Security.',
    link: 'https://app.fastmail.com/settings/security/apppasswords',
  },
  yahoo: {
    label: 'Yahoo Mail',
    imap: { host: 'imap.mail.yahoo.com', port: 993 },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'tls' },
    help: 'Generate an app password under Account Security.',
    link: 'https://login.yahoo.com/account/security',
  },
  outlook: {
    label: 'Outlook.com',
    imap: { host: 'outlook.office365.com', port: 993 },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' },
    help: 'Microsoft often refuses app passwords for mail programs now. If the test fails, give her a Gmail, iCloud, Fastmail or Yahoo mailbox instead.',
  },
};

export type MailPresetId = keyof typeof MAIL_PRESETS;

/** The provider a server name belongs to, for the setup form. */
export function presetFor(host: string | undefined): MailPresetId | 'custom' {
  const found = (Object.keys(MAIL_PRESETS) as MailPresetId[]).find((id) => MAIL_PRESETS[id].imap.host === host);
  return found ?? 'custom';
}

/** The provider an address most likely lives at, to pick the form's preset as you type it. */
export function presetForAddress(address: string): MailPresetId | undefined {
  const domain = address.trim().toLowerCase().split('@')[1] ?? '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') return 'gmail';
  if (domain === 'icloud.com' || domain === 'me.com' || domain === 'mac.com') return 'icloud';
  if (domain === 'fastmail.com' || domain === 'fastmail.fm') return 'fastmail';
  if (domain.startsWith('yahoo.') || domain === 'ymail.com') return 'yahoo';
  if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com' || domain === 'msn.com') return 'outlook';
  return undefined;
}

export function isEmailAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@<>()",;:\\[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value);
}

/** Why the Receptionist wants someone to look at her email: it isn't set up, or it isn't working. */
export function mailNeedsYou(s: MailState): 'setup' | 'broken' | undefined {
  if (s.remindersOff && !s.configured) return undefined;
  if (!s.configured) return 'setup';
  if (s.status === 'error') return 'broken';
  return undefined;
}

/** How often she pops up to remind you, while it's still needed, and how long "Remind me tomorrow" lasts. */
export const MAIL_NAG_EVERY_MS = 2 * 60 * 60_000;
export const MAIL_NAG_SNOOZE_MS = 20 * 60 * 60_000;
