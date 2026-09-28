import * as THREE from 'three';
import type { GitRepoSummary } from '../../shared/git-board';
import type { GitReposState, PullsWallMode } from '../ui/git-board';
import { PINS, wrap } from './boards';

// The Git side of the PR board on the wall (see ui/git-board.ts): a note per repository with its
// branch, how it stands against GitHub and what's uncommitted; and the switch above the board.

const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
const INK = '#2b2d42';

function clip(g: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (g.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

export class GitBoardTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;

  constructor() {
    this.canvas.width = 1200;
    this.canvas.height = 600;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
  }

  render(state: GitReposState) {
    const g = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    // A green felt board, so it reads as the other side at a glance.
    g.fillStyle = '#2f5d46';
    g.fillRect(0, 0, W, H);
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 1200; i++) {
      g.fillStyle = rnd() > 0.5 ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.06)';
      g.fillRect(rnd() * W, rnd() * H, 3, 3);
    }
    g.fillStyle = '#fffaf3';
    g.font = `900 34px ${FONT}`;
    g.fillText('🌿 Git', 24, 48);
    g.font = `700 22px ${FONT}`;
    g.fillStyle = 'rgba(255,250,243,.8)';
    const repos = state.list?.repos ?? [];
    const sub = state.list ? (state.list.floorIsRepo ? 'this floor is one repository' : `${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'} on this floor`) : '';
    g.fillText(sub, 150, 46);

    if (!repos.length) {
      const text = state.error ? `⚠️ ${state.error}` : state.list ? 'No Git repositories on this floor' : 'Loading…';
      g.font = `800 38px ${FONT}`;
      const lines = wrap(g, text, 760, 4);
      const boxH = 60 + lines.length * 48;
      g.fillStyle = '#fffaf3';
      g.fillRect(W / 2 - 420, H / 2 - boxH / 2 + 30, 840, boxH);
      g.fillStyle = INK;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      lines.forEach((line, i) => g.fillText(line, W / 2, H / 2 + 30 - ((lines.length - 1) * 48) / 2 + i * 48));
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      this.texture.needsUpdate = true;
      return;
    }

    const top = 72;
    const n = Math.min(repos.length, 12);
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    const rows = Math.ceil(n / cols);
    const gap = 22;
    const nw = Math.min(640, (W - gap * (cols + 1)) / cols);
    const nh = Math.min(260, (H - top - gap * (rows + 1)) / rows);
    const x0 = (W - cols * nw - (cols - 1) * gap) / 2;
    repos.slice(0, n).forEach((r, i) => this.note(r, i, x0 + (i % cols) * (nw + gap), top + gap / 2 + Math.floor(i / cols) * (nh + gap), nw, nh));
    if (repos.length > n) {
      g.fillStyle = '#fffaf3';
      g.font = `800 24px ${FONT}`;
      g.textAlign = 'right';
      g.fillText(`+${repos.length - n} more`, W - 20, H - 14);
      g.textAlign = 'left';
    }
    this.texture.needsUpdate = true;
  }

  private note(r: GitRepoSummary, i: number, x: number, y: number, w: number, hgt: number) {
    const g = this.ctx;
    const tilt = ((i * 37) % 7 - 3) * 0.01;
    g.save();
    g.translate(x + w / 2, y + hgt / 2);
    g.rotate(tilt);
    g.fillStyle = 'rgba(0,0,0,.3)';
    g.fillRect(-w / 2 + 5, -hgt / 2 + 7, w, hgt);
    g.fillStyle = r.error ? '#ffd6e0' : r.dirty ? '#fff7b0' : '#caffbf';
    g.fillRect(-w / 2, -hgt / 2, w, hgt);
    const fs = Math.max(16, Math.min(30, hgt / 6));
    const left = -w / 2 + 16;
    const maxW = w - 32;
    let ly = -hgt / 2 + fs * 1.7;
    g.fillStyle = INK;
    g.font = `900 ${Math.round(fs * 1.25)}px ${FONT}`;
    g.fillText(clip(g, r.name, maxW), left, ly);
    ly += fs * 1.35;
    g.font = `800 ${Math.round(fs)}px ${FONT}`;
    if (r.error) {
      g.fillStyle = '#c3423f';
      wrap(g, r.error, maxW, 2).forEach((line) => {
        g.fillText(line, left, ly);
        ly += fs * 1.2;
      });
    } else {
      g.fillText(clip(g, `🌿 ${r.branch ?? 'detached HEAD'}`, maxW), left, ly);
      ly += fs * 1.3;
      const sync = !r.upstream ? 'not on GitHub' : !r.ahead && !r.behind ? '✓ in sync with GitHub' : `${r.ahead ? `↑${r.ahead} to push` : ''}${r.ahead && r.behind ? '  ' : ''}${r.behind ? `↓${r.behind} to pull` : ''}`;
      g.fillStyle = !r.upstream ? '#7a6f65' : r.ahead || r.behind ? '#1d6fd6' : '#2a9d4b';
      g.fillText(clip(g, sync, maxW), left, ly);
      ly += fs * 1.3;
      g.fillStyle = r.dirty ? '#b5651d' : '#7a6f65';
      g.fillText(r.dirty ? `✏️ ${r.dirty} uncommitted` : 'clean', left, ly);
    }
    g.beginPath();
    g.arc(0, -hgt / 2 + 10, 11, 0, Math.PI * 2);
    g.fillStyle = PINS[i % PINS.length];
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = INK;
    g.stroke();
    g.restore();
  }
}

/** The switch above the PR board: flips it between pull requests and Git. */
export class PullsWallSwitch {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;

  constructor(width = 1.5) {
    this.canvas.width = 384;
    this.canvas.height = 128;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, alphaTest: 0.05 });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, width / 3), mat);
  }

  /** Says what a press switches to. */
  render(mode: PullsWallMode) {
    const g = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    const r = 34;
    g.beginPath();
    g.roundRect(6, 6, W - 12, H - 18, r);
    g.fillStyle = INK;
    g.fill();
    g.beginPath();
    g.roundRect(6, 0, W - 12, H - 18, r);
    g.fillStyle = mode === 'git' ? '#bde0fe' : '#caffbf';
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = INK;
    g.stroke();
    g.fillStyle = INK;
    g.font = `900 46px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(mode === 'git' ? '🔀 Show PRs' : '🌿 Show Git', W / 2, (H - 18) / 2 + 2);
    this.texture.needsUpdate = true;
  }
}
