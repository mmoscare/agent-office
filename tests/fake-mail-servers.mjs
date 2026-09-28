// Fake IMAP and SMTP servers for the Receptionist's mail tests: real TLS (a self-signed certificate
// for localhost), just enough of each protocol, and a record of what happened. Plain Node, so the
// unit tests (tsx) and the browser tests (node) can both use them.

import net from 'node:net';
import tls from 'node:tls';

/** A certificate for localhost, and its PEM to trust it by. */
export async function localCert() {
  const selfsigned = await import('selfsigned');
  const gen = selfsigned.generate ?? selfsigned.default?.generate;
  const pems = await gen([{ name: 'commonName', value: 'localhost' }], { days: 2, keySize: 2048 });
  return { key: pems.private, cert: pems.cert };
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/**
 * An IMAP mailbox on localhost. `messages` are { uid, raw (Buffer or string), seen }. `log` gets
 * every command (with the password as the server saw it, for the tests to check quoting).
 */
export async function fakeImap({ cert, user = 'receptionist@example.com', pass = 'app-password', messages = [], uidValidity = 7, refuseLogin = false } = {}) {
  const box = { messages: messages.map((m) => ({ seen: false, ...m, raw: Buffer.isBuffer(m.raw) ? m.raw : Buffer.from(m.raw) })), uidValidity, log: [], logins: 0, sockets: new Set() };
  const server = tls.createServer({ key: cert.key, cert: cert.cert }, (socket) => {
    box.sockets.add(socket);
    socket.on('close', () => box.sockets.delete(socket));
    socket.on('error', () => {});
    let buf = '';
    let authed = false;
    let pendingAuth = null;
    const send = (s) => socket.write(s);
    send('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] Fake IMAP ready\r\n');
    const uidSet = (spec) => {
      const all = box.messages.map((m) => m.uid);
      const max = all.length ? Math.max(...all) : 0;
      const out = new Set();
      for (const part of spec.split(',')) {
        const [a, b] = part.split(':');
        const lo = a === '*' ? max : Number(a);
        const hi = b === undefined ? lo : b === '*' ? max : Number(b);
        for (const u of all) if (u >= Math.min(lo, hi) && u <= Math.max(lo, hi)) out.add(u);
      }
      return box.messages.filter((m) => out.has(m.uid));
    };
    const handle = (line) => {
      if (pendingAuth) {
        const tag = pendingAuth;
        pendingAuth = null;
        const [, u, p] = Buffer.from(line.trim(), 'base64').toString('utf8').split('\0');
        box.log.push(`AUTH ${u} ${p}`);
        if (!refuseLogin && u === user && p === pass) {
          authed = true;
          box.logins++;
          return send(`${tag} OK Logged in\r\n`);
        }
        return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
      }
      const m = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
      if (!m) return send('* BAD what?\r\n');
      const [, tag, cmdRaw, rest = ''] = m;
      const cmd = cmdRaw.toUpperCase();
      box.log.push(`${cmd} ${rest}`);
      if (cmd === 'LOGIN') {
        const args = [...rest.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((x) => (x[1] !== undefined ? x[1].replace(/\\(.)/g, '$1') : x[2]));
        if (!refuseLogin && args[0] === user && args[1] === pass) {
          authed = true;
          box.logins++;
          return send(`${tag} OK [CAPABILITY IMAP4rev1] Logged in\r\n`);
        }
        return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
      }
      if (cmd === 'AUTHENTICATE') {
        pendingAuth = tag;
        return send('+ \r\n');
      }
      if (cmd === 'LOGOUT') {
        send('* BYE Fake IMAP signing off\r\n');
        send(`${tag} OK LOGOUT completed\r\n`);
        return socket.end();
      }
      if (!authed) return send(`${tag} BAD Sign in first\r\n`);
      if (cmd === 'SELECT') {
        const next = box.messages.length ? Math.max(...box.messages.map((x) => x.uid)) + 1 : 1;
        send(`* ${box.messages.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY ${box.uidValidity}] UIDs valid\r\n* OK [UIDNEXT ${next}] Predicted next UID\r\n`);
        return send(`${tag} OK [READ-WRITE] SELECT completed\r\n`);
      }
      if (cmd === 'UID') {
        const [sub, ...args] = rest.split(' ');
        const verb = sub.toUpperCase();
        if (verb === 'SEARCH') {
          const q = args.join(' ').toUpperCase();
          let found;
          const uidQ = /^UID (\S+)$/.exec(q);
          if (uidQ) found = uidSet(uidQ[1]);
          else if (q.startsWith('UNSEEN')) found = box.messages.filter((x) => !x.seen);
          else found = box.messages;
          // Unsolicited news in the middle, like a real server may send.
          send(`* ${box.messages.length} EXISTS\r\n`);
          send(`* SEARCH${found.map((x) => ` ${x.uid}`).join('')}\r\n`);
          return send(`${tag} OK SEARCH completed\r\n`);
        }
        if (verb === 'FETCH') {
          const set = args[0];
          const what = args.slice(1).join(' ').toUpperCase();
          const seq = (msg) => box.messages.indexOf(msg) + 1;
          for (const msg of uidSet(set)) {
            if (what.includes('RFC822.SIZE')) send(`* ${seq(msg)} FETCH (UID ${msg.uid} RFC822.SIZE ${msg.raw.length})\r\n`);
            else if (what.includes('BODY.PEEK[HEADER]')) {
              const end = msg.raw.indexOf('\r\n\r\n');
              const head = end < 0 ? msg.raw : msg.raw.subarray(0, end + 4);
              send(`* ${seq(msg)} FETCH (UID ${msg.uid} BODY[HEADER] {${head.length}}\r\n`);
              socket.write(head);
              send(')\r\n');
            } else if (what.includes('BODY.PEEK[]')) {
              // The literal goes out in pieces, the way a big message arrives.
              send(`* ${seq(msg)} FETCH (UID ${msg.uid} BODY[] {${msg.raw.length}}\r\n`);
              for (let i = 0; i < msg.raw.length; i += 7000) socket.write(msg.raw.subarray(i, i + 7000));
              send(` FLAGS (${msg.seen ? '\\Seen' : ''}))\r\n`);
            }
          }
          return send(`${tag} OK FETCH completed\r\n`);
        }
        if (verb === 'STORE') {
          for (const msg of uidSet(args[0])) msg.seen = true;
          return send(`${tag} OK STORE completed\r\n`);
        }
      }
      return send(`${tag} BAD Unknown command\r\n`);
    };
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        handle(line);
      }
    });
  });
  box.port = await listen(server);
  box.add = (raw, extra = {}) => {
    const uid = (box.messages.length ? Math.max(...box.messages.map((m) => m.uid)) : 0) + 1;
    box.messages.push({ uid, seen: false, ...extra, raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw) });
    return uid;
  };
  box.close = () => new Promise((resolve) => {
    for (const s of box.sockets) s.destroy();
    server.close(() => resolve());
  });
  return box;
}

/**
 * An SMTP server on localhost: 'tls' (port 465 style) or 'starttls' (587 style). `sent` gets each
 * message as { from, to, data } with the dot-stuffing undone.
 */
export async function fakeSmtp({ cert, security = 'tls', user = 'receptionist@example.com', pass = 'app-password', mechanisms = 'PLAIN LOGIN', rejectRcpt = [] } = {}) {
  const post = { sent: [], log: [], sockets: new Set() };
  const converse = (socket, secure) => {
    post.sockets.add(socket);
    socket.on('close', () => post.sockets.delete(socket));
    socket.on('error', () => {});
    let buf = '';
    let mode = 'cmd';
    let msg = null;
    let data = '';
    let authed = false;
    let login = null;
    const send = (s) => socket.write(s);
    const onLine = (line) => {
      if (mode === 'data') {
        if (line === '.') {
          mode = 'cmd';
          post.sent.push({ ...msg, data: data.replace(/(^|\r\n)\.\./g, '$1.') });
          msg = null;
          data = '';
          return send('250 2.0.0 OK queued\r\n');
        }
        data += `${line}\r\n`;
        return;
      }
      if (login) {
        const value = Buffer.from(line, 'base64').toString('utf8');
        if (login.step === 'user') {
          login = { step: 'pass', user: value };
          return send('334 UGFzc3dvcmQ6\r\n');
        }
        const ok = login.user === user && value === pass;
        login = null;
        if (!ok) return send('535 5.7.8 Username and Password not accepted\r\n');
        authed = true;
        return send('235 2.7.0 Accepted\r\n');
      }
      post.log.push(line);
      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        const lines = ['fake.smtp at your service', `AUTH ${mechanisms}`, ...(security === 'starttls' && !secure ? ['STARTTLS'] : []), 'SIZE 35882577'];
        return send(lines.map((l, i) => `250${i === lines.length - 1 ? ' ' : '-'}${l}\r\n`).join(''));
      }
      if (upper === 'STARTTLS') {
        send('220 2.0.0 Ready to start TLS\r\n');
        socket.removeAllListeners('data');
        const upgraded = new tls.TLSSocket(socket, { isServer: true, key: cert.key, cert: cert.cert });
        converse(upgraded, true);
        return;
      }
      if (upper.startsWith('AUTH PLAIN ')) {
        const [, u, p] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\0');
        if (u === user && p === pass) {
          authed = true;
          return send('235 2.7.0 Accepted\r\n');
        }
        return send('535 5.7.8 Username and Password not accepted\r\n');
      }
      if (upper === 'AUTH LOGIN') {
        login = { step: 'user' };
        return send('334 VXNlcm5hbWU6\r\n');
      }
      if (upper.startsWith('MAIL FROM:')) {
        if (!authed) return send('530 5.7.0 Authentication Required\r\n');
        msg = { from: /<([^>]*)>/.exec(line)?.[1], to: [] };
        return send('250 2.1.0 OK\r\n');
      }
      if (upper.startsWith('RCPT TO:')) {
        const to = /<([^>]*)>/.exec(line)?.[1];
        if (rejectRcpt.includes(to)) return send('550 5.1.1 No such user\r\n');
        msg.to.push(to);
        return send('250 2.1.5 OK\r\n');
      }
      if (upper === 'DATA') {
        mode = 'data';
        return send('354 Go ahead\r\n');
      }
      if (upper === 'QUIT') {
        send('221 2.0.0 Bye\r\n');
        return socket.end();
      }
      return send('502 5.5.1 Unrecognized command\r\n');
    };
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        onLine(line);
      }
    });
    if (!secure || security === 'tls') send('220 fake.smtp ESMTP ready\r\n');
  };
  const server = security === 'tls'
    ? tls.createServer({ key: cert.key, cert: cert.cert }, (s) => converse(s, true))
    : net.createServer((s) => converse(s, false));
  post.port = await listen(server);
  post.close = () => new Promise((resolve) => {
    for (const s of post.sockets) s.destroy();
    server.close(() => resolve());
  });
  return post;
}

/** A message as a mail client would send it (CRLF line ends). */
export function rawMail({ from = 'Michael <owner@example.com>', to = 'receptionist@example.com', subject = 'Hello', body = 'Hi there', headers = [], messageId } = {}) {
  const id = messageId ?? `<${Math.random().toString(36).slice(2)}@example.com>`;
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Date: Mon, 28 Sep 2026 09:12:33 -0400',
    `Message-ID: ${id}`,
    ...headers,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '',
  ].join('\r\n');
}
