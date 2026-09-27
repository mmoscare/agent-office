import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

function executable(file: string): string | null {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile() ? path.resolve(file) : null;
  } catch {
    return null;
  }
}

/** Windows commands can be native executables or npm's .cmd launchers. */
export function resolveWindowsCommand(command: string): string | null {
  // npm also writes an extensionless POSIX shell script. Prefer Windows launchers over that file.
  const names = path.extname(command) ? [command] : ['.exe', '.com', '.cmd', '.bat', ''].map((ext) => command + ext);
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    for (const name of names) {
      const found = executable(name);
      if (found) return found;
    }
    return null;
  }
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    for (const name of names) {
      const found = executable(path.join(dir, name));
      if (found) return found;
    }
  }
  return null;
}

/**
 * Unwrap npm's standard Node and native shims. This preserves the real CLI entrypoint
 * without sending agent prompts through cmd.exe, where quotes, %, & and other text are executable.
 */
export function commandLaunch(command: string, args: string[]): { file: string; args: string[] } {
  if (process.platform !== 'win32') return { file: command, args };
  const file = resolveWindowsCommand(command) ?? command;
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args };

  let shim: string;
  try {
    shim = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`Could not read the Windows launcher for ${path.basename(file)}`);
  }
  // Some packages (including OpenCode) ship a native executable instead of a Node script.
  const native = /^"%dp0%[\\/]([^"\r\n]+\.exe)"\s+%\*\s*$/im.exec(shim);
  if (/^SET dp0=%~dp0\s*$/im.test(shim) && native) {
    const entry = executable(path.resolve(path.dirname(file), native[1]));
    if (!entry) throw new Error(`The CLI entrypoint for ${path.basename(file)} is missing`);
    return { file: entry, args };
  }
  const target = /"%_prog%"\s+"%dp0%[\\/]([^"\r\n]+)"\s+%\*/i.exec(shim);
  if (!/set\s+"?_prog=node"?/i.test(shim) || !target) {
    throw new Error(`${path.basename(file)} is not a supported npm launcher; configure a native executable instead`);
  }
  const entry = executable(path.resolve(path.dirname(file), target[1]));
  if (!entry) throw new Error(`The CLI entrypoint for ${path.basename(file)} is missing`);
  const node = executable(path.join(path.dirname(file), 'node.exe')) ?? process.execPath;
  return { file: node, args: [entry, ...args] };
}
