import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { buildEnhancedBoats } from '../js/enhanced-boats.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sourceBox(mesh) {
  const result = new THREE.Box3(), point = new THREE.Vector3();
  for (let i = 0; i < mesh.vertices.length; i += 3) result.expandByPoint(point.fromArray(mesh.vertices, i).multiplyScalar(0.01));
  return result;
}
function release(result) {
  for (const child of result.group.children) child.dispose();
  for (const geometry of result.geometries) geometry.dispose();
  for (const material of result.materials) material.dispose();
}
function rawBox(name, size, position, yaw = 0, material = 'boath') {
  const geometry = new THREE.BoxGeometry(...size);
  geometry.rotateY(yaw); geometry.translate(...position); geometry.scale(100, 100, 100);
  const mesh = { name, vertices: [...geometry.attributes.position.array], indices: [...geometry.index.array], groups: [{ start: 0, count: geometry.index.count, material }] };
  geometry.dispose(); return mesh;
}

test('actual level1 replaces the standalone boat and preserves both BOAT.JPG piers without changing source data', async () => {
  const root = new URL('../', import.meta.url), manifest = JSON.parse(await readFile(new URL('assets/manifest.json', root), 'utf8'));
  const data = JSON.parse(await readFile(new URL(manifest.models[manifest.levels[0].model.toLowerCase()], root), 'utf8'));
  const before = hash(data), result = buildEnhancedBoats(data);
  assert.equal(result.replacements, 1);
  assert.deepEqual(result.group.userData.sourceNames, ['dx31']);
  assert.deepEqual([...result.hiddenMaterialNames], ['boath']);
  assert.deepEqual(result.retainedMeshes.map(mesh => mesh.name), ['dx30', 'dx32']);
  for (const mesh of result.retainedMeshes) assert.equal(mesh, data.meshes.find(original => original.name === mesh.name));
  assert.equal(hash(data), before);
  const original = sourceBox(data.meshes.find(mesh => mesh.name === 'dx31'));
  const visual = new THREE.Box3().setFromObject(result.group);
  assert.ok(Math.abs(visual.min.y - original.min.y) < 1e-5, 'keel/feet remain at the original collider minimum');
  assert.ok(Math.abs(visual.max.y - original.max.y) < 1e-5, 'windscreen height fits the original height');
  for (const axis of ['x', 'z']) {
    assert.ok(visual.min[axis] >= original.min[axis] - 1e-5);
    assert.ok(visual.max[axis] <= original.max[axis] + 1e-5);
    assert.ok((visual.max[axis] - visual.min[axis]) / (original.max[axis] - original.min[axis]) > 0.97);
  }
  release(result);
});

test('multiple boats share seven geometry/material batches and preserve their rotated collider envelopes', () => {
  const boats = [rawBox('boat-a', [2.1, 1.65, 6.6], [20, -4, -40], 0.4), rawBox('boat-b', [2.3, 1.8, 7.3], [-30, -3, -43], -0.6)];
  const pier = rawBox('pier', [20, 5, 8], [28, -6, -48]);
  const data = { source: 'levels/1/level.3ds', materials: { boath: { originalMap: 'Textures\\BOAT.JPG' } }, meshes: [...boats, pier] };
  const result = buildEnhancedBoats(data);
  assert.equal(result.replacements, 2); assert.equal(result.group.children.length, 7);
  assert.equal(result.geometries.length, 7); assert.equal(result.materials.length, 7);
  assert.deepEqual(result.retainedMeshes, [pier]);
  const geometryBytes = result.geometries.reduce((sum, geometry) => sum + Object.values(geometry.attributes).reduce((bytes, attribute) => bytes + attribute.array.byteLength, 0), 0);
  const triangles = result.geometries.reduce((sum, geometry) => sum + geometry.attributes.position.count / 3, 0);
  assert.ok(geometryBytes < 2 * 1024 * 1024); assert.ok(triangles > 5000 && triangles < 18000);
  const matrix = new THREE.Matrix4();
  for (let instance = 0; instance < 2; instance++) {
    const bounds = new THREE.Box3(), expected = sourceBox(boats[instance]);
    for (const batch of result.group.children) {
      assert.equal(batch.isInstancedMesh, true); assert.equal(batch.count, 2);
      assert.equal(batch.userData.collision, false); assert.equal(batch.userData.graphicsOwned, true);
      batch.getMatrixAt(instance, matrix);
      assert.ok(matrix.determinant() > 0);
      bounds.union(batch.geometry.boundingBox.clone().applyMatrix4(matrix));
      assert.ok(batch.geometry.attributes.position.array.every(Number.isFinite));
      assert.ok(batch.geometry.attributes.normal.array.every(Number.isFinite));
    }
    for (const axis of ['x', 'y', 'z']) {
      assert.ok(bounds.min[axis] >= expected.min[axis] - 1e-5, `${axis} min overhang`);
      assert.ok(bounds.max[axis] <= expected.max[axis] + 1e-5, `${axis} max overhang`);
    }
    assert.ok(Math.abs(bounds.min.y - expected.min.y) < 1e-5);
  }
  release(result);
});

test('other levels, unrelated textures and long piers do not allocate replacement resources or hide source batches', () => {
  const boat = rawBox('boat', [2, 1.5, 7], [0, 0, 0]);
  const cases = [
    { source: 'levels/2/level.3ds', materials: { boath: { originalMap: 'BOAT.JPG' } }, meshes: [boat] },
    { source: 'levels/1/level.3ds', materials: { boath: { originalMap: 'WOOD.JPG' } }, meshes: [boat] },
    { source: 'levels/1/level.3ds', materials: { boath: { originalMap: 'BOAT.JPG' } }, meshes: [rawBox('pier', [20, 5, 8], [0, 0, 0])] },
  ];
  for (const data of cases) {
    const result = buildEnhancedBoats(data);
    assert.equal(result.replacements, 0); assert.equal(result.hiddenMaterialNames.size, 0);
    assert.equal(result.retainedMeshes.length, 0); assert.equal(result.group.children.length, 0);
    assert.equal(result.materials.length, 0); assert.equal(result.geometries.length, 0);
  }
});
