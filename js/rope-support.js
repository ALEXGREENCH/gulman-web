import { Triangle, Vector3 } from 'three';

/** Continuous footing for the second Acropolis crossing, up to the Venus roof. */
export function ropeSupport(levelId, modelData) {
  if (levelId !== 3) return undefined;
  const beams=['dx244','dx245'].map(name=>modelData.meshes.find(mesh=>mesh.name===name));
  if(beams.some(mesh=>!mesh?.vertices?.length))return undefined;
  const key=points=>points.map(p=>p.toArray().map(x=>Math.round(x*10000)).join(',')).sort().join('|');
  const removed=new Set();
  for(const {vertices,indices} of beams)for(let i=0;i<indices.length;i+=3){
    removed.add(key(indices.slice(i,i+3).map(ix=>new Vector3().fromArray(vertices,ix*3).multiplyScalar(.01))));
  }
  const points=beams.flatMap(({vertices})=>{
    const result=[];
    for(let i=0;i<vertices.length;i+=3)result.push(new Vector3().fromArray(vertices,i).multiplyScalar(.01));
    return result;
  });
  const low=points.reduce((a,b)=>a.y<b.y?a:b),high=points.reduce((a,b)=>a.y>b.y?a:b);
  const near=points.filter(p=>p.z>low.z-.2).reduce((a,b)=>a.y>b.y?a:b);
  // Allow for a slightly off-center approach. Contact with the outside edge
  // of a single rail pushes the capsule or ellipsoid away from the crossing.
  const left=Math.min(...points.map(p=>p.x))-.45,right=Math.max(...points.map(p=>p.x))+.45;
  const joinZ=25.65;
  const joinY=near.y+(high.y-near.y)*(joinZ-near.z)/(high.z-near.z)+.004;
  // The transverse log is almost a metre above the rope anchor. Start on
  // its forward side and descend onto the slope without a drop at the eave.
  const rows=[[-5.16,26.60],[joinY,joinZ],[high.y+.004,high.z]]
    .map(([y,z])=>[new Vector3(left,y,z),new Vector3(right,y,z)]);
  const support=[];
  for(let i=1;i<rows.length;i++){
    const [a,b]=rows[i-1],[c,d]=rows[i];
    support.push(new Triangle(a,b,c),new Triangle(b,d,c));
  }
  return {support,
    exclude:points=>points.every(p=>p.x>=left&&p.x<=right)&&removed.has(key(points))};
}
