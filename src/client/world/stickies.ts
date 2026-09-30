import * as THREE from 'three';
import { STICKY_ADD_AT, STICKY_COLORS, stickyPose, type StickyNote } from '../../shared/stickies';
import { wrap } from './boards';
import type { Interactable } from './office';

// Reminder stickies on the north wall, above the To Do board. Drawn in each browser from that
// person's own list, so they follow you onto every floor and nobody else sees yours.

const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';

function tiltOf(id: string): number {
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n * 33 + id.charCodeAt(i)) % 997;
  return ((n % 9) - 4) * 0.012;
}

function paint(note: StickyNote): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  const aspect = note.w / note.h;
  canvas.width = 640;
  canvas.height = Math.max(240, Math.round(640 / aspect));
  const g = canvas.getContext('2d')!;
  const look = STICKY_COLORS[note.color];
  const W = canvas.width;
  const H = canvas.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(43,45,66,.18)';
  g.beginPath();
  g.roundRect(18, 22, W - 28, H - 28, 18);
  g.fill();
  g.fillStyle = look.paper;
  g.beginPath();
  g.roundRect(8, 8, W - 28, H - 28, 16);
  g.fill();
  g.lineWidth = 8;
  g.strokeStyle = look.edge;
  g.stroke();
  // A folded corner.
  const fold = 54;
  g.beginPath();
  g.moveTo(W - 28 - fold, 8);
  g.lineTo(W - 20, 8 + fold);
  g.lineTo(W - 20, 8);
  g.closePath();
  g.fillStyle = look.edge;
  g.fill();
  // The pin.
  g.fillStyle = '#c23b22';
  g.beginPath();
  g.arc(W / 2 - 6, 36, 16, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,.45)';
  g.beginPath();
  g.arc(W / 2 - 12, 30, 5, 0, Math.PI * 2);
  g.fill();

  const pad = 36;
  const maxW = W - 28 - pad * 2;
  let size = 54;
  g.font = `800 ${size}px ${FONT}`;
  g.fillStyle = look.ink;
  g.textBaseline = 'top';
  g.textAlign = 'left';
  const blocks = note.text.split('\n');
  let lines: string[] = [];
  const maxLines = 7;
  for (const block of blocks) {
    const wrapped = block ? wrap(g, block, maxW, maxLines - lines.length) : [''];
    lines.push(...wrapped);
    if (lines.length >= maxLines) break;
  }
  lines = lines.slice(0, maxLines);
  while (size > 32 && lines.length * (size + 10) > H - 120) {
    size -= 4;
    g.font = `800 ${size}px ${FONT}`;
    lines = [];
    for (const block of blocks) {
      lines.push(...(block ? wrap(g, block, maxW, maxLines - lines.length) : ['']));
      if (lines.length >= maxLines) break;
    }
    lines = lines.slice(0, maxLines);
  }
  const lineH = size + 10;
  const top = 72;
  lines.forEach((line, i) => g.fillText(line, pad, top + i * lineH, maxW));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function paintAdd(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, 256, 256);
  g.fillStyle = '#fffaf3';
  g.beginPath();
  g.roundRect(16, 16, 224, 224, 36);
  g.fill();
  g.lineWidth = 12;
  g.strokeStyle = '#2b2d42';
  g.stroke();
  g.fillStyle = '#2b2d42';
  g.font = `900 140px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('+', 128, 132);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

interface Drawn {
  group: THREE.Group;
  paper: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  key: string;
}

/** The notes, and the + that adds one, parented to the office so every floor has them. */
export class StickyWall {
  readonly group = new THREE.Group();
  private drawn = new Map<string, Drawn>();
  private add: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

  constructor() {
    const pose = stickyPose(STICKY_ADD_AT.u, STICKY_ADD_AT.y);
    this.add = new THREE.Mesh(new THREE.PlaneGeometry(STICKY_ADD_AT.size, STICKY_ADD_AT.size), new THREE.MeshBasicMaterial({ map: paintAdd(), transparent: true }));
    this.add.position.set(pose.x, pose.y, pose.z);
    this.add.userData.interact = { kind: 'stickyAdd', x: pose.x, z: pose.z + 1.2, radius: 0 } satisfies Interactable;
    this.group.add(this.add);
  }

  sync(items: readonly StickyNote[]) {
    const shown = new Set(items.filter((n) => !n.hidden).map((n) => n.id));
    for (const [id, d] of this.drawn) {
      if (shown.has(id)) continue;
      d.paper.geometry.dispose();
      d.paper.material.map?.dispose();
      d.paper.material.dispose();
      d.group.removeFromParent();
      this.drawn.delete(id);
    }
    for (const note of items) {
      if (note.hidden) continue;
      const key = `${note.text}|${note.color}|${note.w}|${note.h}`;
      let d = this.drawn.get(note.id);
      if (!d || d.key !== key) {
        if (d) {
          d.paper.geometry.dispose();
          d.paper.material.map?.dispose();
          d.paper.material.dispose();
          d.group.removeFromParent();
        }
        const paper = new THREE.Mesh(new THREE.PlaneGeometry(note.w, note.h), new THREE.MeshBasicMaterial({ map: paint(note), transparent: true }));
        const group = new THREE.Group();
        group.add(paper);
        group.rotation.z = tiltOf(note.id);
        this.group.add(group);
        d = { group, paper, key };
        this.drawn.set(note.id, d);
      }
      const pose = stickyPose(note.u, note.y);
      d.group.position.set(pose.x, pose.y, pose.z);
      d.group.userData.interact = { kind: 'sticky', stickyId: note.id, x: pose.x, z: pose.z + 1.2, radius: 0 } satisfies Interactable;
    }
  }
}
