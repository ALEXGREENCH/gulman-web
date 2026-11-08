import * as THREE from 'three';
import {mergeWorldMeshes} from './merge-world.js?v=20261109-10';

/** BOAT.JPG also covers entire piers. Replace their broad horizontal timber
 * decks, preserving every railing/support triangle and the source collider. */
export function buildEnhancedDecks({modelData,world,library}){
  const hiddenMaterialNames=new Set(),retainedMeshes=[],selected=[];
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),normal=new THREE.Vector3();
  for(const source of modelData.meshes){
    const deck=[],rest=[],deckGroups=[],restGroups=[];
    const box=new THREE.Box3();for(let n=0;n<source.vertices.length;n+=3)box.expandByPoint(a.fromArray(source.vertices,n));
    const size=box.getSize(a),pier=Math.max(size.x,size.z)>1000;
    for(const part of source.groups||[]){
      const deckStart=deck.length,restStart=rest.length;
      const candidate=pier&&/^BOAT\.JPG$/i.test(modelData.materials[part.material]?.originalMap||'');
      for(let n=part.start;n<part.start+part.count;n+=3){
        const ids=source.indices.slice(n,n+3);a.fromArray(source.vertices,ids[0]*3);b.fromArray(source.vertices,ids[1]*3).sub(a);c.fromArray(source.vertices,ids[2]*3).sub(a);normal.crossVectors(b,c);
        const area=normal.length()*.00005,isDeck=candidate&&area>.15&&Math.abs(normal.normalize().y)>.94;
        (isDeck?deck:rest).push(...ids);
      }
      if(deck.length>deckStart){deckGroups.push({...part,start:deckStart,count:deck.length-deckStart});hiddenMaterialNames.add(part.material);}
      if(rest.length>restStart)restGroups.push({...part,start:restStart,count:rest.length-restStart});
    }
    if(deck.length)selected.push({...source,indices:deck,groups:deckGroups});
    if(rest.length)retainedMeshes.push({...source,indices:rest,groups:restGroups});
  }
  const geometries=new Set(),materials=new Set();let group=new THREE.Group();
  if(selected.length){
    const material=library.createKind('wood',{tileMeters:2.2,normalStrength:.65});materials.add(material);
    group=mergeWorldMeshes({...modelData,meshes:selected},Object.fromEntries([...hiddenMaterialNames].map(n=>[n,material])),material);
    world.updateWorldMatrix(true,false);group.matrix.copy(world.matrixWorld);group.matrixAutoUpdate=false;
  }
  group.name='Scanned timber pier decks';group.traverse(object=>{object.userData.graphicsOwned=true;object.userData.collision=false;if(object.geometry){geometries.add(object.geometry);object.castShadow=true;object.receiveShadow=true;}});
  return {group,geometries,materials,hiddenMaterialNames,retainedMeshes,sourceTriangles:selected.reduce((n,m)=>n+m.indices.length/3,0)};
}
