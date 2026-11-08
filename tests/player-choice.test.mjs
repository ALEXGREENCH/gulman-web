import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerChoice, heroForKey } from '../js/player-choice.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function actor(name='Gulman') {
  return { characterName:name, disposeCount:0, weapon:null,
    group:{parent:null,userData:{},visible:true,position:{x:0,y:0,z:0,copy(p){Object.assign(this,{x:p.x,y:p.y,z:p.z});}},rotation:{y:0},
      removeFromParent(){if(this.parent){this.parent.children.delete(this);this.parent=null;}}},
    attachWeapon(model,options){this.weapon={model,options};},dispose(){this.disposeCount++;this.group.removeFromParent();} };
}
function fixture(factory, modelLoader = async path => ({path})) {
  let player=actor(),scene={children:new Set(),add(group){this.children.add(group);group.parent=this;}},weapon=0;
  const position={x:1,y:2,z:3},storageData=new Map(),changes=[],errors=[];
  scene.add(player.group);
  const setup={ assets:{model:modelLoader,json:async()=>({})},getPlayer:()=>player,setPlayer:p=>{player=p;},
    getScene:()=>scene,getPosition:()=>position,getYaw:()=>1.4,getWeapon:()=>weapon,
    characterFactory:factory,onChange:(name,p)=>changes.push({name,player:p}),onError:m=>errors.push(m),
    storage:{getItem:k=>storageData.get(k),setItem:(k,v)=>storageData.set(k,v)} };
  const choice=createPlayerChoice(setup);
  return {choice,setup,position,changes,errors,storageData,get player(){return player;},get scene(){return scene;},
    setScene:s=>{scene=s;},setWeapon:n=>{weapon=n;}};
}

test('keeps the current player until model and current weapon are ready, preserving the latest transform',async()=>{
  const rig=deferred(),gun=deferred();const f=fixture(()=>rig.promise,()=>gun.promise);const old=f.player;
  const result=f.choice.select('Dama');const next=actor('Dama');rig.resolve(next);await tick();
  assert.equal(f.player,old);assert.equal(old.disposeCount,0);assert.equal(f.scene.children.size,1);
  f.position.x=20;gun.resolve({path:'pistol'});assert.equal(await result,next);
  assert.equal(f.player,next);assert.equal(old.disposeCount,1);assert.equal(next.group.position.x,20);assert.equal(next.group.rotation.y,1.4);
  assert.equal(next.weapon.options.length,.42);assert.equal(f.scene.children.size,1);assert.equal(f.choice.value,'Dama');
  assert.equal(f.storageData.get('gulman-web-player-v1'),'Dama');
});

test('rapid Gulmonika then Gulman cancels the older load without disposing the active player',async()=>{
  const rig=deferred();const f=fixture(()=>rig.promise);const old=f.player;const earlier=f.choice.select('Dama');
  assert.equal(await f.choice.select('Gulman'),old);const stale=actor('Dama');rig.resolve(stale);assert.equal(await earlier,null);
  assert.equal(f.player,old);assert.equal(old.disposeCount,0);assert.equal(stale.disposeCount,1);assert.equal(f.choice.value,'Gulman');
});

test('out-of-order load completion only commits the latest choice',async()=>{
  const one=deferred(),two=deferred();let count=0;const f=fixture(()=>++count===1?one.promise:two.promise);const old=f.player;
  const first=f.choice.select('Dama');const second=f.choice.select('Dama');const newest=actor('Dama');two.resolve(newest);
  assert.equal(await second,newest);const stale=actor('Dama');one.resolve(stale);assert.equal(await first,null);
  assert.equal(f.player,newest);assert.equal(old.disposeCount,1);assert.equal(stale.disposeCount,1);assert.equal(newest.disposeCount,0);
});

test('changing levels while loading discards the candidate and preserves the old scene owner',async()=>{
  const rig=deferred();const f=fixture(()=>rig.promise);const old=f.player;const request=f.choice.select('Dama');
  f.setScene({children:new Set(),add(group){this.children.add(group);group.parent=this;}});
  const candidate=actor('Dama');rig.resolve(candidate);assert.equal(await request,null);
  assert.equal(f.player,old);assert.equal(old.disposeCount,0);assert.equal(candidate.disposeCount,1);assert.equal(f.scene.children.size,0);
});

test('weapon changes during character loading are applied before commit',async()=>{
  const firstGun=deferred();let modelCalls=0;const f=fixture(async()=>actor('Dama'),path=>++modelCalls===1?firstGun.promise:Promise.resolve({path}));
  const request=f.choice.select('Dama');await tick();f.setWeapon(1);firstGun.resolve({path:'old-pistol'});
  const selected=await request;assert.equal(modelCalls,2);assert.match(selected.weapon.model.path,/weaponrifle\.3ds$/);assert.equal(selected.weapon.options.length,.7);
});

test('a failed replacement leaves the old player and persisted selection intact',async t=>{
  t.mock.method(console,'warn',()=>{});
  const f=fixture(async()=>{throw new Error('download failed');});const old=f.player;
  assert.equal(await f.choice.select('Dama'),null);assert.equal(f.player,old);assert.equal(old.disposeCount,0);
  assert.equal(f.choice.value,'Gulman');assert.equal(f.errors.length,1);assert.equal(f.scene.children.size,1);
});

test('menu selection persists and create builds that hero when a scene becomes available',async()=>{
  const f=fixture(async name=>actor(name));f.setScene(null);
  await f.choice.select('Dama');assert.equal(f.choice.value,'Dama');assert.equal(f.player.disposeCount,0);
  const recreated=createPlayerChoice(f.setup);assert.equal(recreated.value,'Dama');
  f.setScene({children:new Set(),add(group){this.children.add(group);group.parent=this;}});
  const created=await recreated.create();assert.equal(created.characterName,'Dama');assert.equal(f.player,created);
});


test('hero keys avoid browser functions, shortcuts, repeats and editable fields',()=>{
  assert.equal(heroForKey({code:'Digit5',key:'5'}),'Gulman');
  assert.equal(heroForKey({code:'Digit6',key:'6'}),'Dama');
  for(const code of ['F1','F2','Digit1','Digit4','KeyG'])assert.equal(heroForKey({code}),null);
  for(const flag of ['ctrlKey','altKey','metaKey','shiftKey','repeat'])assert.equal(heroForKey({code:'Digit6',[flag]:true}),null);
  assert.equal(heroForKey({code:'Digit6',target:{isContentEditable:true}}),null);
  assert.equal(heroForKey({code:'Digit5',target:{closest:()=>({tagName:'INPUT'})}}),null);
});
