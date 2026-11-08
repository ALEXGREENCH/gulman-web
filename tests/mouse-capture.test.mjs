import test from 'node:test';
import assert from 'node:assert/strict';
import { MouseCapture } from '../js/mouse-capture.js';

function fixture(){
  const doc=new EventTarget(), states=[];
  let requests=0,exits=0;
  const target={requestPointerLock(){requests++;}};
  doc.pointerLockElement=null;doc.exitPointerLock=()=>exits++;
  const change=element=>{doc.pointerLockElement=element;doc.dispatchEvent(new Event('pointerlockchange'));};
  const mouse=new MouseCapture(doc,target,state=>states.push(state));
  return {mouse,doc,target,states,change,counts:()=>[requests,exits]};
}

test('late menu unlock does not exit resumed gameplay; re-lock is requested once on the next gesture',()=>{
  const {mouse,target,states,change,counts}=fixture();
  mouse.start();change(target);mouse.stop();mouse.start();
  change(null);assert.equal(mouse.state,'available');assert.deepEqual(counts(),[1,1]);
  mouse.request();mouse.request();change(target);
  assert.equal(mouse.state,'locked');assert.deepEqual(counts(),[2,1]);
  change(null);assert.equal(mouse.state,'available');
  assert.deepEqual(states,['requesting','locked','idle','available','requesting','locked','available']);
  mouse.stop();
});

test('denied pointer lock falls back to drag; a stale rejection cannot cancel a new capture',async()=>{
  const {mouse,target,change}=fixture();
  let reject;
  target.requestPointerLock=()=>new Promise((_,fail)=>{reject=fail;});
  mouse.start();const rejectOld=reject;
  mouse.stop();mouse.start();rejectOld(new Error('old request'));await Promise.resolve();
  assert.equal(mouse.state,'requesting');
  reject(new Error('blocked'));await Promise.resolve();
  assert.equal(mouse.state,'drag');
  mouse.request();change(target);assert.equal(mouse.state,'locked');mouse.stop();change(null);
});
