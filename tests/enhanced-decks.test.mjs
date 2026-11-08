import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {buildEnhancedBoats} from '../js/enhanced-boats.js';
import {buildEnhancedDecks} from '../js/enhanced-decks.js';
import {remainingEnhancedSource,selectEnhancedSourceMaterials} from '../js/enhanced-source.js';

test('real beach piers replace blurry timber while retaining all rails, source arrays and triangle counts',async()=>{
  const root=new URL('../',import.meta.url),manifest=JSON.parse(await readFile(new URL('assets/manifest.json',root),'utf8'));
  const data=JSON.parse(await readFile(new URL(manifest.models[manifest.levels[0].model],root),'utf8')),before=JSON.stringify(data);
  const boats=buildEnhancedBoats(data),remainder=remainingEnhancedSource(data,boats.hiddenMaterialNames,boats.retainedMeshes);
  const world=new THREE.Group();world.scale.setScalar(.01);
  const layer=buildEnhancedDecks({modelData:remainder,world,library:{createKind:()=>new THREE.MeshStandardMaterial()}});
  assert.ok(layer.sourceTriangles>0);assert.equal(layer.group.children.length,1);
  const count=source=>selectEnhancedSourceMaterials(source,layer.hiddenMaterialNames).meshes.reduce((sum,m)=>sum+m.indices.length/3,0);
  const after=remainingEnhancedSource(remainder,layer.hiddenMaterialNames,layer.retainedMeshes);
  assert.equal(count(after)+layer.sourceTriangles,count(remainder));assert.ok(count(after)>0,'railings are retained');
  assert.equal(JSON.stringify(data),before);
  for(const g of layer.geometries)g.dispose();for(const m of layer.materials)m.dispose();
  boats.group.traverse(o=>{if(o.isInstancedMesh)o.dispose();});boats.geometries.forEach(g=>g.dispose());boats.materials.forEach(m=>m.dispose());
});
