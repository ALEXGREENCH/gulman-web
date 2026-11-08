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

test('stance and camera motion ease into crouch, remain bounded, and freeze while paused',()=>{
  const m=new MotionController();
  m.update(1/60,{crouchHeld:true});
  assert.ok(m.eyeHeight<1.4&&m.eyeHeight>1.3,'crouch begins smoothly');
  for(let i=0;i<100;i++)m.update(1/60,{crouchHeld:true});
  assert.ok(Math.abs(m.eyeHeight-1.02)<.001);
  m.update(1/60,{});assert.ok(m.eyeHeight>1.02&&m.eyeHeight<1.12,'standing starts without a camera jump');
  for(let i=0;i<200;i++){
    m.update(1/60,{moving:true,sprinting:true,strafe:1});
    assert.ok(Math.abs(m.bob)<.04);assert.ok(Math.abs(m.roll)<.02);
  }
  const snapshot=[m.clock,m.eyeHeight,m.speed,m.phase,m.bob,m.roll];
  m.update(60,{paused:true,crouchHeld:true});
  assert.deepEqual([m.clock,m.eyeHeight,m.speed,m.phase,m.bob,m.roll],snapshot);
  m.reset();assert.equal(m.eyeHeight,1.4);assert.equal(m.speed,0);assert.equal(m.bob,0);
});

test('collision-provided landing strength survives the next grounded frame and settles stably',()=>{
  const m=new MotionController();m.update(1/60,{grounded:false,verticalSpeed:-12});
  m.landingVelocity=-.85;
  m.update(1/60,{grounded:true,verticalSpeed:0});
  assert.ok(m.landing<-.01,'grounded verticalSpeed=0 must not replace the measured impact');
  let minimum=m.landing;
  for(let i=0;i<180;i++){m.update(1/60);minimum=Math.min(minimum,m.landing);assert.ok(Number.isFinite(m.landing));}
  assert.ok(minimum>-.05);assert.ok(Math.abs(m.landing)<1e-7);
});

test('reset and character switches exactly restore nonidentity clip poses, including elbows and wrists',()=>{
  const build=()=>({bones:new Map([2,3,10,11,12,13,14,15,18].map(id=>{
    const bone=new THREE.Group();bone.quaternion.setFromEuler(new THREE.Euler(id*.017,id*-.011,id*.023));return[id,bone];
  }))});
  const first=build(),second=build(),initial=new Map([...first.bones].map(([id,bone])=>[id,bone.quaternion.clone()]));
  const m=new MotionController();
  for(let i=0;i<500;i++){
    m.update(1/60,{moving:true,sprinting:i%2===0,strafe:1});
    m.prepare(first);m.apply(first,{aiming:.5,reloading:true,reloadProgress:(i%100)/100,recoil:.02,moving:true});
  }
  m.apply(second,{reloading:true,reloadProgress:.35});
  for(const[id,bone]of first.bones)assert.deepEqual(bone.quaternion.toArray(),initial.get(id).toArray());
  m.reset();
  for(const[id,bone]of second.bones)assert.deepEqual(bone.quaternion.toArray(),initial.get(id).toArray());
});
