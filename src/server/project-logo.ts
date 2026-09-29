import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { personalProjectLogoPaths } from './personal-project-logos.js';

/** Logos are small, local assets, read once when a floor opens. Never crawl a checkout or fetch a URL. */
export const MAX_LOGO_BYTES = 512 * 1024;
const TYPES: Record<string, string> = {
  svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', ico: 'image/x-icon',
};
const DIRECTORIES = [
  '', 'public', 'assets', 'images', 'static', 'docs', '.github',
  'public/assets', 'public/images', 'assets/images', 'docs/assets', 'docs/images',
  'src/assets', 'src/images', 'src/public', 'src/client/public', 'app', 'src/app',
];

export interface ProjectLogo {
  bytes: Buffer;
  type: string;
  version: string;
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Prefer an explicit Office logo, then the chosen launcher/dashboard, then conventional assets. */
export function readProjectLogo(dir: string): ProjectLogo | undefined {
  let root: string;
  try { root = realpathSync(dir); } catch { return; }
  const readFile = (relative: string): ProjectLogo | undefined => {
    const type = TYPES[path.extname(relative).slice(1).toLowerCase()];
    if (!type) return;
    let fd: number | undefined;
    try {
      const file = realpathSync(path.join(root, relative));
      if (!inside(root, file)) return;
      fd = openSync(file, 'r');
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_LOGO_BYTES) return;
      // Bound the read even if another process grows the file after stat.
      const buffer = Buffer.alloc(MAX_LOGO_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const n = readSync(fd, buffer, size, buffer.length - size, null);
        if (!n) break;
        size += n;
      }
      if (!size || size > MAX_LOGO_BYTES) return;
      const bytes = Buffer.from(buffer.subarray(0, size));
      return { bytes, type, version: createHash('sha256').update(bytes).digest('hex').slice(0, 16) };
    } catch {
      // A missing/unreadable logo must never prevent a floor from opening.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const folders = ['.agent-office', '.launcher', 'launcher', ...DIRECTORIES].flatMap((relative) => {
    try {
      const folder = realpathSync(path.join(root, relative));
      if (!inside(root, folder)) return [];
      const files = new Map(readdirSync(folder).map((name) => [name.toLowerCase(), name]));
      return [{ relative, files }];
    } catch { return []; }
  });
  const read = (folder: typeof folders[number], stem: string): ProjectLogo | undefined => {
    for (const ext of Object.keys(TYPES)) {
      const name = folder.files.get(`${stem}.${ext}`.toLowerCase());
      if (!name) continue;
      const logo = readFile(path.join(folder.relative, name));
      if (logo) return logo;
    }
  };
  const override = folders.find((f) => f.relative === '.agent-office');
  if (override) {
    const logo = read(override, 'logo');
    if (logo) return logo;
  }
  const project = path.basename(root).toLowerCase();
  for (const file of personalProjectLogoPaths(project)) {
    const logo = readFile(file);
    if (logo) return logo;
  }
  for (const folder of folders.filter((f) => f.relative === '.launcher' || f.relative === 'launcher')) {
    for (const stem of ['logo', 'logo-256', project, `${project}-logo`, 'icon']) {
      const logo = read(folder, stem);
      if (logo) return logo;
    }
  }
  for (const stem of ['logo', `${project}-logo`, project, 'logo-light', 'logo-dark', 'icon', 'apple-touch-icon', 'favicon']) {
    for (const folder of folders) {
      if (!DIRECTORIES.includes(folder.relative)) continue;
      const logo = read(folder, stem);
      if (logo) return logo;
    }
  }
}
