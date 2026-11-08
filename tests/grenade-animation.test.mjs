import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {Assets} from '../js/assets.js';
import {createCharacter} from '../js/characters.js';
import {ProceduralViewmodel} from '../js/viewmodel.js';
const root=new URL('../',import.meta.url),assets=new Assets(),textures=new Map();
assets.json=async path=>JSON.parse(await readFile(new URL(path,root),'utf8'));
assets.texture=async material=>{if(!textures.has(material.map))textures.set(material.map,new THREE.Texture());return textures.get(material.map);};await assets.init();
const make=()=>createCharacter('Gulman',assets.model.bind(assets),assets.json.bind(assets));
const hand=c=>c.bones.get(14).getWorldPosition(new THREE.Vector3());

test('third-person throw winds behind shoulder, releases exactly once at 25/60/120 Hz, then recovers',async()=>{
 for(const dt of [.04,1/60,1/120]){
  const c=await make(),model=await assets.model('models/weapons/granate.3ds',true),held=c.attachWeapon(model,{length:.2});
  assert.equal(c.beginGrenadeThrow(),true);assert.equal(c.beginGrenadeThrow(),false);
  let time=0,count=0,windZ=Infinity,release=null;
  for(let i=0;i<Math.ceil(1.2/dt);i++){
   c.update(dt);time+=dt;const state=c.grenadeThrow;
   if(state.active&&state.time>.26&&state.time<.37)windZ=Math.min(windZ,hand(c).z);
   if(time<.46-1e-9){assert.equal(held.visible,true);assert.equal(c.consumeGrenadeRelease(),null);}
   const event=c.consumeGrenadeRelease();if(event){count++;release=event;assert.ok(time>=.46-1e-9&&time<=.46+dt+1e-8);assert.equal(held.visible,false);assert.equal(c.consumeGrenadeRelease(),null);}
  }
  assert.equal(count,1);assert.ok(windZ<-.25,`real wind-up ${windZ}`);assert.ok(release.z>windZ+.4);assert.ok(release.y>1.4&&release.y<1.9);
  assert.equal(c.grenadeThrow.active,false);assert.equal(held.visible,true);c.dispose();
 }
});

test('throw freezes at dt zero and cancel, death, weapon replacement or disposal never emit a pending grenade',async()=>{
 for(const mode of ['cancel','death','weapon','dispose']){
  const c=await make(),normal=await make();c.attachWeapon(await assets.model('models/weapons/granate.3ds',true),{length:.2});
  c.beginGrenadeThrow();for(let i=0;i<12;i++){c.update(1/60);normal.update(1/60);}
  const time=c.grenadeThrow.time;c.update(0);assert.equal(c.grenadeThrow.time,time);assert.equal(c.consumeGrenadeRelease(),null);
  if(mode==='cancel')c.cancelGrenadeThrow();if(mode==='death')c.update(.02,{dead:true});if(mode==='weapon')c.attachWeapon(await assets.model('models/weapons/weaponpistol.3ds',true));if(mode==='dispose')c.dispose();
  assert.equal(c.grenadeThrow.active,false);assert.equal(c.consumeGrenadeRelease(),null);
  if(mode==='cancel')for(const id of [10,12,14])assert.ok(c.bones.get(id).quaternion.angleTo(normal.bones.get(id).quaternion)<1e-7,'exact original clip pose restored');
  c.dispose();normal.dispose();
 }
});

test('both first-person grenade variants use the synchronized throw, hide only after release and open an anatomical hand',async()=>{
 const vm=new ProceduralViewmodel({assets}),camera=new THREE.PerspectiveCamera();camera.add(vm.group);
 for(const original of [false,true]){
  assert.equal(await vm.setWeapon(2,{original}),true);vm.setVisible(true);for(let i=0;i<60;i++)vm.update(1/60);
  const idle=vm.grenadeReleaseWorldPosition();
  vm.update(.02,{grenadeThrow:{active:true,time:.34,released:false}});const wind=vm.grenadeReleaseWorldPosition();assert.equal(vm._model.visible,true);assert.ok(wind.y>idle.y+.12);
  vm.update(.02,{grenadeThrow:{active:true,time:.46,released:true}});const release=vm.grenadeReleaseWorldPosition();assert.equal(vm._model.visible,false);assert.ok(release.z<wind.z-.2);
  assert.equal(vm.rightHand.userData.palm.geometry,vm.rightHand.userData.openGeometry);assert.equal(vm.rightHand.userData.palm.userData.anatomicalSource,'MakeHuman hm08 CC0');
  vm.update(.02,{grenadeThrow:{active:false,time:0,released:false}});assert.equal(vm._model.visible,true);assert.equal(vm.rightHand.userData.palm.geometry,vm.rightHand.userData.closedGeometry);assert.equal(vm.leftHand.visible,false);
 }
 const source=await assets.model('models/weapons/granate.3ds',true);let disposed=0;source.traverse(o=>{if(o.isMesh){o.geometry.addEventListener('dispose',()=>disposed++);for(const m of Array.isArray(o.material)?o.material:[o.material])m.map?.addEventListener('dispose',()=>disposed++);}});
 vm.dispose();assert.equal(disposed,0,'Original grenade shared resources survive');
});

test('first-person wind-up stays inside the frame, below 185px at 720p, and sleeves cannot cross the near plane',async()=>{
 const vm=new ProceduralViewmodel({assets}),camera=new THREE.PerspectiveCamera(75,16/9,.05,100);camera.add(vm.group);
 for(const original of [false,true]){
  await vm.setWeapon(2,{original});for(let i=0;i<90;i++)vm.update(1/60);
  for(const time of [.16,.28,.339999999,.45]){
   vm.update(.02,{grenadeThrow:{active:true,time,released:false}});camera.updateMatrixWorld(true);
   const bounds=new THREE.Box3().setFromObject(vm._model);let low=Infinity,high=-Infinity;
   for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z]){
    const p=new THREE.Vector3(x,y,z).project(camera);assert.ok(Math.abs(p.x)<.95&&Math.abs(p.y)<.95,`grenade cropped at ${time}`);low=Math.min(low,p.y);high=Math.max(high,p.y);
   }
   assert.ok((high-low)*360<185,`grenade oversized at ${time}: ${(high-low)*360}px`);
   if(time>=.28)assert.equal(vm.leftHand.visible,false,'pin hand is gone before the wind-up');
   for(const hand of [vm.rightHand,vm.leftHand])if(hand.visible){const sleeve=new THREE.Box3().setFromObject(hand.userData.throwSleeve);assert.ok(sleeve.max.z<-.16,`sleeve crosses near camera at ${time}`);assert.equal(hand.userData.sleeve.visible,false);const end=new THREE.Vector3(.62*hand.userData.side,-.65,-.28).project(camera);assert.ok(end.y<-1,'sleeve ends below the camera frame');}
  }
 }
 vm.dispose();
});
