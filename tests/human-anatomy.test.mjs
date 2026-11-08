import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {humanAnatomy} from '../assets/enhanced/characters/human-anatomy.js';
import {humanHead} from '../assets/enhanced/characters/human-head.js';

test('the official CC0 anatomical derivative is pinned, credited and bounded',async()=>{
  const root=new URL('../',import.meta.url),manifest=JSON.parse(await readFile(new URL('assets/enhanced/characters/human-anatomy-manifest.json',root),'utf8'));
  assert.equal(manifest.license,'CC0-1.0');assert.match(manifest.sourceUrl,/raw\.githubusercontent\.com\/makehumancommunity\/makehuman\/[a-f0-9]{40}\/makehuman\/data\/3dobjs\/base\.obj$/);
  assert.ok(manifest.authors.includes('MakeHuman Community'));assert.match(manifest.sourceSha256,/^[a-f0-9]{64}$/);
  const bytes=await readFile(new URL(manifest.derivative.path,root));assert.equal(bytes.length,manifest.derivative.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.derivative.sha256);assert.ok(bytes.length<400*1024);
  assert.equal(humanAnatomy.units,'metres');assert.equal(humanAnatomy.referenceHumanHeight,1.8);assert.deepEqual(Object.keys(humanAnatomy.parts),['leftHand','rightHand']);
  const license=await readFile(new URL('assets/enhanced/characters/MAKEHUMAN-CC0.md',root),'utf8');assert.match(license,/Creative Commons CC0 1.0 Universal/);
});

test('both real hands retain five articulated finger landmark chains, finite anatomy and valid normals',()=>{
  for(const part of Object.values(humanAnatomy.parts)){
    const count=part.positions.length/3;assert.equal(part.normals.length,part.positions.length);assert.equal(part.uv.length,count*2);assert.equal(part.indices.length/3,part.triangles);assert.ok(part.triangles<=3500);
    assert.ok([...part.positions,...part.normals,...part.uv].every(Number.isFinite));assert.ok(part.indices.every(i=>Number.isInteger(i)&&i>=0&&i<count));
    for(let i=0;i<count;i++){const n=part.normals.slice(i*3,i*3+3);assert.ok(Math.abs(Math.hypot(...n)-1)<.00001);}
    for(let finger=1;finger<=5;finger++)for(let joint=1;joint<=4;joint++)assert.ok(part.landmarks[`finger-${finger}-${joint}`]);
    assert.deepEqual(part.wrist,[0,0,0]);assert.deepEqual(part.fingerDirection,[0,1,0]);assert.ok(part.middleTip[1]>.17&&part.middleTip[1]<.21);
    assert.ok(part.bounds.min[1]<-.02&&part.bounds.min[1]>-.03,'short hidden cuff overlap');assert.ok(part.bounds.max[1]<.22,'no entire forearm or stray body parts');
    assert.ok(part.dorsalAxis[2]===-part.palmAxis[2]);
    for(let axis=0;axis<3;axis++){const values=part.positions.filter((_,i)=>i%3===axis);assert.equal(Math.min(...values),part.bounds.min[axis]);assert.equal(Math.max(...values),part.bounds.max[axis]);}
  }
});

test('hand topology is one connected anatomical surface, with no helper joint cubes shipped',()=>{
  for(const part of Object.values(humanAnatomy.parts)){
    const welded=new Map(),ids=[];
    for(let i=0;i<part.positions.length/3;i++){const key=part.positions.slice(i*3,i*3+3).map(x=>Math.round(x*1e5)).join(',');if(!welded.has(key))welded.set(key,welded.size);ids.push(welded.get(key));}
    const edges=Array.from({length:welded.size},()=>new Set());
    for(let i=0;i<part.indices.length;i+=3){const t=part.indices.slice(i,i+3).map(j=>ids[j]);for(let k=0;k<3;k++){edges[t[k]].add(t[(k+1)%3]);edges[t[(k+1)%3]].add(t[k]);}}
    const visited=new Set([0]),pending=[0];while(pending.length)for(const next of edges[pending.pop()])if(!visited.has(next)){visited.add(next);pending.push(next);}
    assert.equal(visited.size,welded.size);
  }
});

test('the imported head keeps bounded human proportions and aligned face landmarks without shoulder fragments',async()=>{
  const root=new URL('../',import.meta.url),manifest=JSON.parse(await readFile(new URL('assets/enhanced/characters/human-head-manifest.json',root),'utf8'));
  const bytes=await readFile(new URL(manifest.derivative.path,root));assert.equal(bytes.length,manifest.derivative.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.derivative.sha256);assert.equal(manifest.license,'CC0-1.0');assert.ok(bytes.length<225*1024);
  const p=humanHead;assert.equal(p.indices.length/3,4000);assert.equal(p.normals.length,p.positions.length);assert.equal(p.uv.length,p.positions.length/3*2);assert.ok(p.indices.every(i=>Number.isInteger(i)&&i>=0&&i<p.positions.length/3));
  assert.ok([...p.positions,...p.normals,...p.uv].every(Number.isFinite));
  assert.ok(p.bounds.max[0]-p.bounds.min[0]<.21,'shoulders must not influence head fitting');assert.ok(p.bounds.max[1]>.25&&p.bounds.max[1]<.30);assert.ok(p.bounds.min[1]>-.006);
  assert.ok(p.chinY<p.mouthY&&p.mouthY<p.noseTip[1]&&p.noseTip[1]<p.eyesY);assert.ok(p.eyes.left[0]>0&&p.eyes.right[0]<0);assert.ok(Math.abs(p.eyes.left[0]+p.eyes.right[0])<1e-6);
  assert.equal(p.hasOpenEyeSockets,false);assert.equal(p.boundaryLoops.length,1);assert.equal(p.boundaryLoops[0].kind,'neck');assert.ok(p.boundaryLoops[0].vertices.every(v=>Math.abs(v[1]+.005403)<.000001));
});
