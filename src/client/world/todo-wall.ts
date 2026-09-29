import * as THREE from 'three';
import { TODO_COLUMNS, todosIn, type TodoColumn, type TodoItem } from '../../shared/todos';
import { ACTIVE_FOCUS, COLUMN_ICON, COLUMN_ORDER, type IssuesWallMode } from '../ui/todos';
import { wrap } from './boards';

// Your own 🔥 To Do board on the wall (see ui/todos.ts): the issues board's side that faces the room
// unless you flip it, drawn in each browser from its own list, so everyone sees their own. And the
// switch above the board that flips it between To Do and the floor's issues.

const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
const INK = '#2b2d42';
/** Header colour, tint behind the cards, and the stripe down each card, per column. */
const LOOK: Record<TodoColumn, { head: string; headInk: string; tint: string; edge: string }> = {
  active: { head: '#ef476f', headInk: '#fff', tint: 'rgba(255,225,225,.92)', edge: '#b3122f' },
  urgent: { head: '#ff9f1c', headInk: INK, tint: 'rgba(255,240,219,.9)', edge: '#c26a00' },
  todo: { head: '#bfe6df', headInk: INK, tint: 'rgba(227,244,241,.9)', edge: '#2a9d8f' },
  done: { head: '#dff1df', headInk: INK, tint: 'rgba(238,247,238,.85)', edge: '#8d99ae' },
};
/** How wide each column is, relative to the others. */
const WEIGHT: Record<TodoColumn, number> = { active: 1.25, urgent: 1.1, todo: 1, done: 0.8 };

export class TodoWallTexture {
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

  render(items: readonly TodoItem[]) {
    const g = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    // Cork, like the issues side.
    g.fillStyle = '#d8a86a';
    g.fillRect(0, 0, W, H);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 1400; i++) {
      g.fillStyle = rnd() > 0.5 ? 'rgba(120,70,30,.18)' : 'rgba(255,240,210,.18)';
      g.fillRect(rnd() * W, rnd() * H, 3, 3);
    }
    g.fillStyle = INK;
    g.font = `900 34px ${FONT}`;
    g.textBaseline = 'alphabetic';
    g.fillText('🔥 My To Do', 22, 44);
    g.font = `800 20px ${FONT}`;
    g.fillStyle = 'rgba(43,45,66,.75)';
    g.fillText('Press E to add and move cards', 250, 42);

    const top = 62;
    const pad = 14;
    const gap = 12;
    const total = COLUMN_ORDER.reduce((s, c) => s + WEIGHT[c], 0);
    const room = W - pad * 2 - gap * (COLUMN_ORDER.length - 1);
    let x = pad;
    for (const column of COLUMN_ORDER) {
      const w = (room * WEIGHT[column]) / total;
      this.column(column, todosIn(items, column), x, top, w, H - top - pad);
      x += w + gap;
    }
    this.texture.needsUpdate = true;
  }

  private column(column: TodoColumn, items: TodoItem[], x: number, y: number, w: number, h: number) {
    const g = this.ctx;
    const look = LOOK[column];
    // The column, and its header.
    g.fillStyle = 'rgba(0,0,0,.25)';
    this.round(x + 4, y + 6, w, h, 16);
    g.fill();
    g.fillStyle = look.tint;
    this.round(x, y, w, h, 16);
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = look.edge;
    g.stroke();
    const headH = 48;
    g.save();
    this.round(x, y, w, h, 16);
    g.clip();
    g.fillStyle = look.head;
    g.fillRect(x, y, w, headH);
    g.restore();
    const count = String(items.length);
    g.font = `900 22px ${FONT}`;
    const cw = Math.max(34, g.measureText(count).width + 18);
    // The name, smaller if it has to be to clear the count.
    const name = `${COLUMN_ICON[column]} ${TODO_COLUMNS[column]}`;
    const nameW = w - cw - 32;
    let hs = 26;
    g.font = `900 ${hs}px ${FONT}`;
    while (hs > 17 && g.measureText(name).width > nameW) g.font = `900 ${--hs}px ${FONT}`;
    g.fillStyle = look.headInk;
    g.textBaseline = 'middle';
    g.fillText(name, x + 12, y + headH / 2 + 1, nameW);
    g.font = `900 22px ${FONT}`;
    g.fillStyle = '#fff';
    this.round(x + w - cw - 10, y + 10, cw, 28, 14);
    g.fill();
    g.fillStyle = column === 'active' && items.length > ACTIVE_FOCUS ? '#b3122f' : INK;
    g.textAlign = 'center';
    g.fillText(count, x + w - cw / 2 - 10, y + 25);
    g.textAlign = 'left';

    // The cards, top first, as many as fit.
    const inner = w - 24;
    let cy = y + headH + 10;
    const bottom = y + h - 10;
    const fs = column === 'done' ? 18 : 21;
    const shown = column === 'done' ? items.slice(0, 8) : items;
    let drawn = 0;
    for (const item of shown) {
      g.font = `800 ${fs}px ${FONT}`;
      const lines = wrap(g, item.text, inner - 26, column === 'done' ? 1 : 3);
      const ch = 16 + lines.length * (fs + 6);
      // Keep room for "+N more" if anything's left after this one.
      const left = shown.length - drawn - 1;
      if (cy + ch > bottom - (left ? 30 : 0)) break;
      g.fillStyle = 'rgba(0,0,0,.18)';
      this.round(x + 12 + 2, cy + 4, inner, ch, 10);
      g.fill();
      g.fillStyle = column === 'done' ? '#f4faf4' : '#fff';
      this.round(x + 12, cy, inner, ch, 10);
      g.fill();
      g.fillStyle = look.edge;
      g.fillRect(x + 12, cy + 4, 7, ch - 8);
      g.fillStyle = column === 'done' ? '#7a6f65' : INK;
      g.textBaseline = 'top';
      lines.forEach((line, i) => {
        const ly = cy + 9 + i * (fs + 6);
        g.fillText(line, x + 28, ly);
        if (column === 'done') {
          g.fillRect(x + 28, ly + fs * 0.55, Math.min(g.measureText(line).width, inner - 26), 2);
        }
      });
      g.textBaseline = 'alphabetic';
      cy += ch + 8;
      drawn++;
    }
    const more = items.length - drawn;
    g.font = `800 20px ${FONT}`;
    g.fillStyle = 'rgba(43,45,66,.7)';
    g.textBaseline = 'middle';
    if (!items.length) {
      g.textAlign = 'center';
      g.fillText(column === 'active' ? 'Nothing active' : column === 'urgent' ? 'Nothing urgent 🎉' : column === 'todo' ? 'All clear' : 'None yet', x + w / 2, y + headH + 40);
      g.textAlign = 'left';
    } else if (more > 0) g.fillText(`+${more} more`, x + 16, Math.min(bottom - 10, cy + 12));
    g.textBaseline = 'alphabetic';
  }

  private round(x: number, y: number, w: number, h: number, r: number) {
    const g = this.ctx;
    g.beginPath();
    g.roundRect(x, y, w, h, r);
  }
}

/** The switch above the issues board: turns it over to the floor's issues, or back to your To Do. */
export class IssuesWallSwitch {
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
  render(mode: IssuesWallMode) {
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
    g.fillStyle = mode === 'todo' ? '#fff7b0' : '#ffd6de';
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = INK;
    g.stroke();
    g.fillStyle = INK;
    g.font = `900 44px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(mode === 'todo' ? '📌 Show Issues' : '🔥 Show To Do', W / 2, (H - 18) / 2 + 2);
    this.texture.needsUpdate = true;
  }
}
