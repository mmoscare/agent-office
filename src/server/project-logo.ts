import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';

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

/** Prefer an explicit Office logo, then a project's logo, then its app icon/favicon. */
export function readProjectLogo(dir: string): ProjectLogo | undefined {
  let root: string;
  try { root = realpathSync(dir); } catch { return; }
  const folders = ['.agent-office', ...DIRECTORIES].flatMap((relative) => {
    try {
      const folder = realpathSync(path.join(root, relative));
      if (!inside(root, folder)) return [];
      const files = new Map(readdirSync(folder).map((name) => [name.toLowerCase(), name]));
      return [{ relative, folder, files }];
    } catch { return []; }
  });
  const read = (folder: typeof folders[number], stem: string): ProjectLogo | undefined => {
    for (const [ext, type] of Object.entries(TYPES)) {
      const name = folder.files.get(`${stem}.${ext}`.toLowerCase());
      if (!name) continue;
      let fd: number | undefined;
      try {
        const file = realpathSync(path.join(folder.folder, name));
        if (!inside(root, file)) continue;
        fd = openSync(file, 'r');
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_LOGO_BYTES) continue;
        // Bound the read even if another process grows the file after stat.
        const buffer = Buffer.alloc(MAX_LOGO_BYTES + 1);
        let size = 0;
        while (size < buffer.length) {
          const n = readSync(fd, buffer, size, buffer.length - size, null);
          if (!n) break;
          size += n;
        }
        if (!size || size > MAX_LOGO_BYTES) continue;
        const bytes = Buffer.from(buffer.subarray(0, size));
        return { bytes, type, version: createHash('sha256').update(bytes).digest('hex').slice(0, 16) };
      } catch {
        // A missing/unreadable logo must never prevent a floor from opening.
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
  };
  const override = folders.find((f) => f.relative === '.agent-office');
  if (override) {
    const logo = read(override, 'logo');
    if (logo) return logo;
  }
  const project = path.basename(root).toLowerCase();
  for (const stem of ['logo', `${project}-logo`, project, 'logo-light', 'logo-dark', 'icon', 'apple-touch-icon', 'favicon']) {
    for (const folder of folders) {
      if (folder.relative === '.agent-office') continue;
      const logo = read(folder, stem);
      if (logo) return logo;
    }
  }
}
