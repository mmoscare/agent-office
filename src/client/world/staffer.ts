// The queue agent (the staffer) leaves his kiosk and walks to you, then back. His name stays
// "Queue agent"; the nameplate is stationLabel('queue').

import * as THREE from 'three';
import { BALCONY, FLOOR, LOFT, STAIRS } from '../../shared/layout';
import { walkable } from '../../shared/nav';
import { doorInto, zoneOf, type Zone } from '../walkto';
import type { Interactable } from './office';

/** Walking pace, in m/s: the same brisk walk as on the way in to a meeting. */
const PACE = 2.8;
/** A worker's feet sit this far above its origin. */
const FEET = 0.07;
/** How far in front of you he comes to stand, and a little closer if there's no room there. */
const BESIDE_SPOT = 1.25;
const CLOSER_SPOT = 0.9;
/** Close enough, and not on his way back, that another press sends him back to the kiosk. */
export const STAFFER_BESIDE = 2.2;
/** A step he can climb in one stride, and how far underfoot still counts as the floor he's on. */
const STEP = 0.35;
const BODY = 0.28;
/** Anything whose underside is this high over his floor is over his head (the hoop, the loft), not in his way. */
const HEAD = 1.6;
/** How far in from a wall or a railing he'll stand. */
const EDGE = 0.45;

interface Area {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Where he can stand on each part of the building you can call him to, in from its walls and railings. */
const AREAS: Record<Exclude<Zone, 'outside'>, Area> = {
  floor: inset(FLOOR),
  loft: inset(LOFT),
  balcony: inset(BALCONY),
  stairs: { minX: STAIRS.fromX, maxX: STAIRS.toX, minZ: STAIRS.minZ + EDGE, maxZ: STAIRS.maxZ - EDGE },
};

/** Which ways from you he tries to stand, turned from the way you face: in front, then either side, then behind. */
const TURNS = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, (3 * Math.PI) / 4, (-3 * Math.PI) / 4, Math.PI];

export interface StafferModel {
  root: THREE.Object3D;
  walking: boolean;
  stopDancing(): void;
}

/** A surface he can stand on. A fence's top isn't one, and a wall (top above 50) isn't either. */
export interface Footing {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  top: number;
  bottom?: number;
  fence?: boolean;
}

interface Outing {
  model: StafferModel;
  home: THREE.Object3D;
  /** Where the kiosk stand is, so the walk back ends on it. */
  homeAt: { x: number; z: number };
  phase: 'to' | 'back' | 'here';
  way: { x: number; z: number }[];
  next: number;
  heading: number;
  stepIn: number;
}

/**
 * Where he comes to stand when you call him, always on the floor you're on (the office floor, the
 * loft, the balcony or the stairs; `y` is its height): just in front of you, so his clipboard faces
 * you. If that's over the edge (out through the loft's glass, over the balcony railing) or in the
 * furniture, beside or behind you instead, and failing that in front of you, pulled back onto your
 * floor. Null outside the building, where he doesn't go.
 */
export function summonSpot(colliders: readonly Footing[], at: { x: number; y: number; z: number }, facing: number): { x: number; y: number; z: number } | null {
  const zone = zoneOf(at);
  if (zone === 'outside') return null;
  const area = AREAS[zone];
  // On the stairs, the step you're on: he climbs up (or down) to it.
  const y = zone === 'loft' ? LOFT.y : zone === 'stairs' ? at.y : 0;
  const door = doorInto(zone);
  const fits = (p: { x: number; z: number }) =>
    inArea(area, p) &&
    (zone === 'stairs' ||
      ((zone !== 'floor' || walkable(p.x, p.z)) &&
        clear(colliders, y, at, p, p, BODY) &&
        // Nothing between you and him, nor on his way in from the loft's door or the balcony doors.
        clear(colliders, y, at, at, p, 0.05) &&
        (!door || clear(colliders, y, at, door, p, BODY))));
  for (const reach of [BESIDE_SPOT, CLOSER_SPOT]) {
    for (const turn of TURNS) {
      const p = { x: at.x + Math.sin(facing + turn) * reach, z: at.z + Math.cos(facing + turn) * reach };
      if (fits(p)) return { ...p, y };
    }
  }
  const x = at.x + Math.sin(facing) * BESIDE_SPOT;
  const z = at.z + Math.cos(facing) * BESIDE_SPOT;
  return { x: THREE.MathUtils.clamp(x, area.minX, area.maxX), y, z: THREE.MathUtils.clamp(z, area.minZ, area.maxZ) };
}

function inset(a: Area): Area {
  return { minX: a.minX + EDGE, maxX: a.maxX - EDGE, minZ: a.minZ + EDGE, maxZ: a.maxZ - EDGE };
}

function inArea(a: Area, p: { x: number; z: number }): boolean {
  return p.x >= a.minX && p.x <= a.maxX && p.z >= a.minZ && p.z <= a.maxZ;
}

/**
 * Whether he can walk from `a` to `b` on the floor at `y` without going through anything (a wall, a
 * desk, a railing), keeping `pad` from it. What's over his head or underfoot doesn't count, and nor
 * does whatever you're standing on or in yourself (a desk you've jumped up on).
 */
function clear(colliders: readonly Footing[], y: number, you: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }, pad: number): boolean {
  for (const c of colliders) {
    if (c.top <= y + STEP || (c.bottom ?? 0) >= y + HEAD) continue;
    if (crosses(c, you, you, 0)) continue;
    if (crosses(c, a, b, pad)) return false;
  }
  return true;
}

/** Whether the line from `a` to `b` comes within `pad` of the box (seen from above). */
function crosses(c: Area, a: { x: number; z: number }, b: { x: number; z: number }, pad: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const axes: [number, number, number, number][] = [
    [a.x, b.x - a.x, c.minX - pad, c.maxX + pad],
    [a.z, b.z - a.z, c.minZ - pad, c.maxZ + pad],
  ];
  for (const [from, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (from < lo || from > hi) return false;
      continue;
    }
    const u = (lo - from) / d;
    const v = (hi - from) / d;
    t0 = Math.max(t0, Math.min(u, v));
    t1 = Math.min(t1, Math.max(u, v));
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * The floor under a foot at (x, z, y): the next step up, if he can make it, otherwise the highest
 * surface he's already on. A loft floor stays the one under him, not the office floor below it.
 */
export function stepOnto(colliders: readonly Footing[], x: number, z: number, y: number): number {
  let stand = -Infinity;
  let step = -Infinity;
  for (const c of colliders) {
    if (c.fence || c.top > 50 || !footOn(c, x, z)) continue;
    // Underfoot, or a step up. What's further down (the garage roof, the street) is neither.
    if (c.top <= y + 0.08) stand = Math.max(stand, c.top);
    else if (c.top <= y + STEP && c.top > step) step = c.top;
  }
  if (step > -Infinity) return step;
  if (stand > -Infinity) return stand;
  return y;
}

function footOn(c: Footing, x: number, z: number): boolean {
  const nx = Math.min(Math.max(x, c.minX), c.maxX);
  const nz = Math.min(Math.max(z, c.minZ), c.maxZ);
  return (x - nx) ** 2 + (z - nz) ** 2 < BODY * BODY;
}

/**
 * Walks the queue agent off his kiosk to wherever you are, and back when you send him. Parent him
 * to something the click raycaster searches (the office), or his clipboard can't be clicked on the way.
 */
export class StafferSummon {
  private out: Outing | null = null;

  constructor(
    private parent: THREE.Object3D,
    private ground: (x: number, z: number, y: number) => number,
    private footstep: (x: number, y: number, z: number) => void,
  ) {}

  get phase(): Outing['phase'] | 'home' {
    return this.out?.phase ?? 'home';
  }

  has(model: StafferModel): boolean {
    return this.out?.model === model;
  }

  /** Where he stands at the kiosk, once he's left it. */
  kioskAt(): { x: number; z: number } | null {
    return this.out ? { ...this.out.homeAt } : null;
  }

  /** Beside him while he's away from the kiosk: E prompts, C reads the clipboard, the same as at the counter. */
  interactables(): Interactable[] {
    if (!this.out || this.out.phase === 'back') return [];
    const p = this.out.model.root.position;
    return [{ kind: 'station', deskId: 'station-queue', x: p.x, z: p.z, y: p.y, radius: 1.4 }];
  }

  positions(): THREE.Vector3[] {
    return this.out ? [this.out.model.root.position] : [];
  }

  /**
   * `way` is the walk from where he is now. `'to'` brings him to you (or retargets him if he's already
   * out); `'back'` sends him to the kiosk. Returns which way he set off.
   */
  call(model: StafferModel, way: { x: number; z: number }[], phase: 'to' | 'back'): 'coming' | 'back' {
    if (phase === 'back') {
      if (this.out?.model === model) {
        this.out.way = way;
        this.out.next = 0;
        this.out.phase = 'back';
      }
      return 'back';
    }
    if (this.out && this.out.model !== model) this.snapHome();
    if (this.out?.model === model) {
      this.out.way = way;
      this.out.next = 0;
      this.out.phase = 'to';
      return 'coming';
    }
    this.depart(model, way);
    return 'coming';
  }

  /** Floor change: back on the kiosk before that floor's workers are swapped out. */
  clear() {
    this.snapHome();
  }

  /** Someone else is taking the model (sent home). Leave him where he stands. */
  forget(model?: StafferModel) {
    if (!this.out || (model && this.out.model !== model)) return;
    this.out.model.walking = false;
    this.out = null;
  }

  update(dt: number, lookAt?: { x: number; z: number }) {
    const o = this.out;
    if (!o) return;
    if (o.phase === 'here') {
      o.model.walking = false;
      if (lookAt) this.face(o, lookAt, dt);
      return;
    }
    this.step(o, dt);
  }

  private depart(model: StafferModel, way: { x: number; z: number }[]) {
    model.stopDancing();
    const home = model.root.parent ?? this.parent;
    const homeAt = home.getWorldPosition(new THREE.Vector3());
    const world = model.root.getWorldPosition(new THREE.Vector3());
    const scale = model.root.getWorldScale(new THREE.Vector3()).x || 1;
    const yaw = worldYaw(model.root);
    this.parent.add(model.root);
    model.root.position.copy(world);
    model.root.rotation.set(0, yaw, 0);
    model.root.scale.setScalar(scale);
    this.out = { model, home, homeAt: { x: homeAt.x, z: homeAt.z }, phase: 'to', way, next: 0, heading: yaw, stepIn: 0 };
  }

  private snapHome() {
    const o = this.out;
    if (!o) return;
    o.model.walking = false;
    o.model.stopDancing();
    // Back on the stand even if that stand isn't in the scene yet (a floor swap, a test). Leaving him
    // on the office would be a second queue agent once the kiosk shows again.
    o.home.add(o.model.root);
    o.model.root.position.set(0, 0, 0);
    o.model.root.rotation.set(0, 0, 0);
    o.model.root.scale.setScalar(1);
    this.out = null;
  }

  private step(o: Outing, dt: number) {
    const pos = o.model.root.position;
    let move = PACE * dt;
    while (move > 0 && o.next < o.way.length) {
      const { x, z } = o.way[o.next];
      const dx = x - pos.x;
      const dz = z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4) o.heading = Math.atan2(dx, dz);
      if (d <= move + 1e-4) {
        pos.x = x;
        pos.z = z;
        move -= d;
        o.next++;
      } else {
        pos.x += (dx / d) * move;
        pos.z += (dz / d) * move;
        move = 0;
      }
    }
    const g = this.ground(pos.x, pos.z, pos.y + FEET);
    if (Number.isFinite(g)) pos.y += (g - FEET - pos.y) * Math.min(1, dt * 14);
    this.face(o, { x: pos.x + Math.sin(o.heading), z: pos.z + Math.cos(o.heading) }, dt);
    const walking = o.next < o.way.length;
    o.model.walking = walking;
    if (walking) {
      o.stepIn -= dt;
      if (o.stepIn <= 0) {
        o.stepIn += Math.PI / 9;
        this.footstep(pos.x, pos.y, pos.z);
      }
      return;
    }
    if (o.phase === 'back') this.snapHome();
    else o.phase = 'here';
  }

  private face(o: Outing, at: { x: number; z: number }, dt: number) {
    const pos = o.model.root.position;
    const heading = Math.atan2(at.x - pos.x, at.z - pos.z);
    const turn = Math.atan2(Math.sin(heading - o.model.root.rotation.y), Math.cos(heading - o.model.root.rotation.y));
    o.model.root.rotation.y += turn * Math.min(1, dt * 8);
  }
}

function worldYaw(obj: THREE.Object3D): number {
  const q = obj.getWorldQuaternion(new THREE.Quaternion());
  return new THREE.Euler().setFromQuaternion(q, 'YXZ').y;
}
