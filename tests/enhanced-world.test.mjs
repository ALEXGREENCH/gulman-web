import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { meshPlacement, buildEnhancedProps } from '../js/enhanced-props.js';
import { EnhancedWorld, foliagePlacements } from '../js/enhanced-world.js';
import { createEnhancedTerrainGeometry } from '../js/enhanced-terrain.js';

const base = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('assets/manifest.json', base), 'utf8'));
const model = async level => JSON.parse(await readFile(new URL(manifest.models[level.model], base), 'utf8'));
const counted = resource => {
  resource.disposals = 0;
  resource.addEventListener('dispose', () => resource.disposals++);
  return resource;
};

function library(load = async () => {}) {
  return {
    materials: new Set(), quality: 'high', disposed: false, load,
    create() { return this.createKind('sand'); },
    createKind() { const m = counted(new THREE.MeshStandardMaterial()); this.materials.add(m); return m; },
    setQuality(quality) { this.quality = quality; },
    disposeMaterial(m) { if (this.materials.delete(m)) m.dispose(); },
    dispose() { if (this.disposed) return; this.disposed = true; for (const m of this.materials) m.dispose(); this.materials.clear(); },
  };
}

function fixture({ low = false, load } = {}) {
  const scene = new THREE.Scene(), world = new THREE.Group();
  world.scale.setScalar(0.01);
  world.position.set(4, 0, -2);
  const geometry = counted(new THREE.PlaneGeometry(1000, 1000));
  geometry.rotateX(-Math.PI / 2);
  const source = counted(new THREE.MeshLambertMaterial({ color: 0xd1bf89 }));
  const mesh = new THREE.Mesh(geometry, source);
  mesh.name = 'world:beach'; world.add(mesh); scene.add(world);
  const data = { materials: { beach: { map: 'assets/images/beach-3aaad64c45d1.jpg', originalMap: 'BEACH.JPG' } }, meshes: [] };
  const layer = new EnhancedWorld({ assets: {}, scene, world, modelData: data, quality: low ? 'low' : 'high' });
  layer.library.dispose();
  layer.library = library(load);
  layer._plants = async () => {};
  return { scene, world, mesh, geometry, source, layer };
}

test('PCA placement retains the long axis and scale of rotated source furniture', () => {
  const geometry = new THREE.BoxGeometry(100, 75, 200);
  geometry.rotateY(0.62); geometry.translate(320, 87.5, -810);
  const p = meshPlacement({ vertices: [...geometry.attributes.position.array] });
  assert.ok(Math.abs(p.width - 1) < 1e-6);
  assert.ok(Math.abs(p.length - 2) < 1e-6);
  assert.ok(Math.abs(p.position.y - 0.5) < 1e-6);
  assert.ok(Math.abs(Math.cos(p.yaw - 0.62)) > 0.9999);
  geometry.dispose();
});

test('authored props across every level use bounded instancing and leave source data intact', async () => {
  let total = 0;
  for (const level of manifest.levels) {
    const data = await model(level), before = JSON.stringify(data), lib = library();
    const props = buildEnhancedProps(data, lib);
    assert.equal(JSON.stringify(data), before, `level ${level.id} source mutated`);
    assert.ok(props.group.children.length <= 25);
    for (const mesh of props.group.children) {
      assert.equal(mesh.isInstancedMesh, true);
      assert.equal(mesh.userData.graphicsOwned, true);
      assert.equal(mesh.userData.collision, false);
      assert.ok(mesh.count > 0);
      assert.ok([...mesh.instanceMatrix.array].every(Number.isFinite));
      assert.ok(mesh.geometry.attributes.position.count < 12000);
      mesh.geometry.dispose();
    }
    for (const material of props.materials) {
      if (lib.materials.has(material)) lib.disposeMaterial(material); else material.dispose();
    }
    lib.dispose();
    total += props.replacements;
  }
  assert.ok(total > 100, `expected real model replacement throughout levels, got ${total}`);
});

test('enhanced world preserves borrowed geometry/materials and exact original visibility', async () => {
  const f = fixture({ low: true });
  f.layer.setEnabled(true);
  await f.layer.load();
  assert.equal(f.layer.ready, true);
  assert.equal(f.layer.library.quality, 'low');
  assert.equal(f.mesh.visible, false);
  assert.equal(f.layer.group.visible, true);
  const replacement = f.layer.group.getObjectByName('enhanced-surface:beach');
  assert.equal(replacement.geometry, f.geometry);
  assert.notEqual(replacement.material, f.source);
  f.scene.updateMatrixWorld(true);
  assert.deepEqual(replacement.matrixWorld.elements, f.mesh.matrixWorld.elements);
  f.layer.setEnabled(false);
  assert.equal(f.mesh.visible, true);
  assert.equal(f.layer.group.visible, false);
  f.layer.setEnabled(true);
  f.layer.dispose(); f.layer.dispose();
  assert.equal(f.mesh.visible, true);
  assert.equal(f.source.disposals, 0);
  assert.equal(f.geometry.disposals, 0);
  assert.equal(replacement.material.disposals, 1);
  assert.equal(f.layer.group.parent, null);
});

test('switching back to Original while Enhanced loads never hides original meshes late', async () => {
  let release;
  const f = fixture({ load: () => new Promise(resolve => { release = resolve; }) });
  f.mesh.visible = false;
  f.layer.setEnabled(true);
  const pending = f.layer.load();
  f.layer.setEnabled(false);
  release(); await pending;
  assert.equal(f.layer.group.visible, false);
  assert.equal(f.mesh.visible, false, 'pre-existing hidden state is preserved');
  f.layer.setEnabled(true); f.layer.setEnabled(false);
  assert.equal(f.mesh.visible, false);
  f.layer.dispose();
  assert.equal(f.geometry.disposals, 0);
});

test('crossed original bush cards become one placement per plant', () => {
  const mesh = { groups: [{ material: 'bush' }], vertices: [-100, 0, 0, 100, 0, 0, 100, 150, 0, -100, 150, 0] };
  const data = { materials: { bush: { originalMap: 'BUSH.TGA' } }, meshes: [mesh, structuredClone(mesh), structuredClone(mesh)] };
  const placements = foliagePlacements(data);
  assert.equal(placements.length, 1);
  assert.equal(placements[0].position.y, 0);
  assert.equal(placements[0].size.y, 1.5);
});

test('terrain subdivision adds bounded relief while preserving source data and triangle seams', () => {
  const original = new THREE.BufferGeometry();
  original.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1000, 0, 0, 0, 0, -1000], 3));
  original.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  original.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  const before = [...original.attributes.position.array];
  const detailed = createEnhancedTerrainGeometry(original, 0.01, { triangleBudget: 64 });
  assert.notEqual(detailed, original);
  assert.equal(detailed.index.count / 3, 64);
  assert.deepEqual([...original.attributes.position.array], before);
  const vertices = detailed.getAttribute('position');
  let relief = false;
  for (let i = 0; i < vertices.count; i++) {
    const x = vertices.getX(i), y = vertices.getY(i), z = vertices.getZ(i);
    assert.ok(Math.abs(y * 0.01) <= 0.008001);
    if (Math.abs(x) < 1e-6 || Math.abs(z) < 1e-6 || Math.abs(x - z - 1000) < 1e-5) assert.equal(y, 0, 'original triangle edge moved');
    if (Math.abs(y) > 0.01) relief = true;
  }
  assert.equal(relief, true);
  assert.ok([...detailed.attributes.normal.array].every(Number.isFinite));
  const limited = createEnhancedTerrainGeometry(original, 0.01, { triangleBudget: 16 });
  assert.equal(limited.index.count / 3, 16);
  original.dispose(); detailed.dispose(); limited.dispose();
});

test('late model resources are released when a cancelled Enhanced load later succeeds or fails', async () => {
  for (const fail of [false, true]) {
    const f = fixture();
    let resume, started, lateGeometry, lateTexture;
    const ready = new Promise(resolve => { started = resolve; });
    f.layer._plants = async () => {
      started();
      await new Promise(resolve => { resume = resolve; });
      // Simulates glTF parse finishing after Original mode has disposed the
      // previous layer, followed by its separately requested alpha result.
      lateGeometry = counted(new THREE.BufferGeometry());
      lateTexture = counted(new THREE.Texture());
      f.layer.geometries.add(lateGeometry);
      f.layer.textures.add(lateTexture);
      if (fail) throw new Error('alpha request failed after cancellation');
    };
    f.layer.setEnabled(true);
    const pending = f.layer.load();
    await ready;
    f.layer.dispose();
    resume();
    if (fail) await assert.rejects(pending, /alpha request failed/); else await pending;
    assert.equal(lateGeometry.disposals, 1, `late geometry, failure=${fail}`);
    assert.equal(lateTexture.disposals, 1, `late texture, failure=${fail}`);
    assert.equal(f.mesh.visible, true);
    assert.equal(f.layer.group.parent, null);
    assert.equal(f.geometry.disposals, 0);
  }
});

test('CC0 models/HDR match recorded checksums and glTF dependencies are self-hosted', async () => {
  const records = JSON.parse(await readFile(new URL('assets/enhanced/models/sources.json', base), 'utf8'));
  let bytes = 0;
  for (const record of records) {
    assert.equal(record.license, 'CC0-1.0');
    for (const file of record.files) {
      const data = await readFile(new URL(file.path, base));
      assert.equal(data.byteLength, file.bytes, file.path);
      assert.equal(createHash('sha256').update(data).digest('hex'), file.sha256, file.path);
      bytes += data.byteLength;
      if (!file.path.endsWith('.gltf')) continue;
      const gltf = JSON.parse(data.toString('utf8'));
      for (const dependency of [...gltf.buffers ?? [], ...gltf.images ?? []]) {
        if (!dependency.uri) continue;
        assert.doesNotMatch(dependency.uri, /^(?:[a-z]+:|\/\/)/i, 'runtime external asset');
        const payload = await readFile(new URL(dependency.uri, new URL(file.path, base)));
        if (dependency.byteLength) assert.ok(payload.byteLength >= dependency.byteLength);
      }
    }
  }
  assert.ok(bytes < 12 * 1024 * 1024, `${bytes} model/HDR bytes`);
});
