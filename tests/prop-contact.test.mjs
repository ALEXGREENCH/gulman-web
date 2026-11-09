import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MeshBasicMaterial, Vector3 } from 'three';
import { WorldCollision } from '../js/collision.js';
import { OriginalMovement } from '../js/original-physics.js';
import { mergeWorldMeshes } from '../js/merge-world.js';
import { ropeSupport } from '../js/rope-support.js';

test('landing and standing on the Acropolis crate and barrel stacks keep the player above the props', async () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('assets/manifest.json', root)));
  const level = manifest.levels.find(({ id }) => id === 3);
  const data = JSON.parse(await readFile(new URL(manifest.models[level.model], root)));
  const materials = Object.fromEntries(Object.keys(data.materials).map(name => [name, new MeshBasicMaterial()]));
  const fallback = new MeshBasicMaterial();
  const group = mergeWorldMeshes(data, materials, fallback);
  group.scale.setScalar(.01);
  const world = new WorldCollision({ radius: .28, height: 1.65, stepHeight: .45 })
    .setWorld(group, ropeSupport(level.id, data));

  try {
    const landings = [
      // The old capsule shifted off the upper edge of the stack above dx84.
      { prop: 'crate stack', start: [69.32538, -14, 11.77236], minY: -14.1 },
      // The cap of barrel dx103 is slightly tilted.
      { prop: 'barrel stack', start: [71.629, -14.04864, 15.852], minY: -14.62 },
    ];
    for (const classic of [false, true]) {
      for (const hz of [25, 60, 120]) {
        for (const { prop, start, minY } of landings) {
          const scenario = `${classic ? 'original' : 'adapted'} physics on ${prop} at ${hz} Hz`;
          const motion = new OriginalMovement(world);
          const position = new Vector3(...start), velocity = new Vector3();
          let grounded = false;
          for (let i = 0; i < hz * 4; i++) {
            if (classic) {
              ({ onGround: grounded } = motion.move(position, velocity, 1 / hz));
            } else {
              // The gameplay loop reapplies movement input each frame.
              velocity.setX(0).setZ(0);
              ({ onGround: grounded } = world.move(position, velocity, 1 / hz, grounded));
            }
            assert.ok(position.y > minY, `${scenario}: feet fell to ${position.y}`);
          }
          const drift = Math.hypot(position.x - start[0], position.z - start[2]);
          assert.ok(grounded, `${scenario}: player did not settle on the prop`);
          assert.ok(drift < .06, `${scenario}: stationary player drifted ${drift} m`);
        }
      }
    }
  } finally {
    world.clear();
    for (const { geometry } of group.children) geometry.dispose();
    for (const material of Object.values(materials)) material.dispose();
    fallback.dispose();
  }
});
