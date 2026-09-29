# Agent Office for Windows

Double-click **Agent Office** on your Desktop, or find **Agent Office** in Start.
To pin it: open Start, search **Agent Office**, right-click it, and choose **Pin to Start**.

The launcher runs the built app from your personal checkout and uses the Personal-Portfolio building, which contains both of your floors. It checks that this checkout is still on the `personal` branch. It does not download another copy.

If the office is already running, the launcher opens it in Chrome. Otherwise, it starts the server quietly. The first time it starts a server, it may ask for the password you normally use for Agent Office. Windows encrypts that password for your Windows account and remembers it locally.

Starting the server also opens a terminal window that follows its output live (the same text goes to `server.log`), and opens the office in Chrome. Close that terminal or press Ctrl+C in it to stop the office. Reopen the terminal with **Show server terminal** from the tray menu if it disappeared while the office is still running.

While the launcher runs the server, its icon lives near the Windows clock (possibly under the hidden-icons arrow). Right-click it to open, restart, or stop Agent Office. Closing Chrome leaves your office running until you close the server terminal or use **Stop**. Restarting or stopping the office also stops its Windows worker processes; let active work finish first.

To load code changes, build the app and use **Restart Agent Office** from that tray menu. If the office was started in PowerShell, stop that copy with Ctrl+C first, then launch the shortcut.

## Reinstall the launcher

From this repository, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\personal\windows\Install-Launcher.ps1
```

The executable, settings, encrypted password, and server log live in `%LOCALAPPDATA%\Agent Office`. Launcher source and its icon stay in `personal/windows` so they are separate from upstream's app code. The icon uses the app's existing desk-and-agent artwork.

For development, the small `host.mjs` wrapper uses a private stdin channel to call the app's normal shutdown handler. It does not need a public shutdown endpoint or a password in the process command line.

After a build, `node tests/local-floor-ui.mjs` checks the host lifecycle, folder picker, saved usage window, and terminal keyboard behavior in a temporary building using headless Edge. It does not hire AI agents or change your real floors.
