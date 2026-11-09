import test from 'node:test';
import assert from 'node:assert/strict';
import { MouseCapture } from '../js/mouse-capture.js';

function fixture(){
  const doc=new EventTarget(), states=[];
  let requests=0,exits=0;
  const target={requestPointerLock(){requests++;}};
  doc.pointerLockElement=null;doc.exitPointerLock=()=>exits++;
  const change=element=>{doc.pointerLockElement=element;doc.dispatchEvent(new Event('pointerlockchange'));};
  const mouse=new MouseCapture(doc,target,(state,reason)=>states.push([state,reason]));
  return {mouse,doc,target,states,change,counts:()=>[requests,exits]};
}

test('late menu unlock does not exit resumed gameplay; re-lock is requested once on the next gesture',()=>{
  const {mouse,target,states,change,counts}=fixture();
  mouse.start();change(target);mouse.stop();mouse.start();
  change(null);assert.equal(mouse.state,'available');assert.deepEqual(counts(),[1,1]);
  mouse.request();mouse.request();change(target);
  assert.equal(mouse.state,'locked');assert.deepEqual(counts(),[2,1]);
  change(null);assert.equal(mouse.state,'available');assert.equal(mouse.reason,'released');
  assert.deepEqual(states.map(([state])=>state),['requesting','locked','idle','available','requesting','locked','available']);
  mouse.stop();
});

test('a stale native error and promise rejection cannot cancel a new capture',async t=>{
  const {mouse,doc,target,change}=fixture();
  t.after(()=>{mouse.stop();change(null);});
  let reject;
  target.requestPointerLock=()=>new Promise((_,fail)=>{reject=fail;});
  mouse.start();const rejectOld=reject;
  mouse.stop();mouse.start();
  doc.dispatchEvent(new Event('pointerlockerror'));
  rejectOld(new Error('old request'));await Promise.resolve();
  assert.equal(mouse.state,'requesting');
  reject(new Error('blocked'));await Promise.resolve();
  assert.equal(mouse.state,'drag');
  mouse.request();change(target);assert.equal(mouse.state,'locked');
});

test('starting without activation waits for the first gesture to request capture',t=>{
  const {mouse,doc,target,states,change,counts}=fixture();
  t.after(()=>{mouse.stop();change(null);});
  const userActivation={isActive:false};
  doc.defaultView={navigator:{userActivation}};

  mouse.start();
  assert.deepEqual(states.at(-1),['available','activation']);
  assert.deepEqual(counts(),[0,0]);

  userActivation.isActive=true;
  mouse.request();change(target);
  assert.equal(mouse.state,'locked');
  assert.deepEqual(counts(),[1,0]);
});

test('a void-returning browser request still handles the native error event',t=>{
  const {mouse,doc}=fixture();
  t.after(()=>mouse.stop());
  mouse.start();
  doc.dispatchEvent(new Event('pointerlockerror'));
  assert.equal(mouse.state,'drag');
});

for(const [name,state,reason] of [
  ['SecurityError','drag','blocked'],
  ['NotAllowedError','drag','activation'],
  ['WrongDocumentError','drag','focus'],
]){
  test(`${name} reports ${reason} even when the native error event arrives first`,async t=>{
    const {mouse,doc,target,states}=fixture();
    t.after(()=>mouse.stop());
    target.requestPointerLock=()=>Promise.reject(new DOMException('Pointer lock refused',name));

    mouse.start();
    doc.dispatchEvent(new Event('pointerlockerror'));
    assert.equal(mouse.state,'requesting');
    await Promise.resolve();

    assert.deepEqual(states.at(-1),[state,reason]);
  });
}

test('an Escape cooldown is retryable, not a permanent security denial', async () => {
  const {mouse,target,change}=fixture();
  target.requestPointerLock=()=>Promise.reject(new DOMException('Pointer lock cannot be acquired immediately after the user has exited the lock.', 'SecurityError'));
  mouse.start();await Promise.resolve();
  assert.equal(mouse.state,'drag');assert.equal(mouse.reason,'released');
  target.requestPointerLock=()=>Promise.resolve();
  mouse.request();change(target);assert.equal(mouse.state,'locked');mouse.stop();change(null);
});

test('drag choice survives pause and releases an abandoned request that succeeds late',()=>{
  const {mouse,target,change,counts}=fixture();
  mouse.start();mouse.useDrag();assert.equal(mouse.state,'drag');
  change(target);assert.deepEqual(counts(),[1,1]);assert.equal(mouse.state,'drag');
  change(null);mouse.stop();mouse.start();assert.deepEqual(counts(),[1,1]);
  assert.equal(mouse.reason,'chosen');
  mouse.request();change(target);assert.equal(mouse.state,'locked');mouse.stop();change(null);
});
