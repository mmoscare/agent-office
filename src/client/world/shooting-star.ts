import * as THREE from 'three';

/*
 * Now and then, on a clear night, a shooting star streaks across the sky: a bright, warm head with
 * a tail fading to the moon's pale blue behind it, sliding down a great circle of the sky for a
 * second or so and burning out before it reaches the roofs. It lives in the sky's dome (sky.ts), so
 * it rides along with you and looks as far off as the stars, and it only shows as much as they do:
 * never by day, under cloud or in fog.
 */

const DEG = Math.PI / 180;
/** How far off it is: in front of the stars (170) and the moon (160), behind the Halloween dome. */
const RADIUS = 150;
/** Half the tail's width where it's widest, at the head: about three pixels across, a little more than a star. */
const HALF_WIDTH = 0.26;
/** Pieces the tail is drawn in, head to tip. */
const SEGMENTS = 28;
/** Never so low it would cross the roofs across the street. */
export const METEOR_LOWEST = 14 * DEG;
/** Seconds between one and the next, once it's dark enough to see them. */
export const METEOR_GAP: readonly [number, number] = [25, 80];

/** One shooting star's path: along the great circle from `from` heading `toward`. */
export interface Meteor {
  /** Where it starts: a unit direction from the middle of the sky. */
  from: THREE.Vector3;
  /** Which way it heads from there: a unit direction at right angles to `from`. */
  toward: THREE.Vector3;
  /** How far it goes, and how long its tail is at most (radians of sky). */
  arc: number;
  tail: number;
  /** How long it lasts, in seconds. */
  secs: number;
}

type Rand = () => number;
const between = (rand: Rand, a: number, b: number) => a + rand() * (b - a);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Where on the path it is `angle` radians along. */
export function alongPath(m: Meteor, angle: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(m.from).multiplyScalar(Math.cos(angle)).addScaledVector(m.toward, Math.sin(angle));
}

/**
 * A new shooting star: starting fairly high in any part of the sky and slanting down across it
 * (falling, but never straight down), ending well above the horizon.
 */
export function planMeteor(rand: Rand = Math.random): Meteor {
  const el = between(rand, 32, 72) * DEG;
  const az = between(rand, 0, 360) * DEG;
  const from = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
  // Down the sky from there, and across it.
  const down = new THREE.Vector3(0, -1, 0).addScaledVector(from, from.y).normalize();
  const across = new THREE.Vector3().crossVectors(from, down).normalize();
  const slant = between(rand, 22, 68) * DEG * (rand() < 0.5 ? -1 : 1);
  const toward = down.multiplyScalar(Math.cos(slant)).addScaledVector(across, Math.sin(slant)).normalize();
  const m: Meteor = { from, toward, arc: between(rand, 16, 30) * DEG, tail: between(rand, 7, 12) * DEG, secs: between(rand, 0.8, 1.4) };
  // Cut it short rather than let it reach the roofs.
  const p = new THREE.Vector3();
  while (m.arc > 4 * DEG && alongPath(m, m.arc, p).y < Math.sin(METEOR_LOWEST)) m.arc -= 1 * DEG;
  m.tail = Math.min(m.tail, m.arc * 0.6);
  return m;
}

/**
 * How it looks `p` (0–1) of the way through: how far along its head and the tip of its tail are
 * (radians), and how bright it is (0–1). It flares up, slows a little as it goes, and burns out,
 * its tail catching up with its head at the end.
 */
export function meteorAt(m: Meteor, p: number): { head: number; tip: number; glow: number } {
  const q = Math.min(1, Math.max(0, p));
  const head = m.arc * (1 - (1 - q) ** 1.6);
  // The tail grows out behind it, then shrinks back as it burns out.
  const tail = m.tail * smooth(0, 0.35, q) * (1 - 0.7 * smooth(0.65, 1, q));
  const glow = smooth(0, 0.12, q) * (1 - smooth(0.55, 1, q));
  return { head, tip: Math.max(0, head - tail), glow };
}

/** The soft round glow at the head. */
function headTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.8)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** The sky's shooting stars: at most one at a time, now and then. Add `group` to the sky's dome. */
export class ShootingStars {
  readonly group = new THREE.Group();
  private readonly tail: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly head: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly calm = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  private meteor: Meteor | null = null;
  private age = 0;
  /** Seconds of dark, clear sky until the next one. */
  private wait = between(Math.random, 8, 30);
  private readonly at = new THREE.Vector3();

  constructor() {
    // A ribbon along the path, facing the middle of the sky (where you are): two points a piece.
    const geo = new THREE.BufferGeometry();
    const along = new Float32Array((SEGMENTS + 1) * 2);
    const side = new Float32Array((SEGMENTS + 1) * 2);
    const index: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      along[i * 2] = along[i * 2 + 1] = i / SEGMENTS;
      side[i * 2] = -1;
      side[i * 2 + 1] = 1;
      if (i < SEGMENTS) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEGMENTS + 1) * 6), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('along', new THREE.BufferAttribute(along, 1));
    geo.setAttribute('side', new THREE.BufferAttribute(side, 1));
    geo.setIndex(index);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        glow: { value: 0 },
        headColor: { value: new THREE.Color('#fff7e6') },
        tailColor: { value: new THREE.Color('#9fb6ff') },
      },
      vertexShader: /* glsl */ `
        attribute float along;
        attribute float side;
        varying float vAlong;
        varying float vSide;
        void main() {
          vAlong = along;
          vSide = side;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: /* glsl */ `
        uniform float glow;
        uniform vec3 headColor;
        uniform vec3 tailColor;
        varying float vAlong;
        varying float vSide;
        void main() {
          float a = glow * pow( 1.0 - vAlong, 1.8 ) * ( 1.0 - vSide * vSide );
          gl_FragColor = vec4( mix( headColor, tailColor, smoothstep( 0.0, 0.6, vAlong ) ), a );
          #include <colorspace_fragment>
        }`,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    // The outline pass would ink it over.
    mat.userData.outlineParameters = { visible: false };
    this.tail = new THREE.Mesh(geo, mat);
    this.tail.frustumCulled = false;

    const headGeo = new THREE.BufferGeometry();
    headGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3).setUsage(THREE.DynamicDrawUsage));
    const headMat = new THREE.PointsMaterial({ color: '#fffaf0', map: headTexture(), size: 14, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    headMat.userData.outlineParameters = { visible: false };
    this.head = new THREE.Points(headGeo, headMat);
    this.head.frustumCulled = false;

    this.group.add(this.tail, this.head);
    this.group.visible = false;
  }

  /** Send one across the sky now (from the console, say); it shows only as much as the stars do. */
  launch() {
    this.meteor = planMeteor();
    this.age = 0;
  }

  /** `stars`: how much the stars show right now (0–1), which is how much a shooting star can. */
  update(dt: number, stars: number) {
    if (!this.meteor) {
      // Only counting down while the stars are out, so the first one doesn't come the moment it's dark.
      if (stars > 0.35) this.wait -= dt;
      if (this.wait <= 0) {
        this.wait = between(Math.random, METEOR_GAP[0], METEOR_GAP[1]);
        if (!this.calm?.matches) this.launch();
      }
    }
    const m = this.meteor;
    if (!m) return;
    this.age += dt;
    const p = this.age / m.secs;
    if (p >= 1) {
      this.meteor = null;
      this.group.visible = false;
      return;
    }
    const { head, tip, glow } = meteorAt(m, p);
    const bright = glow * Math.min(1, stars * 1.25);
    this.group.visible = bright > 0.005;
    if (!this.group.visible) return;

    // The ribbon's sides lie along the axis the path turns about, so it always faces you.
    const axis = this.at.crossVectors(m.from, m.toward);
    const pos = this.tail.geometry.attributes.position as THREE.BufferAttribute;
    const a = pos.array as Float32Array;
    const v = new THREE.Vector3();
    for (let i = 0; i <= SEGMENTS; i++) {
      const k = i / SEGMENTS;
      alongPath(m, head - (head - tip) * k, v).multiplyScalar(RADIUS);
      const w = HALF_WIDTH * (1 - k) ** 0.7;
      a.set([v.x - axis.x * w, v.y - axis.y * w, v.z - axis.z * w, v.x + axis.x * w, v.y + axis.y * w, v.z + axis.z * w], i * 6);
    }
    pos.needsUpdate = true;
    this.tail.material.uniforms.glow.value = bright;

    const hp = this.head.geometry.attributes.position as THREE.BufferAttribute;
    alongPath(m, head, v).multiplyScalar(RADIUS);
    hp.setXYZ(0, v.x, v.y, v.z);
    hp.needsUpdate = true;
    // A faint flicker as it burns.
    this.head.material.opacity = bright * (0.85 + 0.15 * Math.sin(this.age * 47));
  }
}
