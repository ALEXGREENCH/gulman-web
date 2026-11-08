import * as THREE from 'three';
import {EnhancedMaterialLibrary} from './enhanced-materials.js?v=20261109-9';
import {EnhancedWater} from './enhanced-water.js?v=20261109-9';
import {buildEnhancedProps,meshPlacement} from './enhanced-props.js?v=20261109-9';
import {EnhancedImportedProps} from './enhanced-imported-props.js?v=20261109-9';
import {EnhancedVegetation} from './enhanced-vegetation.js?v=20261109-9';
import {buildEnhancedLandscape,isEnhancedLandscapeMaterial} from './enhanced-landscape.js?v=20261109-9';
import {remainingEnhancedSource,selectEnhancedSourceMaterials} from './enhanced-source.js?v=20261109-9';
import {buildEnhancedDecks} from './enhanced-decks.js?v=20261109-9';
import {buildEnhancedBoats} from './enhanced-boats.js?v=20261109-9';
import {buildEnhancedArchitecture} from './enhanced-architecture.js?v=20261109-9';
import {mergeWorldMeshes} from './merge-world.js?v=20261109-9';

const assetRoot='assets/enhanced/models/';
const TAU=Math.PI*2;
function random(seed){let n=seed>>>0;return()=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return n/4294967296;};}

export function foliagePlacements(data){
  const result=[];
  for(const mesh of data.meshes){
    if(mesh.groups?.length!==1)continue;
    const name=mesh.groups[0].material,source=data.materials[name]?.originalMap||'';
    if(!/^bush\.tga$/i.test(source))continue;
    const p=meshPlacement(mesh);if(p.size.y<.15||p.size.y>5)continue;
    // Original bushes consist of three overlapping crossed cards.
    const found=result.find(old=>old.position.distanceToSquared(p.position)<.64&&old.name===name);
    if(found){found.size.max(p.size);continue;}
    result.push({...p,name});
  }
  return result;
}

function owned(object){object.userData.graphicsOwned=true;object.userData.collision=false;return object;}

export function installPlantWind(material,time,amplitude=.065){
  material.onBeforeCompile=shader=>{
    shader.uniforms.gulmanWindTime=time;
    shader.vertexShader='uniform float gulmanWindTime;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
      vec3 plantOrigin=vec3(0.0);
      #ifdef USE_INSTANCING
        plantOrigin=instanceMatrix[3].xyz;
      #endif
      float bend=pow(clamp(position.y,0.0,1.0),1.65);
      float gust=sin(gulmanWindTime*1.35+plantOrigin.x*.31+plantOrigin.z*.17);
      float flutter=sin(gulmanWindTime*3.7+position.x*18.0+plantOrigin.z)*.28;
      transformed.x+=(gust+flutter)*bend*${amplitude.toFixed(4)};
      transformed.z+=cos(gulmanWindTime*.95+plantOrigin.x*.19)*bend*${(amplitude*.45).toFixed(4)};
    `);
  };
  material.customProgramCacheKey=()=>`enhanced-plants-wind-v1-${amplitude}`;
}

/** An independent visual layer. Original meshes/materials/collision are borrowed,
 * never edited or disposed; exact original visibility is restored on disable. */
export class EnhancedWorld {
  constructor({assets,scene,world,modelData,levelId=1,groundSample,quality='high'}){
    Object.assign(this,{assets,scene,world,modelData,levelId,groundSample,quality});
    this.group=owned(new THREE.Group());this.group.name='Enhanced asset pack';this.group.visible=false;
    this.library=new EnhancedMaterialLibrary(assets);this.originalVisibility=new Map();
    this.geometries=new Set();this.materials=new Set();this.textures=new Set();this.plantBatches=[];
    this.time={value:0};this.enabled=false;this.disposed=false;this.ready=false;this.replacements=0;this.surfaceCount=0;
    scene.add(this.group);
  }
  get diagnostics(){return {ready:this.ready,enabled:this.enabled&&this.ready,surfaces:this.surfaceCount,props:this.replacements,architecture:this.architectureStats||null,landscape:this.landscapeStats||null,importedProps:this.importedProps?.stats||null,vegetation:this.vegetation?.stats||null,vegetationError:this.vegetationError||null,plants:this.plantBatches.reduce((n,b)=>n+b.capacity,0),water:this.water?.diagnostics||null};}
  load(){if(!this.promise)this.promise=this._load().catch(error=>{this.setEnabled(false);this.disposed=true;this._release();throw error;});return this.promise;}
  async _load(){
    await this.library.load();if(this.disposed){this.library.dispose();return this;}
    this.library.setQuality(this.quality);
    this.water=new EnhancedWater({scene:this.scene,world:this.world,modelData:this.modelData,quality:this.quality,scale:.01,groundSample:this.groundSample});
    this.world.updateWorldMatrix(true,false);
    this.sourceRemainder=this.modelData;
    this.importedProps=new EnhancedImportedProps({assets:this.assets,modelData:this.sourceRemainder,quality:this.quality});
    await this.importedProps.load();if(this.disposed){this._release();return this;}
    this.group.add(this.importedProps.group);this.replacements+=this.importedProps.replacements;this._consume(this.importedProps);
    const props=buildEnhancedProps(this.sourceRemainder,this.library);this.group.add(props.group);this.replacements+=props.replacements;
    props.group.traverse(o=>{if(o.geometry)this.geometries.add(o.geometry);});for(const m of props.materials)this.materials.add(m);this._consume(props);
    const boats=buildEnhancedBoats(this.sourceRemainder);this._attach(boats);this.replacements+=boats.replacements;
    this._attach(buildEnhancedDecks({modelData:this.sourceRemainder,world:this.world,library:this.library}));
    const architecture=buildEnhancedArchitecture({modelData:this.sourceRemainder,world:this.world,library:this.library,levelId:this.levelId});
    this._attach(architecture);this.architectureStats=architecture.stats;
    const landscape=buildEnhancedLandscape({modelData:this.sourceRemainder,world:this.world,library:this.library,levelId:this.levelId,quality:this.quality});
    this._attach(landscape);this.landscapeStats=landscape.stats;
    this.vegetation=new EnhancedVegetation({assets:this.assets,modelData:this.sourceRemainder,quality:this.quality});
    try{await this.vegetation.load();}catch(error){this.vegetationError=String(error.message||error);}
    if(this.disposed){this._release();return this;}
    if(this.vegetation.ready){this.group.add(this.vegetation.group);this._consume(this.vegetation);}
    this._remainingSurfaces();
    await this._plants();if(this.disposed){this._release();return this;}
    this.sourceRemainder=null;this.ready=true;this.setEnabled(this.enabled);return this;
  }
  _consume(layer){
    const names=layer.hiddenMaterialNames||layer.hidden||[];
    for(const name of names)this._hideOriginal(name);
    this.sourceRemainder=remainingEnhancedSource(this.sourceRemainder,names,layer.retainedMeshes||[]);
  }
  _attach(layer){
    this.group.add(layer.group);for(const g of layer.geometries)this.geometries.add(g);for(const m of layer.materials)this.materials.add(m);this._consume(layer);
  }
  _remainingSurfaces(){
    const names=new Set(this.sourceRemainder.meshes.flatMap(mesh=>(mesh.groups||[]).map(part=>part.material))),materials={};
    const hidden=new Set([...this.originalVisibility.keys()].map(mesh=>mesh.name.replace(/^world:/,'')));
    for(const original of this.world.children){
      if(!original.isMesh||Array.isArray(original.material))continue;
      const name=original.name.replace(/^world:/,''),spec=this.modelData.materials[name],source=original.material;
      if(!spec||!names.has(name))continue;
      // Decorated atlas fragments retained by landscape must keep their original art.
      let material=!isEnhancedLandscapeMaterial(spec,this.levelId)?this.library.create(source,spec.map||spec.originalMap,{waterLevel:this._waterLevel()}):null;
      if(!material&&/^BOX\.JPG$/i.test(spec.originalMap||''))material=this.library.createKind('wood');
      if(material){this._hideOriginal(name);hidden.add(name);this.surfaceCount++;}
      else if(hidden.has(name))material=new THREE.MeshStandardMaterial({map:source.map,color:source.color,side:source.side,alphaTest:source.alphaTest,transparent:source.transparent,opacity:source.opacity,depthWrite:source.depthWrite,roughness:.74,metalness:.03});
      if(material){materials[name]=material;this.materials.add(material);}
    }
    const data=selectEnhancedSourceMaterials(this.sourceRemainder,Object.keys(materials));
    if(!data.meshes.length)return;
    const retained=mergeWorldMeshes(data,materials,Object.values(materials)[0]);retained.name='Remaining enhanced surfaces';
    retained.matrix.copy(this.world.matrixWorld);retained.matrixAutoUpdate=false;
    retained.traverse(o=>{owned(o);if(o.geometry){this.geometries.add(o.geometry);o.name=o.name.replace('world:','enhanced-surface:');o.castShadow=true;o.receiveShadow=true;}});this.group.add(retained);
  }
  _waterLevel(){
    const ys=[];for(const m of this.modelData.meshes){if(!m.groups?.some(p=>/^water\.jpg$/i.test(this.modelData.materials[p.material]?.originalMap||'')))continue;const p=meshPlacement(m);if(p.size.y<.1)ys.push(p.position.y);}
    return ys.length?Math.max(...ys):-10000;
  }
  _hideOriginal(name){const o=this.world.children.find(o=>o.name==='world:'+name);if(o&&!this.originalVisibility.has(o))this.originalVisibility.set(o,o.visible);}
  async _model(name,alpha=false){
    const {GLTFLoader}=await import('../vendor/addons/loaders/GLTFLoader.js?v=20261109-9');
    const folder=assetRoot+name+'/',raw=await this.assets.json(folder+name+'.gltf'),data=structuredClone(raw);
    for(const item of [...data.buffers||[],...data.images||[]])if(item.uri)item.uri=this.assets.url(folder+item.uri);
    const gltf=await new GLTFLoader().parseAsync(data,'');
    // Track parsed resources before the optional alpha request can fail.
    gltf.scene.traverse(o=>{if(o.geometry)this.geometries.add(o.geometry);for(const m of (o.material?Array.isArray(o.material)?o.material:[o.material]:[])){this.materials.add(m);for(const value of Object.values(m))if(value?.isTexture)this.textures.add(value);}});
    let alphaMap;if(alpha){alphaMap=await new THREE.TextureLoader().loadAsync(this.assets.url(folder+'alpha.png'));alphaMap.flipY=false;this.textures.add(alphaMap);}
    gltf.scene.traverse(o=>{
      if(o.geometry)this.geometries.add(o.geometry);
      if(!o.material)return;const list=Array.isArray(o.material)?o.material:[o.material];
      for(const m of list){this.materials.add(m);for(const value of Object.values(m))if(value?.isTexture){this.textures.add(value);value.anisotropy=4;}
        m.envMapIntensity=.55;if(alpha){m.alphaMap=alphaMap;m.alphaTest=.45;m.transparent=false;m.side=THREE.DoubleSide;m.roughness=.92;installPlantWind(m,this.time);}
      }
    });return gltf.scene;
  }
  _batch(prototype,positions,{height=1,wind=false,distance=100,lowRatio=.5}={}){
    if(!positions.length)return;
    const g=prototype.geometry.clone();g.computeBoundingBox();const box=g.boundingBox,c=box.getCenter(new THREE.Vector3()),s=box.getSize(new THREE.Vector3());g.translate(-c.x,-box.min.y,-c.z);g.scale(height/Math.max(s.y,.01),height/Math.max(s.y,.01),height/Math.max(s.y,.01));this.geometries.add(g);
    const batch=owned(new THREE.InstancedMesh(g,prototype.material,positions.length));batch.name='enhanced:'+prototype.name;batch.castShadow=!wind;batch.receiveShadow=true;batch.frustumCulled=false;batch.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const records=positions.map(p=>{const o=new THREE.Object3D();o.position.copy(p.position);o.rotation.y=p.yaw||0;const scale=p.scale||1;typeof scale==='number'?o.scale.setScalar(scale):o.scale.copy(scale);o.updateMatrix();return {matrix:o.matrix.clone(),position:p.position};});
    records.forEach((p,i)=>batch.setMatrixAt(i,p.matrix));batch.instanceMatrix.needsUpdate=true;this.group.add(batch);this.plantBatches.push({batch,records,distance,lowRatio,capacity:positions.length});
  }
  async _plants(){
    const rng=random(1827+this.levelId);
    // Photoscanned coastal rocks stay at the sides of the beach, outside routes.
    if(this.levelId===1){
      const rocks=await this._model('rock_07');if(this.disposed)return;const rockMesh=rocks.getObjectByName('rock_07'),positions=[];
      for(const[x,z,s]of [[53,-26,1.1],[52,-32,.65],[57,-18,1.4],[-59,-24,1.1],[-63,-17,1.5],[-54,-35,.75]]){const y=this.groundSample?.(x,12,z);if(Number.isFinite(y))positions.push({position:new THREE.Vector3(x,y-.16,z),yaw:rng()*TAU,scale:s});}
      if(rockMesh?.isMesh)this._batch(rockMesh,positions,{height:1.15,distance:110,lowRatio:1});
    }
  }
  setEnabled(enabled){this.enabled=!!enabled;if(this.disposed)return;const active=this.enabled&&this.ready;this.group.visible=active;for(const[o,v]of this.originalVisibility)o.visible=active?false:v;this.water?.setEnabled(active);}
  update(time,camera,quality='high'){
    if(!this.enabled||!this.ready||this.disposed)return;this.time.value=time;if(this.quality!==quality)this.library.setQuality(quality);this.quality=quality;this.water?.update(time,camera,quality);this.importedProps?.update(camera,quality,time);this.vegetation?.update(time,camera,quality);
    // Compact nearby instances 5 times/sec; no per-frame allocations or far grass.
    if(time-(this.lastCull??-Infinity)<.2)return;this.lastCull=time;
    for(const record of this.plantBatches){let count=0;const distance=record.distance*(quality==='low'?.72:1),stride=quality==='low'?Math.max(1,Math.round(1/record.lowRatio)):1;
      for(let i=0;i<record.records.length;i+=stride){const p=record.records[i];if(camera.position.distanceToSquared(p.position)>distance*distance)continue;record.batch.setMatrixAt(count++,p.matrix);}
      record.batch.count=count;record.batch.instanceMatrix.needsUpdate=true;
    }
  }
  _release(){this.importedProps?.dispose();this.vegetation?.dispose();this.water?.dispose();this.water=null;this.group.removeFromParent();this.group.traverse(o=>{if(o.isInstancedMesh)o.dispose();});this.group.clear();for(const g of this.geometries)g.dispose();for(const m of this.materials){if(this.library.materials.has(m))this.library.disposeMaterial(m);else m.dispose();}for(const t of this.textures){t.dispose();t.image?.close?.();}this.geometries.clear();this.materials.clear();this.textures.clear();this.library.dispose();}
  dispose(){if(this.disposed)return;this.setEnabled(false);this.disposed=true;this._release();}
}
