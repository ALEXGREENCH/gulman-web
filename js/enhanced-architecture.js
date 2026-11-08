import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const SCALE = .01;
const MAX_TILES = 2400;
const MAX_FEATURES = 1000;

// Rectangles are measured on the original atlases, in image pixels. They are
// never inferred from a material's arbitrary 3DS name. Every placement below
// must be supported by the original triangles and their affine UV projection.
const rect = (x0, y0, x1, y1, type = 'window', style = 'rect') => ({ rect: [x0, y0, x1, y1], type, style });
const house = [rect(17, 8, 68, 53), rect(78, 0, 119, 71, 'door'), rect(211, 10, 247, 58), rect(109, 110, 158, 147, 'window', 'round')];
const dutchRows = (green) => {
  const result = [];
  for (const x of [59,153,245,339,461,556,682,774,869,962]) for (const y of [744,804]) result.push(rect(x-(green?12:24), y-17, x+(green?12:24), y+17));
  const xs = green ? [33,113,194,283,363,462,573,663,742,823,912,992] : [33,181,367,511,590,654,706,878];
  for (const x of xs) result.push(rect(x-15, green?900:890, x+15, green?925:913));
  result.push(rect(638,617,673,676,'door','round'), rect(808,960,839,1017,'door'));
  return result;
};

const ATLASES = {
  'bar': { size:256, style:'timber', roofs:[[100,35,238,245]], features:[] },
  'hotel': { size:128, style:'coastal', features:[rect(0,56,25,83,'door'),rect(45,85,54,97),rect(0,112,20,127,'window','round'),rect(76,112,91,127)], wallKind:'plaster', wallRegions:[[5,4,98,48]] },
  'house1': { size:256, style:'coastal', features:house },
  'house2': { size:256, style:'coastal', features:house },
  'castle_f': { size:1024, style:'castle', features:[rect(158,323,181,349),rect(248,321,277,349),rect(469,622,508,702,'window','point'),rect(538,323,579,418,'door','point'),rect(583,323,625,418,'door','round')], roofs:[[339,307,482,386],[491,427,705,523],[680,544,1024,718],[872,718,1024,1007]] },
  'cherche_': { size:512, style:'castle', features:[rect(107,119,121,172,'window','round'),rect(137,256,151,288,'window','round'),rect(163,247,177,286,'window','round'),rect(187,256,201,288,'window','round'),rect(66,327,100,356,'window','round'),rect(48,416,114,511,'door','round')], roofs:[[179,13,511,129],[176,132,268,183],[73,39,151,68]] },
  'houses1_': { size:1024, style:'dutch', features:[...dutchRows(false),rect(158,489,207,523),rect(155,583,202,616),rect(507,498,555,532)], roofs:[[0,0,1024,210]] },
  'houses2_': { size:1024, style:'dutch', features:[...dutchRows(true),rect(164,488,201,530),rect(333,488,368,530),rect(512,499,548,540)], roofs:[[0,0,1024,210]] },
  'taj_main': { size:512, style:'mughal', features:[rect(40,45,124,169,'door','point'),rect(204,163,224,196,'window','point'),rect(204,205,224,236,'window','point'),rect(21,344,70,411,'door','point'),rect(19,419,72,489,'door','point')] },
  'taj_sten': { size:512, style:'mughal', features:[] },
  'front': { size:512, style:'gothic', features:[rect(95,124,119,212,'window','point'),rect(128,124,152,212,'window','point'),rect(277,132,297,214,'window','point'),rect(305,132,325,214,'window','point'),rect(105,314,121,347,'window','point'),rect(132,313,150,346,'window','point'),rect(294,316,310,344,'window','point'),rect(178,286,246,347,'rose'),rect(72,397,161,468,'door','point'),rect(174,393,262,488,'door','point'),rect(273,403,311,477,'door','point')] },
  'right': { size:512, style:'gothic', features:[] },
  'piramida': { size:1024, style:'maya', features:[] },
  'house': { size:1024, style:'maya', features:[] },
  'bungalo': { size:256, style:'timber', features:[] },
  '12345': { size:256, style:'kremlin', features:[rect(157,57,185,102,'door','point'),rect(28,211,63,255,'door','point'),rect(199,49,231,81,'clock')] },
  'brick mu': { size:256, style:'kremlin', features:[] },
  'wall1': { size:256, style:'industrial', features:[] },
  'tx4': { size:1024, style:'acropolis', features:[],wallKind:'limestone',clipRegions:true,wallRegions:[[60,103,974,218],[8,331,1016,448],[130,573,883,711],[14,843,1014,960]] },
  'безиме': { size:512, style:'kremlin', features:Array.from({length:12},(_,i)=>rect(20+i*14,173,30+i*14,194,'window','point')),wallKind:'brick',wallRegions:[[18,268,250,312],[45,414,265,452],[7,464,235,507],[370,390,440,420]] },
};

// Only genuinely blank masonry/plaster portions are resurfaced. Historic
// ornament, text, murals, openings and all skyline/photo cards remain intact.
for(const name of ['house1','house2'])Object.assign(ATLASES[name],{wallKind:'plaster',wallRegions:[[72,160,120,250],[143,160,243,250]]});
Object.assign(ATLASES.taj_main,{wallKind:'marble',wallRegions:[[160,0,470,82],[132,105,195,270],[235,105,467,270],[276,277,510,510]]});
Object.assign(ATLASES.taj_sten,{wallKind:'limestone',wallRegions:[[0,49,465,385],[474,0,511,511]]});
Object.assign(ATLASES.front,{wallKind:'limestone',wallRegions:[[373,0,511,511]]});
Object.assign(ATLASES.piramida,{wallKind:'mayan',wallRegions:[[270,0,683,715]]});
Object.assign(ATLASES.house,{wallKind:'mayan',wallRegions:[[0,0,730,610],[365,640,1023,1023]]});
// The cathedral bell slits are narrower than their carved stone surrounds.
ATLASES.front.features.splice(0,4,...[[104,140,116,208],[136,140,146,208],[281,144,293,208],[307,144,318,208]].map(r=>rect(...r,'window','point')));

// Replace the actual wall/roof islands, including triangles spanning an atlas
// boundary. Windows, doors, lettering and historic relief remain independent.
const surface=(kind,regions)=>({kind,regions});
ATLASES.bar.surfaceLayers=[surface('wood',[[100,35,238,245]]),surface('plaster',[[69,0,127,30],[241,0,255,255]])];
ATLASES.castle_f.surfaceLayers=[
  surface('limestone:weathered',[[0,0,1024,293],[0,415,370,1024],[0,530,435,1024],[0,725,865,1024],[440,530,589,615],[525,615,589,716],[145,310,226,372]]),
  surface('roof',[[341,310,480,384],[493,430,703,520],[682,570,1024,715],[874,720,1023,1005]])
];
ATLASES.cherche_.surfaceLayers=[surface('limestone',[[14,0,64,298],[88,91,130,197],[298,153,495,294],[15,318,153,511],[215,324,496,511]]),surface('roof',[[180,17,510,126],[180,135,270,180],[80,42,146,64]])];
for(const [name,paint]of [['houses1_','brick'],['houses2_','plaster:teal']]){
  ATLASES[name].surfaceLayers=[
    surface(paint,[[0,478,423,674],[80,420,436,478],[447,487,749,581],[578,582,750,675],[0,705,1024,833]]),
    surface('limestone',[[0,879,1024,1014]]),
    surface('roof',[[24,0,1024,190]]),
    surface(name==='houses1_'?'limestone:slate':'roof',[[0,222,246,405],[250,224,950,429],[766,483,1007,682]])
  ];
}
ATLASES.lenin={size:256,style:'kremlin',features:[],surfaceLayers:[surface('marble:red',[[0,27,158,256]]),surface('marble:dark',[[160,27,256,256]])]};
for(const config of Object.values(ATLASES)){
  if(config.wallRegions&&!config.surfaceLayers)config.surfaceLayers=[surface(config.wallKind,config.wallRegions)];
  if(config.surfaceLayers){config.clipRegions=true;config.preserveRegions=config.features.map(f=>{const[x0,y0,x1,y1]=f.rect;return[x0-3,y0-3,x1+3,y1+3];});}
}

function atlasName(spec = {}) {
  const path = (spec.originalMap || spec.map || '').replaceAll('\\','/').split('/').pop().toLowerCase();
  // The Kremlin original filename includes an old-codepage suffix.
  if (/^12345[^6]/.test(path)) return '12345';
  return path.replace(/\.[^.]+$/, '').replace(/-[a-f\d]{12}$/, '');
}

function owned(object) { object.userData.graphicsOwned = true; object.userData.collision = false; return object; }
function vector(raw, index) { return new THREE.Vector3().fromArray(raw, index * 3).multiplyScalar(SCALE); }
function uvPoint(mesh, index, spec) {
  const uv = new THREE.Vector2().fromArray(mesh.uv, index*2);
  // This matches Assets.texture(), including an atlas's original transform.
  const scale = spec.uvScale || [1,1], offset = spec.uvOffset || [0,0], angle = spec.uvRotation || 0;
  return new THREE.Vector2(scale[0]*(Math.cos(angle)*uv.x+Math.sin(angle)*uv.y)+offset[0],scale[1]*(-Math.sin(angle)*uv.x+Math.cos(angle)*uv.y)+offset[1]);
}
function inside(point, triangle, tolerance = 1e-5) {
  const [a,b,c] = triangle;
  const v0x=b.x-a.x,v0y=b.y-a.y,v1x=c.x-a.x,v1y=c.y-a.y,v2x=point.x-a.x,v2y=point.y-a.y;
  const det=v0x*v1y-v1x*v0y;if(Math.abs(det)<1e-12)return false;
  const s=(v2x*v1y-v1x*v2y)/det,t=(v0x*v2y-v2x*v0y)/det;
  return s>=-tolerance&&t>=-tolerance&&s+t<=1+tolerance;
}
const rounded = vector => vector.toArray().map(n=>Math.round(n*40)).join(',');

/** Coplanar pieces with the SAME UV-to-world transform. Opposite sides and
 * separately tiled windows cannot accidentally share an atlas placement. */
export function extractArchitectureFaces(mesh, material, spec) {
  if (!mesh.uv?.length) return [];
  const faces = new Map();
  for (const group of mesh.groups || []) {
    if (group.material !== material) continue;
    for (let at=group.start; at<group.start+group.count; at+=3) {
      const ids=mesh.indices.slice(at,at+3),p=ids.map(i=>vector(mesh.vertices,i)),uv=ids.map(i=>uvPoint(mesh,i,spec));
      const e1=p[1].clone().sub(p[0]),e2=p[2].clone().sub(p[0]),a=uv[1].clone().sub(uv[0]),b=uv[2].clone().sub(uv[0]);
      const determinant=a.x*b.y-b.x*a.y;if(Math.abs(determinant)<1e-9)continue;
      const U=e1.clone().multiplyScalar(b.y).addScaledVector(e2,-a.y).divideScalar(determinant);
      const V=e2.clone().multiplyScalar(a.x).addScaledVector(e1,-b.x).divideScalar(determinant);
      const origin=p[0].clone().addScaledVector(U,-uv[0].x).addScaledVector(V,-uv[0].y);
      const normal=e1.clone().cross(e2).normalize();if(normal.lengthSq()<.9)continue;
      const key=[rounded(U),rounded(V),rounded(origin),rounded(normal)].join('|');
      let face=faces.get(key);if(!face){face={U,V,origin,normal,triangles:[],points:[],meshName:mesh.name,material,area:0,uvMin:new THREE.Vector2(Infinity,Infinity),uvMax:new THREE.Vector2(-Infinity,-Infinity)};faces.set(key,face);}
      face.triangles.push(uv);face.points.push(...p);face.area+=e1.cross(e2).length()/2;
      for(const t of uv){face.uvMin.min(t);face.uvMax.max(t);}
    }
  }
  return [...faces.values()];
}
function projected(face,u,v) { return face.origin.clone().addScaledVector(face.U,u).addScaledVector(face.V,v); }
function covered(face,u,v) { const p=new THREE.Vector2(u,v);return face.triangles.some(t=>inside(p,t)); }

/** Only place full features supported by the original facade. This rejects
 * atlas photographs on narrow unrelated fragments and the holes of open doors. */
export function projectAtlasFeature(face, feature, size, shiftU=0, shiftV=0) {
  const [x0,y0,x1,y1]=feature.rect,u0=x0/size+shiftU,u1=x1/size+shiftU,v0=1-y1/size+shiftV,v1=1-y0/size+shiftV;
  const samples=[[.5,.5],[.08,.08],[.92,.08],[.08,.92],[.92,.92],[.5,.08],[.5,.92]];
  if(!samples.every(([s,t])=>covered(face,u0+(u1-u0)*s,v0+(v1-v0)*t)))return null;
  let right=face.U.clone().normalize(),up=face.V.clone().normalize();
  const width=face.U.length()*(u1-u0),height=face.V.length()*(v1-v0);
  if(width<.22||height<.24||width>18||height>24||Math.abs(up.y)<.91||Math.abs(right.y)>.15||Math.abs(right.dot(up))>.15||Math.abs(face.normal.y)>.25)return null;
  if(up.y<0)up.negate();let normal=right.clone().cross(up).normalize();
  if(normal.dot(face.normal)<0){right.negate();normal.negate();}
  const center=projected(face,(u0+u1)/2,(v0+v1)/2);
  return {center,right,up,normal,width,height,sourceMesh:face.meshName,sourceMaterial:face.material,type:feature.type,style:feature.style};
}

function columnGeometry() {
  const positions=[],indices=[],uv=[];
  // Molded plinth, torus, tapered shaft with 16 real flutes, echinus and abacus.
  const rings=[[0,.5],[.018,.5],[.022,.455],[.04,.455],[.048,.405],[.07,.385],[.88,.34],[.905,.355],[.925,.405],[.945,.47],[.96,.5],[1,.5]];
  const segments=64;
  for(let row=0;row<rings.length;row++)for(let i=0;i<=segments;i++){
    const theta=i/segments*Math.PI*2,[height,base]=rings[row];
    const flute=row>=5&&row<=6 ? .028*(.5+.5*Math.cos(theta*16)) : 0;
    positions.push(Math.cos(theta)*(base-flute),height,Math.sin(theta)*(base-flute));uv.push(i/segments,height);
    if(row<rings.length-1&&i<segments){const a=row*(segments+1)+i,b=a+segments+1;indices.push(a,b,a+1,a+1,b,b+1);}
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));geometry.setIndex(indices);geometry.computeVertexNormals();return geometry;
}

/** Finds actual isolated cylinders in the original topology. Broken ruins,
 * wall strips, square pillars and the temple's other triangles are retained. */
export function findSourceColumns(mesh, material) {
  const parent=new Map(),find=i=>{let p=parent.get(i);if(p===undefined){parent.set(i,i);return i;}if(p!==i){p=find(p);parent.set(i,p);}return p;};
  const union=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent.set(b,a);};
  const starts=[];
  for(const g of mesh.groups||[])if(g.material===material)for(let at=g.start;at<g.start+g.count;at+=3){const[a,b,c]=mesh.indices.slice(at,at+3);union(a,b);union(a,c);starts.push(at);}
  const components=new Map();for(const at of starts){const key=find(mesh.indices[at]);let c=components.get(key);if(!c){c={vertices:new Set(),starts:[]};components.set(key,c);}c.starts.push(at);for(let k=0;k<3;k++)c.vertices.add(mesh.indices[at+k]);}
  const columns=[];
  for(const c of components.values()){
    if(c.vertices.size<24||c.vertices.size>100)continue;
    const box=new THREE.Box3(),points=[...c.vertices].map(i=>vector(mesh.vertices,i));points.forEach(p=>box.expandByPoint(p));
    const size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
    if(size.y<3||size.y>23||size.x<.4||size.z<.4||size.x/size.z<.88||size.x/size.z>1.14||size.y/Math.max(size.x,size.z)<3.2)continue;
    const radial=points.map(p=>Math.hypot(p.x-center.x,p.z-center.z)).filter(r=>r>Math.min(size.x,size.z)*.28);
    const avg=radial.reduce((s,r)=>s+r,0)/radial.length,variance=radial.reduce((s,r)=>s+(r-avg)**2,0)/radial.length;
    const angles=new Set(points.filter(p=>Math.hypot(p.x-center.x,p.z-center.z)>avg*.6).map(p=>Math.round(Math.atan2(p.z-center.z,p.x-center.x)*30)));
    if(angles.size<10||Math.sqrt(variance)/avg>.12)continue;
    columns.push({center:new THREE.Vector3(center.x,box.min.y,center.z),size,starts:c.starts,sourceMesh:mesh.name});
  }
  return columns;
}

class Batches {
  constructor(library) { this.library=library;this.materials=new Map();this.geometries=new Map();this.batches=new Map();this.instances=0; }
  material(kind) {
    if(this.materials.has(kind))return this.materials.get(kind);
    let m;
    if(kind==='glass')m=new THREE.MeshStandardMaterial({color:0x213b42,roughness:.16,metalness:.48,envMapIntensity:.8});
    else if(kind==='iron')m=new THREE.MeshStandardMaterial({color:0x343938,roughness:.37,metalness:.75});
    else if(kind==='gold')m=new THREE.MeshStandardMaterial({color:0xc7a45a,roughness:.32,metalness:.72});
    else {
      const [base,variant]=kind.split(':'),palette={weathered:0xa5a89a,slate:0x68727a,teal:0x78a79c,red:0x914a40,dark:0x3d2625};
      const color=palette[variant]??(kind==='mayan'?0x8b8b7c:0xffffff);
      m=this.library?.createKind?.(base==='mayan'?'limestone':base,{normalStrength:kind==='mayan'?.5:.26,tileMeters:base==='wood'?1.8:base==='brick'?.85:2,color})||new THREE.MeshStandardMaterial({color:variant?color:kind==='roof'?0xa75c3a:kind==='wood'?0x72583c:kind==='mayan'?0x8b8b7c:0xc9c3ad,roughness:.78});
    }
    m.userData.graphicsOwned=true;this.materials.set(kind,m);return m;
  }
  geometry(kind) {
    if(this.geometries.has(kind))return this.geometries.get(kind);
    let g;if(kind==='column')g=columnGeometry();
    else if(kind==='rod')g=new THREE.CylinderGeometry(.5,.5,1,8);
    else if(kind==='tile'){g=new THREE.CylinderGeometry(.5,.5,1,6,1,true,0,Math.PI);g.rotateY(-Math.PI/2);}
    else g=new THREE.BoxGeometry(1,1,1);
    g.computeBoundingBox();g.computeBoundingSphere();this.geometries.set(kind,g);return g;
  }
  add(shape,kind,position,right,up,normal,size) {
    if(size.some(n=>!Number.isFinite(n)||n<=0))return;
    const key=shape+':'+kind;let b=this.batches.get(key);if(!b){b={shape,kind,matrices:[]};this.batches.set(key,b);}
    const matrix=new THREE.Matrix4().makeBasis(right,up,normal);matrix.scale(new THREE.Vector3(...size));matrix.setPosition(position);b.matrices.push(matrix);this.instances++;
  }
  box(kind,p,basis,size) { this.add('box',kind,p,basis.right,basis.up,basis.normal,size); }
  line(kind,a,b,depth,basis) {
    const delta=b.clone().sub(a),length=delta.length();if(length<1e-4)return;
    const up=delta.divideScalar(length),right=up.clone().cross(basis.normal).normalize();
    this.add('box',kind,a.clone().add(b).multiplyScalar(.5),right,up,basis.normal,[depth,length,depth]);
  }
  finish() {
    const group=owned(new THREE.Group());group.name='Reconstructed architecture';
    let triangles=0;
    for(const {shape,kind,matrices} of this.batches.values()){
      const geometry=this.geometry(shape),batch=owned(new THREE.InstancedMesh(geometry,this.material(kind),matrices.length));batch.name=`architecture:${shape}:${kind}`;
      matrices.forEach((m,i)=>batch.setMatrixAt(i,m));batch.instanceMatrix.needsUpdate=true;batch.castShadow=kind!=='glass';batch.receiveShadow=true;batch.computeBoundingSphere();batch.computeBoundingBox();group.add(batch);
      triangles+=(geometry.index?.count||geometry.attributes.position.count)/3*matrices.length;
    }
    return {group,materials:[...this.materials.values()],geometries:[...this.geometries.values()],triangles,drawCalls:group.children.length};
  }
}

function local(feature,x,y,z) { return feature.center.clone().addScaledVector(feature.right,x).addScaledVector(feature.up,y).addScaledVector(feature.normal,z); }
function decoration(batches,f,style) {
  const {width:w,height:h}=f,kind=style==='timber'?'wood':style==='mughal'?'marble':'limestone';
  const border=Math.max(.035,Math.min(.14,w*.055,h*.045)),depth=Math.min(.19,border*1.6);
  const box=(material,x,y,z,sx,sy,sz)=>batches.box(material,local(f,x,y,z),f,[sx,sy,sz]);
  if(f.type==='clock'||f.type==='rose'){
    const r=Math.min(w,h)*.49,segments=f.type==='rose'?32:24;
    for(let i=0;i<segments;i++){
      const a=i/segments*Math.PI*2,b=(i+1)/segments*Math.PI*2;
      batches.line(f.type==='clock'?'gold':kind,local(f,Math.cos(a)*r,Math.sin(a)*r,depth),local(f,Math.cos(b)*r,Math.sin(b)*r,depth),border,f);
    }
    if(f.type==='rose')for(let i=0;i<12;i++){const a=i/12*Math.PI*2;batches.line(kind,local(f,Math.cos(a)*r*.17,Math.sin(a)*r*.17,depth),local(f,Math.cos(a)*r*.92,Math.sin(a)*r*.92,depth),border*.55,f);}
    // Original stained glass / clock dial remains visible through the geometry.
    return;
  }
  const arched=f.style==='round'||f.style==='point',rise=arched?Math.min(w*.5,h*.36):0,spring=h*.5-rise;
  box(kind,-w*.5,-rise*.5,depth*.5,border,h-rise,depth);
  box(kind,w*.5,-rise*.5,depth*.5,border,h-rise,depth);
  if(arched){
    const points=[];for(let i=0;i<=16;i++){const t=i/16,x=(t-.5)*w,y=spring+rise*(f.style==='point'?1-Math.abs(2*t-1):Math.sqrt(Math.max(0,1-(2*t-1)**2)));points.push(local(f,x,y,depth*.5));}
    for(let i=1;i<points.length;i++)batches.line(kind,points[i-1],points[i],border,f);
  }else box(kind,0,h*.5,depth*.5,w+border,border,depth);
  if(f.type==='door')return; // An opening gets a surround, never an opaque slab.
  box(kind,0,-h*.5-border*.28,depth*.65,w+border*2,border*1.2,depth*1.6);
  // Only the rectangular body receives glass; the atlas keeps its arched head.
  box('glass',0,-rise*.5,.018,Math.max(.03,w-border),Math.max(.03,h-rise-border),.018);
  const sashKind=['coastal','dutch','timber'].includes(style)?'wood':'iron',sash=Math.max(.018,border*.36);
  box(sashKind,0,-rise*.5,depth*.55,sash,h-rise,depth*.38);
  if(h<4.5)box(sashKind,0,-h*.1,depth*.55,w,sash,depth*.38);
  if(style==='dutch'||style==='coastal')box(kind,0,h*.5+border*.7,depth*.7,w+border*3,border*.65,depth*1.7);
}

function addFaceCornice(batches,face,style,dedup) {
  if(Math.abs(face.normal.y)>.12||face.area<1.5)return 0;
  const box=new THREE.Box3().setFromPoints(face.points),size=box.getSize(new THREE.Vector3());
  if(size.y<1.3||size.y>28)return 0;
  // A real horizontal top edge on a facade, not a bounding-box invented ledge.
  let count=0;
  for(let i=0;i<face.points.length;i+=3)for(const[a,b]of [[0,1],[1,2],[2,0]]){
    const p=face.points[i+a],q=face.points[i+b],length=p.distanceTo(q);
    if(Math.abs(p.y-q.y)>.025||Math.abs(p.y-box.max.y)>.03||length<1.8||length>48)continue;
    const key=[...p.toArray(),...q.toArray()].map(v=>Math.round(v*20)).join(',');const reverse=[...q.toArray(),...p.toArray()].map(v=>Math.round(v*20)).join(',');if(dedup.has(key)||dedup.has(reverse))continue;dedup.add(key);
    const right=q.clone().sub(p).normalize(),normal=right.clone().cross(UP).normalize();if(normal.dot(face.normal)<0)right.negate();normal.copy(right).cross(UP);
    const center=p.clone().add(q).multiplyScalar(.5).addScaledVector(normal,.018);center.y-=.04;
    const kind=style==='timber'?'wood':style==='mughal'?'marble':'limestone';
    batches.box(kind,center,{right,up:UP,normal},[length,.09,.1]);count++;
    if(style==='maya'||style==='castle'||style==='gothic'){const c=center.clone();c.y-=.11;batches.box(kind,c,{right,up:UP,normal},[length,.055,.065]);}
  }
  return count;
}

function addRoofTiles(batches,face,config,budget) {
  if(!config.roofs||Math.abs(face.normal.y)<.22||Math.abs(face.normal.y)>.94||face.area<1)return 0;
  const lu=face.U.length(),lv=face.V.length();if(lu<.1||lv<.1||Math.abs(face.U.dot(face.V)/(lu*lv))>.12)return 0;
  const right=face.U.clone().normalize(),up=face.V.clone().normalize(),normal=right.clone().cross(up);if(normal.y<0){right.negate();normal.negate();}
  // Roof geometry spacing is world-sized, independent of the atlas resolution.
  const stepU=.42/lu,stepV=.62/lv;
  let count=0;
  for(const [x0,y0,x1,y1]of config.roofs){
    const minU=Math.max(x0/config.size,face.uvMin.x),maxU=Math.min(x1/config.size,face.uvMax.x),minV=Math.max(1-y1/config.size,face.uvMin.y),maxV=Math.min(1-y0/config.size,face.uvMax.y);
    if((maxU-minU)/stepU>300||(maxV-minV)/stepV>300)continue;
    for(let v=minV+stepV*.5;v<maxV-stepV*.25&&count<budget;v+=stepV)for(let u=minU+stepU*.5;u<maxU-stepU*.25&&count<budget;u+=stepU){
      if(![[0,0],[-.48,-.48],[.48,-.48],[-.48,.48],[.48,.48]].every(([a,b])=>covered(face,u+stepU*a,v+stepV*b)))continue;
      const p=projected(face,u,v).addScaledVector(normal,.012);
      batches.add('tile',config.style==='timber'?'wood':'roof',p,right,up,normal,[.405,.61,.065]);count++;
    }
  }
  return count;
}

function markRemoved(removed,mesh,at) { let set=removed.get(mesh);if(!set){set=new Set();removed.set(mesh,set);}set.add(at); }

function splitUVPolygon(polygon,axis,value,greater) {
  const inside=[],outside=[];
  const signed=p=>(p.uv.getComponent(axis)-value)*(greater?1:-1);
  for(let i=0;i<polygon.length;i++){
    const a=polygon[i],b=polygon[(i+1)%polygon.length],da=signed(a),db=signed(b),aIn=da>=-1e-10,bIn=db>=-1e-10;
    (aIn?inside:outside).push(a);
    if(aIn!==bIn){const t=da/(da-db),point={p:a.p.clone().lerp(b.p,t),uv:a.uv.clone().lerp(b.uv,t),rawUV:a.rawUV.clone().lerp(b.rawUV,t),normal:a.normal.clone().lerp(b.normal,t).normalize()};inside.push(point);outside.push(point);}
  }
  return {inside,outside};
}

/** Geometric UV clipping preserves a narrow bas-relief or stair strip even
 * when it shares one large original triangle with blank masonry. */
export function clipTriangleToAtlasRegions(vertices,regions,size=1024) {
  let remaining=[vertices],selected=[];
  for(const [x0,y0,x1,y1]of regions){
    const next=[];
    for(const polygon of remaining){let candidate=polygon;
      for(const[axis,value,greater]of [[0,x0/size,true],[0,x1/size,false],[1,1-y1/size,true],[1,1-y0/size,false]]){
        if(candidate.length<3)break;
        const part=splitUVPolygon(candidate,axis,value,greater);if(part.outside.length>=3)next.push(part.outside);candidate=part.inside;
      }
      if(candidate.length>=3)selected.push(candidate);
    }
    remaining=next;
  }
  const triangles=polygons=>polygons.flatMap(p=>{const result=[];for(let i=1;i<p.length-1;i++)if(p[i].p.clone().sub(p[0].p).cross(p[i+1].p.clone().sub(p[0].p)).lengthSq()>1e-14)result.push([p[0],p[i],p[i+1]]);return result;});
  return {selected:triangles(selected),remaining:triangles(remaining)};
}

function resurfaceClippedAtlas(mesh,material,spec,config,surfaces,removed,fragments) {
  if(!mesh.uv?.length)return {triangles:0,sourceTriangles:0};
  const fragment={name:mesh.name+':retained-relief',vertices:[],normals:[],uv:[],indices:[],groups:[]};
  let triangles=0,sourceTriangles=0;
  for(const group of mesh.groups||[])if(group.material===material)for(let at=group.start;at<group.start+group.count;at+=3){
    const ids=mesh.indices.slice(at,at+3),points=ids.map(i=>vector(mesh.vertices,i)),faceNormal=points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).normalize();
    const vertices=ids.map((index,k)=>({p:points[k],uv:uvPoint(mesh,index,spec),rawUV:new THREE.Vector2().fromArray(mesh.uv,index*2),normal:mesh.normals?.length===mesh.vertices.length?new THREE.Vector3().fromArray(mesh.normals,index*3).normalize():faceNormal}));
    let remaining=[vertices],replaced=0;
    for(const layer of config.surfaceLayers||[{kind:config.wallKind,regions:config.wallRegions}]){
      const selected=[],next=[];
      for(const triangle of remaining){
        const pieces=clipTriangleToAtlasRegions(triangle,layer.regions,config.size);next.push(...pieces.remaining);
        for(const part of pieces.selected){
          if(config.preserveRegions?.length){const art=clipTriangleToAtlasRegions(part,config.preserveRegions,config.size);next.push(...art.selected);selected.push(...art.remaining);}
          else selected.push(part);
        }
      }
      if(selected.length){
        let surface=surfaces.get(layer.kind);if(!surface){surface={positions:[],normals:[]};surfaces.set(layer.kind,surface);}
        for(const triangle of selected)for(const v of triangle){surface.positions.push(...v.p.toArray());surface.normals.push(...v.normal.toArray());}
        replaced+=selected.length;
      }
      remaining=next;
    }
    if(!replaced)continue;
    markRemoved(removed,mesh,at);sourceTriangles++;triangles+=replaced;
    for(const triangle of remaining)for(const v of triangle){fragment.indices.push(fragment.indices.length);fragment.vertices.push(...v.p.clone().divideScalar(SCALE).toArray());fragment.normals.push(...v.normal.toArray());fragment.uv.push(...v.rawUV.toArray());}
  }
  if(fragment.indices.length){fragment.groups=[{start:0,count:fragment.indices.length,material}];fragments.push(fragment);}
  return {triangles,sourceTriangles};
}

function resurfaceBlankAtlas(mesh,material,spec,config,surfaces,removed) {
  if(!config.wallRegions||!mesh.uv?.length)return 0;
  let count=0;
  for(const group of mesh.groups||[])if(group.material===material)for(let at=group.start;at<group.start+group.count;at+=3){
    const ids=mesh.indices.slice(at,at+3),uv=ids.map(i=>uvPoint(mesh,i,spec));
    const shiftU=Math.floor(uv.reduce((sum,p)=>sum+p.x,0)/3),shiftV=Math.floor(uv.reduce((sum,p)=>sum+p.y,0)/3);
    const fits=config.wallRegions.some(([x0,y0,x1,y1])=>uv.every(p=>p.x-shiftU>=x0/config.size-.00001&&p.x-shiftU<=x1/config.size+.00001&&1-p.y+shiftV>=y0/config.size-.00001&&1-p.y+shiftV<=y1/config.size+.00001));
    if(!fits)continue;
    const p=ids.map(i=>vector(mesh.vertices,i)),normal=p[1].clone().sub(p[0]).cross(p[2].clone().sub(p[0])).normalize();
    let surface=surfaces.get(config.wallKind);if(!surface){surface={positions:[],normals:[]};surfaces.set(config.wallKind,surface);}
    for(let k=0;k<3;k++){surface.positions.push(...p[k].toArray());surface.normals.push(...(mesh.normals?.length===mesh.vertices.length?new THREE.Vector3().fromArray(mesh.normals,ids[k]*3).normalize():normal).toArray());}
    markRemoved(removed,mesh,at);count++;
  }
  return count;
}

/** Ornament the existing three-dimensional reveal edges where the atlas itself
 * has holes. This follows the source opening's tessellation, not a guessed
 * rectangular pane across a traversable doorway. */
function addOpeningRelief(batches,faces,config,dedup) {
  if(!['mughal','gothic','kremlin'].includes(config.style)||!config.features.length)return 0;
  const edges=new Map();
  for(const face of faces){if(Math.abs(face.normal.y)>.25)continue;
    for(let i=0;i<face.triangles.length;i++)for(const[a,b]of [[0,1],[1,2],[2,0]]){
      const p=face.points[i*3+a],q=face.points[i*3+b],uvA=face.triangles[i][a],uvB=face.triangles[i][b];
      const pa=p.toArray().map(n=>Math.round(n*1000)).join(','),pb=q.toArray().map(n=>Math.round(n*1000)).join(','),key=pa<pb?pa+'|'+pb:pb+'|'+pa;
      let edge=edges.get(key);if(!edge){edge={p,q,uvA,uvB,face,normals:[]};edges.set(key,edge);}edge.normals.push(face.normal);
    }
  }
  let count=0;
  for(const[key,e]of edges){
    if(dedup.has(key))continue;
    if(e.normals.length>1&&e.normals.every(n=>Math.abs(n.dot(e.normals[0]))>.997))continue;
    const length=e.p.distanceTo(e.q);if(length<.10||length>12)continue;
    const mid=e.uvA.clone().add(e.uvB).multiplyScalar(.5),u=mid.x-Math.floor(mid.x),v=1-(mid.y-Math.floor(mid.y));
    const match=config.features.find(f=>{const[x0,y0,x1,y1]=f.rect;return u>=(x0-4)/config.size&&u<=(x1+4)/config.size&&v>=(y0-4)/config.size&&v<=(y1+4)/config.size;});
    if(!match)continue;
    const featureWidth=e.face.U.length()*(match.rect[2]-match.rect[0])/config.size;
    const featureHeight=e.face.V.length()*(match.rect[3]-match.rect[1])/config.size;
    if(featureWidth<.35||featureWidth>22||featureHeight>30||length>Math.max(featureWidth,featureHeight)*1.08)continue;
    const normal=e.face.normal,p=e.p.clone().addScaledVector(normal,.032),q=e.q.clone().addScaledVector(normal,.032);
    batches.line(config.style==='mughal'?'marble':match.type==='clock'?'gold':'limestone',p,q,Math.max(.035,Math.min(.10,featureWidth*.025)),{normal});dedup.add(key);count++;
    if(count>=1200)break;
  }
  return count;
}

/** Returns an independent visual layer. Original colliders, atlas textures,
 * geometry and visibility are untouched. retainedMeshes uses the same raw JSON
 * convention as buildEnhancedBoats, for the caller to rebatch hidden materials. */
export function buildEnhancedArchitecture({modelData,world,library,levelId=1}) {
  const batches=new Batches(library),hiddenMaterialNames=new Set(),retainedMeshes=[],removed=new Map();
  const stats={levelId,windows:0,doors:0,roseWindows:0,clocks:0,columns:0,cornices:0,roofTiles:0,openingRelief:0,resurfacedTriangles:0,clippedSourceTriangles:0,facades:0,instances:0,drawCalls:0,triangles:0,sourceMeshes:[]};
  const featureKeys=new Set(),corniceKeys=new Set(),reliefKeys=new Set(),sourceMeshes=new Set(),surfaces=new Map();
  for(const mesh of modelData.meshes||[]){
    for(const material of new Set((mesh.groups||[]).map(g=>g.material))){
      const spec=modelData.materials[material];if(!spec)continue;const name=atlasName(spec),config=ATLASES[name];
      // Two classical temples use whole isolated original cylinders; rebuilding
      // these is safe, whereas isolated ruined-column fragments stay original.
      if(Number(levelId)===3&&['tx1','tx2'].includes(name)){
        for(const column of findSourceColumns(mesh,material)){
          batches.add('column',name==='tx1'?'limestone':'marble',column.center,new THREE.Vector3(1,0,0),UP,new THREE.Vector3(0,0,1),column.size.toArray());
          let indices=removed.get(mesh);if(!indices){indices=new Set();removed.set(mesh,indices);}column.starts.forEach(i=>indices.add(i));hiddenMaterialNames.add(material);stats.columns++;sourceMeshes.add(mesh.name);
        }
      }
      if(!config)continue;
      const faces=extractArchitectureFaces(mesh,material,spec);stats.facades+=faces.length;
      const clipped=config.clipRegions?resurfaceClippedAtlas(mesh,material,spec,config,surfaces,removed,retainedMeshes):null;
      const resurfaced=clipped?clipped.triangles:resurfaceBlankAtlas(mesh,material,spec,config,surfaces,removed);stats.clippedSourceTriangles+=clipped?.sourceTriangles||0;
      if(resurfaced){hiddenMaterialNames.add(material);stats.resurfacedTriangles+=resurfaced;sourceMeshes.add(mesh.name);}
      const relief=addOpeningRelief(batches,faces,config,reliefKeys);stats.openingRelief+=relief;if(relief)sourceMeshes.add(mesh.name);
      for(const face of faces){
        const tiles=stats.roofTiles<MAX_TILES?addRoofTiles(batches,face,config,MAX_TILES-stats.roofTiles):0;stats.roofTiles+=tiles;
        const cornices=addFaceCornice(batches,face,config.style,corniceKeys);stats.cornices+=cornices;if(tiles||cornices)sourceMeshes.add(mesh.name);
        if(featureKeys.size>=MAX_FEATURES)continue;
        for(const feature of config.features){
          // Repeat wrapping is supported only for actual repeated atlas tiles.
          const minU=Math.max(-2,Math.floor(face.uvMin.x)),maxU=Math.min(3,Math.ceil(face.uvMax.x));
          const minV=Math.max(-2,Math.floor(face.uvMin.y)),maxV=Math.min(3,Math.ceil(face.uvMax.y));
          for(let u=minU;u<maxU;u++)for(let v=minV;v<maxV;v++){
            const placement=projectAtlasFeature(face,feature,config.size,u,v);if(!placement)continue;
            const key=rounded(placement.center)+'|'+rounded(placement.normal)+'|'+feature.type;
            if(featureKeys.has(key))continue;featureKeys.add(key);decoration(batches,placement,config.style);sourceMeshes.add(mesh.name);
            if(feature.type==='door')stats.doors++;else if(feature.type==='rose')stats.roseWindows++;else if(feature.type==='clock')stats.clocks++;else stats.windows++;
          }
        }
      }
    }
  }
  // Preserve EVERY other triangle in a hidden source material, including other
  // source objects sharing the same texture. Borrow raw arrays without mutation.
  for(const mesh of modelData.meshes||[]){
    const indices=[],groups=[],excluded=removed.get(mesh);
    for(const g of mesh.groups||[]){if(!hiddenMaterialNames.has(g.material))continue;const start=indices.length;
      for(let at=g.start;at<g.start+g.count;at+=3)if(!excluded?.has(at))indices.push(...mesh.indices.slice(at,at+3));
      if(indices.length>start)groups.push({start,count:indices.length-start,material:g.material});
    }
    if(indices.length)retainedMeshes.push({...mesh,indices,groups});
  }
  const result=batches.finish();
  for(const[kind,surface]of surfaces){
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(surface.positions,3));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(surface.normals,3));geometry.computeBoundingBox();geometry.computeBoundingSphere();
    const material=batches.material(kind),mesh=owned(new THREE.Mesh(geometry,material));mesh.name='architecture:masonry:'+kind;mesh.castShadow=true;mesh.receiveShadow=true;result.group.add(mesh);result.geometries.push(geometry);if(!result.materials.includes(material))result.materials.push(material);result.triangles+=surface.positions.length/9;
  }
  Object.assign(stats,{instances:batches.instances,drawCalls:result.group.children.length,triangles:result.triangles,sourceMeshes:[...sourceMeshes]});
  result.group.userData.architectureStats=stats;
  return {...result,hiddenMaterialNames,retainedMeshes,stats};
}
