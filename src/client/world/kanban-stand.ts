import * as THREE from 'three';
import { AUTONOMOUS_BOARD } from '../../shared/layout';
import { mesh, roundedBox, textPlane, toon } from './toon';
import type { Collider, Interactable } from './office';

// The 🏢 Autonomous Tasks whiteboard: a second rolling whiteboard out on the floor, south of the
// drawing one, with the office's Autonomous Tasks kanban on its face (see ui/todos.ts). Walk up and
// press E to open it.

const ALU = '#aab4be';
const INK = '#2b2d42';

export interface KanbanStand {
  group: THREE.Group;
  colliders: Collider[];
  interactable: Interactable;
  /** The face: its map is the board's texture (world/todo-wall.ts). */
  face: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
}

export function buildKanbanStand(): KanbanStand {
  const { x, z, width, height, bottom, rotY, label } = AUTONOMOUS_BOARD;
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = rotY;
  const alu = toon(ALU);
  const ink = toon(INK);
  const mid = bottom + height / 2;
  const post = width / 2 + 0.1;

  const frame = mesh(roundedBox(width + 0.14, 0.07, height + 0.14, 0.04), alu, 0, mid, 0);
  frame.rotation.x = Math.PI / 2;
  group.add(frame);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }));
  face.position.set(0, mid, 0.04);
  group.add(face);

  // Two posts on feet with casters, and a bar across the bottom, like the drawing whiteboard's.
  for (const sx of [-post, post]) {
    group.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, bottom + height + 0.2, 10), alu, sx, (bottom + height + 0.2) / 2 + 0.1, 0));
    group.add(mesh(roundedBox(0.09, 0.07, 0.95, 0.03), alu, sx, 0.13, 0));
    for (const sz of [-0.42, 0.42]) {
      const wheel = mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.04, 12), ink, sx, 0.055, sz, false);
      wheel.rotation.z = Math.PI / 2;
      group.add(wheel);
    }
    group.add(mesh(new THREE.SphereGeometry(0.05, 10, 8), alu, sx, bottom + height + 0.3, 0, false));
  }
  group.add(mesh(new THREE.CylinderGeometry(0.025, 0.025, post * 2, 8).rotateZ(Math.PI / 2), alu, 0, 0.3, 0, false));

  const plaque = textPlane(label, { bg: '#fffaf3', size: 48 });
  plaque.scale.multiplyScalar(0.55);
  plaque.position.set(0, bottom + height + 0.2, 0.05);
  group.add(plaque);

  // Facing +z or -z, so its footprint stays axis-aligned.
  const colliders: Collider[] = [{ minX: x - post - 0.1, maxX: x + post + 0.1, minZ: z - 0.48, maxZ: z + 0.48, top: bottom + height + 0.35 }];
  const out = Math.cos(rotY) >= 0 ? 1 : -1;
  const interactable: Interactable = { kind: 'autonomous', x, z: z + out * 1.7, radius: 2.3 };
  group.userData.interact = interactable;
  return { group, colliders, interactable, face };
}
