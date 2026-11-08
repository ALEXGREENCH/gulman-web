import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {WorldCollision} from '../js/collision.js';
import {mergeWorldMeshes} from '../js/merge-world.js';
import {jumpSpeedForLevel,maxSlopeForLevel} from '../js/progression.js';

const root=new URL('../',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('assets/manifest.json',root),'utf8'));

test('level 6 upper opening retains jump margin at 25, 60 and 120 Hz',async()=>{
  const level=manifest.levels.find(l=>l.id===6),data=JSON.parse(await readFile(new URL(manifest.models[level.model],root),'utf8'));
  const material=new THREE.MeshBasicMaterial(),materials=Object.fromEntries(Object.keys(data.materials).map(k=>[k,new THREE.MeshBasicMaterial()])),group=mergeWorldMeshes(data,materials,material);
  group.scale.setScalar(.01);
  const world=new WorldCollision({radius:.28,height:1.65,stepHeight:.45,maxSlope:maxSlopeForLevel(6)}).setWorld(group);
  function cross(dt,jump){
    // Actual end of original plank dx447. The diagonal opening at x=-8.5
    // avoids the original parapet; a straight jump hits its outer wall.
    const p=new THREE.Vector3(-11.14015,31.06421,-67.24766),target=new THREE.Vector3(-8.5,32.4655,-69.3),v=new THREE.Vector3(0,jump,0);
    let grounded=false;
    for(let frame=0;frame<Math.ceil(3/dt);frame++){
      const dx=target.x-p.x,dz=target.z-p.z,distance=Math.hypot(dx,dz),gain=Math.min(8,distance*8)/Math.max(distance,.001);
      v.x=dx*gain;v.z=dz*gain;grounded=world.move(p,v,dt,grounded).onGround;
      if(grounded&&distance<.08)break;
      if(p.y<29)break;
    }
    return {p,landed:grounded&&p.y>32.45&&p.distanceTo(target)<.5};
  }
  try{
    assert.equal(cross(.04,8).landed,false,'the old jump misses the opening at the game frame limit');
    for(const dt of [.04,1/60,1/120]){
      const result=cross(dt,jumpSpeedForLevel(6));
      assert.ok(result.landed,`actual opening at dt=${dt}: ${result.p.toArray()}`);
    }
  }finally{world.clear();group.traverse(o=>{if(o.isMesh)o.geometry.dispose();});for(const m of Object.values(materials))m.dispose();material.dispose();}
});
