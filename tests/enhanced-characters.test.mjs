import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { Assets } from '../js/assets.js';
import { createCharacter } from '../js/characters.js';
import { createEnhancedCharacterSkin, ENHANCED_CHARACTER_STYLES, poseAnatomicalHandPoint } from '../js/enhanced-characters.js';
import { humanAnatomy } from '../assets/enhanced/characters/human-anatomy.js';
import { createEnhancedCharacterMaterials } from '../js/enhanced-character-materials.js';

const root = new URL('../', import.meta.url), assets = new Assets();
assets.json = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const sourceTextures = new Map();
assets.texture = async material => {
  if (!sourceTextures.has(material.map)) sourceTextures.set(material.map, new THREE.Texture());
  return sourceTextures.get(material.map);
};
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

test('Enhanced steadies the idle rig, removes the abrupt loop pose and holds a long fall pose', async () => {
  const character = await make('Gulman');
  const torso = character.bones.get(1), shoulder = character.bones.get(10), knee = character.bones.get(6);
  const tick = state => character.update(1 / 60, { enhanced: true, ...state });
  const materials = createEnhancedCharacterMaterials();
  const skin = createEnhancedCharacterSkin(character, 'Gulman', { materials });
  try {
    character.attachWeapon(await assets.model('models/weapons/weaponpistol.3ds', true));
    for (let i = 0; i < 60; i++) tick();
    let previousMuzzle = character.weaponMuzzlePosition();
    let idleMotion = 0;
    for (let i = 0; i < 120; i++) {
      tick();
      const muzzle = character.weaponMuzzlePosition();
      idleMotion = Math.max(idleMotion, muzzle.distanceTo(previousMuzzle));
      previousMuzzle = muzzle;
    }
    assert.ok(idleMotion > .0005 && idleMotion < .003, `steady idle still animates, peak muzzle step ${idleMotion} m`);

    const idleShoulder = shoulder.quaternion.clone();
    tick({ moving: true, running: true });
    const sprintResponse = shoulder.quaternion.angleTo(idleShoulder);
    assert.ok(sprintResponse > .13 && sprintResponse < .25, `first sprint frame responds without jerking, shoulder changed ${sprintResponse} rad`);

    for (const state of [{moving: true, running: true}, {moving: true, running: true, direction: 'left'}, {moving: true, running: true, direction: 'right'}, {crouching: true}]) {
      for (let i = 0; i < 60; i++) tick(state);
      const startTorso = torso.quaternion.clone(), startShoulder = shoulder.quaternion.clone(), startKnee = knee.quaternion.clone();
      let kneeMotion = 0;
      for (let i = 0; i < 180; i++) {
        tick(state);
        assert.ok(torso.quaternion.angleTo(startTorso) < .03, 'torso must not return to the shared reference pose');
        assert.ok(shoulder.quaternion.angleTo(startShoulder) < .35, 'shoulder follows the animation without returning to the reference pose');
        kneeMotion = Math.max(kneeMotion, knee.quaternion.angleTo(startKnee));
      }
      if (state.running) assert.ok(kneeMotion > .5, 'running still animates the legs');
    }
    for (let i = 0; i < 150; i++) tick({ airborne: true });
    const fallenTorso = torso.quaternion.clone();
    for (let i = 0; i < 120; i++) {
      tick({ airborne: true });
      assert.ok(torso.quaternion.angleTo(fallenTorso) < .001, 'a long fall holds its last pose');
    }
  } finally { skin.dispose(); materials.dispose(); character.dispose(); }
});

test('walking continues the current leg pose when sprint is released mid-stride', async () => {
  const character = await make('Gulman');
  const legs = [4, 5, 6, 7, 8, 9].map(id => character.bones.get(id));
  try {
    for (const enhanced of [false, true]) {
      for (const sprintFrames of [24, 35, 46]) {
        for (let i = 0; i < 60; i++) character.update(1 / 60, { enhanced });
        for (let i = 0; i < sprintFrames; i++) character.update(1 / 60, { enhanced, moving: true, running: true });
        const before = legs.map(bone => bone.quaternion.clone());
        character.update(1 / 60, { enhanced, moving: true, running: false });
        const change = Math.max(...legs.map((bone, i) => bone.quaternion.angleTo(before[i])));
        assert.ok(change < .4, `sprint released after ${sprintFrames} frames, Enhanced=${enhanced}: leg moved ${change} rad`);
      }
    }
  } finally { character.dispose(); }
});

test('firearm pose closes three fingers, keeps a trigger finger and opposes the thumb without moving the wrist', () => {
  const source = humanAnatomy.parts.rightHand;
  const pose = point => poseAnatomicalHandPoint(source, ...point, true);
  assert.deepEqual(pose([0, 0, 0]), [0, 0, 0]);
  const index = pose(source.landmarks['finger-2-4']);
  for (const finger of [3, 4, 5]) {
    const tip = pose(source.landmarks[`finger-${finger}-4`]), base = source.landmarks[`finger-${finger}-1`];
    assert.ok(Math.abs(tip[1] - base[1]) < .025, `${finger}: fingertip returns toward its knuckle`);
    assert.ok(tip[2] < (finger === 5 ? -.018 : -.025), `${finger}: fingertip wraps onto the palm side`);
    assert.ok(index[1] > tip[1] + .025, 'index reaches the trigger ahead of curled fingers');
  }
  const thumb = pose(source.landmarks['finger-1-4']);
  assert.ok(Math.abs(thumb[0]) < .035, 'thumb opposes the grip rather than splaying out');
});

test('Enhanced grip offset follows replacement weapons, updates the muzzle and restores Original exactly', async () => {
  const character = await make('Gulman'), materials = createEnhancedCharacterMaterials();
  const weapon = await assets.model('models/weapons/weaponpistol.3ds', true);
  const root = character.attachWeapon(weapon), originalRoot = root.getWorldPosition(new THREE.Vector3()), originalMuzzle = character.weaponMuzzlePosition();
  const skin = createEnhancedCharacterSkin(character, 'Gulman', { materials });
  const offset = character.getWeaponGripOffset(), current = root.getWorldPosition(new THREE.Vector3());
  assert.ok(offset.length() > .04 && offset.length() < .09, 'grip fits inside the closed anatomical palm');
  assert.ok(current.clone().sub(originalRoot).distanceTo(offset) < 1e-6);
  assert.ok(character.weaponMuzzlePosition().clone().sub(originalMuzzle).distanceTo(offset) < 1e-6);
  const replacement = character.attachWeapon(await assets.model('models/weapons/weaponpistol.3ds', true));
  assert.ok(replacement.getWorldPosition(new THREE.Vector3()).distanceTo(current) < 1e-6, 'weapon changes preserve the fit');
  skin.setEnabled(false);
  assert.deepEqual(character.getWeaponGripOffset().toArray(), [0, 0, 0]);
  assert.ok(replacement.getWorldPosition(new THREE.Vector3()).distanceTo(originalRoot) < 1e-6);
  assert.ok(character.weaponMuzzlePosition().distanceTo(originalMuzzle) < 1e-6, 'Original muzzle is restored too');
  character.setWeaponGripOffset([.01, .02, -.03]); skin.setEnabled(true); skin.dispose();
  assert.deepEqual(character.getWeaponGripOffset().toArray(), [.01, .02, -.03], 'custom prior offset is restored on disposal');
  materials.dispose(); character.dispose();
});

test('seven rigs preserve original costumes and hair with PBR detail and reconstructed faces', async () => {
  const materials = createEnhancedCharacterMaterials();
  for (const name of names) {
    const character = await make(name), before = sourceHash(character), originalFeet = visibleBounds({meshes: character.meshes}).min.y, skin = createEnhancedCharacterSkin(character, name, { materials });
    assert.ok(skin.stats.materials <= 4, name);
    assert.ok(skin.stats.meshes <= 19, name);
    assert.ok(skin.stats.triangles > 4000 && skin.stats.triangles <= 27000, `${name}: ${skin.stats.triangles} triangles`);
    assert.equal(skin.stats.sourceBodyParts, name === 'BoSS' ? 11 : 12, `${name}: costume, limbs and shoes use the source silhouette`);
    assert.equal(skin.stats.anatomicalHands, 2, `${name}: real CC0 human topology replaces mitten/capsule hands`);
    assert.equal(skin.stats.anatomicalHead, true);
    const head = skin.meshes.find(mesh => mesh.userData.anatomicalSource && mesh.userData.boneId === 2);
    assert.equal(head.geometry.attributes.position.count / 3, 4000, 'the face uses the imported head topology');
    assert.equal(head.material, materials.faceMaterial, 'approved face atlas remains on the anatomical head');
    for (const mesh of skin.meshes.filter(mesh => mesh.userData.anatomicalSource && mesh.userData.boneId !== 2)) {
      assert.equal(mesh.geometry.attributes.position.count / 3, 3328);
      assert.equal(mesh.material, materials.material);
      assert.ok([14, 15].includes(mesh.userData.boneId));
    }
    assert.ok(skin.stats.sourceHairParts > 0, `${name}: original hairstyle/hat survives`);
    assert.ok(skin.meshes.some(mesh => mesh.material === materials.faceMaterial), `${name}: approved new faces survive`);
    assert.ok(character.meshes.every(mesh => !mesh.visible && mesh.userData.characterSurface), `${name}: source body is hidden and marked as animated`);
    const box = visibleBounds(skin), size = box.getSize(new THREE.Vector3());
    assert.ok(Math.abs(box.min.y - originalFeet) < 1e-6, `${name}: original feet position ${box.min.y}`);
    assert.ok(box.max.y > 1.65 && box.max.y < 1.95, `${name}: height ${box.max.y}`);
    assert.ok(size.x < 1.0 && size.z < 1.1, `${name}: coherent standing body bounds ${size.toArray()}`);
    for (const mesh of skin.meshes) {
      assert.equal(mesh.parent, character.bones.get(mesh.userData.boneId));
      assert.equal(mesh.userData.graphicsOwned, true);
      assert.ok(mesh.userData.characterSurface && mesh.castShadow && !mesh.receiveShadow, 'animated surfaces cast shadows without sampling an older pose');
      for (const attribute of Object.values(mesh.geometry.attributes)) for (const value of attribute.array) assert.ok(Number.isFinite(value), `${name}: non-finite ${attribute.name}`);
      if (!mesh.userData.sourceSilhouette) for (const value of mesh.geometry.attributes.uv.array) assert.ok(value >= 0 && value <= 1, name);
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

test('every source body vertex and UV survives unchanged in the standing bone frame', async () => {
  const materials = createEnhancedCharacterMaterials();
  const vertexTuples = geometries => geometries.flatMap(({ attributes: { position, uv } }) =>
    Array.from({ length: position.count }, (_, i) =>
      [position.getX(i), position.getY(i), position.getZ(i), uv.getX(i), uv.getY(i)].join(',')
    )
  ).sort();
  for (const name of names) {
    const character = await make(name), skin = createEnhancedCharacterSkin(character, name, { materials });
    const ids = new Map([...character.bones].map(([id, bone]) => [bone, id]));
    const sourceByBone = new Map();
    for (const source of [...character.meshes].sort((a, b) => a.name.localeCompare(b.name))) {
      const transform = new THREE.Matrix4(); let parent = source;
      while (parent && !ids.has(parent)) { parent.updateMatrix(); transform.premultiply(parent.matrix); parent = parent.parent; }
      const id = ids.get(parent); if ([2, 14, 15, 16].includes(id)) continue;
      const original = source.geometry.index ? source.geometry.toNonIndexed() : source.geometry.clone(); original.applyMatrix4(transform);
      const list = sourceByBone.get(id) ?? []; list.push(original); sourceByBone.set(id, list);
    }
    for (const [id, originals] of sourceByBone) {
      const replacement = skin.meshes.find(mesh => mesh.userData.boneId === id && mesh.userData.sourceSilhouette);
      assert.ok(replacement, `${name}: original part ${id}`);
      assert.deepEqual(vertexTuples([replacement.geometry]), vertexTuples(originals), `${name}: exact original geometry and UVs at bone ${id}`);
      assert.equal(replacement.material.normalMap.channel, 1);
      assert.equal(replacement.material.roughnessMap.channel, 1);
      assert.ok(replacement.geometry.attributes.uv1, 'micro weave uses independent UVs');
      for (const original of originals) original.dispose();
    }
    skin.dispose(); character.dispose();
  }
  materials.dispose();
});

test('Box forearm keeps its visible normals when its original mirror is baked into the skin', async () => {
  const character = await make('Box'), materials = createEnhancedCharacterMaterials();
  const skin = createEnhancedCharacterSkin(character, 'Box', { materials });
  try {
    const arm = skin.meshes.find(mesh => mesh.userData.boneId === 13 && mesh.userData.sourceSilhouette);
    const { position, normal } = arm.geometry.attributes;
    const face = new THREE.Triangle(), faceNormal = new THREE.Vector3(), vertexNormal = new THREE.Vector3();
    for (let i = 0; i < position.count; i += 3) {
      face.a.fromBufferAttribute(position, i);
      face.b.fromBufferAttribute(position, i + 1);
      face.c.fromBufferAttribute(position, i + 2);
      face.getNormal(faceNormal);
      assert.ok(faceNormal.dot(vertexNormal.fromBufferAttribute(normal, i)) > 0, `inverted forearm triangle ${i / 3}`);
    }
  } finally { skin.dispose(); materials.dispose(); character.dispose(); }
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
  assert.equal(disposed.length, left.meshes.length);
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
