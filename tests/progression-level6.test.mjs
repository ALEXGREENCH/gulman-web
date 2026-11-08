import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { WorldCollision } from '../js/collision.js';
import { mergeWorldMeshes } from '../js/merge-world.js';
import { jumpSpeedForLevel, maxSlopeForLevel, selectInteraction } from '../js/progression.js';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('assets/manifest.json', root), 'utf8'));
const fixtures = await Promise.all(['prefix', 'middle', 'upper'].map(async name =>
  JSON.parse(await readFile(new URL(`tests/fixtures/level6-${name}.json`, root), 'utf8'))));

test('level 6: one continuous runtime-batched route climbs from the original start, collects the Mona Lisa and reaches the exit', async t => {
  const [prefix, middle, upper] = fixtures;
  const level = manifest.levels.find(value => value.id === 6);
  const source = await readFile(new URL(manifest.models[level.model], root));
  const hash = createHash('sha256').update(source).digest('hex');
  for (const fixture of fixtures) assert.equal(fixture.modelSha256, hash);
  const model = JSON.parse(source);
  // Assets.model creates separate material UUIDs for source material names.
  // Matching these batches also preserves capsule contact iteration order.
  const materials = Object.fromEntries(Object.keys(model.materials).map(name => [name, new THREE.MeshBasicMaterial()]));
  const fallback = new THREE.MeshBasicMaterial();
  const group = mergeWorldMeshes(model, materials, fallback);
  group.scale.setScalar(0.01);
  const world = new WorldCollision({ radius: 0.28, height: 1.65, stepHeight: 0.45, maxSlope: maxSlopeForLevel(6) }).setWorld(group);
  const jumpSpeed = jumpSpeedForLevel(6), dt = 1 / 60;
  const position = new THREE.Vector3(...prefix.points[0]);
  const velocity = new THREE.Vector3();
  const start = level.entities.filter(entry => entry.command === 'GameStart').at(-1);
  assert.ok(Math.hypot(position.x - start.x / 100, position.z - start.z / 100) < 0.001);
  const hazards = level.entities.filter(entry => entry.command === '#Uron').map(entry => ({
    position: new THREE.Vector3(entry.x / 100, entry.y / 100, entry.z / 100), radius: Math.max(1, entry.a / 10),
  }));
  const keys = level.entities.filter(entry => entry.command === 'GameKey');
  const exit = level.entities.find(entry => entry.command === 'GameEnd');
  assert.equal(keys.length, 1, 'the control witness must collect every mandatory source item');
  let grounded = false, elapsed = 0, hazardDamage = 0, collected = 0;
  const tick = () => {
    grounded = world.move(position, velocity, dt, grounded).onGround;
    elapsed += dt;
    for (const hazard of hazards) if (position.distanceTo(hazard.position) < hazard.radius) hazardDamage += 10 * dt;
  };
  const beginJump = () => {
    assert.ok(grounded, 'a new jump must begin on actual capsule support');
    velocity.y = jumpSpeed;
    grounded = false;
  };
  function travelPrefix(point, jump) {
    const target = new THREE.Vector3(...point);
    const horizontal = Math.hypot(target.x - position.x, target.z - position.z);
    const dy = target.y - position.y;
    const duration = jump ? (jumpSpeed + Math.sqrt(Math.max(0, jumpSpeed * jumpSpeed - 44 * dy))) / 22 : horizontal / 4.3;
    if (jump) beginJump();
    for (let frame = 0; frame < Math.min(900, Math.ceil((duration + 1.1) * 60)); frame++) {
      const direction = new THREE.Vector3(target.x - position.x, 0, target.z - position.z);
      const distance = direction.length();
      let speed = jump ? Math.min(8, horizontal / Math.max(0.05, duration)) : 4.3;
      speed = distance < 0.04 ? 0 : Math.min(speed, distance * 60);
      direction.normalize();
      velocity.x = direction.x * speed;
      velocity.z = direction.z * speed;
      tick();
      if (Math.hypot(position.x - target.x, position.z - target.z) < 0.06 &&
          Math.abs(position.y - target.y) < 0.42 && grounded) return;
    }
    assert.fail(`Prefix target ${point} was not reached; actual feet ${position.toArray()}`);
  }
  function travel(step) {
    if (step.jump) beginJump();
    const target = new THREE.Vector3(...step.p);
    for (let frame = 0; frame < (step.maxFrames || 1800); frame++) {
      const direction = new THREE.Vector3(target.x - position.x, 0, target.z - position.z);
      const distance = direction.length();
      const gain = Math.min(step.speed, distance * (step.gain || 8)) / Math.max(distance, 0.001);
      velocity.x = direction.x * gain;
      velocity.z = direction.z * gain;
      tick();
      if ((step.arrivalBeforeTick ? distance : Math.hypot(position.x - target.x, position.z - target.z)) < (step.arrivalRadius || 0.08) && grounded &&
          Math.abs(position.y - target.y) < (step.heightTolerance ?? 0.3)) return;
    }
    assert.fail(`Authored walkway target ${step.p} was not reached; actual feet ${position.toArray()}`);
  }
  const items = level.entities.map(entry => ({ entry, pos: new THREE.Vector3(entry.x / 100, entry.y / 100, entry.z / 100), collected: false }));
  const interact = entry => {
    const item = items.find(item => item.entry === entry);
    assert.equal(selectInteraction(items, position, world, { collected, totalKeys: keys.length }), item,
      `Original ${entry.command} must be in range and unobstructed`);
    if (entry.command === 'GameKey') item.collected = true;
  };
  try {
    for (let frame = 0; frame < 60 && !grounded; frame++) tick();
    assert.ok(grounded, 'the original start settles onto the real floor');
    const jumps = new Set(prefix.jumps);
    for (let i = 1; i < prefix.points.length; i++) travelPrefix(prefix.points[i], jumps.has(i));
    // The same position, velocity and grounded state continue across all stages.
    for (const step of middle.steps) travel(step);
    for (let i = 0; i < upper.steps.length; i++) {
      travel(upper.steps[i]);
      if (i + 1 === upper.keyStep) { interact(keys[0]); collected++; }
    }
    assert.equal(collected, keys.length);
    interact(exit);
    assert.ok(hazardDamage < 100, 'the complete route must survive source damage volumes without healing');
    t.diagnostic(`${prefix.points.length - 1 + middle.steps.length + upper.steps.length} continuous legs, ${elapsed.toFixed(2)} simulated seconds, #Uron damage ${hazardDamage.toFixed(2)} / 100 HP`);
  } finally {
    world.clear();
    group.traverse(mesh => { if (mesh.isMesh) mesh.geometry.dispose(); });
    for (const material of Object.values(materials)) material.dispose();
    fallback.dispose();
  }
});
