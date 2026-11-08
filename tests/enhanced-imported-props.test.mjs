import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {EnhancedImportedProps,importedPropPlacements,propInstanceMatrix} from '../js/enhanced-imported-props.js';
import {buildEnhancedProps,classifyProp} from '../js/enhanced-props.js';

const root=new URL('../',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('assets/manifest.json',root),'utf8'));
function source(name,map,size=[1,1,1],position=[0,0,0]){
  const geometry=new THREE.BoxGeometry(...size.map(v=>v*100));geometry.translate(position[0]*100,(position[1]+size[1]/2)*100,position[2]*100);
  const mesh={name,vertices:Array.from(geometry.attributes.position.array),indices:Array.from(geometry.index.array),groups:[{material:map,start:0,count:geometry.index.count}]};geometry.dispose();return mesh;
}
function data(meshes){return{meshes,materials:Object.fromEntries(['box','barrel','lejak','table'].map(k=>[k,{originalMap:{box:'BOX.JPG',barrel:'БОЧКА-2.JPG',lejak:'LEJAK.JPG',table:'TABLE.JPG'}[k]}]))};}
function model(){
  const material=new THREE.MeshStandardMaterial({map:new THREE.Texture()}),scene=new THREE.Group(),low=new THREE.Group();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(2,1,1,2,2,2),material));low.add(new THREE.Mesh(new THREE.BoxGeometry(2,1,1),material));
  return{scene,scenes:[scene,low]};
}
const pack={models:Object.fromEntries(['crate','barrel','table','chair'].map(kind=>[kind,{path:kind,lodScene:1}]))};

test('shape selection distinguishes actual props from shared-atlas towers, platforms, benches and chairs',()=>{
  const meshes=[source('crate','box'),source('tower','box',[5.5,21.4,5.5]),source('beam','box',[.3,2.5,.3]),source('platform','box',[14,3,14]),source('chair','lejak',[.7,1.1,.7]),source('lounger','lejak',[1.3,1,3.6]),source('bench','table',[2,.59,.8]),source('small-chair','table',[.6,.9,.6]),source('round-table','table',[1.1,.8,1.1])],d=data(meshes);
  assert.deepEqual(meshes.map(m=>classifyProp(m,d)),['crate',null,null,null,'chair','lounger',null,'chair','table']);
  assert.deepEqual(importedPropPlacements(d).map(p=>p.mesh.name),['crate','chair','small-chair','round-table']);
  const original=JSON.stringify(d),fallback=buildEnhancedProps(d,{createKind:()=>null});
  assert.equal(JSON.stringify(d),original);assert.equal(fallback.replacements,3);
  assert.ok(fallback.retainedMeshes.includes(meshes[4]));assert.ok(fallback.retainedMeshes.includes(meshes[1]));
  fallback.group.traverse(o=>{o.geometry?.dispose();if(o.isInstancedMesh)o.dispose();});fallback.materials.forEach(m=>m.dispose());
});

test('all nine original worlds exclude obvious BOX architecture; small original chairs become chairs',async()=>{
  const counts=[];
  for(const level of manifest.levels){
    const d=JSON.parse(await readFile(new URL(manifest.models[level.model],root),'utf8')),selected=importedPropPlacements(d);
    assert.ok(selected.length>0);counts.push({level:level.id,count:selected.length});
    for(const p of selected.filter(p=>p.kind==='crate'))assert.ok(p.placement.size.y<=3&&Math.max(p.placement.size.x,p.placement.size.z)<=3.5);
    if(level.id===1)assert.equal(selected.find(p=>p.mesh.name==='dx9')?.kind,'chair');
    if(level.id===6)assert.ok(!selected.some(p=>p.mesh.name==='dx173'));
    if(level.id===5)assert.ok(!selected.some(p=>p.mesh.name==='Mesh160'));
  }
  assert.equal(counts.length,9);
});

test('success is instanced and only successfully replaced source chunks are consumed',async()=>{
  const meshes=[source('crate','box'),source('tower','box',[5,20,5]),source('barrel','barrel'),source('chair','lejak',[.7,1.1,.7])],d=data(meshes),snapshot=JSON.stringify(d);
  const layer=new EnhancedImportedProps({modelData:d,manifest:pack,loadModel:async(_s,kind)=>{if(kind==='barrel')throw Error('offline');return model();}});
  await layer.load();assert.equal(layer.replacements,2);assert.equal(layer.stats.failures.length,1);
  assert.deepEqual([...layer.hiddenMaterialNames].sort(),['box','lejak']);assert.deepEqual(layer.retainedMeshes,[meshes[1]]);
  assert.ok(!layer.replacedMeshes.has(meshes[2]));assert.equal(JSON.stringify(d),snapshot);
  assert.ok(layer.group.children.every(o=>o.isInstancedMesh&&o.userData.graphicsOwned&&o.userData.collision===false));
  layer.dispose();assert.equal(layer.geometries.size,0);assert.equal(layer.group.children.length,0);
});

test('distance LOD retains every object while enforcing the low-quality near budget',async()=>{
  const meshes=Array.from({length:100},(_,i)=>source('crate'+i,'box',[1,1,1],[i*.1,0,0]));
  const layer=new EnhancedImportedProps({modelData:data(meshes),manifest:pack,loadModel:async()=>model()});await layer.load();
  const camera=new THREE.PerspectiveCamera();layer.update(camera,'low',0);
  const batch=layer.batches[0];assert.equal(batch.high[0].count,24);assert.equal(batch.low[0].count,76);
  camera.position.set(200,0,0);layer.update(camera,'low',1);assert.equal(batch.high[0].count,0);assert.equal(batch.low[0].count,100);
  layer.dispose();
});

test('instance envelope stays inside the source bounds, including rotated chairs',()=>{
  const d=data([source('crate','box',[1.1,1.3,1.2]),source('chair','lejak',[.62,1.1,.8])]);
  const box=new THREE.Box3(new THREE.Vector3(-1,0,-.5),new THREE.Vector3(1,1,.5));
  for(const record of importedPropPlacements(d)){
    const result=box.clone().applyMatrix4(propInstanceMatrix(record,box,.7)),expected=record.placement.box;
    assert.ok(result.min.y>=expected.min.y-1e-6&&result.max.y<=expected.max.y+1e-6);
    for(const axis of ['x','z'])assert.ok(result.min[axis]>=expected.min[axis]-1e-6&&result.max[axis]<=expected.max[axis]+1e-6);
  }
});

test('dispose during an async load releases late imported resources once and never publishes replacements',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r),prototype=model(),events={geometry:0,material:0,texture:0};
  const geometries=new Set();for(const scene of prototype.scenes)scene.traverse(o=>{if(o.geometry)geometries.add(o.geometry);});
  for(const g of geometries)g.addEventListener('dispose',()=>events.geometry++);
  const material=prototype.scene.children[0].material;material.addEventListener('dispose',()=>events.material++);material.map.addEventListener('dispose',()=>events.texture++);
  const layer=new EnhancedImportedProps({modelData:data([source('crate','box')]),manifest:pack,loadModel:()=>pending});
  const loading=layer.load();layer.dispose();resolve(prototype);await loading;layer.dispose();
  assert.deepEqual(events,{geometry:2,material:1,texture:1});assert.equal(layer.replacements,0);assert.equal(layer.group.children.length,0);
});

test('shipped CC0 files match provenance hashes and distance meshes retain complete source vertex attributes',async()=>{
  const records=JSON.parse(await readFile(new URL('assets/enhanced/props/sources.json',root),'utf8'));
  assert.equal(records.length,4);let bytes=0;
  for(const record of records){
    assert.equal(record.license,'CC0-1.0');assert.ok(record.source.startsWith('https://polyhaven.com/a/'));
    for(const file of record.files){const buffer=await readFile(new URL(file.path,root));assert.equal(buffer.length,file.bytes);assert.equal(createHash('sha256').update(buffer).digest('hex'),file.sha256);bytes+=buffer.length;}
    const file=record.files.find(f=>f.path.endsWith('.gltf')),gltf=JSON.parse(await readFile(new URL(file.path,root),'utf8'));
    assert.equal(gltf.scenes.length,2);assert.ok(gltf.extras.gulmanLOD.lowTriangles<gltf.extras.gulmanLOD.highTriangles*.2);
    const buffers=await Promise.all(gltf.buffers.map(b=>readFile(new URL(b.uri,new URL(file.path,root)))));
    for(const mesh of gltf.meshes)for(const p of mesh.primitives){
      assert.ok(p.attributes.NORMAL!==undefined&&p.attributes.TEXCOORD_0!==undefined);
      const a=gltf.accessors[p.indices],v=gltf.bufferViews[a.bufferView],b=buffers[v.buffer],C=a.componentType===5125?Uint32Array:Uint16Array;
      const indices=new C(b.buffer,b.byteOffset+(v.byteOffset||0)+(a.byteOffset||0),a.count);
      assert.equal(indices.length%3,0);for(const i of indices)assert.ok(i<gltf.accessors[p.attributes.POSITION].count);
    }
  }
  assert.ok(bytes<3*1024*1024,'the optional prop pack stays below 3 MiB');
});
