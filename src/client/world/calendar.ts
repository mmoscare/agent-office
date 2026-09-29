import * as THREE from 'three';
import { choresOnDay, monthGrid, monthTitle, officeDate, WEEKDAYS, type OfficeDate } from '../../shared/calendar';
import { wallPose } from '../../shared/decor';
import { CALENDAR, LOFT } from '../../shared/layout';
import { mesh, roundedBox, toon } from './toon';
import type { Interactable, Office } from './office';

const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
const W = 528;
const H = 672;
const DOTS = ['#06d6a0', '#118ab2', '#ffd166'];

function paint(g: CanvasRenderingContext2D, today: OfficeDate, view: Pick<OfficeDate, 'year' | 'month'>, done: boolean) {
  g.fillStyle = '#c9a227';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff6e8';
  g.fillRect(10, 36, W - 20, H - 46);
  g.fillStyle = '#c1121f';
  g.fillRect(10, 36, W - 20, 78);
  for (let i = 0; i < 7; i++) {
    const x = 48 + i * 72;
    g.fillStyle = '#d6d3d1';
    g.beginPath();
    g.arc(x, 22, 10, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#78716c';
    g.beginPath();
    g.arc(x, 22, 5, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = '#fff6e8';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `900 36px ${FONT}`;
  g.fillText(monthTitle(view), W / 2, 76, 480);
  g.fillStyle = '#7f1d1d';
  g.font = `800 18px ${FONT}`;
  WEEKDAYS.forEach((d, i) => g.fillText(d, 48 + i * 68, 138));
  const weeks = monthGrid(view.year, view.month);
  const current = today.year === view.year && today.month === view.month;
  weeks.forEach((week, r) => {
    week.forEach((day, c) => {
      if (!day) return;
      const x = 48 + c * 68;
      const y = 178 + r * 78;
      const isToday = current && day === today.day;
      const chores = choresOnDay(day);
      if (isToday) {
        g.fillStyle = '#fee2e2';
        g.beginPath();
        g.arc(x, y, 28, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#c1121f';
        g.lineWidth = 3;
        g.stroke();
      }
      g.fillStyle = isToday ? '#c1121f' : chores.length ? '#9f1239' : '#1c1917';
      g.font = `800 26px ${FONT}`;
      g.fillText(String(day), x, y - (chores.length ? 6 : 0));
      if (chores.length) {
        chores.forEach((_, i) => {
          g.fillStyle = done ? '#06d6a0' : DOTS[i % DOTS.length];
          g.beginPath();
          g.arc(x - 12 + i * 12, y + 18, 5, 0, Math.PI * 2);
          g.fill();
        });
      }
    });
  });
}

/**
 * The wall calendar in the boss office: south wall, west of the bookshelf. Click it (or the ☰
 * menu) to open the month and the first-of-the-month chores (ui/calendar.ts).
 */
export function mountCalendarWall(office: Office) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const group = new THREE.Group();
  const frame = mesh(roundedBox(CALENDAR.width + 0.1, 0.05, CALENDAR.height + 0.12, 0.03), toon('#8a5a3b'), 0, 0, 0);
  frame.rotation.x = Math.PI / 2;
  group.add(frame);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(CALENDAR.width, CALENDAR.height), new THREE.MeshBasicMaterial({ map: texture }));
  face.position.z = 0.03;
  group.add(face);
  group.add(mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.05, 8), toon('#c9a227'), 0, CALENDAR.height / 2 + 0.07, 0.01, false));
  const pose = wallPose(CALENDAR.wall, CALENDAR.u, CALENDAR.y, 0.08);
  group.position.set(pose.x, pose.y, pose.z);
  group.rotation.y = pose.rotY;
  const front = wallPose(CALENDAR.wall, CALENDAR.u, CALENDAR.y, 1.15);
  const interact: Interactable = { kind: 'calendar', x: front.x, y: LOFT.y, z: front.z, radius: 1.6 };
  group.userData.interact = interact;
  office.group.add(group);
  office.interactables.push(interact);
  let drawn = '';
  return (ms: number, utcOffset: number, done: boolean) => {
    const today = officeDate(ms, utcOffset);
    const key = `${monthKeyOf(today)}|${today.day}|${done}`;
    if (key === drawn) return;
    drawn = key;
    paint(g, today, today, done);
    texture.needsUpdate = true;
  };
}

function monthKeyOf(d: Pick<OfficeDate, 'year' | 'month'>): string {
  return `${d.year}-${d.month}`;
}
