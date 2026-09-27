import * as THREE from 'three';
import { PHONE } from '../../shared/layout';
import { mesh, roundedBox, textPlane, toon, toonUnique } from './toon';

// The office phone: an old red wall phone on the elevator's pillar. It rings when an agent worker
// on another floor finishes, since you can't hear that floor's dings from here: the handset rattles
// on its hook and the lamp on top flashes.

const RED = '#d62839';
const INK = '#2b2d42';

export interface Phone {
  group: THREE.Group;
  /** Rattles for `seconds`; a call while it's still ringing keeps it going. */
  ring(seconds: number): void;
  update(dt: number): void;
}

export function buildPhone(): Phone {
  const group = new THREE.Group();
  group.position.set(PHONE.x, PHONE.y, PHONE.z);
  const red = toon(RED);
  const ink = toon(INK);

  // The body on the pillar, with a round dial on its face.
  group.add(mesh(roundedBox(0.26, 0.36, 0.08, 0.03), red, 0, 0, 0.04, false));
  const dial = mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.02, 20).rotateX(Math.PI / 2), toon('#fffaf3'), 0, -0.05, 0.085, false);
  group.add(dial);
  group.add(mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.025, 12).rotateX(Math.PI / 2), ink, 0, -0.05, 0.095, false));

  // The handset hangs on a hook up the left side, so it can jump about when it rings.
  const handset = new THREE.Group();
  handset.position.set(-0.08, 0.1, 0.1);
  handset.add(mesh(roundedBox(0.05, 0.3, 0.05, 0.02), red, 0, 0, 0, false));
  for (const sy of [-1, 1]) handset.add(mesh(roundedBox(0.09, 0.07, 0.06, 0.025), red, 0.01, sy * 0.15, 0.01, false));
  group.add(handset);
  // A coiled cord looping down from it to the body.
  const coil = mesh(new THREE.TorusGeometry(0.035, 0.008, 5, 14), ink, -0.08, -0.14, 0.1, false);
  coil.scale.y = 2.2;
  group.add(coil);

  // A lamp on top that flashes while it rings.
  const lamp = toonUnique('#fff3b0');
  lamp.emissive = new THREE.Color('#ffb703');
  lamp.emissiveIntensity = 0;
  group.add(mesh(new THREE.SphereGeometry(0.04, 12, 8), lamp, 0.07, 0.2, 0.06, false));

  const plaque = textPlane('📞 Other floors', { bg: '#fffaf3', size: 40 });
  plaque.scale.multiplyScalar(0.26);
  plaque.position.set(0, -0.28, 0.02);
  group.add(plaque);

  let left = 0;
  let t = 0;
  return {
    group,
    ring(seconds) {
      // In step with the bell: a new call starts on a burst.
      if (left <= 0) t = 0;
      left = Math.max(left, seconds);
    },
    update(dt) {
      if (left <= 0) return;
      left -= dt;
      t += dt;
      if (left <= 0) {
        handset.position.y = 0.1;
        handset.rotation.z = 0;
        lamp.emissiveIntensity = 0;
        return;
      }
      // It rings in bursts of about a second and a half, two seconds apart, like the bell does.
      const on = t % 3.5 < 1.6;
      handset.position.y = 0.1 + (on ? Math.abs(Math.sin(t * 70)) * 0.012 : 0);
      handset.rotation.z = on ? Math.sin(t * 55) * 0.06 : 0;
      lamp.emissiveIntensity = on && Math.sin(t * 14) > 0 ? 1 : 0.1;
    },
  };
}
