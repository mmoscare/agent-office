import * as THREE from 'three';
import { mesh, roundedBox, textPlane, toon } from './toon';

/** A closed white binder, flat on the desktop; local bottom is y=0. */
export function buildPlansBinder(): THREE.Group {
  const binder = new THREE.Group();
  binder.name = 'to-do-next-binder';
  const white = toon('#ffffff');
  for (const y of [0.015, 0.105]) binder.add(mesh(roundedBox(0.64, 0.025, 0.78, 0.02), white, 0, y, 0));
  binder.add(mesh(roundedBox(0.57, 0.065, 0.72, 0.01), toon('#e8e7e2'), 0.015, 0.06, 0));
  binder.add(mesh(roundedBox(0.065, 0.1, 0.78, 0.02), white, -0.29, 0.06, 0));
  const label = textPlane('To Do Next', { size: 48, color: '#303747' });
  label.scale.setScalar(0.5 / label.geometry.parameters.width);
  label.rotation.x = -Math.PI / 2;
  label.position.set(0.015, 0.12, 0);
  binder.add(label);
  for (const z of [-0.23, 0.23]) binder.add(mesh(roundedBox(0.025, 0.004, 0.045, 0.005), toon('#aeb6bf'), -0.27, 0.119, z));
  return binder;
}
