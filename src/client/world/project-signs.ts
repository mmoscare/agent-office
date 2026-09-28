import * as THREE from 'three';
import { FLOOR_PALETTES, type FloorPalette } from '../../shared/floors';
import { mesh, roundedBox, toon, toonUnique } from './toon';

const INK = '#2b2d42';
const CREAM = '#fffaf3';
const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
const W = 1536;
const H = 384;

/** All the floor's plaques share one canvas and one logo load, including when riding the elevator. */
export function buildProjectSigns() {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const face = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
  const trim = toonUnique(FLOOR_PALETTES[0].trim);
  let palette = FLOOR_PALETTES[0];
  let name = 'Agent Office';
  /** The floor's number as the elevator shows it: "3", or "B1" in the Back Office. */
  let floor: string | undefined;
  let logo: HTMLImageElement | undefined;
  let signature = '';
  let revision = 0;

  function draw() {
    g.fillStyle = CREAM;
    g.fillRect(0, 0, W, H);
    g.strokeStyle = palette.trim;
    g.lineWidth = 4;
    g.beginPath();
    g.roundRect(18, 18, W - 36, H - 36, 26);
    g.stroke();
    g.fillStyle = palette.trim;
    g.fillRect(50, H - 34, W - 100, 7);

    // A light tile keeps transparent and dark logos legible against every floor's colors.
    g.fillStyle = palette.wall;
    g.beginPath();
    g.roundRect(52, 52, 280, 280, 44);
    g.fill();
    if (logo) {
      const scale = Math.min(224 / logo.naturalWidth, 224 / logo.naturalHeight);
      const w = logo.naturalWidth * scale;
      const h = logo.naturalHeight * scale;
      g.drawImage(logo, 192 - w / 2, H / 2 - h / 2, w, h);
    } else {
      const words = name.trim().split(/[\s_./\\-]+/u).filter(Boolean);
      const initials = (words.length > 1 ? words.slice(0, 2).map((w) => Array.from(w)[0]).join('') : Array.from(words[0] ?? 'AO').slice(0, 2).join('')).toLocaleUpperCase();
      g.fillStyle = INK;
      g.font = `900 104px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(initials, 192, H / 2 + 5, 230);
    }

    const left = 380;
    const available = W - left - 68;
    g.fillStyle = '#626476';
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.font = `800 30px ${FONT}`;
    g.fillText(floor === undefined ? 'AGENT OFFICE' : `FLOOR ${String(floor).padStart(2, '0')}  /  WORKSPACE`, left, 94);
    g.fillStyle = INK;
    // Keep the full name when possible, including directory names without word breaks.
    const title = name.replace(/\s+/gu, ' ').trim() || 'Agent Office';
    let lines = [title];
    let size = 90;
    for (;; size -= 2) {
      g.font = `900 ${size}px ${FONT}`;
      lines = [''];
      for (const char of title) {
        const last = lines.length - 1;
        const line = lines[last];
        if (line && g.measureText(line + char).width > available) {
          // Prefer an existing word/path boundary; still handle a single unbroken name.
          const split = Math.max(...[' ', '-', '_', '.', '/', '\\'].map((separator) => line.lastIndexOf(separator)));
          if (split > 0) {
            lines[last] = line.slice(0, split + 1);
            lines.push(line.slice(split + 1) + char);
          } else lines.push(char);
        } else lines[last] += char;
      }
      if (lines.length <= 2 || size === 36) break;
    }
    // An unusually long legacy directory name still stays within the physical plaque.
    if (lines.length > 2) {
      while (g.measureText(lines[1] + '…').width > available) lines[1] = Array.from(lines[1]).slice(0, -1).join('');
      lines[1] += '…';
    }
    lines = lines.slice(0, 2);
    const lineHeight = size * 1.12;
    const top = lines.length === 1 ? 231 : 207 - lineHeight / 2;
    lines.forEach((line, i) => g.fillText(line.trim(), left, top + i * lineHeight, available));
    texture.needsUpdate = true;
  }

  /** A solid rounded plaque facing local +z. Its width is fixed so names never cover a doorway. */
  function create(location: string, width: number): THREE.Group {
    const group = new THREE.Group();
    group.name = `project-sign-${location}`;
    const height = width / 4;
    const frame = mesh(roundedBox(width + 0.08, 0.09, height + 0.08, 0.09), trim);
    frame.rotation.x = Math.PI / 2;
    group.add(frame);
    const panel = mesh(new THREE.PlaneGeometry(width, height), face, 0, 0, 0.05, false);
    panel.name = 'project-sign-face';
    group.add(panel);
    // Small brass fasteners pick up the elevator's existing brass frame.
    for (const x of [-1, 1]) for (const y of [-1, 1]) {
      group.add(mesh(new THREE.SphereGeometry(0.018, 8, 6), toon('#e9b949'), x * (width / 2 + 0.012), y * (height / 2 + 0.012), 0.05, false));
    }
    return group;
  }

  function setProject(nextName: string, url?: string, nextFloor?: string) {
    const next = JSON.stringify([nextName, url, nextFloor]);
    if (next === signature) return;
    signature = next;
    const request = ++revision;
    name = nextName;
    floor = nextFloor;
    logo = undefined;
    draw();
    if (!url) return;
    const image = new Image();
    image.onload = () => {
      // A late response for the floor we left must never repaint the current floor's signs.
      if (request !== revision || !image.naturalWidth || !image.naturalHeight) return;
      logo = image;
      draw();
    };
    image.onerror = () => {
      if (request !== revision) return;
      logo = undefined;
      draw();
    };
    image.src = url;
  }

  draw();
  void document.fonts.ready.then(draw);
  return {
    create,
    setProject,
    setLook(p: FloorPalette) {
      palette = p;
      trim.color.set(p.trim);
      draw();
    },
  };
}
