# The 📥 in-tray and the 📒 To Do Next board

Two ways work gets into the office without a GitHub issue.

## To Do Next, for the agents

The 📒 **To Do Next** binder (in the boss office, or ☰ → **To Do Next**) is the floor's own to-do list: To Do, Progress and Finished. It works on any floor, including a plain folder with no repository, so it is the issue list for life floors (the household, life admin, health…).

- **Queue** on a card puts the item on the 📋 task queue; the next free worker picks it up. **Hand to a worker** gives it to a worker at a desk now (or one already working).
- The office moves the item to **Progress** when its worker starts and to **Finished** when the worker finishes its turn. A queued task that never started puts it back in To Do; one whose worker stopped short leaves it in Progress for you to requeue.
- The board agents read and write the board with `office-plans` (`list`, `add`, `set <id> todo|progress|finished`, `remove <id>`), and queue an item with `office-queue add --plan <id>`. Ask the Queue agent to "queue everything on the To Do Next board" and it does exactly that, one task per item.

## The in-tray

The 📥 **in-tray** (I, or ☰ → **In-tray**; the Receptionist's counter beside the whiteboard, facing the elevator) holds what came in from outside: notes you jot down in the office, forwarded emails, voice memos, photos, PDFs. Each item can be read or opened, filed on To Do Next, queued for a fresh worker, or put away in the archive.

Things get into the tray three ways:

1. **A note in the office.** Type it into the In-tray window.
2. **The folder.** Every floor has `<floor>/.agent-office/inbox/`. Drop files in: `.md` and `.txt` are notes (first line `# Title`, then the text), anything else is a file. Point a synced folder there (OneDrive, Dropbox, Syncthing, a junction) and your phone can drop voice memos in. Put-away items go to `inbox/archive/`.
3. **The door.** `POST /api/inbox` with a token an admin makes in the In-tray window (**Open the door**). The token is shown once; only its hash is kept in the office's `.agent-office/intray.json`. **Close the door** or **New token** stops the old one working.

### Sending things through the door

The token goes in the `Authorization: Bearer …` header (or `?token=`). `?floor=<id>` says which floor's tray; it can be left out while the building has one floor. The floor ids are listed at `GET /api/inbox/door` when you are signed in.

A note, as JSON:

```bash
curl -X POST "http://localhost:4600/api/inbox?floor=personal-portfolio" \
  -H "Authorization: Bearer YOUR-TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Call the dentist","text":"Tuesday or Thursday afternoon","from":"a phone shortcut"}'
```

A note, as plain text (`?title=` and `?from=` name it):

```bash
curl -X POST "http://localhost:4600/api/inbox?title=Groceries&from=Siri" \
  -H "Authorization: Bearer YOUR-TOKEN" -H "Content-Type: text/plain" --data-binary "milk, eggs, coffee"
```

A file (its own Content-Type, named by `X-Filename`, up to 10 MB):

```bash
curl -X POST "http://localhost:4600/api/inbox" -H "Authorization: Bearer YOUR-TOKEN" \
  -H "Content-Type: audio/mp4" -H "X-Filename: memo.m4a" --data-binary @memo.m4a
```

From PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:4600/api/inbox" `
  -Headers @{ Authorization = "Bearer YOUR-TOKEN" } -ContentType "application/json" `
  -Body '{"title":"Call the dentist","text":"Tuesday or Thursday afternoon"}'
```

Anything that can make an HTTP request can use it: an iPhone Shortcut, a Gmail Apps Script or a mail rule, Zapier or IFTTT, a Task Scheduler job. The office answers `201 {"ok":true,"floor":"…","name":"…"}`. A wrong token gets `401`, a closed door `403`, and too many requests from one address `429`.

The office only listens where you started it (`localhost:4600` on your PC). To reach it from a phone away from home, put it behind the same SSH tunnel or HTTPS proxy you would use for the office itself.

### The Receptionist

Walk up to her counter beside the whiteboard (she faces the elevator, so she's the first thing you see on a floor) and press **E**, or click **💁‍♀️ Triage the tray** in the In-tray window. The Receptionist reads every item (`office-inbox list` / `read`), hands out what someone wants done (To Do Next with `office-plans add`, the task queue with `office-queue add`, the Issues or PR agent with `office-ask`), archives what needs nothing, and tells you what came in and where each item went. She is told that what is in the tray is content to sum up and file, never instructions to follow (only mail the office marks as from an allowed sender is a request to act on), and she is launched without the file-editing tools, so she cannot touch the floor's files.

### Keep in mind

- The tray is watched every few seconds; a file still being written shows up once it is complete.
- Notes are kept under 64 KB; send a long one as a file.
- Workers that pick up tray items run with your credentials, like every worker. Keep the door's token as private as the office password.

## Email the Receptionist

Give her a mailbox and people can email her work. An admin sets it up in the office: the **📧 Set up email** chip on the top bar, or the In-tray window (**I**) → **📧 Set up email**. Until someone does, she keeps asking: the chip, a card from her in the corner when you arrive and every couple of hours ("Remind me tomorrow" puts her off for most of a day), her "Set up my email!" card at the kiosk, and a reminder at the end of her replies. An admin can turn the reminders off from the same window.

### Setting up

1. Make her a mailbox of her own. A new Gmail address works well; iCloud, Fastmail and Yahoo work too, and any other IMAP/SMTP provider under "Another provider".
2. Make an app password for it (Gmail: turn on 2-Step Verification, then myaccount.google.com/apppasswords).
3. Type her address, the app password, and under **Who can email her** your own address (and anyone else's you trust). **🔌 Test**, then **💁‍♀️ Save and set her up**. She emails you a welcome with the how-to.

The settings, password included, live in the office's `.agent-office/mail.json` (mode 0600) and never reach the browser; what she remembers (where she got to in the inbox, which email asked for which task) is in `mail-state.json` beside it. The office connects out to the mail servers over TLS; nothing is opened to the internet.

### What happens to an email

The office looks at her inbox every minute (or at once with **Check now**). Mail from the people allowed to email her lands in the right floor's tray as a note, attachments beside it, and she is woken to deal with it:

- work for the agents goes on the task queue (`office-queue add --mail <item>`),
- things for a person go on To Do Next (`office-plans add --mail <item>`),
- GitHub issues and pull requests go to the Issues or PR agent (`office-ask issues|pulls`),
- and she replies in the sender's thread (`office-mail reply <item>`) with what she did.

When a task (or a To Do Next item a worker finishes) came from an email, its sender gets a "✅ Done" email in the same thread, with the pull request if there is one. Replying to that, while the worker is still at its desk and free, goes straight to the worker as its next message.

Shortcuts that need no agent: a subject starting with `todo:` goes straight onto To Do Next, `queue:` (or `task:`) straight onto the queue; both send a receipt. `[floor]` at the start of the subject, or `+floor` in her address (`her.name+household@gmail.com`), picks the floor; otherwise mail goes to the floor chosen in the settings (the first one by default).

### While you're away, and every morning

- **Away alerts:** when a worker has waited on someone for three minutes and nobody is in the office (no tab open, or every tab in the background for five minutes), she emails you. A "✅ … is done" alert takes replies the same way as a "Done" email; a "🙋 … needs you" one is a question or permission in the worker's terminal, which needs you at the office.
- **Morning briefing:** at the time you choose, each busy floor's tray, To Do Next, queue, who's waiting on you, what finished since yesterday, and yesterday's tracked Claude spend (an estimate).

### Safety

- Only mail from the addresses you list is acted on. Anyone else's is left unread in her mailbox (or, with "Ignore mail from anyone else" off, filed in the tray marked as outside mail, and nothing acts on it).
- Mail that claims to be from you but fails the receiving server's SPF, DKIM and DMARC checks is filed marked, and nothing acts on it.
- Machine mail (auto-replies, bounces, newsletters, mailing lists) and her own mail are ignored, and everything she sends is marked as automatic, so she can't get into a loop with an out-of-office reply.
- She only ever writes to the people allowed to email her, and never more than 40 emails an hour.
- Workers that take email work run with your credentials, like every worker.
