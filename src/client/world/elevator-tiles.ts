import * as THREE from 'three';
import type { FloorInfo } from '../../shared/protocol';
import { backOfficeFloors, floorNumber, floorPalette, mainFloors } from '../../shared/floors';
import { ELEVATOR, FLOOR } from '../../shared/layout';
import { ROOF, ROOF_NAME } from '../../shared/rooftop';
import type { Interactable } from './office';
import { mesh, textPlane, toon } from './toon';

const PAGE_SIZE = 6;

/** A small directory mounted above the back handrail, with full-size tiles on every page. */
export function buildElevatorTiles() {
  const group = new THREE.Group();
  group.name = 'elevator-floor-tiles';
  group.position.set(ELEVATOR.x, 0, FLOOR.minZ + 0.06);
  group.add(mesh(new THREE.BoxGeometry(2.12, 1.72, 0.04), toon('#2b2d42'), 0, 1.87, 0, false));
  const heading = textPlane('FLOORS', { color: '#fff7d6', size: 32 });
  heading.position.set(0, 2.57, 0.03);
  group.add(heading);
  const buttons = new THREE.Group();
  group.add(buttons);
  let floors: FloorInfo[] = [];
  let current: string | null = null;
  let page = 0;
  let signature = '';

  const clear = () => {
    for (const child of buttons.children) {
      const tile = child as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
      tile.geometry.dispose();
      tile.material.map?.dispose();
      tile.material.dispose();
    }
    buttons.clear();
  };

  const tile = (label: string, sub: string, badge: string, color: string, x: number, y: number, action: Partial<Interactable>, disabled = false, width = 0.96, height = 0.35) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(175 * width / height);
    canvas.height = 175;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = disabled ? '#dbe1e8' : '#fff7e8';
    ctx.beginPath();
    ctx.roundRect(4, 4, canvas.width - 8, 167, 18);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.fillStyle = '#2b2d42';
    ctx.textBaseline = 'middle';
    ctx.font = '800 42px Nunito, system-ui, sans-serif';
    // Room for a wider badge such as "B12".
    const start = badge ? Math.max(90, 36 + ctx.measureText(badge).width) : 24;
    if (badge) ctx.fillText(badge, 22, 65);
    let name = label;
    while (name.length > 1 && ctx.measureText(name).width > canvas.width - 30 - start) name = name.slice(0, -2) + '…';
    ctx.fillText(name, start, 65);
    ctx.font = '700 28px Nunito, system-ui, sans-serif';
    ctx.fillStyle = '#555b70';
    ctx.fillText(sub, 24, 125);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const button = mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, transparent: true }), x, y, 0.04, false);
    button.userData.interact = { kind: 'elevator', x: ELEVATOR.x + x, z: FLOOR.minZ + 0.1, radius: 0, ...action } satisfies Interactable;
    buttons.add(button);
  };

  const render = () => {
    clear();
    // Numbered the way the elevator panel numbers them. The Back Office's floors come after the main
    // floors and the roof, so the first page keeps the short list.
    const destination = (f: FloorInfo) => ({ id: f.id, name: f.name, badge: floorNumber(floors, f.id), color: floorPalette(f.palette).trim, cloning: !!f.cloning });
    const destinations = mainFloors(floors).map(destination);
    if (floors.some(f => !f.cloning)) destinations.push({ id: ROOF, name: ROOF_NAME, badge: 'R', color: '#9470e0', cloning: false });
    destinations.push(...backOfficeFloors(floors).map(destination));
    const pages = Math.max(1, Math.ceil(destinations.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    destinations.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).forEach((f, i) => {
      const here = f.id === current;
      tile(f.name, here ? 'You are here' : f.cloning ? 'Cloning…' : 'Click / E to ride', f.badge, f.color,
        i % 2 ? 0.51 : -0.51, 2.27 - Math.floor(i / 2) * 0.41, { floorId: f.id }, here || f.cloning);
    });
    // The full picker remains available for adding projects, including an empty building.
    tile('All floors', 'Add a project', '', '#e9b949', 0, 1.1, {}, false, 0.96, 0.19);
    if (pages > 1) {
      tile('‹', 'Previous', '', '#e9b949', -0.79, 1.1, { elevatorPage: -1 }, false, 0.43, 0.19);
      tile('›', `${page + 1} / ${pages}`, '', '#e9b949', 0.79, 1.1, { elevatorPage: 1 }, false, 0.43, 0.19);
    }
  };

  return {
    group,
    setFloors(next: FloorInfo[], here: string | null) {
      // Worker/people counts update often; only redraw when the directory itself changes.
      const key = JSON.stringify([here, next.map(f => [f.id, f.name, f.palette, !!f.cloning, !!f.backOffice])]);
      if (key === signature) return;
      signature = key;
      if (here !== current) page = 0;
      floors = next;
      current = here;
      render();
    },
    turnPage(direction: number) {
      const count = floors.length + Number(floors.some(f => !f.cloning));
      const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
      page = (page + direction + pages) % pages;
      render();
    },
  };
}
