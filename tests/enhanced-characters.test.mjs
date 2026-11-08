import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { Assets } from '../js/assets.js';
import { createCharacter } from '../js/characters.js';
import { createEnhancedCharacterSkin, ENHANCED_CHARACTER_STYLES } from '../js/enhanced-characters.js';
import { createEnhancedCharacterMaterials } from '../js/enhanced-character-materials.js';

const root = new URL('../', import.meta.url), assets = new Assets();
assets.json = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));
assets.texture = async () => new THREE.Texture();
await assets.init();
const names = ['Gulman', 'Dama', 'Box', 'Bugay', 'Ded', 'BruceLee', 'BoSS'];
const make = name => createCharacter(name, assets.model.bind(assets), assets.json.bind(assets));
function visibleBounds(skin) {
  const result = new THREE.Box3(), point = new THREE.Vector3();
  for (const mesh of skin.meshes) if (mesh.visible) {
    mesh.updateWorldMatrix(true, false);
    const positions = mesh.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) result.expandByPoint(point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld));
  }
  return result;
}
function sourceHash(character) {
  const hash = createHash('sha256');
  for (const mesh of character.meshes) {
    hash.update(Buffer.from(mesh.geometry.attributes.position.array.buffer));
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) hash.update(material.uuid);
  }
  return hash.digest('hex');
}

test('seven original rigs receive new bounded anatomical geometry and two shared materials without altering their assets', async () => {
  const materials = createEnhancedCharacterMaterials();
  for (const name of names) {
    const character = await make(name), before = sourceHash(character), skin = createEnhancedCharacterSkin(character, name, { materials });
    assert.equal(skin.stats.materials, 2, name);
    assert.equal(skin.stats.meshes, 16, name);
    assert.ok(skin.stats.triangles > 13000 && skin.stats.triangles <= 27000, `${name}: ${skin.stats.triangles} triangles`);
    assert.ok(skin.stats.authoredDetails > 90, name);
    assert.ok(character.meshes.every(mesh => !mesh.visible), `${name}: Crowd reads direct mesh visibility`);
    const box = visibleBounds(skin), size = box.getSize(new THREE.Vector3());
    assert.ok(Math.abs(box.min.y) < .012, `${name}: feet ${box.min.y}`);
    assert.ok(box.max.y > 1.65 && box.max.y < 1.95, `${name}: height ${box.max.y}`);
    assert.ok(size.x < 1.0 && size.z < 1.1, `${name}: coherent standing body bounds ${size.toArray()}`);
    for (const mesh of skin.meshes) {
      assert.equal(mesh.parent, character.bones.get(mesh.userData.boneId));
      assert.equal(mesh.userData.graphicsOwned, true);
      assert.ok(mesh.castShadow && mesh.receiveShadow);
      for (const attribute of Object.values(mesh.geometry.attributes)) for (const value of attribute.array) assert.ok(Number.isFinite(value), `${name}: non-finite ${attribute.name}`);
      for (const value of mesh.geometry.attributes.uv.array) assert.ok(value >= 0 && value <= 1, name);
    }
    assert.equal(sourceHash(character), before, `${name}: original data intact`);
    skin.setEnabled(false);
    assert.ok(character.meshes.every(mesh => mesh.visible));
    assert.ok(skin.meshes.every(mesh => !mesh.visible));
    assert.ok(skin.meshes.every(mesh => !mesh.parent), 'disabled overlays cannot change Original Box3 grounding');
    skin.dispose(); character.dispose();
  }
  assert.equal(Object.keys(ENHANCED_CHARACTER_STYLES).length, 7);
  materials.dispose();
});

test('disabled overlays preserve Original crouch and death motion exactly', async () => {
  const original = await make('Gulman'), decorated = await make('Gulman'), materials = createEnhancedCharacterMaterials();
  const skin = createEnhancedCharacterSkin(decorated, 'Gulman', { materials, enabled: false });
  for (const state of [{ crouching: true }, { dead: true }, {}]) {
    for (let i = 0; i < 120; i++) { original.update(1 / 60, state); decorated.update(1 / 60, state); }
    original.group.updateMatrixWorld(true); decorated.group.updateMatrixWorld(true);
    for (const [id, bone] of original.bones) assert.deepEqual(bone.matrixWorld.elements, decorated.bones.get(id).matrixWorld.elements);
  }
  skin.setEnabled(true);
  assert.ok(skin.meshes.every(mesh => mesh.parent === decorated.bones.get(mesh.userData.boneId)));
  skin.dispose(); materials.dispose(); original.dispose(); decorated.dispose();
});

test('same-type actors share prototype geometry, preserve exact source visibility and release only after the last skin', async () => {
  const materials = createEnhancedCharacterMaterials(), a = await make('Gulman'), b = await make('Gulman');
  a.meshes[0].visible = false;
  const left = createEnhancedCharacterSkin(a, 'Gulman', { materials }), right = createEnhancedCharacterSkin(b, 'Gulman', { materials });
  assert.equal(createEnhancedCharacterSkin(a, 'Gulman', { materials }), left, 'a second call does not attach another skin');
  const disposed = [];
  for (let i = 0; i < left.meshes.length; i++) {
    assert.equal(left.meshes[i].geometry, right.meshes[i].geometry);
    assert.equal(left.meshes[i].material, right.meshes[i].material);
    assert.notEqual(left.meshes[i].parent, right.meshes[i].parent);
    left.meshes[i].geometry.addEventListener('dispose', () => disposed.push(i));
  }
  let materialDisposals = 0;
  materials.material.addEventListener('dispose', () => materialDisposals++);
  left.dispose(); left.dispose();
  assert.equal(disposed.length, 0);
  assert.equal(a.meshes[0].visible, false);
  assert.ok(a.meshes.slice(1).every(mesh => mesh.visible));
  assert.ok(left.meshes.every(mesh => !mesh.parent));
  right.dispose();
  assert.equal(disposed.length, 16);
  assert.equal(materialDisposals, 0, 'supplied material library belongs to its caller');
  materials.dispose(); a.dispose(); b.dispose();
});

test('late skin creation uses immutable standing basis and animated visible feet settle without hidden original bounds', async () => {
  const a = await make('Dama'), b = await make('Dama'), ma = createEnhancedCharacterMaterials(), mb = createEnhancedCharacterMaterials();
  const early = createEnhancedCharacterSkin(a, 'Dama', { materials: ma });
  for (let i = 0; i < 45; i++) b.update(1 / 60, { moving: true });
  const late = createEnhancedCharacterSkin(b, 'Dama', { materials: mb });
  for (let i = 0; i < early.meshes.length; i++) assert.deepEqual(early.meshes[i].geometry.attributes.position.array, late.meshes[i].geometry.attributes.position.array);
  // An invisible source outlier must never lift an Enhanced corpse above floor.
  const original = b.meshes[0], oldBox = original.geometry.boundingBox;
  original.geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-1e5, -1e5, -1e5), new THREE.Vector3(1e5, 1e5, 1e5));
  try {
    for (const state of [{ crouching: true }, { dead: true }]) {
      for (let i = 0; i < 240; i++) b.update(1 / 60, state);
      assert.ok(Math.abs(visibleBounds(late).min.y) < .008, `visible body meets ground for ${JSON.stringify(state)}`);
    }
  } finally { original.geometry.boundingBox = oldBox; }
  early.dispose(); late.dispose(); ma.dispose(); mb.dispose(); a.dispose(); b.dispose();
});
