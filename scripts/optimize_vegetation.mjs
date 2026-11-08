// Offline LOD processing of credited CC0 source plants and their authored maps.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [input, output, modulePath, selected = '0'] = process.argv.slice(2);
const { MeshoptSimplifier: S } = await import(pathToFileURL(modulePath));
await S.ready;
const source = JSON.parse(await readFile(input, 'utf8'));
const buffers = await Promise.all(source.buffers.map(b => readFile(path.join(path.dirname(input), b.uri))));
const widths = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const component = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array };
function accessor(index) {
  const a = source.accessors[index], view = source.bufferViews[a.bufferView], buffer = buffers[view.buffer];
  const T = component[a.componentType], width = widths[a.type], stride = view.byteStride || width * T.BYTES_PER_ELEMENT;
  const values = new T(a.count * width), offset = (view.byteOffset || 0) + (a.byteOffset || 0);
  for (let i = 0; i < a.count; i++) {
    const raw = new T(buffer.buffer, buffer.byteOffset + offset + i * stride, width);
    values.set(raw, i * width);
  }
  return values;
}
const out = { asset: { version: '2.0', generator: 'GulmanWeb CC0 vegetation offline LOD / meshoptimizer 1.3.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: source.materials, textures: source.textures, images: source.images, samplers: source.samplers, accessors: [], bufferViews: [], buffers: [{ uri: 'mesh.bin', byteLength: 0 }] };
if (source.extensionsUsed) out.extensionsUsed = source.extensionsUsed.filter(x => !/materials_(ior|specular)/.test(x));
const chunks = []; let byteLength = 0;
function add(values, type, target) {
  while (byteLength % 4) { chunks.push(Buffer.alloc(1)); byteLength++; }
  const data = Buffer.from(values.buffer, values.byteOffset, values.byteLength), view = out.bufferViews.length;
  out.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.length, target }); chunks.push(data); byteLength += data.length;
  const spec = { bufferView: view, componentType: values instanceof Float32Array ? 5126 : 5125, count: values.length / widths[type], type };
  if (type === 'VEC3') { spec.min = [Infinity, Infinity, Infinity]; spec.max = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < values.length; i++) { spec.min[i % 3] = Math.min(spec.min[i % 3], values[i]); spec.max[i % 3] = Math.max(spec.max[i % 3], values[i]); } }
  out.accessors.push(spec); return out.accessors.length - 1;
}
const sourceNode = source.nodes.find(n => n.mesh === Number(selected));
const original = source.meshes[Number(selected)];
const stats = [];

// Broadleaf source: each separate leaf is a 7x3 tessellated surface (24 tris).
// Global Prune erases those islands and destroys the crown. Keep the original
// four UV corners instead, then sample spatially across EVERY occupied cell.
// Modest area compensation replaces density lost by sampling, not by opaque
// canopy billboards. The real leaf atlas still determines every silhouette.
function leafSurfaceLOD(positions,normals,uv,indices,lod,{maxVertices=Infinity,strides=[2,16],scales=[1.5,3.5]}={}){
  const count=positions.length/3,parent=new Int32Array(count);for(let i=0;i<count;i++)parent[i]=i;
  const root=x=>{while(parent[x]!==x){parent[x]=parent[parent[x]];x=parent[x];}return x;};
  for(let i=0;i<indices.length;i+=3){parent[root(indices[i])]=root(indices[i+1]);parent[root(indices[i+1])]=root(indices[i+2]);}
  const leaves=new Map(),min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<count;i++){const id=root(i),leaf=leaves.get(id)||[];leaf.push(i);leaves.set(id,leaf);for(let a=0;a<3;a++){min[a]=Math.min(min[a],positions[i*3+a]);max[a]=Math.max(max[a],positions[i*3+a]);}}
  const area=(a,b,c)=>{const ax=b[0]-a[0],ay=b[1]-a[1],az=b[2]-a[2],bx=c[0]-a[0],by=c[1]-a[1],bz=c[2]-a[2];return Math.hypot(ay*bz-az*by,az*bx-ax*bz,ax*by-ay*bx)/2;};
  const point=i=>Array.from(positions.subarray(i*3,i*3+3));let sourceArea=0;
  const remainder=[];
  for(let i=0;i<indices.length;i+=3){if(leaves.get(root(indices[i])).length>maxVertices)remainder.push(indices[i],indices[i+1],indices[i+2]);else sourceArea+=area(point(indices[i]),point(indices[i+1]),point(indices[i+2]));}
  const cells=new Map();
  for(const vertices of leaves.values()){
    if(vertices.length>maxVertices)continue;
    const center=[0,0,0],lo=[Infinity,Infinity],hi=[-Infinity,-Infinity];
    for(const i of vertices){for(let a=0;a<3;a++)center[a]+=positions[i*3+a]/vertices.length;for(let a=0;a<2;a++){lo[a]=Math.min(lo[a],uv[i*2+a]);hi[a]=Math.max(hi[a],uv[i*2+a]);}}
    const uvCorners=[[lo[0],lo[1]],[hi[0],lo[1]],[hi[0],hi[1]],[lo[0],hi[1]]];
    const corners=uvCorners.map(([u,v])=>vertices.reduce((best,i)=>(uv[i*2]-u)**2+(uv[i*2+1]-v)**2<(uv[best*2]-u)**2+(uv[best*2+1]-v)**2?i:best,vertices[0]));
    // These source leaves are trimmed leaf-shaped polygons, not rectangles.
    // Selecting their nearest corner vertices would crop the leaf twice after
    // alpha testing. Fit a UV→position plane and reconstruct the full atlas
    // rectangle; its ORIGINAL alpha texture supplies the exact silhouette.
    const mean=[0,0];for(const i of vertices){mean[0]+=uv[i*2]/vertices.length;mean[1]+=uv[i*2+1]/vertices.length;}
    let uu=0,vv=0,uvv=0;const pu=[0,0,0],pv=[0,0,0];
    for(const i of vertices){const u=uv[i*2]-mean[0],v=uv[i*2+1]-mean[1];uu+=u*u;vv+=v*v;uvv+=u*v;for(let a=0;a<3;a++){pu[a]+=(positions[i*3+a]-center[a])*u;pv[a]+=(positions[i*3+a]-center[a])*v;}}
    const det=uu*vv-uvv*uvv;if(det<1e-12)continue;
    const du=pu.map((v,a)=>(v*vv-pv[a]*uvv)/det),dv=pv.map((v,a)=>(v*uu-pu[a]*uvv)/det);
    const points=uvCorners.map(([u,v])=>center.map((value,a)=>value+du[a]*(u-mean[0])+dv[a]*(v-mean[1]))),surface=area(points[0],points[1],points[2])+area(points[0],points[2],points[3]);
    const key=center.map((v,a)=>Math.min(11,Math.floor((v-min[a])/Math.max(.001,max[a]-min[a])*12))).join(',');
    const list=cells.get(key)||[];list.push({center,corners,uvCorners,points,surface});cells.set(key,list);
  }
  const packed=[],packedNormals=[],packedUV=[],packedIndices=[];let retained=0,outputArea=0;
  for(const list of cells.values()){
    const quality=lod==='high'?0:1,stride=strides[quality],selected=list.filter((_,i)=>i%stride===0),total=list.reduce((n,l)=>n+l.surface,0),kept=selected.reduce((n,l)=>n+l.surface,0);
    const scale=Math.min(scales[quality],Math.sqrt(total/Math.max(1e-9,kept)));
    for(const leaf of selected){
      const base=packed.length/3;
      for(let k=0;k<4;k++){const id=leaf.corners[k];packed.push(...leaf.points[k].map((v,a)=>leaf.center[a]+(v-leaf.center[a])*scale));packedNormals.push(...normals.subarray(id*3,id*3+3));packedUV.push(...leaf.uvCorners[k]);}
      const a=leaf.points[0],b=leaf.points[1],c=leaf.points[2],ax=b[0]-a[0],ay=b[1]-a[1],az=b[2]-a[2],bx=c[0]-a[0],by=c[1]-a[1],bz=c[2]-a[2],id=leaf.corners[0]*3;
      const facing=(ay*bz-az*by)*normals[id]+(az*bx-ax*bz)*normals[id+1]+(ax*by-ay*bx)*normals[id+2];
      if(facing<0)packedIndices.push(base,base+2,base+1,base,base+3,base+2);else packedIndices.push(base,base+1,base+2,base,base+2,base+3);
      retained++;outputArea+=leaf.surface*scale*scale;
    }
  }
  return{positions:new Float32Array(packed),normals:new Float32Array(packedNormals),uv:new Float32Array(packedUV),indices:new Uint32Array(packedIndices),remainder:new Uint32Array(remainder),coverage:{sourceLeaves:[...leaves.values()].filter(v=>v.length<=maxVertices).length,retainedLeaves:retained,occupiedCells:cells.size,retainedCells:cells.size,sourceArea,outputArea,areaRatio:outputArea/sourceArea}};
}

// The source fir models have hundreds of thousands of sub-pixel needles.
// Reconstruct complete twig clusters from their authored stem axes and the
// source photographed twig atlas. These small intersecting branch surfaces
// retain the real 3D branch distribution; no whole-tree impostor is used.
function coniferBranchLOD(positions,indices,lod){
  const count=positions.length/3,parent=Int32Array.from({length:count},(_,i)=>i),root=x=>{while(parent[x]!==x){parent[x]=parent[parent[x]];x=parent[x];}return x;};
  for(let i=0;i<indices.length;i+=3){parent[root(indices[i])]=root(indices[i+1]);parent[root(indices[i+1])]=root(indices[i+2]);}
  const groups=new Map();for(let i=0;i<count;i++){const key=root(i),group=groups.get(key)||[];group.push(i);groups.set(key,group);}
  const branches=[],min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const vertices of groups.values()){
    if(vertices.length<=6)continue;
    const center=[0,0,0],cov=Array(9).fill(0);for(const i of vertices)for(let a=0;a<3;a++)center[a]+=positions[i*3+a]/vertices.length;
    for(const i of vertices){const p=[0,1,2].map(a=>positions[i*3+a]-center[a]);for(let a=0;a<3;a++)for(let b=0;b<3;b++)cov[a*3+b]+=p[a]*p[b];}
    let axis=[1,.7,.3];for(let k=0;k<10;k++){const p=[0,1,2].map(a=>cov[a*3]*axis[0]+cov[a*3+1]*axis[1]+cov[a*3+2]*axis[2]),l=Math.hypot(...p);if(l<1e-12)break;axis=p.map(v=>v/l);}
    if(axis[0]*center[0]+axis[2]*center[2]<0)axis=axis.map(v=>-v);
    let lo=Infinity,hi=-Infinity;for(const i of vertices){const t=axis.reduce((v,n,a)=>v+n*(positions[i*3+a]-center[a]),0);lo=Math.min(lo,t);hi=Math.max(hi,t);}
    const length=hi-lo;if(length<.035||length>3)continue;
    for(let a=0;a<3;a++){center[a]+=axis[a]*(lo+hi)/2;min[a]=Math.min(min[a],center[a]);max[a]=Math.max(max[a],center[a]);}
    branches.push({center,axis,length});
  }
  const cells=new Map();for(const branch of branches){const key=branch.center.map((v,a)=>Math.min(11,Math.floor((v-min[a])/Math.max(.001,max[a]-min[a])*12))).join(','),list=cells.get(key)||[];list.push(branch);cells.set(key,list);}
  const p=[],n=[],uv=[],ix=[],tiles=[[.15,.025,.49,.425],[.63,.09,.995,.40],[.30,.425,.65,.80],[.65,.43,.99,.80]];
  let selectedCount=0;
  for(const list of cells.values()){
    const stride=lod==='high'?1:5,selected=list.filter((_,i)=>i%stride===0),scale=lod==='high'?1:Math.min(1.8,Math.sqrt(list.length/selected.length));
    for(const branch of selected){
      const {center,axis}=branch,length=branch.length*1.12*scale,width=Math.max(.07,branch.length*.68)*scale;
      let side=[axis[2],0,-axis[0]];let size=Math.hypot(...side);if(size<.001){side=[1,0,0];size=1;}side=side.map(v=>v/size);
      const second=[axis[1]*side[2]-axis[2]*side[1],axis[2]*side[0]-axis[0]*side[2],axis[0]*side[1]-axis[1]*side[0]],tile=tiles[selectedCount%tiles.length];
      for(const across of[side,second]){
        const normal=[axis[1]*across[2]-axis[2]*across[1],axis[2]*across[0]-axis[0]*across[2],axis[0]*across[1]-axis[1]*across[0]],base=p.length/3;
        for(const[x,y,u,v]of[[-1,1,tile[0],tile[1]],[1,1,tile[2],tile[1]],[1,-1,tile[2],tile[3]],[-1,-1,tile[0],tile[3]]]){p.push(...center.map((q,a)=>q+axis[a]*y*length/2+across[a]*x*width/2));n.push(...normal);uv.push(u,v);}
        ix.push(base,base+1,base+2,base,base+2,base+3);
      }
      selectedCount++;
    }
  }
  return{positions:new Float32Array(p),normals:new Float32Array(n),uv:new Float32Array(uv),indices:new Uint32Array(ix),coverage:{sourceBranches:branches.length,retainedBranches:selectedCount,occupiedCells:cells.size,retainedCells:cells.size}};
}
for (const lod of ['high', 'low']) {
  const primitives = [];
  for (const primitive of original.primitives) {
    const positions = accessor(primitive.attributes.POSITION), normals = primitive.attributes.NORMAL === undefined ? new Float32Array(positions.length) : accessor(primitive.attributes.NORMAL), uv = primitive.attributes.TEXCOORD_0 === undefined ? new Float32Array(positions.length / 3 * 2) : accessor(primitive.attributes.TEXCOORD_0);
    let indices = new Uint32Array(accessor(primitive.indices));
    if (primitive.attributes.TEXCOORD_0 === undefined) for (let i = 0; i < positions.length / 3; i++) { uv[i * 2] = .5 + Math.atan2(positions[i * 3 + 1], positions[i * 3]) / (Math.PI * 2); uv[i * 2 + 1] = positions[i * 3 + 2] * .2; }
    const name = source.materials[primitive.material].name || '', foliage = /leaves|twig|shrub|palm/.test(name), branch = /branch/.test(name), shrub = /shrub/.test(name);
    const needle=name==='fir_tree_01_twig';
    if(needle){
      const twig=coniferBranchLOD(positions,indices,lod);
      primitives.push({attributes:{POSITION:add(twig.positions,'VEC3',34962),NORMAL:add(twig.normals,'VEC3',34962),TEXCOORD_0:add(twig.uv,'VEC2',34962)},indices:add(twig.indices,'SCALAR',34963),material:primitive.material});
      stats.push({lod,material:name,triangles:twig.indices.length/3,sourceTriangles:indices.length/3,error:0,method:'source-axis twig clusters with original photographed twig alpha atlas',coverage:twig.coverage});continue;
    }
    if(name==='island_tree_02_leaves'){
      const leaf=leafSurfaceLOD(positions,normals,uv,indices,lod);
      primitives.push({attributes:{POSITION:add(leaf.positions,'VEC3',34962),NORMAL:add(leaf.normals,'VEC3',34962),TEXCOORD_0:add(leaf.uv,'VEC2',34962)},indices:add(leaf.indices,'SCALAR',34963),material:primitive.material});
      stats.push({lod,material:name,triangles:leaf.indices.length/3,sourceTriangles:(indices.length-leaf.remainder.length)/3,error:0,method:'spatially distributed UV-corner leaf LOD',coverage:leaf.coverage});
      if(!leaf.remainder.length)continue;
      indices=leaf.remainder;
    }
    // Palm and sorrel are already compact authored assets. Shrub's small
    // disconnected leaf/stem islands must survive; never prune foliage.
    const preserve=/palm|shrub_sorrel/.test(name)||(shrub&&lod==='high');
    const budget = preserve?indices.length/3:lod === 'high' ? (foliage ? 11000 : branch ? 1800 : 1500) : (shrub ? 1800 : foliage ? 1500 : branch ? 250 : 220);
    const target = Math.min(indices.length, budget * 3), attrs = new Float32Array(positions.length / 3 * 5);
    for (let i = 0; i < positions.length / 3; i++) { attrs.set(uv.subarray(i * 2, i * 2 + 2), i * 5); attrs.set(normals.subarray(i * 3, i * 3 + 3), i * 5 + 2); }
    let [reduced, error] = preserve?[indices,0]:S.simplifyWithAttributes(indices, positions, 3, attrs, 5, [.05, .05, .02, .02, .02], null, target, lod === 'high' ? .045 : .12, shrub?['Permissive']:['Permissive', 'Prune']);
    if (!shrub&&reduced.length > target * 1.5) [reduced, error] = S.simplifySloppy(reduced, positions, 3, null, target, lod === 'high' ? .025 : .08);
    const [remap, count] = S.compactMesh(reduced), compact = (source, width) => { const result = new Float32Array(count * width); for (let i = 0; i < remap.length; i++) if (remap[i] !== 0xffffffff) result.set(source.subarray(i * width, i * width + width), remap[i] * width); return result; };
    // compactMesh already rewrites the index buffer in place.
    const mapped = reduced;
    const p = compact(positions, 3), n = compact(normals, 3), tex = compact(uv, 2);
    primitives.push({ attributes: { POSITION: add(p, 'VEC3', 34962), NORMAL: add(n, 'VEC3', 34962), TEXCOORD_0: add(tex, 'VEC2', 34962) }, indices: add(mapped, 'SCALAR', 34963), material: primitive.material });
    stats.push({ lod, material: name, triangles: mapped.length / 3, sourceTriangles: indices.length / 3, error });
  }
  const mesh = out.meshes.length; out.meshes.push({ name: lod, primitives });
  const node = { ...sourceNode, name: lod, mesh }; delete node.children;
  out.scenes[0].nodes.push(out.nodes.length); out.nodes.push(node);
}
for (const material of out.materials) { delete material.extensions; if (/leaves|twig|shrub|palm/.test(material.name || '')) { material.alphaMode = 'MASK'; material.alphaCutoff = .42; material.doubleSided = true; } }
// Remove unused material/texture/image declarations before the importer copies maps.
const usedMaterials = [...new Set(out.meshes.flatMap(m => m.primitives.map(p => p.material)))];
for (const m of out.meshes) for (const p of m.primitives) p.material = usedMaterials.indexOf(p.material);
out.materials = usedMaterials.map(i => out.materials[i]);
const textures = new Set();
function walk(value, visit) { if (!value || typeof value !== 'object') return; for (const [key, item] of Object.entries(value)) { if (/Texture$/.test(key) && item?.index !== undefined) visit(item); else walk(item, visit); } }
for (const m of out.materials) walk(m, x => textures.add(x.index));
const usedTextures = [...textures], usedImages = [...new Set(usedTextures.map(i => out.textures[i].source))];
for (const m of out.materials) walk(m, x => { x.index = usedTextures.indexOf(x.index); });
out.textures = usedTextures.map(i => ({ ...out.textures[i], source: usedImages.indexOf(out.textures[i].source) })); out.images = usedImages.map(i => out.images[i]);
out.buffers[0].byteLength = byteLength;
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'mesh.bin'), Buffer.concat(chunks));
await writeFile(path.join(output, 'model.gltf'), JSON.stringify(out));
await writeFile(path.join(output, 'geometry-stats.json'), JSON.stringify(stats, null, 2) + '\n');
console.log(path.basename(path.dirname(input)), stats.map(s => `${s.lod}:${s.material}=${s.triangles}`).join(', '), 'bytes', byteLength);
