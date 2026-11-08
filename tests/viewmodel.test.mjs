import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFile } from 'node:fs/promises';
import { ProceduralViewmodel } from '../js/viewmodel.js';
import { GraphicsManager } from '../js/graphics.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function rawWeapon(length = 40) {
  const geometry = new THREE.BoxGeometry(length, 6, 12);
  geometry.translate(length / 2, 3, 0);
  const material = new THREE.MeshLambertMaterial({ color: 0x667744 });
  const group = new THREE.Group(); group.add(new THREE.Mesh(geometry, material));
  return { group, geometry, material };
}

test('latest asynchronous weapon selection wins and retains original shared resources', async () => {
  const first = deferred(), second = deferred(), loaded = [];
  const original = rawWeapon();
  let geometryDisposes = 0, materialDisposes = 0;
  original.geometry.addEventListener('dispose', () => geometryDisposes++);
  original.material.addEventListener('dispose', () => materialDisposes++);
  const vm = new ProceduralViewmodel({ assets: { model: path => { loaded.push(path); return loaded.length === 1 ? first.promise : second.promise; } } });
  const a = vm.setWeapon(0), b = vm.setWeapon(1);
  second.resolve(original.group.clone(true)); assert.equal(await b, true);
  assert.equal(vm.weapon, 1);
  first.resolve(original.group.clone(true)); assert.equal(await a, false);
  assert.equal(vm.weapon, 1);
  assert.equal(original.material.depthTest, true);
  assert.equal(original.material.transparent, false);
  assert.equal(vm.group.getObjectByName('original-viewmodel-weapon') !== undefined, true);
  vm.dispose(); vm.dispose();
  assert.equal(geometryDisposes, 0);
  assert.equal(materialDisposes, 0);
});

test('ADS centers the barrel horizontally while keeping the whole weapon below the reticle', async () => {
  const original = rawWeapon();
  const vm = new ProceduralViewmodel({ assets: { model: async () => original.group.clone(true) } });
  const camera = new THREE.PerspectiveCamera(67, 1, 0.08, 1000);
  const scene = new THREE.Scene(); scene.add(camera); camera.add(vm.group);
  await vm.setWeapon(0);
  for (let step = 0; step < 180; step++) vm.update(1 / 60, { aiming: 1 });
  const muzzle = vm.muzzleWorldPosition();
  assert.ok(Math.abs(muzzle.x) < 0.00001, `barrel x=${muzzle.x}`);
  const weaponBounds = new THREE.Box3().setFromObject(vm.group.getObjectByName('original-viewmodel-weapon'));
  assert.ok(weaponBounds.max.y <= -0.03499, `weapon top=${weaponBounds.max.y}`);
  assert.ok(muzzle.y <= weaponBounds.max.y + 1e-5);
  assert.ok(muzzle.z < -0.3 && muzzle.z > -1);
  vm.update(1 / 60, { recoil: { pitch: 0.08, yaw: 0.01 }, reloading: true, reloadProgress: 0.5, speed: 7, sprinting: true, movementX: 2000, movementY: -2000, grounded: false });
  vm.update(1 / 60, { grounded: true, landing: 1 });
  scene.updateMatrixWorld(true);
  vm.group.traverse(object => assert.ok(object.matrixWorld.elements.every(Number.isFinite)));
  assert.ok(vm.mount.position.y < 0);
  vm.dispose();
});

test('flash pool expires, follows the camera, and pending loads cannot resurrect a disposed viewmodel', async () => {
  const original = rawWeapon(), pending = deferred();
  let count = 0;
  const vm = new ProceduralViewmodel({ assets: { model: async () => ++count === 1 ? original.group.clone(true) : pending.promise } });
  const camera = new THREE.PerspectiveCamera(); camera.add(vm.group);
  await vm.setWeapon(0); vm.setVisible(true);
  assert.equal(vm.group.visible, true);
  assert.equal(vm.flash(), true);
  assert.equal(vm._flashes.filter(flash => flash.sprite.visible).length, 1);
  const first = vm.muzzleWorldPosition();
  camera.position.x = 10;
  assert.ok(Math.abs(vm.muzzleWorldPosition().x - first.x - 10) < 1e-8);
  vm.update(0.1);
  assert.equal(vm._flashes.filter(flash => flash.sprite.visible).length, 0);
  const loading = vm.setWeapon(1);
  vm.dispose(); pending.resolve(original.group.clone(true));
  assert.equal(await loading, false);
  assert.equal(vm.group.parent, null);
  assert.equal(vm.group.visible, false);
  assert.equal(vm.flash(), false);
});

test('all four original weapon silhouettes clear the reticle during partial and full ADS', async () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('assets/manifest.json', root), 'utf8'));
  const sourceResources = [];
  const assets = { model: async path => {
    const data = JSON.parse(await readFile(new URL(manifest.models[path], root), 'utf8'));
    const group = new THREE.Group();
    for (const mesh of data.meshes) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.vertices, 3));
      geometry.setIndex(mesh.indices);
      geometry.rotateX(Math.PI / 2);
      const material = new THREE.MeshLambertMaterial();
      sourceResources.push(geometry, material);
      group.add(new THREE.Mesh(geometry, material));
    }
    return group;
  } };
  const vm = new ProceduralViewmodel({ assets });
  const camera = new THREE.PerspectiveCamera(67, 16 / 9, 0.08, 1000);
  camera.add(vm.group);
  for (let weapon = 0; weapon < 4; weapon++) {
    assert.equal(await vm.setWeapon(weapon), true);
    for (const aiming of [0.73, 1]) {
      camera.fov = 75 - aiming * 25;
      camera.updateProjectionMatrix();
      for (let frame = 0; frame < 180; frame++) vm.update(1 / 60, { aiming });
      const muzzle = vm.muzzleWorldPosition();
      if (aiming === 1) assert.ok(Math.abs(muzzle.x) < 1e-5, `weapon ${weapon}: off-center X`);
      const bounds = new THREE.Box3().setFromObject(vm.group.getObjectByName('original-viewmodel-weapon'));
      const clearance = aiming === 1 ? 0.03499 : 0.025;
      assert.ok(bounds.max.y <= -clearance, `weapon ${weapon}, ADS ${aiming}: top ${bounds.max.y} blocks reticle`);
      const size = bounds.getSize(new THREE.Vector3());
      assert.ok(size.z >= 0.18 && size.z <= 0.70, `weapon ${weapon}: length ${size.z}`);
      assert.ok(size.x > 0.035 && size.y > 0.08, `weapon ${weapon}: sufficiently visible thickness`);
      for (const x of [bounds.min.x, bounds.max.x]) for (const z of [bounds.min.z, bounds.max.z]) {
        const projectedTop = new THREE.Vector3(x, bounds.max.y, z).project(camera);
        assert.ok(projectedTop.y <= -0.05, `weapon ${weapon}, ADS ${aiming}: screen-space reticle gap ${projectedTop.y}`);
      }
    }
  }
  vm.dispose();
  for (const resource of sourceResources) resource.dispose();
});

test('graphics scene refreshes and mode switches preserve camera overlay materials and disable weapon shadows', async () => {
  const source = rawWeapon();
  const assets = { model: async () => source.group.clone(true), texture: async () => null, textures: new Map() };
  const graphics = new GraphicsManager({ storage: null, document: null });
  graphics.setMode('enhanced');
  await graphics.applyAssets(assets);
  const camera = new THREE.PerspectiveCamera(), scene = new THREE.Scene();
  scene.add(camera);
  const vm = new ProceduralViewmodel({ assets });
  camera.add(vm.group);
  await vm.setWeapon(0);
  const materials = new Map();
  vm.group.traverse(object => {
    if (!object.isMesh && !object.isSprite) return;
    materials.set(object, object.material);
  });
  const verify = () => {
    for (const [object, material] of materials) {
      assert.equal(object.userData.graphicsOwned, true);
      assert.equal(object.material, material, 'world-material restoration must not replace the overlay copy');
      assert.equal(object.castShadow, false);
      assert.equal(object.receiveShadow, false);
      for (const item of Array.isArray(material) ? material : [material]) {
        assert.equal(item.depthTest, false);
        assert.equal(item.depthWrite, false);
        assert.equal(item.transparent, true);
      }
    }
  };
  verify();
  graphics.applyScene(scene, null); verify();
  graphics.setMode('original', { scene, player: null }); verify();
  graphics.setMode('enhanced', { scene, player: null }); verify();
  graphics.releaseScene(scene); verify();
  vm.dispose(); graphics.dispose();
  source.geometry.dispose(); source.material.dispose();
});
