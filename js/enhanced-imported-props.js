import * as THREE from 'three';
import {mergeGeometries} from '../vendor/addons/utils/BufferGeometryUtils.js?v=20261109-10';
import {classifyProp,meshPlacement} from './enhanced-props.js?v=20261109-10';

const MANIFEST='assets/enhanced/props/manifest.json';
const KINDS=new Set(['crate','barrel','table','chair']);
const Y=new THREE.Vector3(0,1,0);
function owned(object){object.userData.graphicsOwned=true;object.userData.collision=false;return object;}

export function importedPropPlacements(modelData){
  const result=[];
  for(const mesh of modelData?.meshes||[]){
    const kind=classifyProp(mesh,modelData);if(!KINDS.has(kind))continue;
    result.push({mesh,kind,placement:meshPlacement(mesh)});
  }
  return result;
}

// The top of a chair is its backrest, unlike the sign-ambiguous PCA axis of a
// nearly square footprint. Keep the source chair facing its original table.
function backAngle(positions,scale=1){
  const box=new THREE.Box3(),v=new THREE.Vector3();
  for(let i=0;i<positions.length;i+=3)box.expandByPoint(v.fromArray(positions,i).multiplyScalar(scale));
  const center=box.getCenter(new THREE.Vector3()),cut=box.min.y+(box.max.y-box.min.y)*.78;
  let x=0,z=0,count=0;
  for(let i=0;i<positions.length;i+=3)if(positions[i+1]*scale>cut){x+=positions[i]*scale-center.x;z+=positions[i+2]*scale-center.z;count++;}
  return count&&Math.hypot(x,z)>.0001?Math.atan2(x,z):0;
}

export function propInstanceMatrix(record,prototypeBounds,prototypeBack=0){
  const p=record.placement,size=prototypeBounds.getSize(new THREE.Vector3()),object=new THREE.Object3D();
  object.position.copy(p.position);
  if(record.kind==='chair'){
    const angle=backAngle(record.mesh.vertices,.01)-prototypeBack;
    object.rotation.y=angle;
    const c=Math.abs(Math.cos(angle)),s=Math.abs(Math.sin(angle));
    const fit=Math.min(p.size.x/(c*size.x+s*size.z),p.size.z/(s*size.x+c*size.z));
    object.scale.set(fit,p.size.y/size.y,fit);
  }else object.scale.set(p.size.x/size.x,p.size.y/size.y,p.size.z/size.z);
  object.updateMatrix();return object.matrix.clone();
}

/** Owns only parsed/imported GPU resources. It does not mutate source geometry,
 * materials, visibility or colliders. The compositor consumes retainedMeshes
 * and hides original material batches only after a replacement has loaded. */
export class EnhancedImportedProps {
  constructor({assets,modelData,quality='high',loadModel,manifest}={}){
    Object.assign(this,{assets,modelData,quality,loadModel,manifest});
    this.group=owned(new THREE.Group());this.group.name='Imported CC0 props';
    this.hiddenMaterialNames=new Set();this.replacedMeshes=new Set();this.retainedMeshes=[];
    this.geometries=new Set();this.materials=new Set();this.textures=new Set();this.batches=[];
    this.stats={replacements:0,kinds:{},drawCalls:0,highTriangles:0,lowTriangles:0,failures:[]};
    this.disposed=false;this.ready=false;this.enabled=true;
  }
  get replacements(){return this.stats.replacements;}
  load(){return this.promise??=this._load();}
  async _load(){
    const placements=importedPropPlacements(this.modelData);
    if(!placements.length){this.ready=true;return this;}
    try{this.manifest??=await this.assets.json(MANIFEST);}catch(error){this.stats.failures.push({kind:'manifest',message:String(error.message||error)});return this;}
    if(this.disposed)return this;
    for(const kind of KINDS){
      const selected=placements.filter(record=>record.kind===kind),spec=this.manifest.models?.[kind];
      if(!selected.length||!spec)continue;
      try{
        const model=await (this.loadModel?this.loadModel(spec,kind):this._model(spec));
        this._track(model);
        if(this.disposed){this._release();return this;}
        this._build(kind,selected,model,spec);
        for(const record of selected){this.replacedMeshes.add(record.mesh);for(const part of record.mesh.groups)this.hiddenMaterialNames.add(part.material);}
        this.stats.kinds[kind]=selected.length;this.stats.replacements+=selected.length;
      }catch(error){this.stats.failures.push({kind,message:String(error.message||error)});}
    }
    this.retainedMeshes=(this.modelData.meshes||[]).filter(mesh=>!this.replacedMeshes.has(mesh)&&mesh.groups?.some(part=>this.hiddenMaterialNames.has(part.material)));
    this.ready=!this.disposed;this.group.visible=this.enabled&&this.ready;
    return this;
  }
  async _model(spec){
    const {GLTFLoader}=await import('../vendor/addons/loaders/GLTFLoader.js?v=20261109-10');
    const raw=structuredClone(await this.assets.json(spec.path)),folder=spec.path.slice(0,spec.path.lastIndexOf('/')+1);
    for(const item of [...raw.buffers||[],...raw.images||[]])if(item.uri)item.uri=this.assets.url(folder+item.uri);
    return new GLTFLoader().parseAsync(raw,'');
  }
  _track(model){
    for(const scene of model.scenes||[model.scene])scene?.traverse(object=>{
      if(object.geometry)this.geometries.add(object.geometry);
      for(const material of (object.material?Array.isArray(object.material)?object.material:[object.material]:[])){
        this.materials.add(material);material.userData.graphicsOwned=true;material.envMapIntensity=.45;
        for(const value of Object.values(material))if(value?.isTexture){this.textures.add(value);value.anisotropy=this.quality==='low'?1:4;}
      }
    });
  }
  _parts(scene){
    if(!scene)throw new Error('Imported prop has no scene');
    scene.updateMatrixWorld(true);const byMaterial=new Map();
    scene.traverse(object=>{
      if(!object.isMesh||Array.isArray(object.material))return;
      let geometry=object.geometry.clone();geometry.applyMatrix4(object.matrixWorld);
      if(geometry.index){const flat=geometry.toNonIndexed();geometry.dispose();geometry=flat;}
      const parts=byMaterial.get(object.material)||[];parts.push(geometry);byMaterial.set(object.material,parts);
    });
    const result=[];
    for(const[material,parts]of byMaterial){
      const geometry=mergeGeometries(parts);for(const part of parts)part.dispose();
      if(!geometry)throw new Error('Unable to merge imported prop geometry');
      this.geometries.add(geometry);geometry.computeBoundingBox();result.push({geometry,material});
    }
    if(!result.length)throw new Error('Imported prop contains no usable meshes');
    return result;
  }
  _build(kind,placements,model,spec){
    const high=this._parts(model.scene||model.scenes?.[0]);
    const low=model.scenes?.[spec.lodScene??1]?this._parts(model.scenes[spec.lodScene??1]):high;
    const bounds=new THREE.Box3();for(const part of high)bounds.union(part.geometry.boundingBox);
    const size=bounds.getSize(new THREE.Vector3());if(Math.min(size.x,size.y,size.z)<.001)throw new Error('Imported prop has invalid bounds');
    const origin=bounds.getCenter(new THREE.Vector3());origin.y=bounds.min.y;
    const back=kind==='chair'?backAngle(high.flatMap(part=>Array.from(part.geometry.attributes.position.array))):0;
    const allParts=[...new Set([...high,...low])];
    for(const part of allParts){part.geometry.translate(-origin.x,-origin.y,-origin.z);part.geometry.computeBoundingBox();part.geometry.computeBoundingSphere();}
    bounds.translate(origin.clone().negate());
    const records=placements.map(record=>({position:record.placement.position.clone(),matrix:propInstanceMatrix(record,bounds,back)}));
    const make=(parts,lod)=>parts.map(part=>{
      const mesh=owned(new THREE.InstancedMesh(part.geometry,part.material,records.length));mesh.name=`imported:${kind}:${lod}`;
      mesh.castShadow=lod==='near';mesh.receiveShadow=true;mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Both batches are compacted during update. Until then display the low
      // LOD everywhere, so there is no one-frame pile of objects at the origin.
      records.forEach((record,i)=>mesh.setMatrixAt(i,record.matrix));mesh.count=lod==='near'?0:records.length;
      mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();this.group.add(mesh);return mesh;
    });
    const highBatches=make(high,'near'),lowBatches=make(low,'far');
    const triangles=parts=>parts.reduce((n,p)=>n+(p.geometry.index?.count||p.geometry.attributes.position.count)/3,0);
    this.stats.highTriangles+=triangles(high)*records.length;this.stats.lowTriangles+=triangles(low)*records.length;
    this.stats.drawCalls+=highBatches.length+lowBatches.length;
    this.batches.push({kind,records,high:highBatches,low:lowBatches});
  }
  setEnabled(enabled){this.enabled=!!enabled;this.group.visible=this.enabled&&this.ready&&!this.disposed;}
  update(camera,quality=this.quality,time){
    if(this.disposed||!this.ready||!camera)return;
    if(time!==undefined&&quality===this.quality&&time-(this.lastUpdate??-Infinity)<.25)return;
    this.lastUpdate=time;
    if(quality!==this.quality)for(const texture of this.textures){texture.anisotropy=quality==='low'?1:4;texture.needsUpdate=true;}
    this.quality=quality;
    const point=camera.getWorldPosition?camera.getWorldPosition(new THREE.Vector3()):camera.position;
    const low=quality==='low',radius=low?20:48,limits=low?{crate:24,barrel:32,table:8,chair:16}:{crate:96,barrel:96,table:32,chair:64};
    for(const batch of this.batches){
      const sorted=batch.records.map(record=>({record,distance:point.distanceToSquared(record.position)})).sort((a,b)=>a.distance-b.distance);
      let near=0,far=0;
      for(const{record,distance}of sorted){
        const isNear=distance<radius*radius&&near<limits[batch.kind],index=isNear?near++:far++;
        for(const mesh of isNear?batch.high:batch.low)mesh.setMatrixAt(index,record.matrix);
      }
      for(const mesh of batch.high){mesh.count=near;mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();}
      for(const mesh of batch.low){mesh.count=far;mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();}
    }
  }
  _release(){
    this.group.removeFromParent();this.group.traverse(object=>{if(object.isInstancedMesh)object.dispose();});this.group.clear();
    for(const geometry of this.geometries)geometry.dispose();for(const material of this.materials)material.dispose();
    for(const texture of this.textures){texture.dispose();texture.image?.close?.();}
    this.geometries.clear();this.materials.clear();this.textures.clear();this.batches=[];
  }
  dispose(){if(this.disposed)return;this.disposed=true;this.ready=false;this._release();}
}
