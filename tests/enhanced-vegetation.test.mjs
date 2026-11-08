import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/addons/loaders/GLTFLoader.js';
import { EnhancedVegetation, vegetationPlacements } from '../js/enhanced-vegetation.js';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('assets/manifest.json', root), 'utf8'));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
globalThis.ProgressEvent ??= class { constructor(type, values) { this.type = type; Object.assign(this, values); } };
async function original(id) { const level = manifest.levels.find(l => l.id === id); return JSON.parse(await readFile(new URL(manifest.models[level.model], root), 'utf8')); }
async function prototype(kind) {
  const folder = new URL('assets/enhanced/vegetation/' + kind + '/', root);
  const data = JSON.parse(await readFile(new URL('model.gltf', folder), 'utf8'));
  for (const buffer of data.buffers) buffer.uri = 'data:application/octet-stream;base64,' + (await readFile(new URL(buffer.uri, folder))).toString('base64');
  // Exercise the real GLTF parser/mesh/node transforms in Node; image decoding
  // belongs to browser QA, so replace only texture references with neutral PBR.
  for (const material of data.materials) { const name = material.name; for (const key of Object.keys(material)) delete material[key]; material.name = name; }
  delete data.textures; delete data.images;
  return (await new GLTFLoader().parseAsync(data, '')).scene;
}

test('all nine source levels replace every dedicated tree/palm/tuia/bush/flower material without consuming terrain or mutating original geometry', async t => {
  for (let id = 1; id <= 9; id++) {
    const data = await original(id), before = hash(data), result = vegetationPlacements(data);
    const expected = Object.entries(data.materials).filter(([, spec]) => /^(tree\.tga|tuia[12]?\.(tga|jpg)|palma\.tga|bush\.tga|flowers\.tga)$/i.test(spec.originalMap || '')).map(([name]) => name);
    assert.deepEqual([...result.hiddenMaterialNames].sort(), expected.sort());
    assert.equal(hash(data), before);
    assert.equal(result.retainedMeshes.length, 0, 'all actual groups using dedicated foliage maps are understood');
    assert.ok(result.placements.length > 0);
    assert.ok(result.placements.every(p => p.size.y > .12 && p.size.y < 40 && p.position.toArray().every(Number.isFinite)));
    const bushParts = result.placements.filter(p => p.kind === 'shrub').reduce((sum, p) => sum + p.sourceParts, 0);
    if ([1, 2, 3, 4, 5].includes(id)) assert.ok(bushParts > result.placements.filter(p => p.kind === 'shrub').length, 'crossed source cards become one volumetric plant');
    t.diagnostic(`L${id}: ${result.placements.length} plants replace ${result.sourceParts} source groups`);
  }
});

test('partial material batches retain unconsumed groups with correct indices and preserve all source arrays', () => {
  const data = { materials: { plants: { originalMap: 'BUSH.TGA' }, ground: { originalMap: 'GRASS4.JPG' } }, meshes: [{ name: 'mixed', vertices: [0, 0, 0, 100, 100, 0, 100, 0, 0, 300, 0, 0, 400, 0, 0, 300, 0, 100], indices: [0, 1, 2, 3, 4, 5, 3, 5, 4], groups: [{ start: 0, count: 3, material: 'plants' }, { start: 3, count: 3, material: 'plants' }, { start: 6, count: 3, material: 'ground' }] }] };
  const before = hash(data), result = vegetationPlacements(data);
  assert.equal(result.placements.length, 1); assert.deepEqual([...result.hiddenMaterialNames], ['plants']);
  assert.equal(result.retainedMeshes.length, 1); assert.deepEqual(result.retainedMeshes[0].indices, [3, 4, 5]);
  assert.deepEqual(result.retainedMeshes[0].groups, [{ start: 0, count: 3, material: 'plants' }]);
  assert.equal(result.retainedMeshes[0].vertices, data.meshes[0].vertices); assert.equal(hash(data), before);
});

test('self-hosted source pack hashes, LOD geometry, indices and browser glTF transforms are valid and bounded', async () => {
  const sources = JSON.parse(await readFile(new URL('assets/enhanced/vegetation/sources.json', root), 'utf8'));
  assert.deepEqual(sources.map(s => s.kind).sort(), ['broadleaf', 'conifer', 'flower', 'palm', 'shrub']);
  let bytes = 0;
  for (const source of sources) {
    assert.equal(source.license, 'CC0-1.0');
    for (const file of source.files) { const value = await readFile(new URL(file.path, root)); bytes += value.length; assert.equal(createHash('sha256').update(value).digest('hex'), file.sha256); }
    const scene = await prototype(source.kind); scene.updateMatrixWorld(true);
    const counts = {};
    for (const lod of ['high', 'low']) {
      const node = scene.getObjectByName(lod); assert.ok(node); const bounds = new THREE.Box3().setFromObject(node); assert.ok(bounds.getSize(new THREE.Vector3()).length() > .05);
      counts[lod] = 0;
      node.traverse(mesh => { if (!mesh.isMesh) return; const p = mesh.geometry.attributes.position; assert.ok([...p.array].every(Number.isFinite)); for (const index of mesh.geometry.index.array) assert.ok(index < p.count); counts[lod] += mesh.geometry.index.count / 3; });
    }
    const budgets={broadleaf:[34000,5000],conifer:[37000,8500],shrub:[8000,2000],palm:[1032,1032],flower:[148,148]}[source.kind];
    assert.ok(counts.high <= budgets[0], `${source.kind}: bounded detailed mesh`); assert.ok(counts.low <= budgets[1], `${source.kind}: bounded distant mesh`); assert.ok(counts.low <= counts.high);
    scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  }
  assert.ok(bytes < 11 * 1024 * 1024, 'all five self-hosted species fit a compact download');
});

test('conifer twig clusters retain the whole crown; shrubs, palms and flowers preserve authored surface coverage',async()=>{
  const records=JSON.parse(await readFile(new URL('assets/enhanced/vegetation/conifer/geometry-stats.json',root),'utf8'));
  for(const lod of ['high','low']){
    const twig=records.find(r=>r.lod===lod&&r.material==='fir_tree_01_twig');
    assert.equal(twig.coverage.sourceBranches,7817);assert.equal(twig.coverage.occupiedCells,651);
    assert.equal(twig.coverage.retainedCells,651);assert.equal(twig.triangles,twig.coverage.retainedBranches*4);
    if(lod==='high')assert.equal(twig.coverage.retainedBranches,twig.coverage.sourceBranches,'close LOD retains every authored twig axis');
  }
  function surface(node){
    let area=0,components=0,triangles=0;const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3();
    node.traverse(mesh=>{if(!mesh.isMesh)return;const p=mesh.geometry.attributes.position,index=mesh.geometry.index,parent=Int32Array.from({length:p.count},(_,i)=>i),root=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
      for(let i=0;i<index.count;i+=3){const ia=index.getX(i),ib=index.getX(i+1),ic=index.getX(i+2);parent[root(ia)]=root(ib);parent[root(ib)]=root(ic);a.fromBufferAttribute(p,ia);b.fromBufferAttribute(p,ib);c.fromBufferAttribute(p,ic);area+=b.sub(a).cross(c.sub(a)).length()/2;triangles++;}
      components+=new Set(Array.from({length:p.count},(_,i)=>root(i))).size;
    });return{area,components,triangles};
  }
  for(const kind of ['shrub','palm','flower']){
    const scene=await prototype(kind),high=surface(scene.getObjectByName('high')),low=surface(scene.getObjectByName('low'));
    assert.ok(low.area/high.area>.93,`${kind}: distant LOD retains at least 93% of source surface area`);
    assert.ok(low.components/high.components>.99,`${kind}: disconnected fronds/leaves must survive simplification`);
    if(kind!=='shrub')assert.deepEqual(low,high,`${kind} is already compact and needs no geometry removal`);
    scene.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});
  }
});

test('broadleaf LOD preserves leaves throughout the whole crown instead of pruning disconnected leaf islands',async()=>{
  const records=JSON.parse(await readFile(new URL('assets/enhanced/vegetation/broadleaf/geometry-stats.json',root),'utf8'));
  for(const lod of ['high','low']){
    const leaves=records.find(r=>r.lod===lod&&r.material==='island_tree_02_leaves');
    assert.equal(leaves.coverage.sourceLeaves,29781);assert.equal(leaves.coverage.occupiedCells,709);
    assert.equal(leaves.coverage.retainedCells,leaves.coverage.occupiedCells);
    assert.equal(leaves.triangles,leaves.coverage.retainedLeaves*2,'two textured triangles per complete leaf, never arbitrary half-leaf fragments');
    assert.ok(leaves.coverage.areaRatio>.8,'reconstructed leaf surfaces must cover the crown; this is rectangle area before texture alpha');
  }
  const scene=await prototype('broadleaf'),a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),normal=new THREE.Vector3();
  scene.traverse(mesh=>{
    if(!mesh.isMesh||!mesh.material.name.includes('leaves'))return;
    const {position,normal:normals}=mesh.geometry.attributes,index=mesh.geometry.index;
    for(let i=0;i<index.count;i+=3){
      const ia=index.getX(i);a.fromBufferAttribute(position,ia);b.fromBufferAttribute(position,index.getX(i+1));c.fromBufferAttribute(position,index.getX(i+2));normal.fromBufferAttribute(normals,ia);
      assert.ok(b.sub(a).cross(c.sub(a)).dot(normal)>0,'leaf front faces must agree with their authored normals');
    }
  });
  scene.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});
});

test('actual level 4 uses shared instanced LODs, source-sized trees, bounded low mode, culling and owned resource disposal', async () => {
  const data = await original(4), before = hash(data), layer = new EnhancedVegetation({ modelData: data, loadModel: prototype });
  await layer.load(); assert.ok(layer.ready); assert.equal(hash(data), before);
  assert.ok(layer.stats.replacements > 100); assert.ok(layer.stats.batches <= 18);
  for (const batch of layer.batches) { assert.ok(batch.mesh.isInstancedMesh); assert.equal(batch.mesh.userData.graphicsOwned, true); assert.equal(batch.mesh.userData.collision, false); }
  const p = vegetationPlacements(data).placements.find(p => p.kind === 'broadleaf');
  layer.update(1, p.position, 'low'); assert.ok(layer.stats.visible > 0); assert.ok(layer.stats.triangles < 500000, `360-degree view without frustum culling draws ${layer.stats.triangles} foliage triangles`);
  const high = layer.stats.high; layer.update(2, p.position, 'high'); assert.ok(layer.stats.high >= high);
  layer.update(3, new THREE.Vector3(10000, 10000, 10000), 'low'); assert.equal(layer.stats.visible, 0); assert.ok(layer.batches.every(b => b.mesh.count === 0));
  let geometryDisposed = 0, materialDisposed = 0;
  const geometryCount = layer.geometries.size, materialCount = layer.materials.size;
  for (const g of layer.geometries) g.addEventListener('dispose', () => geometryDisposed++);
  for (const m of layer.materials) m.addEventListener('dispose', () => materialDisposed++);
  layer.dispose(); layer.dispose(); assert.equal(geometryDisposed, geometryCount); assert.equal(materialDisposed, materialCount); assert.equal(layer.group.children.length, 0); assert.equal(hash(data), before);
});

test('dispose during asynchronous import releases late resources and never hides source materials', async () => {
  const data = await original(1); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const layer = new EnhancedVegetation({ modelData: data, loadModel: async kind => { await gate; return prototype(kind); } });
  const loading = layer.load(); layer.dispose(); release(); await loading;
  assert.equal(layer.hiddenMaterialNames.size, 0); assert.equal(layer.ready, false); assert.equal(layer.geometries.size, 0); assert.equal(layer.group.children.length, 0);
});
