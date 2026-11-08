import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {EnhancedCharacterLayer} from '../js/enhanced-character-layer.js';
import {CrowdRenderer} from '../js/crowd.js';

function fixture(){
  let resolve,reject;
  const pending=new Promise((a,b)=>{resolve=a;reject=b;});
  const materials={disposed:0,load:()=>pending,dispose(){this.disposed++;}};
  const made=[],changes=[];
  const layer=new EnhancedCharacterLayer({materials,onChange:()=>changes.push(true),skinFactory:(actor,name,options)=>{
    const skin={actor,name,options,disposed:0,stats:{triangles:42},dispose(){this.disposed++;}};made.push(skin);return skin;
  }});
  const actor=()=>({disposed:0,dispose(){this.disposed++;}});
  return {layer,materials,made,changes,resolve,reject,actor};
}

test('texture completion skins the latest roster after a hero replacement',async()=>{
  const f=fixture(),old=f.actor(),current=f.actor(),enemy=f.actor();
  f.layer.setCharacters([[old,'Gulman'],[enemy,'Box']]);const load=f.layer.load();
  f.layer.setCharacters([[current,'Dama'],[enemy,'Box']]);f.resolve();await load;
  assert.deepEqual(f.made.map(s=>s.name),['Dama','Box']);assert.equal(old.enhancedSkin,undefined);
  assert.equal(f.layer.diagnostics.count,2);assert.equal(f.changes.length,1);
  f.layer.dispose();assert.equal(f.made.every(s=>s.disposed===1),true);
});

test('leaving Enhanced before textures arrive never changes original actors',async()=>{
  const f=fixture(),actor=f.actor(),originalDispose=actor.dispose;
  f.layer.setCharacters([[actor,'Gulman']]);const load=f.layer.load();f.layer.dispose();f.resolve();await load;
  assert.equal(f.made.length,0);assert.equal(actor.dispose,originalDispose);assert.equal(f.changes.length,0);
});

test('replacing one hero releases its skin, and level disposal restores actor ownership',async()=>{
  const f=fixture(),hero=f.actor(),enemy=f.actor(),dispose=enemy.dispose;
  f.layer.setCharacters([[hero,'Gulman'],[enemy,'Box']]);f.resolve();await f.layer.load();
  const skin=hero.enhancedSkin;hero.dispose();assert.equal(hero.disposed,1);assert.equal(skin.disposed,1);
  assert.equal(f.layer.diagnostics.count,1);
  f.layer.dispose();assert.equal(enemy.dispose,dispose);assert.equal(enemy.enhancedSkin,undefined);
  assert.equal(enemy.disposed,0);assert.equal(f.made[1].disposed,1);
});

test('a texture failure cannot leave attached replacement models',async()=>{
  const f=fixture();f.layer.setCharacters([[f.actor(),'Dama']]);const load=f.layer.load();f.reject(new Error('offline'));
  await assert.rejects(load,/offline/);assert.equal(f.layer.disposed,true);assert.equal(f.made.length,0);
});

test('crowd preserves Enhanced material ownership and only renders visible skin meshes',()=>{
  const scene=new THREE.Scene(),geometry=new THREE.BoxGeometry(),material=new THREE.MeshStandardMaterial();
  const actors=[0,1].map(x=>{const group=new THREE.Group();group.position.x=x;
    const old=new THREE.Mesh(geometry,new THREE.MeshLambertMaterial());old.visible=false;group.add(old);
    const mesh=new THREE.Mesh(geometry,material);mesh.userData.graphicsOwned=true;mesh.castShadow=mesh.receiveShadow=true;group.add(mesh);
    return {char:{group},pos:group.position};});
  const crowd=new CrowdRenderer(scene,actors);crowd.update(new THREE.Vector3());
  const enhanced=crowd.batches.find(b=>b.instance.userData.graphicsOwned);
  assert.equal(enhanced.instance.count,2);assert.equal(enhanced.instance.material,material);
  assert.equal(enhanced.instance.castShadow,true);assert.equal(enhanced.instance.receiveShadow,true);
  assert.equal(crowd.stats.drawCalls,1);crowd.dispose();geometry.dispose();material.dispose();
});

test('optional Enhanced camera culling removes characters behind the view while keeping Original distance behavior',()=>{
  const scene=new THREE.Scene(),geometry=new THREE.BoxGeometry(),material=new THREE.MeshStandardMaterial();
  const actors=[-10,10].map(z=>{const group=new THREE.Group();group.position.z=z;group.add(new THREE.Mesh(geometry,material));return {char:{group,height:1.8},pos:group.position};});
  const crowd=new CrowdRenderer(scene,actors),camera=new THREE.PerspectiveCamera(65,1,.1,100);camera.position.y=1;
  assert.equal(crowd.update(camera).visibleActors,1);
  assert.equal(crowd.update(camera.position).visibleActors,2);
  camera.rotation.y=Math.PI;assert.equal(crowd.update(camera).visibleActors,1);
  crowd.dispose();geometry.dispose();material.dispose();
});
