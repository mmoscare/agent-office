import * as THREE from 'three';
import { SYNC_BUTTON } from '../../shared/layout';
import { mesh, roundedBox, textPlane, toon, toonUnique } from './toon';
import type { Collider, Interactable } from './office';

// 🔄 Sync everything (ui/sync-all.ts): a big round push-button on a pedestal beside the merge gong.
// Walk up and press E, or click it: it saves and uploads the floor's unsaved work and the app
// folder's, pulls the latest, and says what to do next. It dips when pressed and glows while a sync runs.

const INK = '#2b2d42';
const CAP = '#06d6a0';
const BRASS = '#e9b949';

export interface SyncButton {
  group: THREE.Group;
  colliders: Collider[];
  interactable: Interactable;
  /** The button dips, like a real one. */
  press(): void;
  /** Glows and turns its arrows while a sync runs. */
  setBusy(on: boolean): void;
  update(dt: number): void;
}

export function buildSyncButton(): SyncButton {
  const { x, z, radius, height } = SYNC_BUTTON;
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  const ink = toon(INK);

  // A plinth, a slim column, and a brass collar the button sits in.
  group.add(mesh(roundedBox(radius * 2 + 0.12, 0.1, radius * 2 + 0.12, 0.04), ink, 0, 0.05, 0));
  group.add(mesh(new THREE.CylinderGeometry(radius * 0.72, radius * 0.85, height - 0.2, 16), toon('#8d99ae'), 0, 0.1 + (height - 0.2) / 2, 0));
  group.add(mesh(new THREE.CylinderGeometry(radius + 0.02, radius * 0.8, 0.12, 24), toon(BRASS), 0, height - 0.06, 0));

  // The button: a fat green cap with the sync arrows on top, tilted a little towards whoever walks up.
  const top = new THREE.Group();
  top.position.set(0, height, 0);
  top.rotation.x = 0.28;
  group.add(top);
  const capMat = toonUnique(CAP);
  capMat.emissive = new THREE.Color('#2ee6b0');
  capMat.emissiveIntensity = 0;
  const cap = new THREE.Group();
  top.add(cap);
  cap.add(mesh(new THREE.CylinderGeometry(radius * 0.86, radius * 0.9, 0.12, 28), capMat, 0, 0.06, 0));
  cap.add(mesh(new THREE.SphereGeometry(radius * 0.86, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.28, 1), capMat, 0, 0.12, 0, false));
  const arrows = textPlane('🔄', { bg: 'rgba(0,0,0,0)', size: 96 });
  arrows.scale.multiplyScalar(0.34);
  arrows.rotation.x = -Math.PI / 2;
  arrows.position.y = 0.2;
  cap.add(arrows);

  // A plaque on the column, facing the room.
  const plaque = textPlane('🔄 Sync', { bg: '#fffaf3', size: 44 });
  plaque.scale.multiplyScalar(0.36);
  plaque.position.set(0, height * 0.62, radius * 0.78 + 0.01);
  group.add(plaque);

  const colliders: Collider[] = [{ minX: x - radius - 0.06, maxX: x + radius + 0.06, minZ: z - radius - 0.06, maxZ: z + radius + 0.06, top: height + 0.15 }];
  const interactable: Interactable = { kind: 'sync', x, z: z + 0.85, radius: 0.85 };
  group.userData.interact = interactable;

  let dip = 0;
  let busy = false;
  let glow = 0;
  let t = 0;
  return {
    group,
    colliders,
    interactable,
    press() {
      dip = 1;
      glow = Math.max(glow, 0.8);
    },
    setBusy(on) {
      busy = on;
    },
    update(dt) {
      t += dt;
      dip = Math.max(0, dip - dt * 4);
      cap.position.y = -0.06 * Math.sin(Math.min(1, dip) * Math.PI);
      glow = busy ? 0.45 + 0.35 * Math.sin(t * 5) : glow * Math.exp(-dt * 3);
      capMat.emissiveIntensity = glow * 0.6;
      if (busy) arrows.rotation.z -= dt * 3;
    },
  };
}
