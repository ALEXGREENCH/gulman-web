import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import {mergeWorldMeshes} from '../js/merge-world.js';

const root = new URL('../', import.meta.url);

test('material batching keeps per-corner UV and explicit normals without welding', () => {
  const a = new THREE.MeshBasicMaterial(), b = new THREE.MeshBasicMaterial();
  const data = {meshes:[
    {vertices:[0,0,0, 1,0,0, 0,1,0, 1,1,0], normals:[0,0,1, 0,0,1, 0,0,1, 0,0,1], uv:[0,0, 1,0, 0,1, 1,1], indices:[0,1,2, 1,3,2], groups:[{start:0,count:3,material:'a'},{start:3,count:3,material:'b'}]},
    {vertices:[0,0,0, 0,1,0, 0,0,1], normals:[1,0,0, 1,0,0, 1,0,0], uv:[.25,.5, .5,1, 1,0], indices:[0,1,2], groups:[{start:0,count:3,material:'a'}]},
  ]};
  const merged = mergeWorldMeshes(data, {a,b}, b);
  assert.equal(merged.children.length, 2);
  const ga = merged.children.find(m => m.material === a).geometry;
  assert.equal(ga.index, null);
  assert.deepEqual([...ga.getAttribute('position').array], [0,0,0, 1,0,0, 0,1,0, 0,0,0, 0,1,0, 0,0,1]);
  assert.deepEqual([...ga.getAttribute('normal').array], [0,0,1, 0,0,1, 0,0,1, 1,0,0, 1,0,0, 1,0,0]);
  assert.deepEqual([...ga.getAttribute('uv').array], [0,0, 1,0, 0,1, .25,.5, .5,1, 1,0]);
  assert.deepEqual(ga.groups, [{start:0,count:6,materialIndex:0}]);
});

test('all nine worlds preserve triangle count and exact float32 bounds', async t => {
  const manifest = JSON.parse(await fs.readFile(new URL('assets/manifest.json',root),'utf8'));
  for (const level of manifest.levels) {
    await t.test(`level ${level.id}`, async () => {
      const data = JSON.parse(await fs.readFile(new URL(manifest.models[level.model],root),'utf8'));
      const materials = Object.fromEntries(Object.keys(data.materials).map(k => [k,new THREE.MeshBasicMaterial()]));
      const fallback = new THREE.MeshBasicMaterial();
      const originalBox = new THREE.Box3();
      let sourceCorners = 0, originalCalls = 0;
      for (const mesh of data.meshes) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position',new THREE.Float32BufferAttribute(mesh.vertices,3));
        g.computeBoundingBox(); originalBox.union(g.boundingBox); g.dispose();
        sourceCorners += mesh.indices.length;
        originalCalls += mesh.groups.length || 1;
      }
      const merged = mergeWorldMeshes(data,materials,fallback);
      const mergedBox = new THREE.Box3().setFromObject(merged);
      assert.deepEqual(mergedBox.min.toArray(),originalBox.min.toArray());
      assert.deepEqual(mergedBox.max.toArray(),originalBox.max.toArray());
      const renderedCorners = merged.children.reduce((sum,m) => sum+m.geometry.getAttribute('position').count,0);
      assert.equal(renderedCorners,sourceCorners);
      assert.ok(merged.children.length < originalCalls / 2, 'draw calls should decrease materially');
      for (const mesh of merged.children) {
        const g = mesh.geometry;
        assert.equal(g.getAttribute('position').count,g.getAttribute('normal').count);
        assert.equal(g.getAttribute('position').count,g.getAttribute('uv').count);
        assert.equal(g.groups[0].count,g.getAttribute('position').count);
        g.dispose();
      }
      t.diagnostic(`Level ${level.id}: ${originalCalls} → ${merged.children.length} world draw calls; ${sourceCorners/3} triangles unchanged`);
    });
  }
});
