import * as THREE from 'three';
import type { AuthorUpdates } from '../../shared/author-updates';
import { FLOOR, GONG } from '../../shared/layout';
import { authorUpdateLabel } from '../ui/author-updates';
import type { Office, Interactable } from './office';

/** Where the board hangs: centred over the gong, above its frame and clear of the receptionist's card past it. */
const BOARD = { x: GONG.x, y: 3.75, width: 2.6, height: 1.56 } as const;

/** A small noticeboard on the north wall above the merge gong. Hidden on every other floor. */
export function mountAuthorUpdatesWall(office: Office) {
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 540;
  const g = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(BOARD.width, BOARD.height), new THREE.MeshBasicMaterial({ map: texture }));
  mesh.position.set(BOARD.x, BOARD.y, FLOOR.minZ + 0.12);
  // Only by pointing at it (or from the menu): walking up to it is walking up to the gong, and E there rings it.
  const interact: Interactable = { kind: 'authorUpdates', x: BOARD.x, z: FLOOR.minZ + 1.5, radius: 0, off: true };
  mesh.userData.interact = interact;
  mesh.visible = false;
  office.group.add(mesh);
  office.interactables.push(interact);
  const fixture = { wall: 'north' as const, u0: BOARD.x - BOARD.width / 2 - 0.05, u1: BOARD.x + BOARD.width / 2 + 0.05, y0: BOARD.y - BOARD.height / 2 - 0.05, y1: BOARD.y + BOARD.height / 2 + 0.05 };
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
