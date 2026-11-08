import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createEnhancedWeapon, ENHANCED_WEAPON_SPECS } from '../js/enhanced-weapons.js';

test('four newly authored weapons have distinct silhouettes, PBR detail and bounded draw/triangle counts', () => {
  const silhouettes = new Set();
  for (let index = 0; index < 4; index++) {
    const weapon = createEnhancedWeapon(index), size = weapon.bounds.getSize(new THREE.Vector3());
    assert.equal(weapon.name, ENHANCED_WEAPON_SPECS[index].name);
    assert.ok(weapon.stats.authoredParts >= 50);
    assert.ok(weapon.stats.triangles > 3000 && weapon.stats.triangles < 9000);
    assert.ok(weapon.stats.meshes <= 14, `weapon ${index}: ${weapon.stats.meshes} draw batches`);
    assert.equal(weapon.stats.textures, 4);
    assert.ok(size.x > 0.045 && size.x < 0.14); assert.ok(size.y > 0.14 && size.y < 0.33);
    assert.ok(size.z > 0.08 && size.z < 0.75);
    silhouettes.add(size.toArray().map(value => value.toFixed(3)).join(','));
    const maps = new Set(), roughness = new Set(), metalness = new Set();
    weapon.group.traverse(object => {
      if (!object.isMesh) return;
      assert.ok(object.geometry.attributes.position.array.every(Number.isFinite));
      assert.ok(object.geometry.attributes.normal.array.every(Number.isFinite));
      assert.equal(object.material.isMeshStandardMaterial, true);
      roughness.add(object.material.roughness); metalness.add(object.material.metalness);
      if (object.material.normalMap) maps.add(object.material.normalMap);
    });
    assert.ok(maps.size >= 2); assert.ok(roughness.size >= 4); assert.ok(metalness.size >= 4);
    for (const map of maps) { assert.equal(map.image.width, 128); assert.equal(map.userData.graphicsOwned, true); }
    weapon.dispose();
  }
  assert.equal(silhouettes.size, 4);
});

test('moving magazines, bolts and levers return exactly to rest when firing/reload ends or is interrupted', () => {
  for (let index = 0; index < 4; index++) {
    const weapon = createEnhancedWeapon(index);
    weapon.shot(); weapon.update(0.025);
    if (index < 2) assert.ok(weapon.parts.action.position.z > 0);
    weapon.update(0.25);
    assert.deepEqual(weapon.parts.action.position.toArray(), [0, 0, 0]);
    weapon.update(0.016, { reloading: true, reloadProgress: 0.35 });
    assert.ok(weapon.parts.magazine.position.length() > 0.03);
    if (index > 1) assert.ok(Math.abs(weapon.parts.action.rotation.x) > 0.2);
    weapon.update(0.016, { reloading: false });
    for (const part of Object.values(weapon.parts)) {
      assert.equal(part.position.lengthSq(), 0);
      assert.ok(part.quaternion.angleTo(new THREE.Quaternion()) < 1e-8);
      assert.equal(part.visible, true);
    }
    const count = weapon.group.children.length;
    for (let shot = 0; shot < 200; shot++) { weapon.shot(); weapon.update(0.02); }
    assert.equal(weapon.group.children.length, count);
    weapon.dispose();
  }
});

test('model-owned geometry, materials and deterministic maps dispose exactly once', () => {
  const first = createEnhancedWeapon(0), second = createEnhancedWeapon(0), resources = new Map();
  const textures = [];
  first.group.traverse(object => {
    if (!object.isMesh) return;
    for (const resource of [object.geometry, object.material, object.material.normalMap, object.material.roughnessMap]) {
      if (!resource || resources.has(resource)) continue;
      resources.set(resource, 0); resource.addEventListener('dispose', () => resources.set(resource, resources.get(resource) + 1));
      if (resource.isTexture) textures.push(resource);
    }
  });
  const secondMap = second.group.children[0].children.find(object => object.material.normalMap).material.normalMap;
  assert.ok(textures.some(texture => texture.image.data.every((value, index) => value === secondMap.image.data[index])));
  first.dispose(); first.dispose();
  for (const count of resources.values()) assert.equal(count, 1);
  assert.ok(second.group.children[0].children.length > 0, 'other model instance retains independent resources');
  second.dispose();
});
