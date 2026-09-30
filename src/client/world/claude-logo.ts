import * as THREE from 'three';
import { toon } from './toon';

/** Claude's starburst: its rays, each at an angle (radians) and a length (share of the radius). */
const RAYS: readonly (readonly [angle: number, length: number])[] = Array.from({ length: 12 }, (_, i) => {
  const lengths = [1, 0.78, 0.92, 0.7, 0.96, 0.82, 0.88, 0.74, 1, 0.8, 0.9, 0.72];
  return [(i / 12) * Math.PI * 2 + (i % 2 ? 0.08 : -0.05), lengths[i]] as const;
});

/** The starburst cut out of paper: a white paper edge round the terracotta rays, and a soft shadow under it. */
function paperLogoTexture(): THREE.CanvasTexture {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const mid = size / 2;
  const reach = size * 0.4;
  const burst = (width: number, color: string, dx = 0, dy = 0) => {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineCap = 'round';
    for (const [a, len] of RAYS) {
      g.beginPath();
      g.moveTo(mid + dx, mid + dy);
      g.lineTo(mid + dx + Math.cos(a) * reach * len, mid + dy + Math.sin(a) * reach * len);
      g.stroke();
    }
    g.fillStyle = color;
    g.beginPath();
    g.arc(mid + dx, mid + dy, width * 0.9, 0, Math.PI * 2);
    g.fill();
  };
  g.filter = 'blur(6px)';
  burst(58, 'rgba(0,0,0,0.28)', 8, 10);
  g.filter = 'none';
  burst(58, '#fbf7ee');
  burst(34, '#d97757');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** A paper Claude logo lying flat on the floor at (x, z), `size` across. */
export function buildClaudeLogo(x: number, z: number, size = 2.4, turn = 0.3): THREE.Mesh {
  const logo = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshToonMaterial({ map: paperLogoTexture(), gradientMap: toon('#fff').gradientMap, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  logo.rotation.set(-Math.PI / 2, 0, turn);
  logo.position.set(x, 0.013, z);
  logo.renderOrder = 1;
  logo.receiveShadow = true;
  return logo;
}
