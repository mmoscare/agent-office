import * as THREE from 'three';
import { mesh, roundedBox, textPlane, toon } from './toon';

/** A ruled index card, flat on the desktop with a pencil beside it; local bottom is y=0. */
export function buildTimeCard(): THREE.Group {
  const card = new THREE.Group();
  card.name = 'indirect-time-card';
  card.add(mesh(roundedBox(0.5, 0.008, 0.3, 0.004), toon('#fffdf6'), 0, 0.004, 0));
  // A red rule under the heading, blue ones below it.
  card.add(mesh(new THREE.BoxGeometry(0.46, 0.002, 0.006), toon('#e5484d'), 0, 0.009, -0.07, false));
  for (const z of [-0.025, 0.02, 0.065, 0.11]) card.add(mesh(new THREE.BoxGeometry(0.46, 0.002, 0.004), toon('#8fb8ea'), 0, 0.009, z, false));
  const label = textPlane('Indirect Time', { size: 48, color: '#303747' });
  label.scale.setScalar(0.34 / label.geometry.parameters.width);
  label.rotation.x = -Math.PI / 2;
  label.position.set(0, 0.011, -0.105);
  card.add(label);
  const pencil = new THREE.Group();
  const body = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.24, 6), toon('#ffd166'), 0, 0, 0);
  const tip = mesh(new THREE.ConeGeometry(0.012, 0.035, 6), toon('#f2d2a9'), 0, 0.1375, 0);
  const eraser = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.03, 6), toon('#f28482'), 0, -0.135, 0);
  pencil.add(body, tip, eraser);
  pencil.rotation.z = -Math.PI / 2;
  pencil.rotation.y = 0.35;
  pencil.position.set(0.02, 0.012, 0.2);
  card.add(pencil);
  return card;
}
