import test from 'node:test';
import assert from 'node:assert/strict';
import {remainingEnhancedSource,selectEnhancedSourceMaterials} from '../js/enhanced-source.js';

test('layers sharing one atlas never restore a preceding layer replacement',()=>{
  const source={name:'shared',vertices:Array.from({length:36},(_,i)=>i),indices:[0,1,2,3,4,5,6,7,8,9,10,11],groups:[{start:0,count:9,material:'atlas'},{start:9,count:3,material:'other'}]};
  const data={materials:{atlas:{},other:{}},meshes:[source]},before=JSON.stringify(data);
  const architectureRemainder={...source,indices:[3,4,5,6,7,8],groups:[{start:0,count:6,material:'atlas'}]};
  const afterArchitecture=remainingEnhancedSource(data,new Set(['atlas']),[architectureRemainder]);
  const landscapeRemainder={...source,indices:[6,7,8],groups:[{start:0,count:3,material:'atlas'}]};
  const afterLandscape=remainingEnhancedSource(afterArchitecture,new Set(['atlas']),[landscapeRemainder]);
  const result=selectEnhancedSourceMaterials(afterLandscape,new Set(['atlas']));
  assert.deepEqual(result.meshes.flatMap(m=>m.indices),[6,7,8]);
  assert.deepEqual(afterLandscape.meshes.flatMap(m=>m.indices),[9,10,11,6,7,8]);
  assert.equal(result.meshes[0].vertices,source.vertices,'source vertex arrays remain borrowed');
  assert.equal(JSON.stringify(data),before,'Original source is immutable');
});

test('empty replacement and a whole-object replacement preserve every unrelated group',()=>{
  const untouched={name:'other',vertices:[],indices:[0,1,2],groups:[{start:0,count:3,material:'other'}]};
  const data={materials:{},meshes:[{name:'tree',vertices:[],indices:[0,1,2],groups:[{start:0,count:3,material:'leaf'}]},untouched]};
  assert.equal(remainingEnhancedSource(data,[]),data);
  const result=remainingEnhancedSource(data,['leaf']);
  assert.deepEqual(result.meshes,[untouched]);
  assert.equal(selectEnhancedSourceMaterials(result,['leaf']).meshes.length,0);
});

test('whole retained meshes cannot duplicate an unrelated material group',()=>{
  const mixed={vertices:[],indices:[0,1,2,3,4,5],groups:[{start:0,count:3,material:'wood'},{start:3,count:3,material:'metal'}]};
  const result=remainingEnhancedSource({materials:{},meshes:[mixed]},['wood'],[mixed]);
  assert.deepEqual(result.meshes.flatMap(m=>m.indices),[3,4,5,0,1,2]);
});
