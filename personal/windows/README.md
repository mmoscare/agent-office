# Agent Office for Windows

Double-click **Agent Office** on your Desktop, or find **Agent Office** in Start.
To pin it: open Start, search **Agent Office**, right-click it, and choose **Pin to Start**.

The launcher runs the built app from your personal checkout and uses the Personal-Portfolio building, which contains both of your floors. It checks that this checkout is still on the `personal` branch. It does not download another copy.

If the office is already running, the launcher opens it in Chrome. Otherwise, it starts the server quietly. The first time it starts a server, it may ask for the password you normally use for Agent Office. Windows encrypts that password for your Windows account and remembers it locally.

Starting the server also opens a terminal window that follows its output live (the same text goes to `server.log`), and opens the office in Chrome. Close that terminal or press Ctrl+C in it to stop the office. Reopen the terminal with **Show server terminal** from the tray menu if it disappeared while the office is still running.

While the launcher runs the server, its icon lives near the Windows clock (possibly under the hidden-icons arrow). Right-click it to open, restart, or stop Agent Office. Closing Chrome leaves your office running until you close the server terminal or use **Stop**. Restarting or stopping the office also stops its Windows worker processes; let active work finish first.

To load code changes, use the office's **Update the office** walkthrough (the bar across the top after an Agent Office PR merges). It pulls, builds in a staging folder and asks the launcher to restart the office. You can also build by hand and use **Restart Agent Office** from the tray menu. If the office was started in PowerShell, stop that copy with Ctrl+C first, then launch the shortcut.

## Restarting for an update

The walkthrough builds the new version in `.agent-office\app-update\next` inside the app folder, so the running office's own `dist` and `node_modules` are never touched while it runs. Its restart button asks `host.mjs` to close the office down gracefully and exit with code **75**. The launcher starts the office again on that code, without opening another browser tab.

Before the office loads, `host.mjs` switches the staged build in: `dist`, plus `node_modules` when the update brought new packages. The build it replaces moves to `.agent-office\app-update\previous-<time>`. If the new version fails to start, `host.mjs` exits with code **76**. The launcher then starts it again, and the previous build is put back first. Any other exit code still shows "Agent Office stopped".

An office started from PowerShell, or by a launcher installed before this feature, can't restart itself. The walkthrough then shows the steps to restart it by hand. A staged build without new packages still switches in as that office stops. Reinstalling the launcher once (below) makes the button work.

## Reinstall the launcher

Stop the office first (tray icon → **Stop Agent Office and exit**): the installer replaces `Agent Office.exe`, which can't be overwritten while it runs. Then, from this repository, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\personal\windows\Install-Launcher.ps1
```

The executable, settings, encrypted password, and server log live in `%LOCALAPPDATA%\Agent Office`. Launcher source and its icon stay in `personal/windows` so they are separate from upstream's app code. The icon uses the app's existing desk-and-agent artwork.

For development, the small `host.mjs` wrapper uses a private stdin channel to call the app's normal shutdown handler. It does not need a public shutdown endpoint or a password in the process command line. The restart request uses an in-process hook that only `host.mjs` sets (`globalThis[Symbol.for('agent-office.launcher')]`). That hook is how the office knows the button will work. `tests/windows-launcher.test.ts` checks the exit codes, the switch-in and the rollback, and compiles `Launcher.cs`.

After a build, `node tests/local-floor-ui.mjs` checks the host lifecycle, folder picker, saved usage window, and terminal keyboard behavior in a temporary building using headless Edge. It does not hire AI agents or change your real floors.
