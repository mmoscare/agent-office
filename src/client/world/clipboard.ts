import * as THREE from 'three';
import type { RosterGroup } from '../../shared/roster';
import { wrap } from './boards';
import { mesh, roundedBox, toon, toonUnique } from './toon';

const W = 512;
const H = 680;
const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
/** In meters: the board, and the sheet clipped to it. */
const BOARD = { width: 0.4, height: 0.52 };
const SHEET = { width: 0.35, height: (0.35 * H) / W };

/**
 * What the queue agent's clipboard says, drawn once onto a canvas every clipboard in the room shares:
 * each repository in bold with the workers in it under it, and what each one's on.
 */
export class ClipboardSheet {
  readonly texture: THREE.CanvasTexture;
  /** The paper's material, shared by every clipboard showing this sheet. */
  readonly face = toonUnique('#ffffff');
  private canvas = document.createElement('canvas');
  private drawn = '';

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.face.map = this.texture;
    this.render([]);
  }

  render(groups: RosterGroup[]) {
    const key = JSON.stringify(groups.map((g) => [g.repo, g.entries.map((e) => [e.name, e.status, e.repos, e.doing])]));
    if (key === this.drawn) return;
    this.drawn = key;
    const g = this.canvas.getContext('2d')!;
    g.fillStyle = '#fffdf6';
    g.fillRect(0, 0, W, H);
    // Ruled lines, like a legal pad.
    g.strokeStyle = '#d7e3f0';
    g.lineWidth = 2;
    for (let y = 120; y < H; y += 34) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(W, y);
      g.stroke();
    }
    g.fillStyle = '#2b2d42';
    g.font = `900 38px ${FONT}`;
    g.fillText("Who's on what", 28, 92);
    let y = 150;
    const room = () => y < H - 30;
    const total = groups.reduce((n, gr) => n + gr.entries.length, 0);
    if (!total) {
      g.font = `700 26px ${FONT}`;
      g.fillStyle = '#6c757d';
      g.fillText('Nobody hired yet.', 28, y);
      this.texture.needsUpdate = true;
      return;
    }
    let shown = 0;
    for (const group of groups) {
      if (!group.entries.length || !room()) continue;
      // The repository first, so it's clear where everyone below it is working.
      g.fillStyle = '#06d6a0';
      g.fillRect(20, y - 26, 8, 32);
      g.fillStyle = '#1b4332';
      g.font = `900 28px ${FONT}`;
      g.fillText(fit(g, `📁 ${group.repo}`, W - 60), 36, y);
      y += 38;
      for (const e of group.entries) {
        if (!room()) break;
        g.fillStyle = e.color;
        g.beginPath();
        g.arc(40, y - 9, 8, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#2b2d42';
        g.font = `800 24px ${FONT}`;
        g.fillText(fit(g, e.name, W - 90), 56, y);
        y += 28;
        g.fillStyle = '#495057';
        g.font = `600 20px ${FONT}`;
        for (const line of wrap(g, e.doing || 'Waiting for a task', W - 90, 2)) {
          if (!room()) break;
          g.fillText(line, 56, y);
          y += 24;
        }
        y += 10;
        shown++;
      }
      y += 8;
    }
    if (shown < total) {
      g.fillStyle = '#6c757d';
      g.font = `800 22px ${FONT}`;
      g.fillText(`+${total - shown} more — press C to read it all`, 28, H - 18);
    }
    this.texture.needsUpdate = true;
  }
}

/** `text` on one line no wider than `maxW`, cut short with an ellipsis (a long owner/repo has no spaces to wrap at). */
function fit(g: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (g.measureText(text).width <= maxW) return text;
  let cut = text;
  while (cut.length > 1 && g.measureText(`${cut}…`).width > maxW) cut = cut.slice(0, -1);
  return `${cut}…`;
}

let parts: { board: THREE.BufferGeometry; sheet: THREE.BufferGeometry; clip: THREE.BufferGeometry; wood: THREE.Material; steel: THREE.Material } | null = null;

/**
 * A clipboard showing `sheet`, face (+z) out, for someone to hold in front of them. Its geometry and
 * materials are shared by every clipboard, so there's nothing to free when one is put down.
 */
export function clipboardProp(sheet: ClipboardSheet): THREE.Group {
  parts ??= {
    board: roundedBox(BOARD.width, BOARD.height, 0.018, 0.02),
    sheet: new THREE.PlaneGeometry(SHEET.width, SHEET.height),
    clip: roundedBox(0.16, 0.06, 0.03, 0.012),
    wood: toon('#b07d4f'),
    steel: toon('#c9ced6'),
  };
  const group = new THREE.Group();
  group.add(mesh(parts.board, parts.wood));
  group.add(mesh(parts.sheet, sheet.face, 0, -0.012, 0.011, false));
  group.add(mesh(parts.clip, parts.steel, 0, BOARD.height / 2 - 0.035, 0.018, false));
  return group;
}
