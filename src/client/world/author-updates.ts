import * as THREE from 'three';
import type { AuthorUpdates } from '../../shared/author-updates';
import { FLOOR } from '../../shared/layout';
import { authorUpdateLabel } from '../ui/author-updates';
import type { Office, Interactable } from './office';

/** A small noticeboard on the north wall beside the merge gong. Hidden on every other floor. */
export function mountAuthorUpdatesWall(office: Office) {
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 540;
  const g = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.56), new THREE.MeshBasicMaterial({ map: texture }));
  mesh.position.set(15.5, 2.8, FLOOR.minZ + 0.12);
  const interact: Interactable = { kind: 'authorUpdates', x: 15.5, z: FLOOR.minZ + 1.5, radius: 1.5, off: true };
  mesh.userData.interact = interact;
  mesh.visible = false;
  office.group.add(mesh);
  office.interactables.push(interact);
  const fixture = { wall: 'north' as const, u0: 14.15, u1: 16.85, y0: 1.97, y1: 3.63 };
  return (state: AuthorUpdates) => {
    mesh.visible = state.enabled;
    interact.off = !state.enabled;
    const fixtures = office.fixtures();
    const index = fixtures.indexOf(fixture);
    if (state.enabled && index < 0) fixtures.push(fixture);
    if (!state.enabled && index >= 0) fixtures.splice(index, 1);
    if (!state.enabled) return;
    g.fillStyle = '#26354a';
    g.fillRect(0, 0, 900, 540);
    g.fillStyle = state.error || state.merging ? '#ffd6a5' : state.behind ? '#ffd166' : '#caffbf';
    g.fillRect(18, 18, 864, 504);
    g.fillStyle = '#26354a';
    g.textAlign = 'center';
    g.font = '900 64px Nunito, system-ui, sans-serif';
    g.fillText('AUTHOR UPDATES', 450, 118);
    g.font = '700 32px Nunito, system-ui, sans-serif';
    g.fillText('AgentSystemLabs / agent-office', 450, 184);
    g.font = '900 48px Nunito, system-ui, sans-serif';
    g.fillText(authorUpdateLabel(state), 450, 296, 800);
    g.font = '700 35px Nunito, system-ui, sans-serif';
    g.fillText('Review · merge · resolve conflicts', 450, 385);
    g.fillText('Click or press E', 450, 458);
    texture.needsUpdate = true;
  };
}
