import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {WorldCollision} from '../js/collision.js';
import {mergeWorldMeshes} from '../js/merge-world.js';
import {jumpSpeedForLevel,maxSlopeForLevel,selectInteraction} from '../js/progression.js';

const root=new URL('../',import.meta.url),hz=Number(process.env.PROGRESSION_HZ||60);
const manifest=JSON.parse(await readFile(new URL('assets/manifest.json',root),'utf8'));
const fixture=JSON.parse(await readFile(new URL('fixtures/progression-upper-level5.json',import.meta.url),'utf8'));

// A reproducible control sequence with continuous feet/velocity state, not a
// navigation solver. Each waypoint is reached on real original-world support.
function travel(world,position,step,jumpSpeed){
  const[x,y,z,jump,speed,milliseconds]=step,destination=new THREE.Vector3(x,y,z),start=position.clone();
  const velocity=new THREE.Vector3(0,jump?jumpSpeed:0,0);let grounded=!jump;
  for(let frame=0;frame<Math.ceil(milliseconds/1000*hz);frame++){
    const direction=destination.clone().sub(position);direction.y=0;const distance=direction.length();direction.normalize().multiplyScalar(Math.min(speed,distance*hz));
    velocity.x=direction.x;velocity.z=direction.z;grounded=world.move(position,velocity,1/hz,grounded).onGround;
    assert.ok(position.toArray().every(Number.isFinite));
    if(grounded&&Math.hypot(position.x-x,position.z-z)<.12&&Math.abs(position.y-y)<.15)return;
  }
  assert.fail(`Route leg from ${start.toArray()} to ${destination.toArray()} stopped at ${position.toArray()}; jump=${jump}, speed=${speed}`);
}

test(`level 5: complete spawn → upper book → original exit at ${hz} Hz, with the runtime jump helper`,async()=>{
  const level=manifest.levels.find(l=>l.id===fixture.id),source=await readFile(new URL(manifest.models[level.model],root));
  assert.equal(createHash('sha256').update(source).digest('hex'),fixture.modelSha256);
  const data=JSON.parse(source),materials=Object.fromEntries(Object.keys(data.materials).map(name=>[name,new THREE.MeshBasicMaterial()])),group=mergeWorldMeshes(data,materials,Object.values(materials)[0]);group.scale.setScalar(.01);
  const world=new WorldCollision({radius:.28,height:1.65,stepHeight:.45,maxSlope:maxSlopeForLevel(level.id)});world.setWorld(group);
  const spawn=level.entities.filter(e=>e.command==='GameStart').at(-1),position=new THREE.Vector3(spawn.x/100,spawn.y/100,spawn.z/100);
  position.y=(world.ground(position.x,position.y+.2,position.z,50)??position.y-1)+.03;
  assert.ok(Math.hypot(position.x-fixture.start[0],position.z-fixture.start[2])<.001);
  const items=level.entities.map(entry=>({entry,pos:new THREE.Vector3(entry.x/100,entry.y/100,entry.z/100),collected:false}));
  const keyIds=level.entities.filter(e=>e.command==='GameKey').map(e=>e.id),collected=[];
  try{
    for(let i=0;i<fixture.steps.length;i++){
      travel(world,position,fixture.steps[i],jumpSpeedForLevel(level.id));
      for(const checkpoint of fixture.checkpoints.filter(c=>c.step===i+1)){
        const selected=selectInteraction(items,position,world,{collected:collected.length,totalKeys:keyIds.length});
        assert.equal(selected?.entry.id,checkpoint.id,'the real objective is in range with unobstructed line of sight');
        assert.equal(selected.entry.command,'GameKey');selected.collected=true;collected.push(selected.entry.id);
      }
    }
    assert.deepEqual(collected.sort((a,b)=>a-b),keyIds.sort((a,b)=>a-b));
    const exit=selectInteraction(items,position,world,{collected:collected.length,totalKeys:keyIds.length});
    assert.equal(exit?.entry.id,fixture.exit);assert.equal(exit.entry.command,'GameEnd');
  }finally{world.clear();group.traverse(o=>{if(o.isMesh)o.geometry.dispose();});Object.values(materials).forEach(material=>material.dispose());}
});
