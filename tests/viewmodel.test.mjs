import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ProceduralViewmodel } from '../js/viewmodel.js';
import { createEnhancedWeapon } from '../js/enhanced-weapons.js';
import { GraphicsManager } from '../js/graphics.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const record = index => {
  const result = createEnhancedWeapon(index), dispose = result.dispose;
  result.disposals = 0; result.dispose = () => { result.disposals++; dispose(); };
  return result;
};
const tick = (vm, state, frames = 180) => { for (let frame = 0; frame < frames; frame++) vm.update(1 / 60, state); };

test('latest async replacement wins, keeps the current model while waiting and disposes discarded owned resources', async () => {
  const first = deferred(), second = deferred();
  const old = record(0), stale = record(1), latest = record(3);
  const vm = new ProceduralViewmodel({ weaponFactory: index => index === 0 ? old : index === 1 ? first.promise : second.promise });
  await vm.setWeapon(0);
  const a = vm.setWeapon(1), b = vm.setWeapon(3);
  assert.equal(vm.group.getObjectByName('enhanced-viewmodel-weapon'), old.group);
  assert.equal(old.disposals, 0);
  second.resolve(latest); assert.equal(await b, true);
  first.resolve(stale); assert.equal(await a, false);
  assert.equal(vm.weapon, 3);
  assert.equal(old.disposals, 1); assert.equal(stale.disposals, 1); assert.equal(latest.disposals, 0);
  const geometry = latest.group.children[0].children[0].geometry;
  let disposals = 0; geometry.addEventListener('dispose', () => disposals++);
  assert.equal(await vm.setWeapon(3), true);
  assert.equal(vm.group.getObjectByName('enhanced-viewmodel-weapon'), latest.group, 'quality refresh reuses our independent model');
  vm.dispose(); vm.dispose();
  assert.equal(latest.disposals, 1); assert.equal(disposals, 1);
});

test('Enhanced builds new geometry without accessing any original asset model', async () => {
  let originalRequests = 0;
  const vm = new ProceduralViewmodel({ assets: { model() { originalRequests++; throw new Error('Original cache must stay untouched'); } } });
  for (let weapon = 0; weapon < 4; weapon++) {
    assert.equal(await vm.setWeapon(weapon), true);
    assert.ok(vm.group.getObjectByName('enhanced-viewmodel-weapon').userData.authoredModel);
  }
  assert.equal(originalRequests, 0);
  let handMeshes = 0;
  for (const hand of [vm.rightHand, vm.leftHand]) hand.traverse(object => { if (object.isMesh) handMeshes++; });
  assert.equal(handMeshes, 6, 'detailed fingers and sleeves are consolidated by material');
  vm.dispose();
});

test('all new silhouettes leave a clear reticle during partial/full ADS, recoil and camera sway', async () => {
  const vm = new ProceduralViewmodel();
  const camera = new THREE.PerspectiveCamera(67, 16 / 9, 0.08, 1000); camera.add(vm.group);
  for (let weapon = 0; weapon < 4; weapon++) {
    await vm.setWeapon(weapon);
    for (const aiming of [0.73, 1]) {
      camera.fov = 75 - aiming * 25; camera.updateProjectionMatrix();
      tick(vm, { aiming });
      const muzzle = vm.muzzleWorldPosition();
      if (aiming === 1) assert.ok(Math.abs(muzzle.x) < 1e-5, `weapon ${weapon}: off-center barrel`);
      const model = vm.group.getObjectByName('enhanced-viewmodel-weapon');
      const bounds = new THREE.Box3().setFromObject(model);
      assert.ok(bounds.max.y < -0.032, `weapon ${weapon}: neutral silhouette blocks reticle`);
      for (const x of [bounds.min.x, bounds.max.x]) for (const z of [bounds.min.z, bounds.max.z]) {
        const top = new THREE.Vector3(x, bounds.max.y, z).project(camera);
        assert.ok(top.y <= -0.05, `weapon ${weapon}: projected top ${top.y}`);
      }
    }
    tick(vm, { aiming: 1, speed: 3, recoil: { pitch: 0.13, yaw: 0.03 }, movementX: 50, movementY: -20 }, 20);
    vm.group.updateWorldMatrix(true, true);
    const shaken = new THREE.Box3().setFromObject(vm.group.getObjectByName('enhanced-viewmodel-weapon'));
    assert.ok(shaken.max.y < -0.024, `weapon ${weapon}: recoil covers reticle at ${shaken.max.y}`);
    vm.update(1 / 60, { reloading: true, reloadProgress: 0.5, sprinting: true, grounded: false });
    vm.update(1 / 60, { grounded: true, landing: 1 });
    vm.group.updateWorldMatrix(true, true);
    vm.group.traverse(object => assert.ok(object.matrixWorld.elements.every(Number.isFinite)));
    tick(vm, {});
  }
  vm.dispose();
});

test('shot animates the action; flash pool follows camera and pending work cannot resurrect a disposed rig', async () => {
  const pending = deferred(), pistol = record(0), rifle = record(1);
  const vm = new ProceduralViewmodel({ weaponFactory: index => index === 0 ? pistol : pending.promise });
  const camera = new THREE.PerspectiveCamera(); camera.add(vm.group);
  await vm.setWeapon(0); tick(vm, {}); vm.setVisible(true);
  assert.equal(vm.group.visible, true); assert.equal(vm.flash(), true);
  vm.update(0.02);
  assert.ok(pistol.parts.action.position.z > 0);
  assert.equal(vm._flashes.filter(flash => flash.sprite.visible).length, 1);
  const first = vm.muzzleWorldPosition(); camera.position.x = 10;
  assert.ok(Math.abs(vm.muzzleWorldPosition().x - first.x - 10) < 1e-8);
  vm.update(0.2);
  assert.equal(vm._flashes.filter(flash => flash.sprite.visible).length, 0);
  assert.equal(pistol.parts.action.position.z, 0);
  const loading = vm.setWeapon(1); vm.dispose(); pending.resolve(rifle);
  assert.equal(await loading, false); assert.equal(rifle.disposals, 1);
  assert.equal(vm.group.parent, null); assert.equal(vm.group.visible, false); assert.equal(vm.flash(), false);
});

test('graphics refresh and scene disposal leave private Enhanced overlay materials and surface maps intact', async () => {
  const graphics = new GraphicsManager({ storage: null, document: null }); graphics.setMode('enhanced');
  const camera = new THREE.PerspectiveCamera(), scene = new THREE.Scene(); scene.add(camera);
  const vm = new ProceduralViewmodel(); camera.add(vm.group); await vm.setWeapon(1);
  const materials = new Map(), textures = new Map();
  vm.group.traverse(object => {
    if (!object.isMesh && !object.isSprite) return;
    materials.set(object, object.material);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const value of Object.values(material)) if (value?.isTexture && !textures.has(value)) {
        textures.set(value, 0); value.addEventListener('dispose', () => textures.set(value, textures.get(value) + 1));
      }
    }
  });
  const verify = () => {
    for (const [object, material] of materials) {
      assert.equal(object.userData.graphicsOwned, true); assert.equal(object.material, material);
      assert.equal(object.castShadow, false); assert.equal(object.receiveShadow, false);
      for (const item of Array.isArray(material) ? material : [material]) {
        assert.equal(item.depthTest, false); assert.equal(item.depthWrite, false); assert.equal(item.transparent, true);
      }
    }
    for (const count of textures.values()) assert.equal(count, 0);
  };
  graphics.applyScene(scene, null); verify();
  graphics.setMode('original', { scene, player: null }); verify();
  graphics.setMode('enhanced', { scene, player: null }); verify();
  graphics.releaseScene(scene); graphics.dispose(); verify();
  vm.dispose(); for (const count of textures.values()) assert.equal(count, 1);
});
