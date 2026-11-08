import * as THREE from 'three';
import {unzipSync} from '../vendor/fflate.js';
import {mergeWorldMeshes} from './merge-world.js';

export class Assets {
  constructor() { this.manifest=null; this.blobs=new Map(); this.models=new Map(); this.jsons=new Map(); this.textures=new Map(); }
  url(path) { return this.blobs.get(path) || new URL('../'+path,import.meta.url).href; }
  async json(path) {
    if(!this.jsons.has(path)) this.jsons.set(path,(async()=>{const r=await fetch(this.url(path));if(!r.ok)throw new Error(`${path}: HTTP ${r.status}`);return r.json();})());
    return this.jsons.get(path);
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
    if(!this.textures.has(key)) this.textures.set(key,(async()=>{
      const tex=await new THREE.TextureLoader().loadAsync(this.url(mat.map));tex.colorSpace=THREE.SRGBColorSpace;tex.wrapS=tex.wrapT=THREE.RepeatWrapping;
      tex.repeat.fromArray(mat.uvScale||[1,1]);tex.offset.fromArray(mat.uvOffset||[0,0]);tex.rotation=mat.uvRotation||0;tex.anisotropy=4;return tex;
    })());
    return this.textures.get(key);
  }
  async model(original,raw=false) {
    const key=original.toLowerCase().replaceAll('\\','/');const cacheKey=key+':'+raw;
    if(!this.models.has(cacheKey)) this.models.set(cacheKey,this.buildModel(key,raw));
    return (await this.models.get(cacheKey)).clone(true);
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
