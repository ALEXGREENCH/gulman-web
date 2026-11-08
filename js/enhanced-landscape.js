import * as THREE from 'three';
import {clipTriangleToAtlasRegions} from './enhanced-architecture.js?v=20261109-10';

const SCALE=.01;
// Hash-qualified source maps are deliberate. The word ROCK also occurs on
// props, and several atlases share a material name with unrelated levels.
const LANDSCAPES=Object.freeze({
  'beach-3aaad64c45d1.jpg':{level:1,mode:6,base:'sand',path:'sand'},
  'land-77ae1a7ffc08.png':{level:2,mode:1,path:'concrete',tint:0xd1cbab},
  'tx5-6e6d85ae3024.jpg':{level:3,mode:0,tint:0xd0d5b4},
  'tx3-05285933d5f6.jpg':{level:3,kind:'cliff',paving:[[632,0,780,279],[12,807,115,911],[295,398,700,718]]},
  'landscap-5f75de926c77.jpg':{level:4,mode:2,path:'sand',tint:0xb4aa81},
  'terrain-ff344f98d7d2.jpg':{level:5,mode:4,path:'limestone'},
  'rock-e9ac16fd6737.jpg':{level:5,kind:'cliff'},
  'asset-7baef9f1d336.jpg':{level:6,kind:'cobblestone',flat:true},
  'asset-ba9ba3262738.jpg':{level:6,mode:5,path:'sand',flat:true},
  'ground-4e3b9dbabe6a.jpg':{level:7,mode:3,path:'sand',tint:0xa8ac81},
  'rock-04bde2bf205d.jpg':{level:7,kind:'cliff'},
  'asset-87875987f94b.jpg':{level:8,kind:'cobblestone',flat:true},
  'grass4-5b9b3140d17b.jpg':{level:9,mode:0,tint:0xc5cba7},
});
function configFor(spec={},levelId){const file=String(spec.map||'').replaceAll('\\','/').split('/').pop().toLowerCase();const config=LANDSCAPES[file];return config&&config.level===Number(levelId)?config:null;}
export function isEnhancedLandscapeMaterial(spec,levelId){return Boolean(configFor(spec,levelId));}
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const smooth=x=>{x=clamp(x);return x*x*(3-2*x);};
const coordKey=p=>p.toArray().map(n=>Math.round(n*10000)).join(',');
const edgeKey=(a,b)=>a<b?a+'|'+b:b+'|'+a;
function transformedUV(raw,spec){const s=spec.uvScale||[1,1],o=spec.uvOffset||[0,0],angle=spec.uvRotation||0;return new THREE.Vector2(s[0]*(Math.cos(angle)*raw.x+Math.sin(angle)*raw.y)+o[0],s[1]*(-Math.sin(angle)*raw.x+Math.cos(angle)*raw.y)+o[1]);}
function sourceTriangle(mesh,at,spec){
  const ids=mesh.indices.slice(at,at+3),p=ids.map(i=>new THREE.Vector3().fromArray(mesh.vertices,i*3).multiplyScalar(SCALE));
  const face=p[1].clone().sub(p[0]).cross(p[2].clone().sub(p[0])).normalize();
  return ids.map((index,k)=>{const rawUV=new THREE.Vector2(mesh.uv?.[index*2]||0,mesh.uv?.[index*2+1]||0);return {p:p[k],rawUV,uv:transformedUV(rawUV,spec),normal:mesh.normals?.length===mesh.vertices.length?new THREE.Vector3().fromArray(mesh.normals,index*3).normalize():face.clone()};});
}
function pushRaw(target,triangle){for(const v of triangle){target.indices.push(target.indices.length);target.vertices.push(v.p.x/SCALE,v.p.y/SCALE,v.p.z/SCALE);target.normals.push(...v.normal.toArray());target.uv.push(...v.rawUV.toArray());}}
const hash=(x,y,z)=>{let n=Math.sin(x*127.1+y*311.7+z*74.7)*43758.5453123;return n-Math.floor(n);};
function noise(x,y,z){
  const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z),u=smooth(x-ix),v=smooth(y-iy),w=smooth(z-iz);
  const mix=(a,b,t)=>a+(b-a)*t;
  return mix(mix(mix(hash(ix,iy,iz),hash(ix+1,iy,iz),u),mix(hash(ix,iy+1,iz),hash(ix+1,iy+1,iz),u),v),mix(mix(hash(ix,iy,iz+1),hash(ix+1,iy,iz+1),u),mix(hash(ix,iy+1,iz+1),hash(ix+1,iy+1,iz+1),u),v),w)*2-1;
}

/** A separate visual surface, in metres. Uniform edge subdivision and welded
 * source normals make adjacent source triangles agree even across UV seams.
 * Exterior/cut edges are fixed, walkable ground relief is <=18 mm, and steep
 * mountain relief is <=45 cm. No collision positions or source arrays change.
 */
export function createLandscapeGeometry(triangles,{subdivisions=4,flat=false}={}){
  const n=Math.max(1,Math.min(12,Math.floor(subdivisions))),edges=new Map(),normals=new Map();
  for(const triangle of triangles){
    const keys=triangle.map(v=>coordKey(v.p)),face=triangle[1].p.clone().sub(triangle[0].p).cross(triangle[2].p.clone().sub(triangle[0].p));
    for(let i=0;i<3;i++){const key=edgeKey(keys[i],keys[(i+1)%3]);if(!edges.has(key))edges.set(key,{count:0,a:triangle[i].p,b:triangle[(i+1)%3].p});edges.get(key).count++;if(!normals.has(keys[i]))normals.set(keys[i],new THREE.Vector3());normals.get(keys[i]).add(face);}
  }
  for(const value of normals.values())value.normalize();
  const boundaries=[...edges.values()].filter(e=>e.count===1).map(e=>({...e,box:new THREE.Box3().setFromPoints([e.a,e.b]).expandByScalar(1.5),dx:e.b.x-e.a.x,dy:e.b.y-e.a.y,dz:e.b.z-e.a.z,lengthSq:e.a.distanceToSquared(e.b)}));
  const positions=[],uvs=[],indices=[];
  let maxDisplacement=0;
  for(const triangle of triangles){
    const[a,b,c]=triangle,keys=triangle.map(v=>coordKey(v.p)),normal=keys.map(k=>normals.get(k));
    // Distance to the SAME global boundary set on both sides of a shared
    // edge avoids cracks caused by each triangle fading against different
    // exterior edges. AABB pruning keeps the CPU-only subdivision bounded.
    const box=new THREE.Box3().setFromPoints(triangle.map(v=>v.p)),nearEdges=boundaries.filter(e=>box.intersectsBox(e.box));
    const grid=new Map(),key=(i,j)=>i*(n+1)+j;
    for(let i=0;i<=n;i++)for(let j=0;j<=n-i;j++){
      const bary=[1-(i+j)/n,i/n,j/n],p=a.p.clone().multiplyScalar(bary[0]).addScaledVector(b.p,bary[1]).addScaledVector(c.p,bary[2]);
      const N=normal[0].clone().multiplyScalar(bary[0]).addScaledVector(normal[1],bary[1]).addScaledVector(normal[2],bary[2]).normalize();
      let distanceSq=2.25;for(const e of nearEdges)if(e.box.containsPoint(p)){const t=clamp(((p.x-e.a.x)*e.dx+(p.y-e.a.y)*e.dy+(p.z-e.a.z)*e.dz)/Math.max(e.lengthSq,1e-10));const dx=p.x-e.a.x-e.dx*t,dy=p.y-e.a.y-e.dy*t,dz=p.z-e.a.z-e.dz*t;distanceSq=Math.min(distanceSq,dx*dx+dy*dy+dz*dz);}
      const fade=smooth(Math.sqrt(distanceSq)/1.5);
      const slope=flat?0:1-smooth((Math.abs(N.y)-.52)/.34),amplitude=flat?0:.018+slope*.432;
      const relief=(noise(p.x*.63,p.y*.63,p.z*.63)*.7+noise(p.x*1.81+9,p.y*1.81,p.z*1.81)*.3)*amplitude*fade;
      grid.set(key(i,j),positions.length/3);
      p.addScaledVector(N,relief);maxDisplacement=Math.max(maxDisplacement,Math.abs(relief));positions.push(p.x,p.y,p.z);
      uvs.push(a.rawUV.x*bary[0]+b.rawUV.x*bary[1]+c.rawUV.x*bary[2],a.rawUV.y*bary[0]+b.rawUV.y*bary[1]+c.rawUV.y*bary[2]);
    }
    for(let i=0;i<n;i++)for(let j=0;j<n-i;j++){const a=grid.get(key(i,j)),b=grid.get(key(i+1,j)),c=grid.get(key(i,j+1));indices.push(a,b,c);if(i+j<n-1)indices.push(b,grid.get(key(i+1,j+1)),c);}
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));geometry.setIndex(indices);geometry.computeVertexNormals();
  // Smooth the duplicate UV-edge normals, without welding UVs or topology.
  const sums=new Map(),attribute=geometry.getAttribute('normal');
  for(let i=0;i<positions.length/3;i++){const key=coordKey(new THREE.Vector3().fromArray(positions,i*3));if(!sums.has(key))sums.set(key,new THREE.Vector3());sums.get(key).add(new THREE.Vector3().fromBufferAttribute(attribute,i));}
  for(let i=0;i<positions.length/3;i++){const N=sums.get(coordKey(new THREE.Vector3().fromArray(positions,i*3))).normalize();attribute.setXYZ(i,N.x,N.y,N.z);}
  geometry.computeBoundingBox();geometry.computeBoundingSphere();
  geometry.userData={enhancedLandscape:true,sourceTriangles:triangles.length,subdivisions:n,maxDisplacementMeters:maxDisplacement,collision:false};
  return geometry;
}

/** Consumes only its exact landscape materials from a possibly already clipped
 * model. Every untouched fragment of a hidden material is returned for the
 * shared source compositor. It does not hide or edit the borrowed world itself.
 */
export function buildEnhancedLandscape({modelData,world,library,levelId=1,quality='high'}={}){
  const group=new THREE.Group();group.name='Scanned landscape';group.userData={graphicsOwned:true,collision:false};
  if(world){world.updateWorldMatrix(true,false);group.matrix.copy(world.matrixWorld).multiply(new THREE.Matrix4().makeScale(100,100,100));group.matrixAutoUpdate=false;}
  const geometries=new Set(),materials=new Set(),hiddenMaterialNames=new Set(),retainedMeshes=[],batches=new Map();
  const stats={surfaces:0,sourceTriangles:0,triangles:0,preservedTriangles:0,maxDisplacementMeters:0,triangleBudget:quality==='low'?7000:28000};
  if(!modelData?.meshes||!library)return {group,geometries,materials,hiddenMaterialNames,retainedMeshes,stats};
  for(const [name,spec]of Object.entries(modelData.materials||{})){
    const config=configFor(spec,levelId);if(!config)continue;
    const atlas=world?.children.find(o=>o.name==='world:'+name)?.material?.map;
    const material=config.kind?library.createKind(config.kind,{normalStrength:.78}):library.createLandscape?.({atlas,...config})??library.createKind(config.base||'grass');
    if(!material)continue;batches.set(name,{name,spec,config,material,triangles:[]});
    if(config.paving)batches.set(name+':paving',{name,spec,config:{flat:true},material:library.createKind('limestone',{tileMeters:2.2,normalStrength:.55}),triangles:[]});
  }
  for(const mesh of modelData.meshes){
    const retained={name:mesh.name+':retained-landscape',vertices:[],normals:[],uv:[],indices:[],groups:[]};
    for(const part of mesh.groups||[]){const batch=batches.get(part.material);if(!batch)continue;const start=retained.indices.length;
      for(let at=part.start;at<part.start+part.count;at+=3){const triangle=sourceTriangle(mesh,at,batch.spec);
        const pieces=batch.config.paving?clipTriangleToAtlasRegions(triangle,batch.config.paving):{remaining:[triangle],selected:[]};
        batch.triangles.push(...pieces.remaining);if(pieces.selected.length)batches.get(part.material+':paving').triangles.push(...pieces.selected);
        stats.sourceTriangles++;stats.preservedTriangles+=pieces.selected.length;
      }
      if(retained.indices.length>start)retained.groups.push({start,count:retained.indices.length-start,material:part.material});
    }
    if(retained.indices.length)retainedMeshes.push(retained);
  }
  const triangleCount=[...batches.values()].reduce((sum,b)=>sum+b.triangles.length,0);
  const subdivisions=Math.max(1,Math.min(12,Math.floor(Math.sqrt(stats.triangleBudget/Math.max(1,triangleCount)))));
  for(const [name,batch]of batches){
    if(!batch.triangles.length){library.disposeMaterial?.(batch.material);continue;}
    const geometry=createLandscapeGeometry(batch.triangles,{subdivisions,flat:batch.config.flat});
    const mesh=new THREE.Mesh(geometry,batch.material);mesh.name='landscape:'+name;mesh.userData={graphicsOwned:true,collision:false,sourceMaterial:name};mesh.castShadow=false;mesh.receiveShadow=true;
    group.add(mesh);geometries.add(geometry);materials.add(batch.material);hiddenMaterialNames.add(batch.name);stats.surfaces++;stats.triangles+=geometry.index.count/3;stats.maxDisplacementMeters=Math.max(stats.maxDisplacementMeters,geometry.userData.maxDisplacementMeters);
  }
  // A fully preserved material stays visible in the borrowed world; returning
  // it again would duplicate its original surface in the compositor.
  const retained=retainedMeshes.map(mesh=>{const indices=[],groups=[];for(const part of mesh.groups)if(hiddenMaterialNames.has(part.material)){const start=indices.length;indices.push(...mesh.indices.slice(part.start,part.start+part.count));groups.push({...part,start});}return {...mesh,indices,groups};}).filter(mesh=>mesh.indices.length);
  return {group,geometries,materials,hiddenMaterialNames,retainedMeshes:retained,stats};
}
