import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { WorldCollision } from '../js/collision.js';
import { mergeWorldMeshes } from '../js/merge-world.js';
import { maxSlopeForLevel, jumpSpeedForLevel, selectInteraction } from '../js/progression.js';

const HZ = Number(process.env.PROGRESSION_HZ || 60);
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('assets/manifest.json', root), 'utf8'));
const fixtures = JSON.parse(await readFile(new URL('fixtures/progression-campaign.json', import.meta.url), 'utf8'));

// A fixed control witness, not another navigation solver: feet/velocity are
// carried continuously between waypoints. Every segment ends on real support.
// No teleport, no noclip, no changed collider, and no mid-route recovery.
function travel(world, position, destination, jump, jumpVelocity, onFrame) {
  const start = position.clone();
  const horizontal = Math.hypot(destination.x - start.x, destination.z - start.z);
  const dy = destination.y - start.y;
  const duration = jump ? (jumpVelocity + Math.sqrt(Math.max(0, jumpVelocity * jumpVelocity - 44 * dy))) / 22 : horizontal / 4.3;
  const velocity = new THREE.Vector3(0, jump ? jumpVelocity : 0, 0);
  let grounded = !jump;
  for (let frame = 0; frame < Math.min(20000, Math.ceil((duration + 1.1) * HZ)); frame++) {
    const direction = new THREE.Vector3(destination.x - position.x, 0, destination.z - position.z);
    const distance = direction.length();
    let speed = jump ? Math.min(8, horizontal / Math.max(0.05, duration)) : 4.3;
    speed = distance < 0.04 ? 0 : Math.min(speed, distance * HZ);
    direction.normalize();
    velocity.x = direction.x * speed;
    velocity.z = direction.z * speed;
    grounded = world.move(position, velocity, 1 / HZ, grounded).onGround;
    onFrame(position);
    if (Math.hypot(position.x - destination.x, position.z - destination.z) < 0.06 &&
        Math.abs(position.y - destination.y) < 0.42 && grounded) return;
  }
  assert.fail(`Cannot reach ${destination.toArray()} from ${start.toArray()}; stopped at ${position.toArray()}`);
}

for (const fixture of fixtures.levels) {
  test(`level ${fixture.id}: continuous original-collider route collects every key, then reaches exit`, async t => {
    const level = manifest.levels.find(entry => entry.id === fixture.id);
    const source = await readFile(new URL(manifest.models[level.model], root));
    assert.equal(createHash('sha256').update(source).digest('hex'), fixture.modelSha256);
    const model = JSON.parse(source);
    const material = new THREE.MeshBasicMaterial();
    // Runtime batches by material UUID. Preserve its per-source-material order:
    // sharing a single material changes triangle order on narrow beam contacts.
    const materials = Object.fromEntries(Object.keys(model.materials).map(name => [name, new THREE.MeshBasicMaterial()]));
    const group = mergeWorldMeshes(model, materials, material);
    group.scale.setScalar(0.01);
    group.updateMatrixWorld(true);
    const world = new WorldCollision({ radius: 0.28, height: 1.65, stepHeight: 0.45, maxSlope: maxSlopeForLevel(level.id) });
    world.setWorld(group);
    const position = new THREE.Vector3(...fixture.points[0]);
    const start = level.entities.filter(entry => entry.command === 'GameStart').at(-1);
    assert.ok(Math.hypot(position.x - start.x / 100, position.z - start.z / 100) < 0.001);
    const jumps = new Set(fixture.jumps);
    const keys = level.entities.filter(entry => entry.command === 'GameKey');
    const collected = new Set();
    const hazards = level.entities.filter(entry => entry.command === '#Uron').map(entry => ({
      position: new THREE.Vector3(entry.x / 100, entry.y / 100, entry.z / 100), radius: Math.max(1, entry.a / 10),
    }));
    let hazardDamage = 0;
    const onFrame = point => {
      for (const hazard of hazards) if (point.distanceTo(hazard.position) < hazard.radius) hazardDamage += 10 / HZ;
    };
    const interact = id => {
      const entry = level.entities.find(value => value.id === id);
      const item = { entry, pos: new THREE.Vector3(entry.x / 100, entry.y / 100, entry.z / 100) };
      assert.equal(selectInteraction([item], position, world, { collected: collected.size, totalKeys: keys.length }), item,
        `Objective ${id} must be within the unchanged interaction range and unobstructed`);
      return entry;
    };
    try {
      // loadLevel starts 3 cm above the surface with grounded=false.
      const settleVelocity = new THREE.Vector3();
      let supported = false;
      for (let frame = 0; frame < HZ && !supported; frame++) {
        supported = world.move(position, settleVelocity, 1 / HZ, supported).onGround;
        onFrame(position);
      }
      assert.ok(supported, 'the unchanged start position must settle onto a valid floor');
      for (let i = 1; i < fixture.points.length; i++) {
        travel(world, position, new THREE.Vector3(...fixture.points[i]), jumps.has(i), jumpSpeedForLevel(level.id), onFrame);
        for (const checkpoint of fixture.checkpoints.filter(value => value.waypoint === i)) {
          assert.equal(interact(checkpoint.id).command, 'GameKey');
          collected.add(checkpoint.id);
        }
      }
      assert.deepEqual([...collected].sort((a, b) => a - b), keys.map(entry => entry.id).sort((a, b) => a - b));
      assert.equal(interact(fixture.exit).command, 'GameEnd');
      assert.ok(hazardDamage < 100, 'the complete route must survive original static damage volumes without healing');
      if (hazards.length) t.diagnostic(`Original #Uron damage over the complete route: ${hazardDamage.toFixed(2)} / 100 HP`);
    } finally {
      world.clear();
      group.traverse(mesh => { if (mesh.isMesh) mesh.geometry.dispose(); });
      for (const sourceMaterial of Object.values(materials)) sourceMaterial.dispose();
      material.dispose();
    }
  });
}
