import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {OriginalProjectiles,ORIGINAL_PROJECTILE_WEAPONS,rollOriginalLoot,rollOriginalPickup} from '../js/original-combat.js';

const v=(x=0,y=1,z=0)=>new THREE.Vector3(x,y,z);
function fixture(world={ray:()=>null}){const impacts=[],scene=new THREE.Scene();const system=new OriginalProjectiles({scene,world,onImpact:hit=>impacts.push(hit),random:()=>.5});return {system,impacts,scene};}
function wallAt(x){return {ray:(origin,direction,max)=>{const distance=(x-origin.x)/direction.x;return distance>=0&&distance<=max?{distance,position:origin.clone().addScaledVector(direction,distance),normal:v(-1,0,0)}:null;}};}

test('the original blue rounds really travel; no damage is delivered at fire time',()=>{
  const f=fixture(),actor={pos:v(10,0,0),hp:100};f.system.fire({weapon:0,origin:v(),direction:v(1,0,0),damage:34});
  assert.equal(f.impacts.length,0);assert.equal(f.system.activeCount,1);f.system.update(.1,{actors:[actor]});assert.equal(f.impacts.length,0);
  assert.ok(Math.abs(f.system.projectiles[0].position.x-5)<1e-5);f.system.update(.11,{actors:[actor]});assert.equal(f.impacts.length,1);assert.equal(f.impacts[0].actor,actor);assert.equal(f.impacts[0].damage,34);assert.equal(f.system.activeCount,0);f.system.dispose();
});

test('swept collisions hit thin walls first, and enemies behind the wall receive no projectile hit',()=>{
  const f=fixture(wallAt(2)),actor={pos:v(3,0,0)};f.system.fire({weapon:1,origin:v(),direction:v(1,0,0)});f.system.update(.25,{actors:[actor]});
  assert.equal(f.impacts.length,1);assert.equal(f.impacts[0].actor,null);assert.equal(f.impacts[0].position.x,2);assert.deepEqual(f.impacts[0].normal.toArray(),[-1,0,0]);f.system.dispose();
});

test('yellow big-gun burst contains eight rounds but explicit trigger damage is never multiplied',()=>{
  const f=fixture(wallAt(2));assert.equal(f.system.fire({weapon:3,origin:v(),direction:v(1,0,0),damage:85}),8);assert.equal(f.system.activeCount,8);
  f.system.update(.2);assert.equal(f.impacts.length,8);assert.equal(f.impacts.reduce((sum,p)=>sum+p.damage,0),85);assert.ok(f.impacts.every(p=>p.weapon===3));f.system.dispose();
});

test('grenade moves along an arc and explodes at its original fuse, even without an immediate target',()=>{
  const f=fixture();f.system.fire({weapon:2,origin:v(0,5,0),direction:v(1,.5,0),damage:120});assert.ok(f.system.effects.every(e=>e.ttl===0),'a hand throw must not flash like a firearm');f.system.update(.5);
  assert.equal(f.impacts.length,0);const p=f.system.projectiles[0];assert.ok(p.mesh.visible);assert.ok(p.position.x>4);f.system.update(1);
  assert.equal(f.impacts.length,1);assert.equal(f.impacts[0].expired,true);assert.equal(f.impacts[0].splash,6);assert.equal(p.mesh.visible,false);assert.ok(f.system.effects.some(e=>e.ttl>0),'the delayed explosion still emits sparks');f.system.dispose();
});

test('classic grenade reflects off the first wall, loses speed, then detonates on the fuse',()=>{
  const f=fixture(wallAt(3));
  f.system.fire({weapon:2,origin:v(0,5,0),direction:v(1,0,0),classicGrenade:true});
  f.system.update(.35);const p=f.system.projectiles[0];
  assert.equal(f.impacts.length,0);assert.ok(p.mesh.visible&&p.velocity.x<0);
  assert.ok(Math.abs(p.classicSpeed-1.7424)<1e-8);
  assert.ok(p.position.x>2.7&&p.position.x<3);
  f.system.update(1.15);assert.equal(f.impacts.length,1);
  assert.equal(f.impacts[0].expired,true);assert.equal(f.impacts[0].splash,6);
  f.system.dispose();
});

test('the real original grenade stays Y-up, 18 cm tall and rotates about its centre without editing cached resources',async()=>{
  const data=JSON.parse(await readFile(new URL('../assets/models/granate-a21ec8b8a246.json',import.meta.url),'utf8'));
  assert.equal(data.coordinateSystem,'y-up');assert.equal(data.originalCoordinateSystem,'z-up');
  // Match Assets.buildModel(false), including the original centimetre scale.
  const prototype=new THREE.Group(),material=new THREE.MeshLambertMaterial(),geometries=[];prototype.scale.setScalar(.01);
  for(const source of data.meshes){const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(source.vertices,3));geometry.setIndex(source.indices);geometries.push(geometry);prototype.add(new THREE.Mesh(geometry,material));}
  const before=geometries.map(g=>Array.from(g.attributes.position.array));let borrowedDisposals=0,ownedDisposals=0;
  for(const r of [...geometries,material])r.addEventListener('dispose',()=>borrowedDisposals++);
  const f=fixture();f.system.assets={manifest:{},model:async(path,raw)=>{assert.equal(path,'models/weapons/granate.3ds');assert.equal(raw,false);return prototype;}};
  for(const r of [f.system.geometry,f.system.material,f.system.fallback,f.system.grenadeGeometry,f.system.grenadeMaterial])r.addEventListener('dispose',()=>ownedDisposals++);
  await f.system.load();const origin=v(7,4,-3);f.system.fire({weapon:2,origin,direction:v(1,.5,0)});
  const p=f.system.projectiles[0],box=new THREE.Box3().setFromObject(p.mesh,true),size=box.getSize(new THREE.Vector3());
  assert.ok(box.getCenter(new THREE.Vector3()).distanceTo(origin)<1e-6);assert.ok(Math.abs(size.y-.18)<1e-6);assert.ok(size.y>size.x&&size.y>size.z,'do not undo the asset converter and rotate the Y-up model back into Z-up');
  const instances=[];p.mesh.traverse(o=>{if(o.isMesh)instances.push(o);});assert.equal(instances.length,geometries.length);
  for(let i=0;i<instances.length;i++){assert.equal(instances[i].geometry,geometries[i]);assert.equal(instances[i].material,material);}
  f.system.update(.2);assert.ok(Math.abs(p.mesh.rotation.x)>1&&Math.abs(p.mesh.rotation.z)>.5);
  p.mesh.updateWorldMatrix(true,true);
  const sourceCenter=new THREE.Box3().setFromBufferAttribute(geometries[0].attributes.position).getCenter(new THREE.Vector3());
  assert.ok(instances[0].localToWorld(sourceCenter).distanceTo(p.position)<1e-6,'the centred grenade spins in place instead of orbiting its source origin');
  assert.deepEqual(prototype.position.toArray(),[0,0,0]);assert.deepEqual(prototype.scale.toArray(),[.01,.01,.01]);assert.deepEqual(prototype.userData,{});
  geometries.forEach((g,i)=>{assert.deepEqual(Array.from(g.attributes.position.array),before[i]);assert.equal(g.boundingBox,null);assert.equal(g.boundingSphere,null);});
  f.system.dispose();f.system.dispose();assert.equal(borrowedDisposals,0);assert.equal(ownedDisposals,5);assert.equal(p.mesh,null);assert.equal(f.scene.children.length,0);
  for(const r of [...geometries,material])r.dispose();
});

test('a pooled fallback grenade upgrades after model load and each throw restarts its own centred spin',async()=>{
  const borrowedGeometry=new THREE.BoxGeometry(20,40,10);borrowedGeometry.translate(200,-70,95);
  const borrowedMaterial=new THREE.MeshLambertMaterial(),prototype=new THREE.Group();prototype.add(new THREE.Mesh(borrowedGeometry,borrowedMaterial));
  const scene=new THREE.Scene(),system=new OriginalProjectiles({scene,world:{ray:()=>null},capacity:8,assets:{manifest:{},model:async()=>prototype}});
  system.fire({weapon:2,origin:v(),direction:v(1,1,0)});const p=system.projectiles[0],holder=p.mesh;
  assert.equal(holder.children[0].geometry,system.grenadeGeometry);system.update(.1);assert.notEqual(holder.rotation.x,0);
  await system.load();for(let i=0;i<7;i++)system.fire({weapon:0,origin:v(),direction:v(1,0,0)});
  assert.ok(system.effects.some(e=>e.ttl>0),'firearms retain their muzzle flash');
  const origin=v(5,8,3);system.fire({weapon:2,origin,direction:v(0,1,0)});
  assert.equal(p.mesh,holder);assert.deepEqual(holder.rotation.toArray().slice(0,3),[0,0,0]);assert.equal(holder.children.length,1);
  const box=new THREE.Box3().setFromObject(holder,true),size=box.getSize(new THREE.Vector3());assert.ok(Math.abs(Math.max(size.x,size.y,size.z)-.18)<1e-6);assert.ok(box.getCenter(new THREE.Vector3()).distanceTo(origin)<1e-6);
  const meshes=[];holder.traverse(o=>{if(o.isMesh)meshes.push(o);});assert.equal(meshes[0].geometry,borrowedGeometry);assert.equal(scene.children.length,1);assert.equal(system.root.children.length,2);
  system.dispose();borrowedGeometry.dispose();borrowedMaterial.dispose();
});

test('enemy projectiles hit the player only when their swept path reaches the player',()=>{
  const f=fixture();f.system.fire({weapon:1,origin:v(),direction:v(1,0,0),owner:'enemy',damage:4});f.system.update(.05,{playerPosition:v(8,0,0)});assert.equal(f.impacts.length,0);
  f.system.update(.2,{playerPosition:v(8,0,0)});assert.equal(f.impacts.length,1);assert.equal(f.impacts[0].actor,'player');assert.equal(f.impacts[0].owner,'enemy');f.system.dispose();
});

test('projectile movement and impacts remain stable at 25, 60 and 120 Hz',()=>{
  const results=[];for(const hz of [25,60,120]){const f=fixture(wallAt(13));f.system.fire({weapon:1,origin:v(),direction:v(1,.1,0)});for(let i=0;i<hz;i++)f.system.update(1/hz);assert.equal(f.impacts.length,1);results.push(f.impacts[0].position);f.system.dispose();}
  assert.ok(results.every(p=>p.distanceTo(results[0])<.001));
});

test('source pickup amounts are randomized grants, never the >1> token',()=>{
  assert.deepEqual(rollOriginalPickup('БАКСЫ',{random:()=>0}),{amount:20});assert.equal(rollOriginalPickup('БАКСЫ',{random:()=>1}).amount,39);
  assert.equal(rollOriginalPickup('АПТЕЧКА',{random:()=>0}).amount,7);assert.equal(rollOriginalPickup('АПТЕЧКА',{random:()=>1}).amount,16);
  assert.deepEqual(rollOriginalPickup('ПАТРОНЫ',{random:()=>0}),{amount:20,ammoByWeapon:[5,15,0,0]});
  let draws=[0,0,5/7,0,5/9,0];assert.deepEqual(rollOriginalPickup('ПАТРОНЫ',{random:()=>draws.shift()}),{amount:23,ammoByWeapon:[5,15,1,2]});
});

test('each death drops money, ammo/health follow source probabilities, and offsets stay bounded',()=>{
  let seed=7;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};const totals={'БАКСЫ':0,'ПАТРОНЫ':0,'АПТЕЧКА':0};
  for(let i=0;i<10000;i++)for(const drop of rollOriginalLoot(v(),{random})){totals[drop.command]++;assert.ok(drop.amount>=7);assert.ok(Math.abs(drop.position.x)<=.98&&Math.abs(drop.position.z)<=.98);assert.match(drop.model,/\.3ds$/);}
  assert.equal(totals['БАКСЫ'],10000);assert.ok(Math.abs(totals['ПАТРОНЫ']/10000-.2)<.02);assert.ok(Math.abs(totals['АПТЕЧКА']/10000-1/7)<.02);
  const start=v(3,7,4),drops=rollOriginalLoot(start,{random,world:{ray:()=>({}),ground:()=>undefined}});assert.deepEqual(drops[0].position.toArray(),start.toArray());
});

test('clear/dispose reset bounded pools and never dispose borrowed original texture or model resources',async()=>{
  const blue=new THREE.Texture(),yellow=new THREE.Texture(),borrowedGeometry=new THREE.BoxGeometry(),borrowedMaterial=new THREE.MeshLambertMaterial();let borrowedDisposals=0;
  for(const r of [blue,yellow,borrowedGeometry,borrowedMaterial])r.addEventListener('dispose',()=>borrowedDisposals++);
  let resolve;const pending=new Promise(r=>{resolve=r;}),prototype=new THREE.Group();prototype.add(new THREE.Mesh(borrowedGeometry,borrowedMaterial));
  const assets={manifest:{images:{'textures/3q.jpg':'blue','textures/2q.jpg':'yellow'}},texture:async({map})=>map==='blue'?blue:yellow,model:()=>pending};
  const f=fixture();f.system.assets=assets;const loading=f.system.load();await Promise.resolve();await Promise.resolve();f.system.dispose();resolve(prototype);await loading;assert.equal(borrowedDisposals,0);
  const active=fixture();for(let i=0;i<1000;i++)active.system.fire({weapon:1,origin:v(),direction:v(1,0,0)});assert.equal(active.system.activeCount,128);assert.equal(active.system.root.children.length,1);active.system.clear();assert.equal(active.system.activeCount,0);assert.ok([...active.system.geometry.attributes.alpha.array].every(a=>a===0));active.system.dispose();
  assert.equal(ORIGINAL_PROJECTILE_WEAPONS[0].speed,50);assert.equal(ORIGINAL_PROJECTILE_WEAPONS[3].count,8);for(const r of [blue,yellow,borrowedGeometry,borrowedMaterial])r.dispose();
});
