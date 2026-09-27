import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LocalFolderListing } from '../shared/local-folders.js';

/** Accept pasted absolute paths (including Explorer's Copy as path) without invoking a shell. */
export function localFolder(input: unknown): string {
  if (typeof input !== 'string' || input.length > 4096 || /[\x00-\x1f]/.test(input)) throw new Error('Enter a full folder path');
  let dir = input.trim().replace(/^"(.*)"$/, '$1');
  if (dir === '~') dir = os.homedir();
  else if (/^~[\\/]/.test(dir)) dir = path.join(os.homedir(), dir.slice(2));
  if (!path.isAbsolute(dir)) throw new Error('Enter a full folder path');
  try {
    const resolved = realpathSync.native(dir);
    if (!statSync(resolved).isDirectory()) throw new Error('not-directory');
    accessSync(resolved, constants.R_OK);
    return resolved;
  } catch (err) {
    if ((err as Error).message === 'not-directory') throw new Error('Choose a folder, not a file');
    throw new Error('That folder could not be opened. Check the path and access permissions.');
  }
}

/** Existing floors may use a junction, a different drive-letter case, or a now-missing path. */
export function localFolderKey(dir: string): string {
  let resolved: string;
  try { resolved = realpathSync.native(dir); }
  catch { resolved = path.resolve(dir); }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** List directory names only; the browser never needs the files inside a project. */
export async function listLocalFolders(input: unknown): Promise<LocalFolderListing> {
  const dir = localFolder(input);
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { throw new Error('The folders here could not be listed. Check access permissions.'); }
  const folders: LocalFolderListing['folders'] = [];
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && await stat(child).then(s => s.isDirectory(), () => false))) {
      folders.push({ name: entry.name, dir: child });
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const parent = path.dirname(dir);
  return { dir, parent: parent === dir ? null : parent, folders: folders.slice(0, 500), truncated: folders.length > 500 };
}
