import * as THREE from 'three';
import { mesh, roundedBox, textPlane, toon } from './toon';

// The bookshelf in the boss office: a few rows of books, and the Office Manual standing face-out in
// the middle with its title on the cover, under a small "📘 Manual" plaque. Using it opens the manual
// (ui/manual.ts). Built facing +z (into the room from a south wall is rotY = π).

const BOOK_COLORS = ['#ef476f', '#118ab2', '#06d6a0', '#ffd166', '#8338ec', '#fb8500', '#2b2d42', '#e9c46a', '#577590'];

/** The manual's cover: a title you can read from across the room. */
function coverTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 340;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1d4e89';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#ffd166';
  g.lineWidth = 10;
  g.strokeRect(14, 14, c.width - 28, c.height - 28);
  g.fillStyle = '#ffd166';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '900 44px Nunito, ui-rounded, system-ui, sans-serif';
  g.fillText('OFFICE', c.width / 2, 120);
  g.fillText('MANUAL', c.width / 2, 172);
  g.font = '64px system-ui, sans-serif';
  g.fillText('📘', c.width / 2, 258);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export interface Bookshelf {
  group: THREE.Group;
  /** Width along the wall and depth out from it, for its collider. */
  width: number;
  depth: number;
}

export function buildBookshelf(): Bookshelf {
  const width = 1.6;
  // Low enough to sit under the "👑 Boss Office" sign on the wall above it.
  const height = 1.35;
  const depth = 0.36;
  const shelves = 3;
  const group = new THREE.Group();
  const wood = toon('#8a5a3b');
  const inside = toon('#6f4630');
  const side = 0.05;
  // The case: back, sides, top and bottom, and the shelves between.
  group.add(mesh(new THREE.BoxGeometry(width, height, 0.03), inside, 0, height / 2, -depth / 2 + 0.015));
  for (const sx of [-1, 1]) group.add(mesh(new THREE.BoxGeometry(side, height, depth), wood, sx * (width / 2 - side / 2), height / 2, 0));
  group.add(mesh(roundedBox(width + 0.06, 0.06, depth + 0.04, 0.02), wood, 0, height + 0.03, 0.01));
  const rowH = (height - 0.08) / shelves;
  for (let i = 0; i < shelves; i++) group.add(mesh(new THREE.BoxGeometry(width - side * 2, 0.04, depth - 0.02), wood, 0, 0.06 + i * rowH, 0.005));

  // Books along each shelf, spine out, with a gap in the middle row for the manual.
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const inner = width - side * 2 - 0.04;
  for (let row = 0; row < shelves; row++) {
    const floorY = 0.08 + row * rowH;
    let x = -inner / 2;
    while (x < inner / 2 - 0.05) {
      const bw = 0.035 + rnd() * 0.035;
      // The manual stands face-out in the middle of the middle row.
      if (row === 1 && x > -0.2 && x < 0.2) {
        x = 0.2;
        continue;
      }
      if (x + bw > inner / 2) break;
      const bh = rowH * (0.6 + rnd() * 0.28);
      const bd = depth * (0.7 + rnd() * 0.2);
      const book = mesh(new THREE.BoxGeometry(bw, bh, bd), toon(BOOK_COLORS[Math.floor(rnd() * BOOK_COLORS.length)]), x + bw / 2, floorY + bh / 2, depth / 2 - bd / 2 - 0.02, false);
      // Now and then one leans on its neighbor.
      if (rnd() > 0.85) book.rotation.z = (rnd() - 0.5) * 0.25;
      group.add(book);
      x += bw + 0.004;
    }
  }

  // The Office Manual: face-out, leaning back a little, its cover to the room.
  const manual = new THREE.Group();
  const bookW = 0.3;
  const bookH = Math.min(0.4, rowH * 0.88);
  const bookD = 0.05;
  const pages = mesh(new THREE.BoxGeometry(bookW - 0.02, bookH - 0.02, bookD - 0.01), toon('#fffaf3'), 0.01, 0, 0, false);
  manual.add(pages);
  manual.add(mesh(new THREE.BoxGeometry(bookW, bookH, 0.008), toon('#1d4e89'), 0, 0, -bookD / 2, false));
  manual.add(mesh(new THREE.BoxGeometry(0.012, bookH, bookD), toon('#1d4e89'), -bookW / 2, 0, 0, false));
  const cover = new THREE.Mesh(new THREE.PlaneGeometry(bookW, bookH), new THREE.MeshBasicMaterial({ map: coverTexture() }));
  cover.position.z = bookD / 2 + 0.001;
  manual.add(cover);
  manual.position.set(0, 0.08 + rowH + bookH / 2 + 0.005, 0.03);
  manual.rotation.x = -0.12;
  group.add(manual);

  // The plaque on top, so it's labelled from across the room.
  const plaque = textPlane('📘 Manual', { bg: '#ffd166', size: 48 });
  plaque.scale.multiplyScalar(0.45);
  plaque.position.set(0, height + 0.165, 0.02);
  group.add(plaque);

  return { group, width: width + 0.06, depth: depth + 0.04 };
}
