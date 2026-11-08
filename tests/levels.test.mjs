import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Box3, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { WorldCollision } from '../js/collision.js';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('assets/manifest.json', root), 'utf8'));

for (const level of manifest.levels) {
  test(`original level ${level.id}: spawn ray and 120 capsule movement frames`, async t => {
    const data = JSON.parse(await readFile(new URL(manifest.models[level.model], root), 'utf8'));
    const group = new Group();
    const material = new MeshBasicMaterial();
    for (const source of data.meshes) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(source.vertices, 3));
      geometry.setIndex(source.indices);
      group.add(new Mesh(geometry, material));
    }
    group.scale.setScalar(1 / manifest.unitsPerMeter);
    const world = new WorldCollision({ radius: .28, height: 1.65, stepHeight: .45 }).setWorld(group);
    const bounds = new Box3().setFromObject(group);
    const start = level.entities.filter(entity => entity.command === 'GameStart').at(-1);
    assert.ok(start, 'original script must define a spawn');
    const position = new Vector3(start.x, start.y, start.z).divideScalar(manifest.unitsPerMeter);
    const rayOrigin = position.clone().add(new Vector3(0, .2, 0));
    const hit = world.ray(rayOrigin, new Vector3(0, -1, 0), 50);
    assert.ok(hit, `spawn has no geometry below it: ${position.toArray()}`);
    const floor = world.ground(position.x, position.y + .2, position.z, 50);
    assert.ok(Number.isFinite(floor), 'spawn must have walkable ground');
    position.y = floor + .03;
    const velocity = new Vector3();
    let onGround = false;
    let supportedFrames = 0;
    for (let frame = 0; frame < 120; frame++) {
      // First settle; then exercise movement through the actual nearby mesh.
      // A small closed route avoids deliberately walking off an exposed edge.
      const phase = Math.max(0, frame - 30) / 90 * Math.PI * 2;
      velocity.x = frame < 30 ? 0 : Math.cos(phase) * .35;
      velocity.z = frame < 30 ? 0 : Math.sin(phase) * .35;
      ({ onGround } = world.move(position, velocity, 1 / 60, onGround));
      supportedFrames += Number(onGround);
      assert.ok(position.toArray().every(Number.isFinite), `NaN position at frame ${frame}`);
      assert.ok(velocity.toArray().every(Number.isFinite), `NaN velocity at frame ${frame}`);
      assert.ok(position.y >= bounds.min.y - .5, `fell below level at frame ${frame}: ${position.toArray()}`);
      assert.ok(position.y >= floor - 2, `fell through spawn floor at frame ${frame}: ${position.y} < ${floor}`);
    }
    assert.ok(supportedFrames > 90, `unstable spawn support: ${supportedFrames}/120`);
    t.diagnostic(`${world.triangleCount} triangles; spawn floor ${floor.toFixed(2)} m; supported ${supportedFrames}/120`);
    world.clear();
    group.traverse(object => object.geometry?.dispose());
    material.dispose();
  });
}
