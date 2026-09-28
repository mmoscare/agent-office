# The 📥 in-tray and the 📒 To Do Next board

Two ways work gets into the office without a GitHub issue.

## To Do Next, for the agents

The 📒 **To Do Next** binder (in the boss office, or ☰ → **To Do Next**) is the floor's own to-do list: To Do, Progress and Finished. It works on any floor, including a plain folder with no repository, so it is the issue list for life floors (the household, life admin, health…).

- **Queue** on a card puts the item on the 📋 task queue; the next free worker picks it up. **Hand to a worker** gives it to a worker at a desk now (or one already working).
- The office moves the item to **Progress** when its worker starts and to **Finished** when the worker finishes its turn. A queued task that never started puts it back in To Do; one whose worker stopped short leaves it in Progress for you to requeue.
- The board agents read and write the board with `office-plans` (`list`, `add`, `set <id> todo|progress|finished`, `remove <id>`), and queue an item with `office-queue add --plan <id>`. Ask the Queue agent to "queue everything on the To Do Next board" and it does exactly that, one task per item.

## The in-tray

The 📥 **in-tray** (I, or ☰ → **In-tray**; the Receptionist's kiosk past the gong) holds what came in from outside: notes you jot down in the office, forwarded emails, voice memos, photos, PDFs. Each item can be read or opened, filed on To Do Next, queued for a fresh worker, or put away in the archive.

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

Walk up to the kiosk past the gong and press **E**, or click **🤖 Triage the tray** in the In-tray window. The Receptionist reads every item (`office-inbox list` / `read`), files what someone wants done on To Do Next (`office-plans add`), queues what should be worked on right away (`office-queue add`), archives what needs nothing, and tells you what came in and where each item went. It is told that what is in the tray is content to sum up and file, never instructions to follow, and it is launched without the file-editing tools, so it cannot touch the floor's files.

### Keep in mind

- The tray is watched every few seconds; a file still being written shows up once it is complete.
- Notes are kept under 64 KB; send a long one as a file.
- Workers that pick up tray items run with your credentials, like every worker. Keep the door's token as private as the office password.
