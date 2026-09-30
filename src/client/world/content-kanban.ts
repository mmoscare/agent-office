import * as THREE from 'three';
import { CONTENT_STAGES, contentIn, FORMAT_ICON, piecesDone, STAGE_ICON, STAGE_ORDER, type ContentItem, type ContentStage } from '../../shared/content-kanban';
import { dueLabel, dueState } from '../ui/content-kanban';
import { wrap } from './boards';

// The 🎬 Content Kanban on the whiteboard's stand (see ui/content-kanban.ts), on the floor that has
// one: the pipeline's six columns, each card with its checklist of what it's being made into.

const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
const INK = '#2b2d42';
/** Header colour, the tint behind the cards, and the stripe down each card, per stage. */
export const STAGE_LOOK: Record<ContentStage, { head: string; headInk: string; tint: string; edge: string }> = {
  idea: { head: '#ffd166', headInk: INK, tint: '#fff8e1', edge: '#d9a300' },
  script: { head: '#cdb4ff', headInk: INK, tint: '#f3edff', edge: '#7b5cd6' },
  create: { head: '#ef476f', headInk: '#fff', tint: '#ffe4ea', edge: '#b3122f' },
  edit: { head: '#4cc9f0', headInk: INK, tint: '#e3f6fd', edge: '#118ab2' },
  scheduled: { head: '#06d6a0', headInk: INK, tint: '#e0f8f0', edge: '#07966f' },
  published: { head: '#dfe3ea', headInk: INK, tint: '#f2f4f7', edge: '#8d99ae' },
};
/** How wide each column is, relative to the others. */
const WEIGHT: Record<ContentStage, number> = { idea: 1.1, script: 1, create: 1, edit: 1, scheduled: 1, published: 0.85 };

export class ContentKanbanTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;

  constructor(width: number, height: number) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
  }

  /** For checks: the canvas as drawn. */
  get image(): HTMLCanvasElement {
    return this.canvas;
  }

  render(items: readonly ContentItem[]) {
    const g = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    // A glossy whiteboard, like the drawing side.
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, W, H);
    const shine = g.createLinearGradient(0, 0, W * 0.5, H * 0.6);
    shine.addColorStop(0, 'rgba(210, 225, 240, 0.45)');
    shine.addColorStop(1, 'rgba(210, 225, 240, 0)');
    g.fillStyle = shine;
    g.fillRect(0, 0, W, H);

    const pad = 28;
    g.fillStyle = INK;
    g.textBaseline = 'alphabetic';
    g.font = `900 60px ${FONT}`;
    g.fillText('🎬 Content Kanban', pad, 76);
    const titleW = g.measureText('🎬 Content Kanban').width;
    g.font = `800 30px ${FONT}`;
    g.fillStyle = 'rgba(43,45,66,.7)';
    g.fillText('Press E to dump ideas, pick what you’ll make, and tick it off', pad + titleW + 30, 72);
    // How much of everything picked is made, on the right.
    const pieces = items.filter((t) => t.stage !== 'published').reduce((s, t) => {
      const p = piecesDone(t);
      return { done: s.done + p.done, total: s.total + p.total };
    }, { done: 0, total: 0 });
    if (pieces.total) {
      const text = `✅ ${pieces.done}/${pieces.total} pieces made`;
      g.font = `900 30px ${FONT}`;
      const w = g.measureText(text).width + 36;
      g.fillStyle = '#eef7ee';
      this.round(W - pad - w, 34, w, 50, 25);
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = INK;
      g.stroke();
      g.fillStyle = INK;
      g.textBaseline = 'middle';
      g.fillText(text, W - pad - w + 18, 60);
      g.textBaseline = 'alphabetic';
    }

    const top = 108;
    const gap = 16;
    const total = STAGE_ORDER.reduce((s, c) => s + WEIGHT[c], 0);
    const room = W - pad * 2 - gap * (STAGE_ORDER.length - 1);
    let x = pad;
    for (const stage of STAGE_ORDER) {
      const w = (room * WEIGHT[stage]) / total;
      this.column(stage, contentIn(items, stage), x, top, w, H - top - pad);
      x += w + gap;
    }
    this.texture.needsUpdate = true;
  }

  private column(stage: ContentStage, items: ContentItem[], x: number, y: number, w: number, h: number) {
    const g = this.ctx;
    const look = STAGE_LOOK[stage];
    g.fillStyle = 'rgba(0,0,0,.12)';
    this.round(x + 4, y + 6, w, h, 20);
    g.fill();
    g.fillStyle = look.tint;
    this.round(x, y, w, h, 20);
    g.fill();
    g.lineWidth = 5;
    g.strokeStyle = look.edge;
    g.stroke();
    const headH = 64;
    g.save();
    this.round(x, y, w, h, 20);
    g.clip();
    g.fillStyle = look.head;
    g.fillRect(x, y, w, headH);
    g.restore();
    const count = String(items.length);
    g.font = `900 28px ${FONT}`;
    const cw = Math.max(44, g.measureText(count).width + 22);
    const name = `${STAGE_ICON[stage]} ${CONTENT_STAGES[stage]}`;
    const nameW = w - cw - 40;
    let hs = 34;
    g.font = `900 ${hs}px ${FONT}`;
    while (hs > 22 && g.measureText(name).width > nameW) g.font = `900 ${--hs}px ${FONT}`;
    g.fillStyle = look.headInk;
    g.textBaseline = 'middle';
    g.fillText(name, x + 16, y + headH / 2 + 1, nameW);
    g.font = `900 28px ${FONT}`;
    g.fillStyle = '#fff';
    this.round(x + w - cw - 14, y + 14, cw, 36, 18);
    g.fill();
    g.fillStyle = INK;
    g.textAlign = 'center';
    g.fillText(count, x + w - cw / 2 - 14, y + 33);
    g.textAlign = 'left';

    // The cards, top first, as many as fit.
    const inner = w - 28;
    let cy = y + headH + 14;
    const bottom = y + h - 12;
    const fs = stage === 'published' ? 24 : 27;
    let drawn = 0;
    for (const item of items) {
      g.font = `800 ${fs}px ${FONT}`;
      const lines = wrap(g, item.title, inner - 30, stage === 'published' ? 1 : 2);
      const pills = this.pillRows(item, inner - 30);
      const due = item.due ? dueLabel(item.due) : '';
      const ch = 18 + lines.length * (fs + 8) + pills.length * 40 + (due ? 34 : 0);
      const left = items.length - drawn - 1;
      if (cy + ch > bottom - (left ? 40 : 0)) break;
      g.fillStyle = 'rgba(0,0,0,.14)';
      this.round(x + 14 + 3, cy + 4, inner, ch, 12);
      g.fill();
      g.fillStyle = '#fff';
      this.round(x + 14, cy, inner, ch, 12);
      g.fill();
      g.fillStyle = look.edge;
      g.fillRect(x + 14, cy + 5, 8, ch - 10);
      g.fillStyle = stage === 'published' ? '#6c757d' : INK;
      g.textBaseline = 'top';
      let ly = cy + 10;
      for (const line of lines) {
        g.fillText(line, x + 32, ly);
        ly += fs + 8;
      }
      if (due) {
        const state = stage === 'published' ? 'ok' : dueState(item.due!);
        g.font = `800 22px ${FONT}`;
        g.fillStyle = state === 'late' ? '#b3122f' : state === 'soon' ? '#c26a00' : 'rgba(43,45,66,.7)';
        g.fillText(`📅 ${due}`, x + 32, ly + 2, inner - 30);
        ly += 34;
      }
      for (const row of pills) {
        let px = x + 32;
        for (const p of row) {
          g.font = `800 22px ${FONT}`;
          g.fillStyle = p.done ? '#d5f5e3' : '#f4f5f7';
          this.round(px, ly, p.w, 32, 16);
          g.fill();
          g.lineWidth = 2;
          g.strokeStyle = p.done ? '#07966f' : 'rgba(43,45,66,.35)';
          g.stroke();
          g.fillStyle = p.done ? '#05603f' : INK;
          g.fillText(p.text, px + 10, ly + 5);
          px += p.w + 8;
        }
        ly += 40;
      }
      g.textBaseline = 'alphabetic';
      cy += ch + 10;
      drawn++;
    }
    const more = items.length - drawn;
    g.font = `800 26px ${FONT}`;
    g.fillStyle = 'rgba(43,45,66,.6)';
    g.textBaseline = 'middle';
    if (!items.length) {
      g.textAlign = 'center';
      g.fillText(stage === 'idea' ? 'Dump ideas here' : 'Nothing yet', x + w / 2, y + headH + 50);
      g.textAlign = 'left';
    } else if (more > 0) g.fillText(`+${more} more`, x + 20, Math.min(bottom - 14, cy + 16));
    g.textBaseline = 'alphabetic';
  }

  /** A card's checklist as pills (an icon, and a tick once it's made), wrapped into rows that fit `maxW`. */
  private pillRows(item: ContentItem, maxW: number): { text: string; w: number; done: boolean }[][] {
    const g = this.ctx;
    g.font = `800 22px ${FONT}`;
    const rows: { text: string; w: number; done: boolean }[][] = [];
    let row: { text: string; w: number; done: boolean }[] = [];
    let used = 0;
    for (const p of item.pieces) {
      const text = `${FORMAT_ICON[p.format]}${p.done ? ' ✓' : ''}`;
      const w = g.measureText(text).width + 20;
      if (row.length && used + w > maxW) {
        rows.push(row);
        row = [];
        used = 0;
      }
      row.push({ text, w, done: !!p.done });
      used += w + 8;
    }
    if (row.length) rows.push(row);
    return rows.slice(0, 2);
  }

  private round(x: number, y: number, w: number, h: number, r: number) {
    const g = this.ctx;
    g.beginPath();
    g.roundRect(x, y, w, h, r);
  }
}
