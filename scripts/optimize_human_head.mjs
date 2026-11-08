// Offline meshoptimizer processing of the official CC0 human mesh. The
// simplifier is a build dependency, never a runtime network dependency.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i,'$1')),'..');
const work=path.resolve(root,'../../work/makehuman-source');
const modulePath=process.argv[2]||path.resolve(root,'../../work/vendor/meshoptimizer/package/meshopt_simplifier.js');
const {MeshoptSimplifier:S}=await import(pathToFileURL(modulePath));await S.ready;
const source=JSON.parse(await readFile(path.join(work,'human-head-source.json'),'utf8'));
const positions=new Float32Array(source.positions),attributes=new Float32Array(positions.length);
attributes.set(source.normals);
const [simplified,error]=S.simplifyWithAttributes(new Uint32Array(source.indices),positions,3,attributes,3,[.035,.035,.035],null,12000,.0012,['LockBorder','ErrorAbsolute']);
const [remap,count]=S.compactMesh(simplified);
const packed={...source,positions:new Array(count*3),normals:new Array(count*3),uv:new Array(count*2),indices:Array.from(simplified)};
for(let index=0;index<remap.length;index++)if(remap[index]!==0xffffffff){const out=remap[index];for(let axis=0;axis<3;axis++){packed.positions[out*3+axis]=source.positions[index*3+axis];packed.normals[out*3+axis]=source.normals[index*3+axis];}for(let axis=0;axis<2;axis++)packed.uv[out*2+axis]=source.uv[index*2+axis];}
const bounds=(predicate=()=>true)=>{const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(let i=0;i<count;i++){const p=packed.positions.slice(i*3,i*3+3);if(!predicate(p))continue;for(let a=0;a<3;a++){min[a]=Math.min(min[a],p[a]);max[a]=Math.max(max[a],p[a]);}}return{min,max};};
packed.bounds=bounds();packed.skullBounds=bounds(p=>p[1]>source.chinY+.03);packed.triangles=packed.indices.length/3;
// Count welded boundary loops, ignoring the source UV seam. This body asset
// has a closed face, including eye/mouth surfaces; only the neck is open.
const welded=new Map(),ids=[],points=[];
for(let i=0;i<count;i++){const p=packed.positions.slice(i*3,i*3+3),key=p.map(v=>Math.round(v*1e6)).join(',');if(!welded.has(key)){welded.set(key,points.length);points.push(p);}ids.push(welded.get(key));}
const edges=new Map();for(let at=0;at<packed.indices.length;at+=3){const tri=packed.indices.slice(at,at+3).map(i=>ids[i]);for(let k=0;k<3;k++){const a=tri[k],b=tri[(k+1)%3],key=a<b?`${a},${b}`:`${b},${a}`;edges.set(key,(edges.get(key)||0)+1);}}
const adjacency=new Map();for(const [key,count]of edges)if(count===1){const[a,b]=key.split(',').map(Number);if(!adjacency.has(a))adjacency.set(a,new Set());if(!adjacency.has(b))adjacency.set(b,new Set());adjacency.get(a).add(b);adjacency.get(b).add(a);}
const visited=new Set(),loops=[];for(const start of adjacency.keys()){if(visited.has(start))continue;const pending=[start],component=[];visited.add(start);while(pending.length){const vertex=pending.pop();component.push(vertex);for(const next of adjacency.get(vertex))if(!visited.has(next)){visited.add(next);pending.push(next);}}
  const center=[0,0,0];for(const vertex of component)for(let axis=0;axis<3;axis++)center[axis]+=points[vertex][axis]/component.length;loops.push({kind:center[1]<.01?'neck':'other',center,vertices:component.map(v=>points[v])});
}
packed.boundaryLoops=loops;packed.hasOpenEyeSockets=loops.some(loop=>loop.kind!=='neck');
const output=path.join(root,'assets/enhanced/characters/human-head.js');
await writeFile(output,'// MakeHuman hm08 anatomical head, CC0-1.0. See human-head-manifest.json.\nexport const humanHead = '+JSON.stringify(packed)+';\n');
const bytes=await readFile(output),original=await readFile(path.join(work,'base.obj'));
const hash=data=>createHash('sha256').update(data).digest('hex');
const manifest={version:1,asset:'MakeHuman hm08 anatomical head',license:'CC0-1.0',source:source.source,sourceCommit:'a8bc2d54ff0ac92e78ff71431b1023eda42bf482',sourceSha256:hash(original),authors:['Data Collection AB','Joel Palmius','Jonas Hauquier','MakeHuman Community'],licenseFile:'MAKEHUMAN-CC0.md',retrieved:'2026-11-09',derivative:{path:'assets/enhanced/characters/human-head.js',bytes:bytes.length,sha256:hash(bytes),vertices:count,triangles:packed.triangles,bounds:packed.bounds,skullBounds:packed.skullBounds},processing:['Official body topology only; helpers, hair and separate eyes excluded','Cut 5.4 mm below source neck joint; no shoulder flanges','Y-up, face +Z, neck-local metres, 1.8 m reference human','Original UVs and anatomy preserved; smooth source normals','meshoptimizer 1.3.0 attribute-aware simplification, LockBorder; requested absolute error 1.2 mm',`Reported simplification error ${error} m`],rebuild:'python scripts/fetch_human_anatomy.py --head-only && node scripts/optimize_human_head.mjs <meshopt_simplifier.js>',usage:'Use original costume and approved face texture with frontal UV projection; the imported topology replaces only anatomical head geometry.'};
await writeFile(path.join(root,'assets/enhanced/characters/human-head-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({vertices:count,triangles:packed.triangles,bytes:bytes.length,error,bounds:packed.bounds,skullBounds:packed.skullBounds,boundaries:loops.map(l=>({kind:l.kind,count:l.vertices.length}))},null,2));
