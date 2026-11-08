import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {buildEnhancedLandscape,createLandscapeGeometry,isEnhancedLandscapeMaterial} from '../js/enhanced-landscape.js';
import {remainingEnhancedSource,selectEnhancedSourceMaterials} from '../js/enhanced-source.js';
import {mergeWorldMeshes} from '../js/merge-world.js';
import {WorldCollision} from '../js/collision.js';
import {EnhancedMaterialLibrary} from '../js/enhanced-materials.js';

const root=new URL('../',import.meta.url),manifest=JSON.parse(await readFile(new URL('assets/manifest.json',root),'utf8'));
const levels=await Promise.all(manifest.levels.map(level=>readFile(new URL(manifest.models[level.model.toLowerCase()],root),'utf8').then(JSON.parse)));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const library=()=>({createKind:()=>new THREE.MeshStandardMaterial(),createLandscape:()=>new THREE.MeshStandardMaterial(),disposeMaterial:m=>m.dispose()});
const release=result=>{for(const g of result.geometries)g.dispose();for(const m of result.materials)m.dispose();};

test('landscape selection is source-hash and level specific; faces, water, murals and props stay excluded',()=>{
  assert.equal(isEnhancedLandscapeMaterial({map:'assets/images/tx5-6e6d85ae3024.jpg'},3),true);
  assert.equal(isEnhancedLandscapeMaterial({map:'assets/images/tx5-6e6d85ae3024.jpg'},4),false);
  for(const map of ['TX5.JPG','rock-unrelated.jpg','grass4-unrelated.jpg','assets/images/water.jpg','assets/enhanced/characters/face-color.webp'])assert.equal(isEnhancedLandscapeMaterial({map},3),false,map);
});

test('all nine maps receive separate bounded landscape geometry without mutating any source arrays',()=>{
  const expected=[1,1,3,1,2,5,2,1,1];
  for(let index=0;index<levels.length;index++){
    const data=levels[index],before=hash(data),result=buildEnhancedLandscape({modelData:data,library:library(),levelId:index+1});
    assert.equal(result.stats.surfaces,expected[index],`level ${index+1}`);
    assert.ok(result.stats.triangles<=28000);assert.ok(result.stats.triangles>result.stats.sourceTriangles);
    assert.ok(result.stats.maxDisplacementMeters<=.45);
    for(const mesh of result.group.children){assert.equal(mesh.userData.collision,false);assert.equal(mesh.userData.graphicsOwned,true);assert.ok([...mesh.geometry.attributes.position.array].every(Number.isFinite));}
    assert.equal(hash(data),before,`source changed on level ${index+1}`);
    const low=buildEnhancedLandscape({modelData:data,library:library(),levelId:index+1,quality:'low'});
    assert.ok(low.stats.triangles<=7000);assert.ok(low.stats.triangles<=result.stats.triangles);release(low);release(result);
  }
});

test('terrain edge relief is continuous across source triangles and keeps exterior seams fixed',()=>{
  const p=[new THREE.Vector3(0,0,0),new THREE.Vector3(10,20,0),new THREE.Vector3(10,20,10),new THREE.Vector3(0,0,10)];
  const triangle=ids=>ids.map(i=>({p:p[i],rawUV:new THREE.Vector2(p[i].x/10,p[i].z/10),normal:new THREE.Vector3(-2,1,0).normalize()}));
  const g=createLandscapeGeometry([triangle([0,2,1]),triangle([0,3,2])],{subdivisions:8});
  assert.ok(g.userData.maxDisplacementMeters>.025);assert.ok(g.userData.maxDisplacementMeters<=.45);
  const a=g.attributes.position,shared=[];
  // Both copies of every internal diagonal vertex must land at the same point.
  for(let i=0;i<9;i++){
    const first=i*9-i*(i-1)/2; // j=0 along first triangle's 0 -> 2 side
    const second=45+i; // second triangle's i=0, j=0..8 along 0 -> 2
    shared.push(new THREE.Vector3().fromBufferAttribute(a,first).distanceTo(new THREE.Vector3().fromBufferAttribute(a,second)));
  }
  assert.ok(shared.every(distance=>distance<1e-5),JSON.stringify(shared));
  for(let i=0;i<a.count;i++){const x=a.getX(i),y=a.getY(i),z=a.getZ(i);if(x===0||x===10||z===0||z===10)assert.ok(Math.abs(y-x*2)<1e-5);}
  g.dispose();
});

test('TX3 stairs and platforms get limestone while rock remains a separate scan without duplicate source surfaces',()=>{
  const material='shared',mesh={name:'arbitrary-fragment-after-architecture',vertices:[0,0,0,1000,0,0,1000,0,1000,0,0,1000],uv:[0,0,1,0,1,1,0,1],indices:[0,2,1,0,3,2],groups:[{start:0,count:6,material}]};
  const data={materials:{shared:{map:'assets/images/tx3-05285933d5f6.jpg'}},meshes:[mesh]},before=hash(data);
  const result=buildEnhancedLandscape({modelData:data,library:library(),levelId:3});
  assert.ok(result.hiddenMaterialNames.has(material));assert.equal(result.retainedMeshes.length,0);
  const remainder=remainingEnhancedSource(data,result.hiddenMaterialNames,result.retainedMeshes);
  assert.deepEqual(selectEnhancedSourceMaterials(remainder,result.hiddenMaterialNames).meshes,remainder.meshes);
  const borrowed=new THREE.MeshLambertMaterial(),retained=mergeWorldMeshes(remainder,{shared:borrowed},borrowed);retained.scale.setScalar(.01);retained.updateMatrixWorld(true);result.group.updateMatrixWorld(true);
  const ray=new THREE.Raycaster(new THREE.Vector3(.70*10,3,.88*10),new THREE.Vector3(0,-1,0),0,8);
  assert.ok(ray.intersectObject(result.group,true).some(hit=>hit.object.name.endsWith(':paving')),'stairs get dedicated limestone');
  assert.equal(ray.intersectObject(retained,true).length,0,'consumed old texture does not overlap new surface');
  ray.ray.origin.set(.24*10,3,.65*10);assert.ok(ray.intersectObject(result.group,true).length>0,'ordinary rock is genuinely replaced');
  assert.equal(hash(data),before);retained.traverse(o=>o.geometry?.dispose());borrowed.dispose();release(result);
});

test('partially consumed source groups never reintroduce missing triangles',()=>{
  const data=structuredClone(levels[2]);
  const target=data.meshes.find(mesh=>mesh.groups.some(part=>isEnhancedLandscapeMaterial(data.materials[part.material],3)));
  const part=target.groups.find(part=>isEnhancedLandscapeMaterial(data.materials[part.material],3));
  const isolated={...data,meshes:[{...target,name:'a clipped fragment',indices:target.indices.slice(part.start,part.start+3),groups:[{start:0,count:3,material:part.material}]}]};
  const result=buildEnhancedLandscape({modelData:isolated,library:library(),levelId:3});
  assert.equal(result.stats.sourceTriangles,1);assert.ok(result.stats.triangles<=12*12*8);release(result);
});

test('adding or removing the entire visual landscape preserves actual collision triangle counts and ray hits',()=>{
  const data=levels[2],mats=Object.fromEntries(Object.keys(data.materials).map(name=>[name,new THREE.MeshLambertMaterial()]));
  const world=mergeWorldMeshes(data,mats,Object.values(mats)[0]);world.scale.setScalar(.01);
  const scene=new THREE.Group();scene.add(world);const collision=new WorldCollision().setWorld(scene),count=collision.triangleCount;
  const samples=[[0,50,0],[12.55,50,-7.5],[-27.37,50,-33.39],[70,50,33],[63,50,30]].map(p=>new THREE.Vector3(...p));
  const hits=()=>samples.map(p=>collision.ray(p,new THREE.Vector3(0,-1,0),150)?.position.toArray());
  const before=hits(),result=buildEnhancedLandscape({modelData:data,world,library:library(),levelId:3});scene.add(result.group);collision.setWorld(scene);
  assert.equal(collision.triangleCount,count);assert.deepEqual(hits(),before);result.group.removeFromParent();collision.setWorld(scene);assert.deepEqual(hits(),before);
  release(result);world.traverse(o=>o.geometry?.dispose());Object.values(mats).forEach(m=>m.dispose());
});

test('landscape borrows only atlas masks, uses real independent scan normals, and disposes none of the source maps',async()=>{
  const pack=JSON.parse(await readFile(new URL('assets/enhanced/materials/manifest.json',root),'utf8'));
  const lib=new EnhancedMaterialLibrary({json:async()=>pack,url:p=>p},{textureLoader:{loadAsync:async()=>new THREE.Texture()}});await lib.load();
  const atlas=new THREE.Texture();atlas.repeat.set(2,3);atlas.offset.set(.2,.4);let disposed=0;atlas.addEventListener('dispose',()=>disposed++);
  const material=lib.createLandscape({atlas,mode:1,path:'concrete'}),u=material.userData.enhancedUniforms;
  assert.equal(u.enhancedAtlas.value,atlas);assert.equal(u.landscapeRockNormal.value,lib.sets.get('cliff').normal);assert.equal(u.landscapePathNormal.value,lib.sets.get('concrete').normal);
  assert.notEqual(u.enhancedNormal.value,atlas);assert.equal(material.defines.ENHANCED_LANDSCAPE,1);
  assert.deepEqual(u.enhancedAtlasTransform.value.elements,new THREE.Matrix3().setUvTransform(.2,.4,2,3,0,0,0).elements);
  lib.setQuality('low');assert.equal(u.enhancedLow.value,1);lib.disposeMaterial(material);lib.dispose();assert.equal(disposed,0);atlas.dispose();
});
