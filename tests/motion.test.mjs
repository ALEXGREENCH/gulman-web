import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {MotionController} from '../js/motion.js';
import {CombatFX} from '../js/combat-fx.js';

test('slide requires grounded sprint and has a cooldown; aim reduces movement',()=>{
  const m=new MotionController();for(let i=0;i<50;i++)m.update(.016,{moving:true,sprinting:true});
  m.update(.016,{moving:true,sprinting:true,crouchPressed:true});assert.equal(m.sliding,true);
  for(let i=0;i<60;i++)m.update(.016,{moving:true});assert.equal(m.sliding,false);
  const walk=m.speed;for(let i=0;i<60;i++)m.update(.016,{moving:true,aiming:1});assert.ok(m.speed<walk);
  m.reset();m.update(.016,{crouchPressed:true,sprinting:true,grounded:false});assert.equal(m.sliding,false);
});
test('procedural pose removes its previous frame without accumulating rotations',()=>{
  const m=new MotionController(),character={bones:new Map([2,3,10,11,13,18].map(id=>[id,new THREE.Group()]))};
  m.lean=.1;for(let i=0;i<300;i++){m.prepare(character);m.apply(character,{aiming:1,reloading:true,reloadProgress:.5});}
  m.prepare(character);for(const bone of character.bones.values())assert.ok(bone.quaternion.angleTo(new THREE.Quaternion())<1e-6);
});
test('combat effect pools stay bounded through sustained fire and disable cleanly',()=>{
  const scene=new THREE.Scene(),fx=new CombatFX(scene);fx.setEnabled(true);
  const origin=new THREE.Vector3(),end=new THREE.Vector3(0,0,5),normal=new THREE.Vector3(0,0,-1);
  const children=fx.root.children.length;
  for(let i=0;i<400;i++){fx.shot({origin,end,normal,explosionRadius:i%10===0?3:0});fx.update(.016);}
  assert.equal(fx.root.children.length,children);assert.equal(fx.spark.slots.length,128);assert.equal(fx.decals.length,24);
  fx.setEnabled(false);assert.equal(fx.root.visible,false);assert.equal(fx.light.intensity,0);fx.dispose();assert.equal(scene.children.length,0);
});
