import { Triangle, Vector3 } from 'three';

/** The Acropolis crossing is two 11 cm sloping beams with a 40 cm gap.
 * Bridge that gap for footsteps using their actual top endpoints. The visual
 * model stays untouched; stepping off the outer edge still means a fall. */
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
  const left=Math.min(...points.map(p=>p.x))-.025,right=Math.max(...points.map(p=>p.x))+.025;
  const a=new Vector3(left,near.y+.004,near.z),b=new Vector3(right,a.y,a.z);
  const c=new Vector3(left,high.y+.004,high.z),d=new Vector3(right,c.y,c.z);
  return {support:[new Triangle(a,b,c),new Triangle(b,d,c)],
    exclude:points=>points.every(p=>p.x>=left&&p.x<=right)&&removed.has(key(points))};
}
