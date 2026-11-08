import * as THREE from 'three';
import {unzipSync} from '../vendor/fflate.js?v=20261109-10';
import {mergeWorldMeshes} from './merge-world.js?v=20261109-10';

// Static hosting can briefly return 503 while a deployment reaches an edge.
// Bound cold-start requests and never retain rejected promises in the cache.
class AssetQueue {
  constructor(limit=6){this.limit=limit;this.active=0;this.waiting=[];}
  async run(load){
    if(this.active>=this.limit)await new Promise(resolve=>this.waiting.push(resolve));else this.active++;
    try{return await load();}finally{const next=this.waiting.shift();if(next)next();else this.active--;}
  }
}
export async function retryAsset(load,{wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),shouldRetry=()=>true}={}){
  for(let attempt=0;;attempt++){
    try{return await load();}catch(error){if(attempt>=2||!shouldRetry(error))throw error;await wait(250*2**attempt);}
  }
}
function cached(cache,key,load){
  if(!cache.has(key)){
    const pending=Promise.resolve().then(load).catch(error=>{if(cache.get(key)===pending)cache.delete(key);throw error;});
    cache.set(key,pending);
  }
  return cache.get(key);
}
export class Assets {
  constructor({fetcher=(...args)=>fetch(...args),textureLoader=new THREE.TextureLoader(),wait}={}) { this.manifest=null; this.blobs=new Map(); this.models=new Map(); this.jsons=new Map(); this.textures=new Map();this.fetcher=fetcher;this.textureLoader=textureLoader;this.wait=wait;this.queue=new AssetQueue(); }
  url(path) { return this.blobs.get(path) || new URL('../'+path,import.meta.url).href; }
  async json(path) {
    return cached(this.jsons,path,()=>this.queue.run(()=>retryAsset(async()=>{
      const r=await this.fetcher(this.url(path),{cache:'no-cache'});
      if(!r.ok){const error=new Error(`${path}: HTTP ${r.status}`);error.retryable=[408,425,429,500,502,503,504].includes(r.status);throw error;}
      return r.json();
    },{wait:this.wait,shouldRetry:error=>error.retryable===true||error instanceof TypeError})));
  }
  async init() { this.manifest=await this.json('assets/manifest.json'); return this.manifest; }
  async importZip(file) {
    const files=unzipSync(new Uint8Array(await file.arrayBuffer()));
    const prefix=Object.keys(files).find(p=>p.endsWith('assets/manifest.json'))?.replace(/assets\/manifest.json$/,'');
    if(prefix===undefined) throw new Error('В ZIP не найден assets/manifest.json');
    for(const u of this.blobs.values()) URL.revokeObjectURL(u);
    this.blobs.clear();this.jsons.clear();this.models.clear();this.textures.clear();
    for(const [path,bytes] of Object.entries(files)) {const key=path.slice(prefix.length);if(!key.startsWith('assets/')||path.endsWith('/'))continue; const ext=key.split('.').pop();const type={json:'application/json',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',wav:'audio/wav'}[ext]||'application/octet-stream';this.blobs.set(key,URL.createObjectURL(new Blob([bytes],{type})));}
    return this.init();
  }
  image(original) {return this.url(this.manifest.images[original.toLowerCase()]);}
  sound(original) {const p=this.manifest.sounds[original.toLowerCase()];return p?this.url(p):null;}
  async texture(mat) {
    const key=JSON.stringify([mat.map,mat.uvScale,mat.uvOffset,mat.uvRotation]);
    return cached(this.textures,key,()=>this.queue.run(async()=>{
      let tex;try{tex=await retryAsset(()=>this.textureLoader.loadAsync(this.url(mat.map)),{wait:this.wait});}
      catch(cause){throw new Error(`Текстура ${mat.map}: ${cause?.message||'не удалось загрузить изображение'}`,{cause});}
      tex.colorSpace=THREE.SRGBColorSpace;tex.wrapS=tex.wrapT=THREE.RepeatWrapping;
      tex.repeat.fromArray(mat.uvScale||[1,1]);tex.offset.fromArray(mat.uvOffset||[0,0]);tex.rotation=mat.uvRotation||0;tex.anisotropy=4;return tex;
    }));
  }
  async model(original,raw=false) {
    const key=original.toLowerCase().replaceAll('\\','/');const cacheKey=key+':'+raw;
    return (await cached(this.models,cacheKey,()=>this.buildModel(key,raw))).clone(true);
  }
  async buildModel(key,raw) {
    const url=this.manifest.models[key];if(!url)throw new Error('Модель отсутствует: '+key);
    const data=await this.json(url);const materials={};
    await Promise.all(Object.entries(data.materials).map(async([name,source])=>{
      const m={...source};
      if(key.startsWith('models/players-nano/')&&!m.map){m.map=this.manifest.images[key.slice(0,key.lastIndexOf('/')+1)+'3.jpg'];m.color=[1,1,1];}
      materials[name]=new THREE.MeshLambertMaterial({color:new THREE.Color(...(m.color||[1,1,1])),map:m.map?await this.texture(m):null,side:THREE.DoubleSide,transparent:m.opacity<1,opacity:m.opacity??1,alphaTest:m.alphaTest||0});
    }));
    const fallback=new THREE.MeshLambertMaterial({color:0x9caa83,side:THREE.DoubleSide});
    if(key.startsWith('levels/')){const group=mergeWorldMeshes(data,materials,fallback,raw);if(!raw)group.scale.setScalar(.01);return group;}
    const group=new THREE.Group();
    for(const m of data.meshes){
      const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(m.vertices,3));if(m.uv?.length)g.setAttribute('uv',new THREE.Float32BufferAttribute(m.uv,2));g.setIndex(m.indices);
      const mats=[];for(const part of m.groups||[]){g.addGroup(part.start,part.count,mats.length);mats.push(materials[part.material]||fallback);}
      if(m.normals?.length)g.setAttribute('normal',new THREE.Float32BufferAttribute(m.normals,3));else g.computeVertexNormals();
      if(raw)g.rotateX(Math.PI/2);
      const mesh=new THREE.Mesh(g,mats.length?mats:fallback);mesh.name=m.name||'';group.add(mesh);
    }
    if(!raw)group.scale.setScalar(.01);return group;
  }
}
