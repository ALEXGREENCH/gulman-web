import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { AudioManager, decodePCM } from '../js/audio.js';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await fs.readFile(new URL('assets/manifest.json', root), 'utf8'));
const asArrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
class Param { constructor(){this.value=1;} setTargetAtTime(value){this.value=value;} }
class AudioNode { connect(){return this;} disconnect(){this.disconnected=true;} }
class Source extends AudioNode {
  start(when=0, offset=0, duration){this.started=true;this.offset=offset;this.duration=duration;}
  stop(){this.stopped=true;this.onended?.();}
}
// This fake tests manager lifecycle only. Actual audible browser playback is
// checked separately; these tests do not pretend to verify a sound device.
class TestContext {
  constructor(){this.state='suspended';this.currentTime=0;this.destination=new AudioNode();}
  createBuffer(channels,frames,sampleRate){
    const data=Array.from({length:channels},()=>new Float32Array(frames));
    return {numberOfChannels:channels,length:frames,sampleRate,duration:frames/sampleRate,getChannelData:i=>data[i]};
  }
  createGain(){const node=new AudioNode();node.gain=new Param();return node;}
  createDynamicsCompressor(){const node=new AudioNode();for(const k of ['threshold','knee','ratio','attack','release'])node[k]=new Param();return node;}
  createBufferSource(){return new Source();}
  async resume(){this.state='running';this.onstatechange?.();}
  async close(){this.state='closed';}
}

test('all 25 official WAV files decode with their native rates and nonzero finite PCM', async()=>{
  const entries=Object.entries(manifest.sounds);assert.equal(entries.length,25);
  const context=new TestContext();const codecs=new Set();
  for(const [name,path] of entries){
    const pcm=decodePCM(asArrayBuffer(await fs.readFile(new URL(path,root))),context);
    assert.ok(pcm,name);assert.ok(pcm.buffer.duration>0,name);assert.ok(pcm.peak>0&&pcm.peak<=1,name);
    assert.ok(Number.isFinite(pcm.rms)&&pcm.rms>0,name);codecs.add(pcm.format.bits);
    if(name.startsWith('music/'))assert.equal(pcm.buffer.sampleRate,8000,'Avoid 6× memory expansion when decoding original music');
  }
  assert.deepEqual([...codecs].sort((a,b)=>a-b),[8,16]);
});

test('PCM8 unsigned midpoint and PCM16 signed extrema are decoded correctly',()=>{
  function wav(bits,samples){
    const bytes=Buffer.alloc(44+samples.length*(bits/8));bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
    bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(8000,24);
    bytes.writeUInt32LE(8000*bits/8,28);bytes.writeUInt16LE(bits/8,32);bytes.writeUInt16LE(bits,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);
    samples.forEach((sample,i)=>bits===8?bytes.writeUInt8(sample,44+i):bytes.writeInt16LE(sample,44+i*2));return asArrayBuffer(bytes);
  }
  assert.deepEqual([...decodePCM(wav(8,[0,128,255]),new TestContext()).buffer.getChannelData(0)],[-1,0,127/128]);
  assert.deepEqual([...decodePCM(wav(16,[-32768,0,32767]),new TestContext()).buffer.getChannelData(0)],[-1,0,32767/32768]);
});

test('queued music unlocks, resumes its offset, changes tracks and preserves user settings',async()=>{
  const oldContext=globalThis.AudioContext,oldFetch=globalThis.fetch,oldStorage=globalThis.localStorage;
  const storage={data:new Map(),getItem(k){return this.data.get(k);},setItem(k,v){this.data.set(k,v);}};
  globalThis.AudioContext=TestContext;globalThis.localStorage=storage;
  globalThis.fetch=async url=>({ok:true,arrayBuffer:async()=>asArrayBuffer(await fs.readFile(new URL(url)))});
  let audio;
  try{
    audio=new AudioManager(path=>manifest.sounds[path]?new URL(manifest.sounds[path],root).href:null);
    await audio.setMusic('music/gulman1_sg3.wav');assert.equal(audio.diagnostics.musicPlaying,false);
    await audio.unlock();await audio.resumeMusic();assert.equal(audio.state,'running');assert.equal(audio.diagnostics.musicPlaying,true);
    assert.ok(audio._musicRecord.musicGain>1,'Compensate the quiet original menu recording');
    audio.context.currentTime=12;audio.pauseMusic();assert.equal(audio._musicOffset,12);assert.equal(audio.diagnostics.musicPlaying,false);
    await audio.resumeMusic();assert.equal(audio._musicSource.offset,12);assert.equal(audio.diagnostics.musicPlaying,true,'Cached tracks must restart after pause');
    await audio.setMusic('music/t3.wav');assert.equal(audio._musicOffset,0);assert.equal(audio.diagnostics.musicPlaying,true);
    assert.equal(await audio.play('sounds/гульмен/г1.wav',.9,{voice:true}),true);
    assert.equal(audio.musicGain.gain.value,audio.musicVolume*.35,'Voice ducks the music');
    assert.equal(await audio.play('sounds/гульмен/г2.wav',.9,{voice:true}),false,'Do not overlap voice lines');
    audio._voice.stop();assert.equal(audio.musicGain.gain.value,audio.musicVolume);
    audio.muted=true;assert.equal(await audio.play('sounds/weapons/pistol-01.wav'),false);assert.equal(audio.masterGain.gain.value,0);
    audio.musicVolume=.3;audio.effectsVolume=.7;
    assert.deepEqual(new AudioManager(()=>null).settings,{musicVolume:.3,effectsVolume:.7,muted:true});
    await audio.dispose();assert.equal(audio.state,'closed');assert.equal(audio._effects.size,0);
  }finally{
    if(audio?.state!=='closed')await audio?.dispose();
    globalThis.AudioContext=oldContext;globalThis.fetch=oldFetch;globalThis.localStorage=oldStorage;
  }
});
