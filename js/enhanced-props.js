import * as THREE from 'three';
import {mergeGeometries} from '../vendor/addons/utils/BufferGeometryUtils.js?v=20261109-10';

/** Source meshes remain untouched: these are visual replacements in metres. */
export function meshPlacement(mesh, scale=.01) {
  const box=new THREE.Box3(), p=new THREE.Vector3();let xx=0,zz=0,xz=0;
  for(let i=0;i<mesh.vertices.length;i+=3)box.expandByPoint(p.fromArray(mesh.vertices,i).multiplyScalar(scale));
  const center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3());
  for(let i=0;i<mesh.vertices.length;i+=3){const x=mesh.vertices[i]*scale-center.x,z=mesh.vertices[i+2]*scale-center.z;xx+=x*x;zz+=z*z;xz+=x*z;}
  const angle=.5*Math.atan2(2*xz,xx-zz), yaw=Math.PI/2-angle;
  let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for(let i=0;i<mesh.vertices.length;i+=3){p.fromArray(mesh.vertices,i).multiplyScalar(scale).sub(center).applyAxisAngle(new THREE.Vector3(0,1,0),-yaw);minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minZ=Math.min(minZ,p.z);maxZ=Math.max(maxZ,p.z);}
  return {position:new THREE.Vector3(center.x,box.min.y,center.z),size,yaw,width:maxX-minX,length:maxZ-minZ,box};
}

/** Recover the axes of the authored obstacle before fitting a replacement. */
export function solidPropPlacement(mesh, kind) {
  const points = [];
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    points.push(new THREE.Vector3().fromArray(mesh.vertices, i).multiplyScalar(.01));
  }
  const axes = [], normal = new THREE.Vector3(), edge = new THREE.Vector3();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = points[mesh.indices[i]], b = points[mesh.indices[i + 1]], c = points[mesh.indices[i + 2]];
    normal.subVectors(b, a).cross(edge.subVectors(c, a));
    const area = normal.length();
    if (area < 1e-6) continue;
    normal.divideScalar(area);
    const axis = axes.find(({ direction }) => Math.abs(direction.dot(normal)) > .99995);
    if (axis) axis.area += area;
    else axes.push({ direction: normal.clone(), area });
  }

  const up = new THREE.Vector3(0, 1, 0);
  const orientation = new THREE.Quaternion();
  if (kind === 'crate') {
    if (axes.length !== 3) return null;
    const [y, x, z] = axes.map(axis => axis.direction).sort((a, b) => Math.abs(b.y) - Math.abs(a.y));
    if (Math.max(Math.abs(x.dot(y)), Math.abs(z.dot(y)), Math.abs(x.dot(z))) > .01) return null;
    if (y.y < 0) y.negate();
    if (x.x < 0) x.negate();
    z.crossVectors(x, y).normalize();
    x.crossVectors(y, z);
    orientation.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  } else {
    axes.sort((a, b) => b.area - a.area);
    // A barrel's two parallel end caps share one normal and dominate its side faces.
    if (axes.length < 4 || axes[0].area < axes[1].area * 1.5) return null;
    const axis = axes[0].direction;
    if (axis.y < 0) axis.negate();
    orientation.setFromUnitVectors(up, axis);
  }

  const inverse = orientation.clone().invert(), box = new THREE.Box3().setFromPoints(points);
  for (const point of points) point.applyQuaternion(inverse);
  const bounds = new THREE.Box3().setFromPoints(points);
  const size = bounds.getSize(new THREE.Vector3());
  if (Math.min(size.x, size.y, size.z) < .01) return null;
  if (kind === 'crate') {
    // BOX.JPG also paints groups of objects and irregular debris. Keep their
    // source geometry unless its vertices define all eight corners of a box.
    const corners = new Set();
    for (const point of points) {
      let corner = 0;
      for (const [bit, axis] of ['x', 'y', 'z'].entries()) {
        if (Math.abs(point[axis] - bounds.max[axis]) < .015) corner |= 1 << bit;
        else if (Math.abs(point[axis] - bounds.min[axis]) >= .015) return null;
      }
      corners.add(corner);
    }
    if (corners.size !== 8) return null;
  }
  const position = bounds.getCenter(new THREE.Vector3());
  position.y = bounds.min.y;
  return { position: position.applyQuaternion(orientation), size, orientation, box };
}

function sourceKind(name) {
  name=String(name).toLowerCase();
  if(/^lejak2?\.jpg$/.test(name))return 'lounger';
  if(/^zont\d?\.jpg$/.test(name))return 'parasol';
  if(name==='box.jpg')return 'crate';
  if(/бочка.*\.jpg/.test(name))return 'barrel';
  if(name==='table.jpg'||name==='big_tabl.jpg')return 'table';
  return null;
}

/** Atlases are reused on unrelated meshes: inspect shape before substituting.
 * In particular BOX.JPG also paints towers, beams and large route platforms. */
export function classifyProp(mesh,modelData){
  if(mesh.groups?.length!==1)return null;
  const name=String(modelData.materials[mesh.groups[0].material]?.originalMap||'').replaceAll('\\','/').split('/').at(-1).toLowerCase();
  const candidate=sourceKind(name);if(!candidate)return null;
  const p=meshPlacement(mesh),s=p.size,min=Math.min(s.x,s.z),max=Math.max(s.x,s.z);
  if(candidate==='crate')return min>=.45&&max<=3.5&&s.y>=.4&&s.y<=3&&Math.max(max,s.y)/Math.min(min,s.y)<3.3?'crate':null;
  if(candidate==='barrel')return min>=.4&&max<=2.5&&s.y>=.4&&s.y<=2.8?'barrel':null;
  if(candidate==='lounger'){
    if(max<1.5&&s.y>.55&&s.y<1.7)return 'chair';
    return p.length>1.5&&max>1.5&&max<5&&s.y<2.5?'lounger':null;
  }
  if(candidate==='table'){
    if(name==='table.jpg'&&max<.95&&s.y>.65&&s.y<1.5)return 'chair';
    return min>.8&&max<2.8&&max/min<1.4&&s.y>=.6&&s.y<1.65?'table':null;
  }
  return candidate==='parasol'&&s.y>1&&s.y<5&&max<5?'parasol':null;
}

function builder(){
  const parts=new Map();
  const add=(g,m,pos=[0,0,0],rot=[0,0,0])=>{g.rotateX(rot[0]);g.rotateY(rot[1]);g.rotateZ(rot[2]);g.translate(...pos);if(!parts.has(m))parts.set(m,[]);parts.get(m).push(g);};
  const box=(size,m,pos,rot)=>add(new THREE.BoxGeometry(...size),m,pos,rot);
  const rod=(a,b,r,m)=>{const delta=new THREE.Vector3(...b).sub(new THREE.Vector3(...a)),g=new THREE.CylinderGeometry(r,r,delta.length(),10);g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize()));g.translate((a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2);add(g,m);};
  const finish=()=>[...parts].map(([material,geos])=>{const geometry=mergeGeometries(geos.map(g=>g.index?g.toNonIndexed():g));for(const g of geos)g.dispose();geometry.computeBoundingBox();geometry.computeBoundingSphere();return {geometry,material};});
  return {add,box,rod,finish};
}

function prototype(kind,m){
  const b=builder();
  if(kind==='lounger'){
    for(const x of [-.46,.46]){
      b.rod([x,.24,-.86],[x,.26,.84],.023,m.metal);
      b.rod([x,.25,.26],[x,.72,.83],.023,m.metal);
      for(const z of [-.58,.53]){b.rod([x,.27,z-.13],[x,.03,z+.12],.025,m.metal);b.rod([x,.03,z-.12],[x,.27,z+.13],.025,m.metal);}
      b.rod([x,.45,.12],[x,.45,.55],.024,m.metal);
    }
    for(const z of [-.83,.18,.8])b.rod([-.46,.26,z],[.46,.26,z],.022,m.metal);
    b.box([.85,.045,1.12],m.fabric,[0,.265,-.29]);
    b.box([.85,.045,.79],m.fabric,[0,.49,.56],[-.67,0,0]);
    for(let i=-3;i<=3;i++){b.box([.035,.003,1.11],m.blue,[i*.12,.289,-.29]);b.box([.035,.004,.78],m.blue,[i*.12,.511,.547],[-.67,0,0]);}
    b.box([.58,.09,.19],m.fabric,[0,.71,.72],[-.67,0,0]);
  }else if(kind==='parasol'){
    b.rod([0,0,0],[0,2.75,0],.028,m.metal);b.add(new THREE.CylinderGeometry(.24,.31,.07,20),m.metal,[0,.035,0]);
    const slices=12,rings=7,positions=[],uv=[],idx=[];
    for(let i=0;i<=slices;i++)for(let j=0;j<=rings;j++){
      const a=i/slices*Math.PI*2,r=j/rings*1.5,y=2.68-.62*Math.pow(j/rings,1.5);positions.push(Math.cos(a)*r,y,Math.sin(a)*r);uv.push(i/slices,j/rings);
    }
    const gs=[[],[]];for(let i=0;i<slices;i++)for(let j=0;j<rings;j++){const a=i*(rings+1)+j,c=a+rings+1;gs[i%2].push(a,c,a+1,c,c+1,a+1);}
    for(let k=0;k<2;k++){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(gs[k]);g.computeVertexNormals();b.add(g,k?m.fabric:m.blue);}
    for(let i=0;i<slices;i++){const a=i/slices*Math.PI*2,c=Math.cos(a),s=Math.sin(a);b.rod([0,2.6,0],[c*.8,2.42,s*.8],.012,m.metal);b.rod([c*.8,2.42,s*.8],[c*1.5,2.04,s*1.5],.01,m.metal);}
    b.add(new THREE.SphereGeometry(.055,10,6),m.metal,[0,2.73,0]);
  }else if(kind==='crate'){
    b.box([.98,.98,.98],m.wood,[0,.5,0]);
    for(const s of [-1,1])for(const v of [-.36,.36]){b.box([.1,.98,.07],m.wood,[v,.5,s*.515]);b.box([.07,.98,.1],m.wood,[s*.515,.5,v]);b.box([.1,.07,.98],m.wood,[v,1.02,0]);}
    for(const s of [-1,1]){b.box([1.03,.075,.065],m.dark,[0,.13,s*.55]);b.box([1.03,.075,.065],m.dark,[0,.86,s*.55]);}
    for(const x of [-.36,.36])for(const y of [.13,.86])for(const s of [-1,1])b.add(new THREE.CylinderGeometry(.014,.014,.008,6),m.metal,[x,y,s*.553],[Math.PI/2,0,0]);
  }else if(kind==='barrel'){
    b.add(new THREE.CylinderGeometry(.42,.42,1,32,6),m.blue,[0,.5,0]);
    for(const y of [.025,.24,.76,.975]){b.add(new THREE.TorusGeometry(.426,.018,6,32),m.dark,[0,y,0],[Math.PI/2,0,0]);}
    b.add(new THREE.CylinderGeometry(.41,.41,.012,32),m.metal,[0,1.005,0]);b.add(new THREE.CylinderGeometry(.047,.047,.015,12),m.dark,[.22,1.02,.08]);
  }else if(kind==='table'){
    b.add(new THREE.CylinderGeometry(.65,.65,.07,32),m.wood,[0,.74,0]);b.rod([0,.03,0],[0,.73,0],.05,m.metal);
    for(let i=0;i<4;i++){const a=i*Math.PI/2;b.rod([0,.14,0],[Math.cos(a)*.49,.03,Math.sin(a)*.49],.03,m.metal);}
  }
  return b.finish();
}

export function buildEnhancedProps(modelData,library,{skipKinds=new Set(),skipMeshes=new Set()}={}){
  const group=new THREE.Group();group.name='Enhanced authored props';group.userData.graphicsOwned=true;
  const m={metal:new THREE.MeshStandardMaterial({color:0x8c9698,metalness:.86,roughness:.3}),dark:new THREE.MeshStandardMaterial({color:0x252b2b,metalness:.68,roughness:.46}),fabric:new THREE.MeshStandardMaterial({color:0xd7d3ba,roughness:.95,side:THREE.DoubleSide}),blue:new THREE.MeshStandardMaterial({color:0x386c7a,roughness:.7,side:THREE.DoubleSide}),wood:library.createKind('wood')||new THREE.MeshStandardMaterial({color:0x87704d,roughness:.87})};
  const batches=new Map(),hidden=new Set(),replacedMeshes=new Set();
  for(const mesh of modelData.meshes){
    if(mesh.groups?.length!==1)continue;
    const name=mesh.groups[0].material,kind=classifyProp(mesh,modelData);if(!kind||kind==='chair'||skipKinds.has(kind)||skipMeshes.has(mesh))continue;
    const placement=kind==='crate'||kind==='barrel'?solidPropPlacement(mesh,kind):meshPlacement(mesh);
    if(!placement||placement.size.length()<.2)continue;
    if(!batches.has(kind))batches.set(kind,[]);batches.get(kind).push(placement);hidden.add(name);replacedMeshes.add(mesh);
  }
  const obj=new THREE.Object3D(),origin=new THREE.Vector3(),prototypeSize=new THREE.Vector3(),offset=new THREE.Vector3();
  let replacements=0;
  for(const[kind,placements]of batches){
    const parts=prototype(kind,m);replacements+=placements.length;
    const solid=kind==='crate'||kind==='barrel';
    if(solid){
      const bounds=new THREE.Box3();
      for(const part of parts)bounds.union(part.geometry.boundingBox);
      bounds.getCenter(origin);origin.y=bounds.min.y;
      bounds.getSize(prototypeSize);
    }
    for(const part of parts){const batch=new THREE.InstancedMesh(part.geometry,part.material,placements.length);batch.name='enhanced:'+kind;batch.userData.graphicsOwned=true;batch.userData.collision=false;batch.castShadow=true;batch.receiveShadow=true;
      placements.forEach((p,i)=>{
        obj.position.copy(p.position);
        if(solid){
          obj.quaternion.copy(p.orientation);
          obj.scale.copy(p.size).divide(prototypeSize);
          obj.position.sub(offset.copy(origin).multiply(obj.scale).applyQuaternion(p.orientation));
        }else{
          obj.rotation.set(0,kind==='lounger'?p.yaw:0,0);
          if(kind==='lounger')obj.scale.set(p.width/.98,p.size.y/.77,p.length/1.76);
          else if(kind==='parasol')obj.scale.set(p.size.x/3,p.size.y/2.79,p.size.z/3);
          else obj.scale.set(p.size.x/1.3,p.size.y/.78,p.size.z/1.3);
        }
        obj.updateMatrix();batch.setMatrixAt(i,obj.matrix);
      });
      batch.instanceMatrix.needsUpdate=true;batch.computeBoundingSphere();group.add(batch);
    }
  }
  const retainedMeshes=modelData.meshes.filter(mesh=>!replacedMeshes.has(mesh)&&mesh.groups?.some(part=>hidden.has(part.material)));
  return {group,hidden,hiddenMaterialNames:hidden,retainedMeshes,replacedMeshes,replacements,materials:Object.values(m)};
}
