import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { OriginalWater } from '../js/original-water.js';
import { EnhancedWater } from '../js/enhanced-water.js';
import { GraphicsManager } from '../js/graphics.js';
import { WorldCollision } from '../js/collision.js';

const levelData = JSON.parse(await readFile(new URL('../assets/models/level-7ffdf74e5f40.json', import.meta.url)));
function fixture(levelId = 1) {
  const scene = new THREE.Scene(), world = new THREE.Group(), sky = new THREE.Texture();
  world.scale.setScalar(.01);
  // Build the actual source water and beach batches, with their real UVs.
  for (const name of ['waterf', 'waterf1']) {
    const mesh = levelData.meshes.find(mesh => mesh.groups.some(group => group.material === name));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.vertices, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(mesh.uv, 2));
    geometry.setIndex(mesh.indices); geometry.computeVertexNormals();
    const map = new THREE.Texture(); map.name = levelData.materials[name].map;
    const object = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({map}));
    object.name = `world:${name}`;
    world.add(object);
  }
  scene.add(world); scene.background = sky;
  const collision = new WorldCollision().setWorld(world);
  const water = new OriginalWater({scene,world,sky,modelData:levelData,levelId});
  return {scene,world,sky,collision,water,source:world.getObjectByName('world:waterf'),sand:world.getObjectByName('world:waterf1')};
}

test('first beach uses the original water footprint/sky; sand, geometry and collisions stay intact', () => {
  const {scene,world,sky,collision,water,source,sand} = fixture();
  const geometry = source.geometry, material = source.material;
  const vertices = geometry.attributes.position.array.slice(), uv = geometry.attributes.uv.array.slice();
  const triangles = collision.triangleCount, floor = collision.ground(0,10,-70,100);
  water.setEnabled(true);
  assert.equal(water.diagnostics.surfaces,1);
  assert.equal(source.visible,false);
  assert.equal(sand.visible,true,'waterf1 is BEACH.JPG, not sea');
  const replacement = water.root.children[0];
  scene.updateMatrixWorld(true);
  assert.equal(replacement.geometry,geometry,'no extra tessellation in Original');
  assert.deepEqual(replacement.matrixWorld,source.matrixWorld);
  assert.equal(replacement.material.uniforms.seaSky.value,sky);
  assert.equal(replacement.material.uniforms.seaRipple.value,material.map);
  assert.equal(replacement.userData.collision,false);
  assert.equal(replacement.castShadow,false,'the sea must not cast a giant solid shadow');
  assert.equal(geometry.index.count / 3,2);
  water.update(.016);
  water.setEnabled(false);
  assert.equal(source.material,material);
  assert.equal(source.visible,true);
  assert.deepEqual(geometry.attributes.position.array,vertices);
  assert.deepEqual(geometry.attributes.uv.array,uv);
  collision.setWorld(world);
  assert.equal(collision.triangleCount,triangles);
  assert.equal(collision.ground(0,10,-70,100),floor);
  water.dispose();
});

test('Original/Enhanced/economy cycling restores source visibility and keeps the owned shader', () => {
  const {scene,world,sky,water,source,sand} = fixture();
  const enhanced = new EnhancedWater({scene,world,modelData:levelData,quality:'low'});
  const graphics = new GraphicsManager({storage:null,document:null});
  const sourceMaterial = source.material, waterMaterial = water.root.children[0].material;
  for (const mode of ['original','enhanced','original','potato','enhanced','potato','original']) {
    graphics.setMode(mode,{scene});
    water.setEnabled(false);
    enhanced.setEnabled(mode === 'enhanced');
    water.setEnabled(mode !== 'enhanced');
    assert.equal(source.visible,false,'exactly one water replacement should own the source');
    assert.equal(water.root.visible,mode !== 'enhanced');
    assert.equal(enhanced.root.visible,mode === 'enhanced');
    assert.equal(water.root.children[0].material,waterMaterial,'graphics conversion must skip the original water shader');
    assert.equal(sand.visible,true);
  }
  water.setEnabled(false); enhanced.dispose(); graphics.dispose();
  assert.equal(source.visible,true);
  assert.equal(source.material,sourceMaterial);
  assert.equal(scene.background,sky);
  water.dispose();
});

test('water pauses, resumes smoothly, respects pre-hidden sources and only disposes its own resources', () => {
  const {water,source,sky} = fixture();
  let geometryDisposals=0, skyDisposals=0, mapDisposals=0, materialDisposals=0;
  source.geometry.addEventListener('dispose',()=>geometryDisposals++);
  sky.addEventListener('dispose',()=>skyDisposals++);
  source.material.map.addEventListener('dispose',()=>mapDisposals++);
  water.parts[0].material.addEventListener('dispose',()=>materialDisposals++);
  source.visible=false;
  water.setEnabled(true);
  assert.equal(water.root.children[0].visible,false);
  water.update(.04); assert.equal(water.time.value,.04);
  water.update(0); water.update(NaN); assert.equal(water.time.value,.04);
  water.update(20); assert.ok(Math.abs(water.time.value-.14)<1e-10,'bounded after tab suspension');
  water.setEnabled(false); water.update(1);
  assert.equal(source.visible,false);
  assert.ok(Math.abs(water.time.value-.14)<1e-10);
  water.dispose(); water.dispose(); water.setEnabled(true);
  assert.equal(water.root.parent,null);
  assert.equal(materialDisposals,1);
  assert.equal(geometryDisposals+skyDisposals+mapDisposals,0);
});

test('other missions keep their original material; missing sky gracefully retains the source', () => {
  const {water,source,scene,world} = fixture(2);
  water.setEnabled(true);
  assert.equal(water.parts.length,0);
  assert.equal(source.visible,true);
  water.dispose();
  const fallback = new OriginalWater({scene,world,sky:null,modelData:levelData,levelId:1});
  fallback.setEnabled(true);
  assert.equal(fallback.diagnostics.enabled,false);
  assert.equal(source.visible,true);
  fallback.dispose();
});
