import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { WorldCollision } from '../js/collision.js';
import { OriginalMovement } from '../js/original-physics.js';
import { mergeWorldMeshes } from '../js/merge-world.js';
import { ropeSupport } from '../js/rope-support.js';
import { maxSlopeForLevel, jumpSpeedForLevel, selectInteraction } from '../js/progression.js';

const root = new URL('../', import.meta.url), manifest = JSON.parse(await readFile(new URL('assets/manifest.json', root), 'utf8'));
async function levelWorld(id, maxSlope = maxSlopeForLevel(id)) {
  const level = manifest.levels.find(level => level.id === id), source = await readFile(new URL(manifest.models[level.model], root)), data = JSON.parse(source);
  // Match assets.model's per-material batches and therefore octree insertion
  // order; intersecting original rails can be sensitive to triangle order.
  const materials = Object.fromEntries(Object.keys(data.materials).map(name => [name, new THREE.MeshBasicMaterial()]));
  const fallback = new THREE.MeshBasicMaterial(), group = mergeWorldMeshes(data, materials, fallback);
  group.scale.setScalar(.01);
  const ropes = ropeSupport(id, data);
  const world = new WorldCollision({ radius: .28, height: 1.65, stepHeight: .45, maxSlope }).setWorld(group, ropes);
  return { level, world, ropes, modelSha256: createHash('sha256').update(source).digest('hex'), dispose() { world.clear(); for (const child of group.children) child.geometry.dispose(); for (const material of Object.values(materials)) material.dispose(); fallback.dispose(); } };
}
function actor(world, start, jumpSpeed = 8, dt = 1 / 60) {
  const position = new THREE.Vector3(...start), velocity = new THREE.Vector3(); let onGround = false;
  const tick = () => { ({ onGround } = world.move(position, velocity, dt, onGround)); };
  for (let i = 0; i < Math.ceil(.5 / dt); i++) tick();
  return {
    position,
    travel(target, { speed = 4, jump = false, maxFrames = 1800, arrivalRadius = .08 } = {}) {
      if (jump) { velocity.y = jumpSpeed; onGround = false; }
      let supported = 0;
      for (let frame = 0; frame < maxFrames; frame++) {
        const dx = target[0] - position.x, dz = target[2] - position.z, distance = Math.hypot(dx, dz), gain = Math.min(speed, distance * 8) / Math.max(distance, .001);
        velocity.x = dx * gain; velocity.z = dz * gain; tick(); supported += Number(onGround);
        if (Math.hypot(target[0] - position.x, target[2] - position.z) < arrivalRadius && onGround) return { reached: true, supported, frames: frame + 1 };
      }
      return { reached: false, supported, frames: maxFrames };
    },
  };
}
function objectives(level, world) {
  const items = level.entities.map(entry => ({ entry, pos: new THREE.Vector3(entry.x, entry.y, entry.z).multiplyScalar(.01), collected: false }));
  const keys = items.filter(item => item.entry.command === 'GameKey');
  let collected = 0;
  return {
    key: keys[0], exit: items.find(item => item.entry.command === 'GameEnd'),
    collect(item, position) {
      assert.equal(selectInteraction(items, position, world, { health: 100, collected, totalKeys: keys.length }), item, 'all original interactions are considered, including nearby supplies and shops');
      if (item.entry.command === 'GameKey') { item.collected = true; collected++; }
      else assert.equal(collected, keys.length, 'every original key is collected before using the exit');
    },
  };
}
function originalSpawn({ level, world, modelSha256 }, fixture) {
  assert.equal(modelSha256, fixture.modelSha256, 'the route witness applies to this unchanged source geometry');
  const entry = level.entities.filter(entry => entry.command === 'GameStart').at(-1);
  const position = new THREE.Vector3(entry.x / 100, entry.y / 100, entry.z / 100);
  position.y = (world.ground(position.x, position.y + .2, position.z, 50) ?? position.y - 1) + .03;
  assert.ok(position.distanceTo(new THREE.Vector3(...fixture.start)) < 1e-6, 'fixture starts at the last original GameStart grounded exactly as app.loadLevel');
  return position.toArray();
}

test('level 3 starts at the original spawn, crosses its rock/roof/beam route, collects the temple key and returns to the exit', async t => {
  const loaded = await levelWorld(3), { level, world, dispose } = loaded;
  try {
    const prefix = JSON.parse(await readFile(new URL('tests/fixtures/level3-prefix.json', root), 'utf8'));
    const player = actor(world, originalSpawn(loaded, prefix), jumpSpeedForLevel(3));
    const mission = objectives(level, world);
    for (const step of prefix.steps) {
      assert.ok(player.travel(step.p, { speed: step.speed, jump: step.jump }).reached, `spawn/roof prefix ${step.p} at ${player.position.toArray()}`);
      assert.ok(Math.abs(player.position.y - step.p[1]) < 1, `landed on the intended upper surface at ${step.p}`);
    }
    const beam = player.travel([12.55, 5.6, -7.5]);
    assert.ok(beam.reached && beam.supported > 450, '34 m of original 11 cm beams support the actual moving capsule');
    assert.ok(player.position.y > 5.6);
    const key = mission.key;
    assert.ok(player.travel([key.pos.x, 6.38, key.pos.z], { speed: 6 }).reached);
    mission.collect(key, player.position);
    assert.ok(player.travel([-36, -17, -34], { speed: 6 }).reached, 'can drop off the temple roof');
    const exit = mission.exit;
    assert.ok(player.travel([exit.pos.x, exit.pos.y - 1, exit.pos.z], { speed: 6, maxFrames: 2200 }).reached, 'open return route to original exit');
    mission.collect(exit, player.position);
    t.diagnostic(`${beam.supported} supported beam frames; actual key and exit line of sight verified`);
  } finally { dispose(); }
});

test('the adapted player can mount the second Acropolis crossing off center and stop on it', async () => {
  const { world, dispose } = await levelWorld(3);
  try {
    for (const [hz, x, yaw] of [[25, 12.55, Math.PI - .012], [60, 13, Math.PI], [120, 12.24, Math.PI + .012]]) {
      const z = 26.75, dt = 1 / hz;
      const position = new THREE.Vector3(x, world.ground(x, -4, z) + .05, z);
      const velocity = new THREE.Vector3();
      let grounded = false;
      const tick = speed => {
        velocity.x = Math.sin(yaw) * speed;
        velocity.z = Math.cos(yaw) * speed;
        ({ onGround: grounded } = world.move(position, velocity, dt, grounded));
      };
      for (let i = 0; i < hz / 2; i++) tick(0);
      for (let i = 0; i < hz * 3 && position.z > 15; i++) tick(8);
      assert.ok(grounded && position.z <= 15 && position.y > -2.6, `${hz} Hz approach at ${position.toArray()}`);
      const height = position.y;
      for (let i = 0; i < hz; i++) tick(0);
      assert.ok(grounded && position.y > height - .12, `${hz} Hz stop at ${position.toArray()}`);
      for (let i = 0; i < hz * 5 && position.z > -10; i++) tick(8);
      assert.ok(grounded && position.z <= -10 && position.y > 6.4, `${hz} Hz roof at ${position.toArray()}`);
    }
  } finally { dispose(); }
});

test('both Acropolis crossings support a pause and a slightly angled approach in both movement modes', async () => {
  const { world, ropes, dispose } = await levelWorld(3);
  try {
    const spans = [
      { start: [64, -7.83, 29.37], axis: 'x', yaw: Math.atan2(-44.65, -3.15), pause: 44, end: 20.3, roof: -5.7 },
      { start: [12.55, -5.09, 26.75], axis: 'z', yaw: Math.PI, pause: 14, end: -9.4, roof: 6.2 },
    ];
    for (const hz of [25, 60, 120]) for (const classic of [false, true]) for (const span of spans) {
      const position = new THREE.Vector3(...span.start), velocity = new THREE.Vector3();
      const motion = new OriginalMovement(world), dt = 1 / hz, aim = span.yaw + .06;
      let grounded = false;
      const tick = forward => {
        const yaw = grounded ? ropes.heading(position, aim, forward, 0) : aim;
        if (classic) {
          ({ onGround: grounded } = motion.move(position, velocity, dt, { forward, yaw, sprint: true }));
        } else {
          velocity.x = Math.sin(yaw) * forward * 8;
          velocity.z = Math.cos(yaw) * forward * 8;
          ({ onGround: grounded } = world.move(position, velocity, dt, grounded));
        }
      };
      const check = `${hz} Hz, ${classic ? 'DCE' : 'capsule'}, ${span.axis} span`;
      for (let i = 0; i < hz / 2; i++) tick(0);
      for (let i = 0; i < hz * 15 && position[span.axis] > span.pause; i++) tick(1);
      assert.ok(grounded && position[span.axis] <= span.pause, `${check}: crossing at ${position.toArray()}`);
      for (let i = 0; i < hz; i++) tick(0);
      const settled = position.clone();
      for (let i = 0; i < hz * 5; i++) tick(0);
      assert.ok(grounded && settled.distanceTo(position) < .02, `${check}: idle drift from ${settled.toArray()} to ${position.toArray()}`);
      for (let i = 0; i < hz * 15 && position[span.axis] > span.end; i++) tick(1);
      assert.ok(grounded && position[span.axis] <= span.end && position.y > span.roof, `${check}: roof at ${position.toArray()}`);
    }
  } finally { dispose(); }
});

test('level 4 starts at the original spawn, crosses its corrected roof route, collects the key and returns to the exit', async t => {
  const old = await levelWorld(4, 50);
  try {
    const player = actor(old.world, [18.2, -18.55, -50.25]);
    const result = player.travel([15.4, -13.95, -48.4], { speed: 2, maxFrames: 360 });
    assert.equal(result.reached, false);
    assert.ok(player.position.y < -18.5, 'default rule rejects the original sloping plank');
  } finally { old.dispose(); }
  assert.equal(maxSlopeForLevel(4), 55);
  assert.equal(maxSlopeForLevel(3), 50);
  const fixed = await levelWorld(4);
  try {
    const prefix = JSON.parse(await readFile(new URL('tests/fixtures/level4-prefix.json', root), 'utf8'));
    const player = actor(fixed.world, originalSpawn(fixed, prefix), jumpSpeedForLevel(4));
    const mission = objectives(fixed.level, fixed.world);
    for (const step of prefix.steps) {
      assert.ok(player.travel(step.p, { speed: step.speed, jump: step.jump }).reached, `spawn/roof prefix ${step.p} at ${player.position.toArray()}`);
      assert.ok(Math.abs(player.position.y - step.p[1]) < 1, `landed on the intended upper surface at ${step.p}`);
    }
    const lower = player.travel([18.55, -18.9, -50.6], { speed: 3 });
    assert.ok(lower.reached, `long lower plank at ${player.position.toArray()}`);
    assert.ok(player.travel([15.4, -13.95, -48.4], { speed: 3 }).reached);
    assert.ok(player.position.y > -14.1, `walks onto the tank roof at ${player.position.toArray()}`);
    assert.ok(player.travel([11.8, -15.5, -47], { speed: 3 }).reached);
    assert.ok(player.travel([0, -21.85, -42], { speed: 8, jump: true }).reached, 'long descending jump lands on church roof');
    const key = mission.key;
    assert.ok(player.travel([key.pos.x, key.pos.y - 1, key.pos.z], { speed: 4 }).reached);
    mission.collect(key, player.position);
    assert.ok(player.travel([-5, -34, -55], { speed: 6 }).reached, 'can leave the key roof');
    for (const point of [[8, -34, -55], [8, -34, -30], [0, -35, 17.5], [-30, -35, 17.5], [-45, -35, 16.25], [-56, -35, 15], [-67, -35, 16.25], [-77, -35, 17.5]]) {
      const aroundTrees = player.travel(point, { speed: 6, maxFrames: 1800 });
      assert.ok(aroundTrees.reached, `ground return at ${player.position.toArray()}`);
    }
    const exit = mission.exit;
    assert.ok(player.travel([exit.pos.x, exit.pos.y - 1, exit.pos.z], { speed: 6, maxFrames: 1800 }).reached);
    mission.collect(exit, player.position);
    t.diagnostic('Upper plank, tank roof, descending jump, church key and ground return to original exit passed');
  } finally { fixed.dispose(); }
});

test('level 4 original lower scaffold reaches its two-metre eave with its level-specific jump, without changing other levels', async () => {
  const { world, dispose } = await levelWorld(4);
  try {
    const old = actor(world, [32, -29.35, -35.5], 8);
    assert.equal(old.travel([31.2, -27.5, -33.8], { speed: 4, jump: true, maxFrames: 180 }).reached, false);
    assert.ok(old.position.y < -29, 'the old jump falls back onto the lower platform');
    assert.equal(jumpSpeedForLevel(4), 9.5);
    assert.equal(jumpSpeedForLevel(2), 8);
    const fixed = actor(world, [32, -29.35, -35.5], jumpSpeedForLevel(4));
    assert.ok(fixed.travel([31.2, -27.5, -33.8], { speed: 4, jump: true, maxFrames: 180 }).reached);
    assert.ok(fixed.position.y > -27.5, 'lands on the authored roof');
  } finally { dispose(); }
});

test('original DCE climbs the level 4 plank eave without colliding with back-facing roof edges', async () => {
  const {world,dispose}=await levelWorld(4);
  try {
    const position=new THREE.Vector3(54.01115,-28.45,-36.8),velocity=new THREE.Vector3();
    const motion=new OriginalMovement(world),dt=1/60,yaw=Math.atan2(.453,1);
    for(let i=0;i<90;i++)motion.move(position,velocity,dt,{});
    const forward=1/5.4455;
    for(let i=0;i<8;i++)motion.move(position,velocity,dt,{forward,yaw});
    for(let i=0;i<150;i++)motion.move(position,velocity,dt,{forward,yaw,jump:i===0});
    assert.ok(position.y>-26.4,`roof landing at ${position.toArray()}`);
    assert.ok(position.z>-36&&motion.onGround,'land on the authored roof, not the plank below');
    for(let i=0;i<120;i++)motion.move(position,velocity,dt,{brake:true});
    assert.ok(position.y>-26.4&&motion.onGround,'the roof still supports the body when standing');
  } finally {dispose();}
});

test('original DCE keeps downhill run-up after a stop on the level 4 tower and lands on the church roof', async () => {
  const {world,dispose}=await levelWorld(4);
  try {
    for(const hz of [25,60,120]){
      const p=new THREE.Vector3(15.5,-12,-48.47),v=new THREE.Vector3();
      const motion=new OriginalMovement(world),dt=1/hz;
      for(let i=0;i<hz*3;i++)motion.move(p,v,dt,{brake:true});
      assert.ok(motion.onGround,`${hz} Hz: stopped on tower`);
      const yaw=Math.atan2(-p.x,-42-p.z);
      for(let i=0;i<Math.round(.23*hz);i++)motion.move(p,v,dt,{forward:1,sprint:true,yaw});
      assert.ok(motion.onGround&&Math.hypot(v.x,v.z)>5.5,`${hz} Hz: downhill run-up stays grounded`);
      let airborne=false,landed=false;
      for(let i=0;i<hz*3;i++){
        motion.move(p,v,dt,{forward:1,sprint:true,yaw,jump:i===0});
        airborne||=!motion.onGround;
        if(airborne&&motion.onGround&&p.y<-18&&p.x<5){landed=true;break;}
      }
      assert.ok(landed&&p.y>-24.5&&p.x<3,`${hz} Hz: church roof, not the street below: ${p.toArray()}`);
    }
  } finally {dispose();}
});

test('level 3 original rock-to-rock gap rejects jump8 and is reachable with its restored per-level jump', async () => {
  const { world, dispose } = await levelWorld(3);
  try {
    const old = actor(world, [64.84, -12.68, 22.42], 8);
    old.travel([69.23, -11.1, 23], { speed: 8, jump: true, maxFrames: 180 });
    assert.ok(old.position.y < -14, 'the former jump falls below the target stone');
    assert.equal(jumpSpeedForLevel(3), 9.5);
    const fixed = actor(world, [64.84, -12.68, 22.42], jumpSpeedForLevel(3));
    assert.ok(fixed.travel([69.23, -11.1, 23], { speed: 8, jump: true, maxFrames: 180 }).reached);
    assert.ok(fixed.position.y > -11.2, 'lands on the authored stone top');
  } finally { dispose(); }
});

for (const dt of [.04, 1 / 120]) {
  test(`critical level 3/4 jumps and narrow ramps remain traversable at dt=${dt}`, async t => {
    const level3 = await levelWorld(3), level4 = await levelWorld(4);
    try {
      const rock = actor(level3.world, [64.84, -12.68, 22.42], jumpSpeedForLevel(3), dt);
      assert.ok(rock.travel([69.23, -11.1, 23], { speed: 8, jump: true, maxFrames: Math.ceil(4 / dt) }).reached, `level 3 rock at ${rock.position.toArray()}`);
      assert.ok(rock.position.y > -11.2, 'lands on the intended rock, not the ground below');
      const beam = actor(level3.world, [12.55, -5.1, 26.5], jumpSpeedForLevel(3), dt);
      const crossing = beam.travel([12.55, 5.6, -7.5], { maxFrames: Math.ceil(20 / dt) });
      assert.ok(crossing.reached && beam.position.y > 5.6, `level 3 11 cm beam at ${beam.position.toArray()}`);
      assert.ok(crossing.supported * dt > 7, 'support is maintained along the long original beam');
      const eave = actor(level4.world, [32, -29.35, -35.5], jumpSpeedForLevel(4), dt);
      assert.ok(eave.travel([31.2, -27.5, -33.8], { speed: 4, jump: true, maxFrames: Math.ceil(4 / dt) }).reached, `level 4 eave at ${eave.position.toArray()}`);
      assert.ok(eave.position.y > -27.5, 'lands on the intended roof');
      const ramp = actor(level4.world, [18.2, -18.55, -50.25], jumpSpeedForLevel(4), dt);
      assert.ok(ramp.travel([15.4, -13.95, -48.4], { speed: 4.3, maxFrames: Math.ceil(20 / dt) }).reached, `level 4 steep plank at ${ramp.position.toArray()}`);
      assert.ok(ramp.position.y > -14.1, 'reaches tank roof');
      t.diagnostic(`11 cm beam supported for ${(crossing.supported * dt).toFixed(2)} seconds; both jumps and the 54-degree plank passed`);
    } finally { level3.dispose(); level4.dispose(); }
  });
}

test('original DCE walks the Taj Mahal stair riser without losing ground drive or gaining a wall jump', async () => {
  const {world,dispose}=await levelWorld(5);
  try {
    for(const hz of [25,60,120]) {
      const motion=new OriginalMovement(world),position=new THREE.Vector3(-52.317894,-33.4358,-24.53557),velocity=new THREE.Vector3();
      for(let n=0;n<hz;n++)motion.move(position,velocity,1/hz,{brake:true});
      const target=new THREE.Vector3(-52.96,-33.1,-24.51);
      let edgeContact=false,reached=false;
      for(let n=0;n<hz*3;n++) {
        motion.move(position,velocity,1/hz,{forward:1,yaw:Math.atan2(target.x-position.x,target.z-position.z)});
        edgeContact ||= motion.onGround&&motion.normalY<.5;
        if(Math.hypot(target.x-position.x,target.z-position.z)<.2&&position.y> -33.3){reached=true;break;}
      }
      assert.ok(edgeContact,`${hz} Hz must exercise the vertical riser contact`);
      assert.ok(reached,`${hz} Hz stalled at ${position.toArray()}`);
    }
    const motion=new OriginalMovement(world),position=new THREE.Vector3(-52.317894,-33.4358,-24.53557),velocity=new THREE.Vector3();
    for(let n=0;n<120;n++)motion.move(position,velocity,1/60,{brake:true});
    motion.move(position,velocity,1/60,{forward:1,yaw:-Math.PI/2});
    assert.ok(motion.onGround&&motion.normalY<.5);
    motion.move(position,velocity,1/120,{jump:true});
    assert.equal(motion.ascent,0,'riser contact permits walking, not a jump off a vertical wall');
  } finally { dispose(); }
});

test('level 6 original 56-degree roof approach and rear crate staircase connect to the upper plank at 25, 60 and 120 Hz', async t => {
  const fixture = JSON.parse(await readFile(new URL('tests/fixtures/level6-middle.json', root), 'utf8'));
  const old = await levelWorld(6, 50);
  try {
    const player = actor(old.world, fixture.start, jumpSpeedForLevel(6));
    assert.equal(player.travel(fixture.steps[0].p, { ...fixture.steps[0], maxFrames: 300 }).reached, false);
    assert.ok(player.position.x < -11.3 && player.position.y < 6.2, 'the former slope rule blocks the authored roof at its lower edge');
  } finally { old.dispose(); }
  assert.equal(maxSlopeForLevel(6), 56);
  assert.equal(maxSlopeForLevel(2), 50);
  const fixed = await levelWorld(6);
  try {
    assert.equal(fixed.modelSha256, fixture.modelSha256);
    for (const dt of [.04, 1 / 60, 1 / 120]) {
      const player = actor(fixed.world, fixture.start, jumpSpeedForLevel(6), dt);
      for (const step of fixture.steps) {
        assert.ok(player.travel(step.p, { ...step, maxFrames: Math.ceil(30 / dt) }).reached, `level 6 dt=${dt} waypoint ${step.p} stopped at ${player.position.toArray()}`);
        assert.ok(Math.abs(player.position.y - step.p[1]) < .3, `landed on the intended level 6 surface, dt=${dt}, waypoint ${step.p}, position ${player.position.toArray()}`);
      }
      t.diagnostic(`Level 6 cornice → roof → rear platform → crates → plank: ${Math.round(1 / dt)} Hz at ${player.position.toArray()}`);
    }
  } finally { fixed.dispose(); }
});
