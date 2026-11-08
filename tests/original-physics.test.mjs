import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as T from 'three';
import { WorldCollision } from '../js/collision.js';
import { OriginalMovement } from '../js/original-physics.js';
import { mergeWorldMeshes } from '../js/merge-world.js';
import { ropeSupport } from '../js/rope-support.js';

function flatWorld(wall=false) {
  const scene=new T.Group();
  const floor=new T.Mesh(new T.BoxGeometry(100,.2,100));floor.position.y=-.1;scene.add(floor);
  if(wall){const mesh=new T.Mesh(new T.BoxGeometry(.008,5,10));mesh.position.set(-2,2,0);scene.add(mesh);}
  return new WorldCollision().setWorld(scene);
}
function driver(world, point, hz=60) {
  const motion=new OriginalMovement(world),p=new T.Vector3(...point),v=new T.Vector3();
  const tick=input=>motion.move(p,v,1/hz,input);
  for(let i=0;i<hz*.5;i++)tick();
  return {motion,p,v,tick};
}

test('DCE accelerates and brakes with inertia, with Shift and reverse using the slower rate',()=>{
  const world=flatWorld(),run=driver(world,[0,.03,0]),walk=driver(world,[0,.03,0]),back=driver(world,[0,.03,0]);
  run.tick({forward:1});assert.ok(run.v.z>0&&run.v.z<1);
  for(let i=0;i<60;i++){run.tick({forward:1});walk.tick({forward:1,shift:true});back.tick({forward:-1});}
  assert.ok(run.v.z>5.4&&run.v.z<5.5);
  assert.ok(walk.v.z>2.95&&walk.v.z<3);
  assert.ok(Math.abs(walk.v.z+back.v.z)<1e-9);
  const z=run.p.z;run.tick();assert.ok(run.p.z>z&&run.v.z>0);
  for(let i=0;i<60;i++)run.tick();assert.ok(run.v.length()<.002);
});

test('source jump rises at 4 m/s first, carries run momentum and lands consistently across refresh rates',()=>{
  const results=[];
  for(const hz of [25,60,120]){
    const {motion,p,v,tick}=driver(flatWorld(),[0,.03,0],hz);
    for(let i=0;i<hz;i++)tick({forward:1});
    const base=p.y,z=p.z;tick({jump:true});
    assert.ok(v.y>=3.95&&v.y<=4.01);assert.ok(v.z>4);
    let peak=p.y,frames=1;
    while(!motion.onGround&&frames<hz*2){tick({strafe:1});peak=Math.max(peak,p.y);frames++;}
    assert.ok(motion.onGround);
    assert.ok(peak-base>1.3&&peak-base<1.5);
    assert.ok(p.z-z>5&&Math.abs(p.x)<.6,'air steering must be weak and momentum must survive takeoff');
    results.push([peak,frames/hz]);
  }
  assert.ok(results.every(([peak,time])=>Math.abs(peak-results[0][0])<.012&&Math.abs(time-results[0][1])<.05));
});

test('swept DCE collider slides along a thin wall and also stops against live actors',()=>{
  const {p,tick}=driver(flatWorld(true),[0,.03,-4]);
  for(let i=0;i<30;i++)tick({forward:1,strafe:1});
  const alongWall=p.z;
  for(let i=0;i<24;i++)tick({forward:1,strafe:1});
  assert.ok(p.x> -1.61&&p.x< -1.50);assert.ok(p.z>alongWall+1.4,`${p.toArray()} after sliding from z=${alongWall}`);
  const actor={pos:new T.Vector3(0,0,2)};
  const body=driver(flatWorld(),[0,.03,0]);
  for(let i=0;i<60;i++)body.tick({forward:1,actors:[actor]});
  assert.ok(body.p.z>1.1&&body.p.z<1.21);
  actor.dead=true;
  for(let i=0;i<30;i++)body.tick({forward:1,actors:[actor]});
  assert.ok(body.p.z>2.5);
});

test('actual Acropolis ropes carry both edges and the gap at 25, 60 and 120 Hz',async()=>{
  const root=new URL('../',import.meta.url);
  const manifest=JSON.parse(await readFile(new URL('assets/manifest.json',root)));
  const level=manifest.levels.find(level=>level.id===3);
  const data=JSON.parse(await readFile(new URL(manifest.models[level.model],root)));
  const materials=Object.fromEntries(Object.keys(data.materials).map(name=>[name,new T.MeshBasicMaterial()]));
  const group=mergeWorldMeshes(data,materials,new T.MeshBasicMaterial());group.scale.setScalar(.01);
  const world=new WorldCollision().setWorld(group,ropeSupport(3,data));
  for(const [hz,x] of [[25,12.24],[60,12.55],[120,12.86]]){
    const {p,tick}=driver(world,[x,-5.1,26.5],hz);
    let supported=0,frames=0;
    while(p.z>-7.5&&frames<hz*25){supported+=Number(tick({forward:1,yaw:Math.PI}).onGround);frames++;}
    assert.ok(p.z<=-7.5&&p.y>5.6,`${hz} Hz, x=${x}: ${p.toArray()}`);
    assert.ok(supported/frames>.95,'bridge should not repeatedly detach the player');
  }
  const edge=driver(world,[12.55,0,8]);
  for(let i=0;i<160;i++)edge.tick({strafe:1});
  assert.ok(edge.p.y<-2,'stepping off the side must still allow a fall');
});
