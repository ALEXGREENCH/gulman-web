import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {Assets} from '../js/assets.js';

test('temporary hosting errors retry the same JSON once per request and share the pending result',async()=>{
  let calls=0;const waits=[];
  const assets=new Assets({wait:async ms=>waits.push(ms),fetcher:async()=>++calls<3?{ok:false,status:503}:{ok:true,json:async()=>({ready:true})}});
  const results=await Promise.all(Array.from({length:8},()=>assets.json('assets/test.json')));
  assert.equal(calls,3);assert.deepEqual(waits,[250,500]);assert.ok(results.every(result=>result===results[0]));assert.equal(results[0].ready,true);
});

test('missing files fail without retries and rejected JSON/model caches can recover',async()=>{
  let online=false,calls=0;
  const assets=new Assets({wait:async()=>{},fetcher:async()=>{calls++;return online?{ok:true,json:async()=>({ok:true})}:{ok:false,status:404};}});
  await assert.rejects(assets.json('missing.json'),/missing.json: HTTP 404/);assert.equal(calls,1);assert.equal(assets.jsons.size,0);
  online=true;assert.deepEqual(await assets.json('missing.json'),{ok:true});
  let modelCalls=0;assets.buildModel=async()=>{if(++modelCalls===1)throw new Error('failed dependency');return new THREE.Group();};
  await assert.rejects(assets.model('model.3ds'),/failed dependency/);assert.equal(assets.models.size,0);
  const one=await assets.model('model.3ds'),two=await assets.model('model.3ds');assert.notEqual(one,two);assert.equal(modelCalls,2);
});

test('texture retries are bounded, preserve the failed URL and allow a later clean attempt',async()=>{
  let good=false,calls=0;const assets=new Assets({wait:async()=>{},textureLoader:{loadAsync:async()=>{calls++;if(!good)throw new TypeError('network');return new THREE.Texture();}}});
  await assert.rejects(assets.texture({map:'assets/sand.webp'}),/assets\/sand.webp: network/);
  assert.equal(calls,3);assert.equal(assets.textures.size,0);good=true;
  const texture=await assets.texture({map:'assets/sand.webp'});assert.equal(calls,4);assert.equal(texture.colorSpace,THREE.SRGBColorSpace);texture.dispose();
});

test('cold-start JSON and image requests share a six-request budget even after failures',async()=>{
  let active=0,peak=0;const request=async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,2));active--;};
  const assets=new Assets({wait:async()=>{},fetcher:async url=>{await request();return {ok:!url.includes('missing'),status:404,json:async()=>({ok:true})};},textureLoader:{loadAsync:async()=>{await request();return new THREE.Texture();}}});
  const results=await Promise.allSettled(Array.from({length:30},(_,i)=>i%2?assets.json(`assets/${i===7?'missing':i}.json`):assets.texture({map:`assets/${i}.webp`})));
  assert.equal(peak,6);assert.equal(active,0);assert.equal(assets.queue.active,0);assert.equal(assets.queue.waiting.length,0);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  for(const result of results)if(result.status==='fulfilled'&&result.value.isTexture)result.value.dispose();
});
