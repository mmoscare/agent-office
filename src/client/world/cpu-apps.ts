import * as THREE from 'three';
import type { CpuApp } from '../../shared/protocol';
import { CPU_APPS } from '../../shared/layout';
import { loadColor } from './machine';

const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
const INK = '#1b1d2e';
const MUTED = '#9aa0b8';
const W = 920;
const H = Math.round((W * CPU_APPS.height) / CPU_APPS.width);

/**
 * The list above the machine monitor: the five apps using the most CPU, and what percent of the
 * machine each one has.
 */
export class CpuAppsTexture {
  readonly texture: THREE.CanvasTexture;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private drawn = '';

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
  }

  render(apps: CpuApp[] | undefined) {
    const key = apps ? JSON.stringify(apps) : '-';
    if (key === this.drawn) return;
    this.drawn = key;
    const g = this.ctx;
    g.fillStyle = INK;
    g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillStyle = '#ffffff';
    g.font = `900 40px ${FONT}`;
    g.fillText('Top 5 CPU', 28, 52);
    g.textAlign = 'right';
    g.fillStyle = MUTED;
    g.font = `700 22px ${FONT}`;
    g.fillText('% of this machine', W - 28, 48);

    if (!apps) this.note('Reading…');
    else if (!apps.length) this.note('Nothing busy');
    else this.rows(apps.slice(0, 5));
    this.texture.needsUpdate = true;
  }

  private note(text: string) {
    const g = this.ctx;
    g.textAlign = 'center';
    g.fillStyle = MUTED;
    g.font = `800 36px ${FONT}`;
    g.fillText(text, W / 2, H / 2 + 24);
  }

  private rows(apps: CpuApp[]) {
    const g = this.ctx;
    const top = Math.max(apps[0]?.pct ?? 1, 0.1);
    const rowH = 90;
    const y0 = 74;
    apps.forEach((app, i) => {
      const y = y0 + i * rowH;
      g.fillStyle = '#25283d';
      roundRect(g, 20, y, W - 40, rowH - 10, 14);
      g.fill();
      const color = loadColor(app.pct);
      g.textAlign = 'left';
      g.fillStyle = MUTED;
      g.font = `800 28px ${FONT}`;
      g.fillText(String(i + 1), 36, y + 48);
      g.fillStyle = '#ffffff';
      g.font = `800 32px ${FONT}`;
      g.fillText(fit(g, app.name, 520), 78, y + 40);
      g.textAlign = 'right';
      g.fillStyle = color;
      g.font = `900 36px ${FONT}`;
      const pct = `${app.pct.toFixed(1)}%`;
      g.fillText(pct, W - 40, y + 44);
      const bx = 78;
      const bw = 520;
      const by = y + 54;
      g.fillStyle = '#3a3d55';
      roundRect(g, bx, by, bw, 12, 6);
      g.fill();
      g.fillStyle = color;
      roundRect(g, bx, by, Math.min(bw, Math.max(10, (app.pct / top) * bw)), 12, 6);
      g.fill();
    });
  }
}

function fit(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && g.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}
