import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {buildEnhancedArchitecture,extractArchitectureFaces,projectAtlasFeature,findSourceColumns,clipTriangleToAtlasRegions} from '../js/enhanced-architecture.js';
import {EnhancedWorld} from '../js/enhanced-world.js';
import {mergeWorldMeshes} from '../js/merge-world.js';

const root=new URL('../',import.meta.url);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const manifest=JSON.parse(await readFile(new URL('assets/manifest.json',root),'utf8'));
const levels=await Promise.all(manifest.levels.map(level=>readFile(new URL(manifest.models[level.model.toLowerCase()],root),'utf8').then(JSON.parse)));
const release=result=>{result.group.traverse(o=>{if(o.isInstancedMesh)o.dispose();});result.geometries.forEach(g=>g.dispose());result.materials.forEach(m=>m.dispose());};
function quad({name='facade',width=8,height=8,z=0,material='wall',uv=[0,0,1,0,1,1,0,1]}={}){
  return {name,vertices:[0,0,z,width*100,0,z,width*100,height*100,z,0,height*100,z],uv,indices:[0,1,2,0,2,3],groups:[{start:0,count:6,material}]};
}
function rawGeometry(geometry,material='column'){
  geometry.scale(100,100,100);
  return {name:'synthetic',vertices:[...geometry.attributes.position.array],uv:[...geometry.attributes.uv.array],indices:[...geometry.index.array],groups:[{start:0,count:geometry.index.count,material}]};
}

test('atlas features are placed by the original UV affine map and reject unsupported holes or tilted surfaces',()=>{
  const mesh=quad(),face=extractArchitectureFaces(mesh,'wall',{})[0];
  assert.equal(face.triangles.length,2);
  const feature={rect:[25,25,50,75],type:'window',style:'rect'},placement=projectAtlasFeature(face,feature,100);
  assert.equal(placement.width,2);assert.equal(placement.height,4);
  assert.deepEqual(placement.center.toArray(),[3,4,0]);
  assert.ok(new THREE.Matrix4().makeBasis(placement.right,placement.up,placement.normal).determinant()>.99);
  const partial={...face,triangles:[[new THREE.Vector2(0,0),new THREE.Vector2(.2,0),new THREE.Vector2(0,.2)]]};
  assert.equal(projectAtlasFeature(partial,feature,100),null,'a bounding rectangle alone does not authorize a facade across empty space');
  const horizontal={...face,U:new THREE.Vector3(8,0,0),V:new THREE.Vector3(0,0,8),normal:new THREE.Vector3(0,1,0)};
  assert.equal(projectAtlasFeature(horizontal,feature,100),null);
  const transformed=extractArchitectureFaces(mesh,'wall',{uvScale:[2,1],uvOffset:[.1,0]})[0];
  const p=projectAtlasFeature(transformed,feature,100);
  assert.ok(Math.abs(p.center.x-1.1)<1e-6);assert.equal(p.width,1);
});

test('new windows have depth, glass and mullions, while the original door opening is never filled',()=>{
  const data={materials:{wall:{originalMap:'HOUSE1.TGA'}},meshes:[quad()]};
  const before=hash(data),result=buildEnhancedArchitecture({modelData:data,levelId:2});
  assert.equal(hash(data),before);assert.equal(result.stats.windows,3);assert.equal(result.stats.doors,1);
  result.group.updateMatrixWorld(true);
  const doorX=(78+119)/2/256*8,doorY=(1-(0+71)/2/256)*8;
  const ray=new THREE.Raycaster(new THREE.Vector3(doorX,doorY,1),new THREE.Vector3(0,0,-1),0,2);
  assert.equal(ray.intersectObject(result.group,true).length,0,'an open source doorway keeps its clear center');
  ray.set(new THREE.Vector3((17+68)/2/256*8,(1-(8+53)/2/256)*8,1),new THREE.Vector3(0,0,-1));
  assert.ok(ray.intersectObject(result.group,true).length>0,'window includes real new geometry');
  assert.ok(new THREE.Box3().setFromObject(result.group).max.z>.04);
  release(result);
});

test('columns are selected from actual isolated circular topology, never square posts or broken ruins',()=>{
  const cylinder=new THREE.CylinderGeometry(.5,.5,6,12),box=new THREE.BoxGeometry(1,6,1),broken=new THREE.CylinderGeometry(.5,.5,1.4,12);
  assert.equal(findSourceColumns(rawGeometry(cylinder),'column').length,1);
  assert.equal(findSourceColumns(rawGeometry(box),'column').length,0);
  assert.equal(findSourceColumns(rawGeometry(broken),'column').length,0);
  cylinder.dispose();box.dispose();broken.dispose();
});

test('both original Greek temples get 128 genuinely new fluted columns, with every unrelated triangle retained',()=>{
  const data=levels[2],before=hash(data),result=buildEnhancedArchitecture({modelData:data,levelId:3});
  assert.equal(result.stats.columns,128);assert.equal(result.group.children.filter(o=>o.name.startsWith('architecture:column:')).length,2);
  assert.ok(result.hiddenMaterialNames.has('dd')&&result.hiddenMaterialNames.has('hhhhh'));
  let originalTriangles=0,removedTriangles=0;
  for(const mesh of data.meshes)for(const group of mesh.groups){if(!['dd','hhhhh'].includes(group.material))continue;originalTriangles+=group.count/3;removedTriangles+=findSourceColumns(mesh,group.material).reduce((n,c)=>n+c.starts.length,0);}
  const retained=result.retainedMeshes.reduce((n,m)=>n+m.groups.filter(g=>['dd','hhhhh'].includes(g.material)).reduce((k,g)=>k+g.count/3,0),0);
  assert.equal(originalTriangles-removedTriangles,retained);
  assert.equal(hash(data),before);
  const geometry=result.geometries[0],positions=geometry.attributes.position;
  const shaftRadii=[];
  for(let i=0;i<positions.count;i++)if(Math.abs(positions.getY(i)-.07)<1e-5)shaftRadii.push(Math.hypot(positions.getX(i),positions.getZ(i)));
  assert.ok(Math.max(...shaftRadii)-Math.min(...shaftRadii)>.025,'flutes change the actual silhouette, not just the normal map');
  assert.ok(result.stats.triangles<200000);
  release(result);
});

test('UV clipping conserves surface area and retains ornament strips without gaps or overlapping replacements',()=>{
  const vertex=(x,y)=>({p:new THREE.Vector3(x*10,y*10,0),uv:new THREE.Vector2(x,y),rawUV:new THREE.Vector2(x,y),normal:new THREE.Vector3(0,0,1)});
  const triangle=[vertex(0,0),vertex(1,0),vertex(0,1)];
  const clipped=clipTriangleToAtlasRegions(triangle,[[0,40,100,80],[20,50,90,100]],100);
  const area=triangles=>triangles.reduce((sum,[a,b,c])=>sum+b.p.clone().sub(a.p).cross(c.p.clone().sub(a.p)).length()/2,0);
  assert.ok(clipped.selected.length>0&&clipped.remaining.length>0);
  assert.ok(Math.abs(area(clipped.selected)+area(clipped.remaining)-50)<1e-9);
  for(const piece of [...clipped.selected,...clipped.remaining])for(const v of piece){assert.ok(Math.abs(v.p.x-v.rawUV.x*10)<1e-9);assert.ok(Math.abs(v.p.y-v.rawUV.y*10)<1e-9);assert.equal(v.normal.z,1);}
});

test('Acropolis spawn wall uses new PBR while terrain remains available to the landscape layer',()=>{
  const result=buildEnhancedArchitecture({modelData:levels[2],levelId:3});result.group.updateMatrixWorld(true);
  const from=new THREE.Vector3(132.86,-19.89,15.71),wall=new THREE.Raycaster(from,new THREE.Vector3(-1,0,0),0,10);
  assert.ok(wall.intersectObject(result.group,true).some(hit=>hit.object.name==='architecture:masonry:limestone'),'spawn wall has actual scanned stone');
  assert.equal(result.hiddenMaterialNames.has('qwe'),false,'green mountain atlas belongs to the landscape layer');
  assert.equal(result.hiddenMaterialNames.has('dfghhkl'),false,'rock terrain belongs to the landscape layer');
  const retained=result.retainedMeshes.filter(m=>m.name.endsWith(':retained-relief'));
  assert.ok(retained.length>=1);
  const area=meshes=>meshes.reduce((total,mesh)=>total+mesh.groups.filter(g=>g.material==='dfgh').reduce((sum,g)=>{
    for(let at=g.start;at<g.start+g.count;at+=3){const p=mesh.indices.slice(at,at+3).map(i=>new THREE.Vector3().fromArray(mesh.vertices,i*3).multiplyScalar(.01));sum+=p[1].sub(p[0]).cross(p[2].sub(p[0])).length()/2;}return sum;
  },0),0);
  let replacementArea=0;
  result.group.traverse(o=>{if(!o.name.startsWith('architecture:masonry:'))return;const p=o.geometry.attributes.position;
    for(let at=0;at<p.count;at+=3){const a=new THREE.Vector3().fromBufferAttribute(p,at),b=new THREE.Vector3().fromBufferAttribute(p,at+1),c=new THREE.Vector3().fromBufferAttribute(p,at+2);replacementArea+=b.sub(a).cross(c.sub(a)).length()/2;}
  });
  assert.ok(Math.abs(area(levels[2].meshes)-area(result.retainedMeshes)-replacementArea)<.02,'clipped world faces do not lose or duplicate area');
  release(result);
});

test('all nine levels have finite, instanced architectural upgrades without mutating original models or visibility',()=>{
  for(let i=0;i<9;i++){
    const data=levels[i],before=hash(data),world=new THREE.Group(),borrowedGeometry=new THREE.BoxGeometry(),borrowedMaterial=new THREE.MeshLambertMaterial();
    const borrowed=new THREE.Mesh(borrowedGeometry,borrowedMaterial);borrowed.name='world:'+Object.keys(data.materials)[0];borrowed.visible=false;world.add(borrowed);
    const result=buildEnhancedArchitecture({modelData:data,world,levelId:i+1});
    assert.equal(hash(data),before,`level ${i+1} raw data changed`);assert.equal(borrowed.visible,false);assert.equal(borrowed.material,borrowedMaterial);assert.equal(borrowed.geometry,borrowedGeometry);
    assert.ok(result.stats.instances>0,`level ${i+1} is missing new architecture`);assert.ok(result.stats.drawCalls<=14);assert.ok(result.stats.roofTiles<=2400);assert.ok(result.stats.triangles<210000);
    assert.ok(Array.isArray(result.retainedMeshes));
    const matrix=new THREE.Matrix4();
    result.group.traverse(object=>{
      assert.equal(object.userData.graphicsOwned,true);assert.equal(object.userData.collision,false);
      if(object.geometry)for(const attribute of Object.values(object.geometry.attributes))assert.ok(attribute.array.every(Number.isFinite));
      if(object.isInstancedMesh)for(let n=0;n<object.count;n++){object.getMatrixAt(n,matrix);assert.ok(matrix.elements.every(Number.isFinite));assert.ok(matrix.determinant()>0);}
    });
    if(i===1)assert.ok(result.stats.windows>=48);
    if(i===3)assert.ok(result.stats.windows>100&&result.stats.roofTiles>1000);
    if(i===4||i===5)assert.ok(result.stats.openingRelief>500&&result.stats.resurfacedTriangles>4000);
    // A material may be hidden only if some of its exact source triangles are
    // retained or replaced; every retained group refers to a hidden material.
    for(const mesh of result.retainedMeshes)for(const group of mesh.groups){assert.ok(result.hiddenMaterialNames.has(group.material));assert.equal(group.start%3,0);assert.equal(group.count%3,0);}
    const originalHidden=data.meshes.reduce((n,m)=>n+m.groups.filter(g=>result.hiddenMaterialNames.has(g.material)).reduce((k,g)=>k+g.count/3,0),0);
    const retainedTriangles=result.retainedMeshes.reduce((n,m)=>n+m.indices.length/3,0);
    if(i!==2){
      const area=meshes=>meshes.reduce((total,m)=>{for(const g of m.groups||[])if(result.hiddenMaterialNames.has(g.material))for(let at=g.start;at<g.start+g.count;at+=3){const p=m.indices.slice(at,at+3).map(n=>new THREE.Vector3().fromArray(m.vertices,n*3).multiplyScalar(.01));total+=p[1].sub(p[0]).cross(p[2].sub(p[0])).length()/2;}return total;},0);
      let newArea=0;result.group.traverse(o=>{if(!o.name.startsWith('architecture:masonry:'))return;const p=o.geometry.attributes.position;for(let n=0;n<p.count;n+=3){const a=new THREE.Vector3().fromBufferAttribute(p,n),b=new THREE.Vector3().fromBufferAttribute(p,n+1),c=new THREE.Vector3().fromBufferAttribute(p,n+2);newArea+=b.sub(a).cross(c.sub(a)).length()/2;}});
      assert.ok(Math.abs(area(data.meshes)-area(result.retainedMeshes)-newArea)<.04,`level ${i+1} lost or duplicated source surface area`);
    }
    release(result);borrowedGeometry.dispose();borrowedMaterial.dispose();
  }
});

test('unrelated photo panoramas, graffiti, scenery cards and alpha atlases are never rebuilt by name guesses',()=>{
  for(const originalMap of ['HOTEL_RE.TGA','BEACH_RE.TGA','FOTO_060.JPG','ROAD.TGA','VNUTR.JPG','URNA.JPG']){
    const data={materials:{wall:{originalMap}},meshes:[quad()]},result=buildEnhancedArchitecture({modelData:data});
    assert.equal(result.group.children.length,0);assert.equal(result.hiddenMaterialNames.size,0);assert.equal(result.retainedMeshes.length,0);assert.equal(result.materials.length,0);assert.equal(result.geometries.length,0);
  }
});

test('integrated architecture restores hidden sources and releases new resources once after cancellation or failure',async()=>{
  for(const failure of [false,true]){
    const data=levels[2],sourceMap=new THREE.Texture(),sourceMaterials={},count=resource=>{resource.userData.disposals=0;resource.addEventListener('dispose',()=>resource.userData.disposals++);return resource;};
    count(sourceMap);for(const name of Object.keys(data.materials))sourceMaterials[name]=count(new THREE.MeshLambertMaterial({map:sourceMap}));
    const scene=new THREE.Scene(),world=mergeWorldMeshes(data,sourceMaterials,Object.values(sourceMaterials)[0]);world.scale.setScalar(.01);scene.add(world);
    const sourceGeometries=world.children.map(o=>count(o.geometry));world.getObjectByName('world:hhhhh').visible=false;
    const before=world.children.map(o=>o.visible),layer=new EnhancedWorld({assets:{},scene,world,modelData:data,levelId:3});
    layer.library.dispose();const allocatedMaterials=[];
    layer.library={materials:new Set(),load:async()=>{},setQuality(){},create(){return null;},createKind(){const m=count(new THREE.MeshStandardMaterial());this.materials.add(m);allocatedMaterials.push(m);return m;},disposeMaterial(m){if(this.materials.delete(m))m.dispose();},dispose(){for(const m of this.materials)m.dispose();this.materials.clear();}};
    let resume,ready;const started=new Promise(resolve=>{ready=resolve;});
    layer._plants=async()=>{ready();await new Promise(resolve=>{resume=resolve;});if(failure)throw new Error('simulated later asset failure');};
    layer.setEnabled(true);const pending=layer.load();await started;
    const geometries=[...layer.geometries].map(count),instanceMeshes=[];layer.group.traverse(o=>{if(o.isInstancedMesh)instanceMeshes.push(count(o));});
    const retainedMaterials=[...layer.materials].filter(m=>m.map===sourceMap).map(count);
    assert.ok(retainedMaterials.length>=3,'each shared hidden architecture atlas has a retained material');
    assert.deepEqual(world.children.map(o=>o.visible),before,'loading does not prematurely hide original world');
    if(failure){resume();await assert.rejects(pending,/simulated later asset failure/);}
    else {layer.dispose();resume();await pending;}
    layer.dispose();
    assert.deepEqual(world.children.map(o=>o.visible),before);assert.equal(layer.group.parent,null);
    for(const resource of [...geometries,...allocatedMaterials,...retainedMaterials,...instanceMeshes])assert.equal(resource.userData.disposals,1,'owned GPU resource disposal');
    for(const resource of [sourceMap,...sourceGeometries,...Object.values(sourceMaterials)])assert.equal(resource.userData.disposals,0,'borrowed original resource must survive');
    sourceMap.dispose();sourceGeometries.forEach(g=>g.dispose());Object.values(sourceMaterials).forEach(m=>m.dispose());
  }
});
