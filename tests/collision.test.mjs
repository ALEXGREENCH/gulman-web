import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { WorldCollision } from '../js/collision.js';

const material = new MeshBasicMaterial();
function box(x, y, z, width, height, depth) {
  const mesh = new Mesh(new BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z);
  return mesh;
}
function makeWorld(...meshes) {
  const group = new Group();
  group.add(...meshes);
  return new WorldCollision().setWorld(group);
}
const floor = () => box(0, -.5, 0, 40, 1, 40);

test('falling capsule lands on original-style triangle geometry', () => {
  const world = makeWorld(floor());
  const position = new Vector3(0, 5, 0), velocity = new Vector3();
  let state = { onGround: false };
  for (let i = 0; i < 120; i++) state = world.move(position, velocity, 1 / 60, state.onGround);
  assert.ok(Math.abs(position.y) < .001, `feet y=${position.y}`);
  assert.equal(state.onGround, true);
  assert.equal(velocity.y, 0);
});

test('thin wall stops high-speed movement from both face directions', () => {
  const vertices = [0, 0, -10, 0, 6, -10, 0, 6, 10, 0, 0, -10, 0, 6, 10, 0, 0, 10];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
  const world = makeWorld(floor(), new Mesh(geometry, material));
  for (const side of [-1, 1]) {
    const position = new Vector3(side * 3, .0001, 0);
    const velocity = new Vector3(-side * 80, 0, 0);
    world.move(position, velocity, .2, true);
    assert.ok(position.x * side >= world.radius - .002, `tunnel from side ${side}: x=${position.x}`);
  }
});

test('capsule slides along a wall without crossing it', () => {
  const world = makeWorld(floor(), box(0, 2, 0, .1, 4, 30));
  const position = new Vector3(-1, 0, 0);
  let grounded = true;
  for (let i = 0; i < 60; i++) {
    grounded = world.move(position, new Vector3(4, 0, 3), 1 / 60, grounded).onGround;
  }
  assert.ok(position.x < -.36);
  assert.ok(position.z > 2.8, `wall blocked tangential movement: z=${position.z}`);
});

test('small step is climbable but taller obstruction is not', () => {
  for (const [height, climbable] of [[.25, true], [.8, false]]) {
    const world = makeWorld(floor(), box(2, height / 2, 0, 4, height, 4));
    const position = new Vector3(-1, 0, 0);
    let grounded = true;
    for (let i = 0; i < 80; i++) grounded = world.move(position, new Vector3(2, 0, 0), 1 / 60, grounded).onGround;
    if (climbable) {
      assert.ok(position.x > 1, `failed to step: ${position.toArray()}`);
      assert.ok(Math.abs(position.y - height) < .01);
    } else assert.ok(position.x < 0, `climbed high wall: ${position.toArray()}`);
  }
});

test('jump leaves ground, collides with ceiling and lands', () => {
  const world = makeWorld(floor(), box(0, 2.5, 0, 10, .1, 10));
  const position = new Vector3(0, 0, 0), velocity = new Vector3(0, 7, 0);
  let grounded = true, maximum = 0, airborne = false;
  for (let i = 0; i < 120; i++) {
    grounded = world.move(position, velocity, 1 / 60, grounded).onGround;
    maximum = Math.max(maximum, position.y);
    airborne ||= !grounded;
  }
  assert.ok(airborne);
  assert.ok(maximum > .2 && maximum <= .701, `ceiling penetration y=${maximum}`);
  assert.ok(Math.abs(position.y) < .001);
  assert.equal(grounded, true);
});

test('walkable ramp permits ascent and ray distances respect world transforms', () => {
  const ramp = box(2, .7, 0, 6, .1, 4);
  ramp.rotation.z = Math.PI / 12;
  const world = makeWorld(floor(), ramp);
  const position = new Vector3(-1, .01, 0);
  let grounded = true;
  for (let i = 0; i < 80; i++) grounded = world.move(position, new Vector3(2, 0, 0), 1 / 60, grounded).onGround;
  assert.ok(position.x > 1 && position.y > .5, `ramp ascent failed ${position.toArray()}`);
  const hit = world.ray(new Vector3(10, 4, 0), new Vector3(0, -7, 0), 5);
  assert.ok(Math.abs(hit.distance - 4) < .001);
  assert.ok(hit.normal.y > .99);
  assert.equal(world.ray(new Vector3(10, 4, 0), new Vector3(0, -1, 0), 3), null);
  assert.equal(world.ground(10, 4, 0, 3), undefined);
  assert.equal(world.ground(10, 4, 0, 5), 0);
  world.clear();
  assert.equal(world.ray(new Vector3(0, 4, 0), new Vector3(0, -1, 0)), null);
});

test('a steep ramp cannot turn horizontal walking into wall climbing', () => {
  const ramp = box(2, 1, 0, 6, .1, 4);
  ramp.rotation.z = Math.PI / 3;
  const world = makeWorld(floor(), ramp);
  const position = new Vector3(-1, 0, 0);
  let grounded = true;
  for (let i = 0; i < 150; i++) grounded = world.move(position, new Vector3(3, 0, 0), 1 / 60, grounded).onGround;
  assert.ok(position.x < 1.6 && position.y < .1, `climbed steep ramp: ${position.toArray()}`);
});

test('a low ceiling prevents stepping onto an otherwise climbable ledge', () => {
  const world = makeWorld(floor(), box(2, .125, 0, 4, .25, 4), box(0, 1.9, 0, 15, .1, 10));
  const position = new Vector3(-1, 0, 0);
  let grounded = true;
  for (let i = 0; i < 90; i++) grounded = world.move(position, new Vector3(2, 0, 0), 1 / 60, grounded).onGround;
  assert.ok(position.x < 0, `stepped through ceiling: ${position.toArray()}`);
  assert.ok(position.y + world.height <= 1.851, `ceiling penetration: ${position.toArray()}`);
});
