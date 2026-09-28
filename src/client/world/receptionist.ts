import * as THREE from 'three';
import { mesh, toon, toonUnique } from './toon';

/** Small bits (lashes, the mic) are drawn without the cartoon outline, which would swallow them. */
const detail = (color: string) => {
  const m = toonUnique(color);
  m.userData.outlineParameters = { visible: false };
  return m;
};

/**
 * The Receptionist's look, worn over an ordinary worker (see Worker.accessory): her hair up in a bun
 * with a bow, lashes and rosy cheeks, a mic on her headset, and a name badge. In the worker's own
 * space: its bean's middle is at y 0.55, its eyes at y 0.7 on its front (+z), its headset's cups at
 * x ±0.29.
 */
export function receptionistLook(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'receptionist-look';
  const hair = toon('#4a2c1d');
  const pink = toon('#ff5d8f');

  // A high bun at the back of her head, its base wrapped round.
  g.add(mesh(new THREE.SphereGeometry(0.125, 16, 12), hair, 0, 0.94, -0.18));
  const wrap = mesh(new THREE.TorusGeometry(0.095, 0.032, 8, 20), hair, 0, 0.9, -0.15);
  wrap.rotation.x = 1.1;
  g.add(wrap);

  // A bow on the front of the bun: two loops and a knot.
  const bow = new THREE.Group();
  for (const sx of [-1, 1]) {
    const loop = mesh(new THREE.ConeGeometry(0.055, 0.1, 12), pink, sx * 0.05, 0, 0);
    loop.rotation.z = sx * (Math.PI / 2);
    loop.scale.set(1, 1, 0.45);
    bow.add(loop);
  }
  bow.add(mesh(new THREE.SphereGeometry(0.028, 10, 8), pink, 0, 0, 0));
  bow.position.set(0, 1.04, -0.1);
  bow.rotation.x = -0.35;
  g.add(bow);

  // Two lashes at the outer corner of each eye.
  const ink = detail('#1d1d1d');
  for (const sx of [-1, 1]) {
    for (const k of [0, 1]) {
      const lash = mesh(new THREE.BoxGeometry(0.05, 0.013, 0.013), ink, sx * (0.175 + k * 0.012), 0.772 - k * 0.028, 0.232, false);
      lash.rotation.z = sx * (0.45 + k * 0.4);
      g.add(lash);
    }
  }

  // Rosy cheeks.
  const blush = detail('#ff9fb4');
  for (const sx of [-1, 1]) {
    const cheek = mesh(new THREE.SphereGeometry(0.042, 10, 8), blush, sx * 0.175, 0.6, 0.225, false);
    cheek.scale.set(1, 0.6, 0.35);
    g.add(cheek);
  }

  // Her headset's mic: a boom from the right ear cup round to her mouth.
  const dark = detail('#2b2d42');
  const boom = new THREE.CatmullRomCurve3([new THREE.Vector3(0.3, 0.7, 0.03), new THREE.Vector3(0.285, 0.62, 0.14), new THREE.Vector3(0.21, 0.565, 0.235), new THREE.Vector3(0.1, 0.55, 0.28)]);
  g.add(mesh(new THREE.TubeGeometry(boom, 16, 0.012, 6, false), dark, 0, 0, 0, false));
  g.add(mesh(new THREE.SphereGeometry(0.03, 10, 8), dark, 0.09, 0.55, 0.285, false));

  // A name badge on her chest.
  const badge = new THREE.Group();
  badge.add(mesh(new THREE.BoxGeometry(0.11, 0.07, 0.012), toon('#ffffff'), 0, 0, 0, false));
  badge.add(mesh(new THREE.BoxGeometry(0.11, 0.022, 0.014), detail('#ff5d8f'), 0, 0.024, 0.001, false));
  badge.position.set(-0.13, 0.45, 0.252);
  badge.rotation.y = -0.47;
  g.add(badge);
  return g;
}
