import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { EnhancedWater, extractWaterSurfaces, bakeWaterDepth, evaluateWaterWaves } from '../js/enhanced-water.js';

const square = (name, material, y = 0, size = 10, vertical = false) => ({
  name,
  vertices: vertical ? [0,0,0, 0,10,0, 0,10,10, 0,0,10] : [0,y,0, size,y,0, size,y,size, 0,y,size],
  indices: [0,2,1, 0,3,2], groups: [{start:0,count:6,material}],
});

function fixture() {
  return {
    materials: { water: { map: 'assets/images/water-123.jpg' }, sand: { map: 'assets/images/beach-456.jpg' }, urn: { map: 'assets/images/urna-789.jpg' } },
    meshes: [square('sea','water'), { ...square('bottom','sand',-1), vertices:[0,-.1,0,10,-4,0,10,-4,10,0,-.1,10] }],
  };
}

function setup(data = fixture(), options = {}) {
  const scene = new THREE.Scene(), world = new THREE.Group();
  const source = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshLambertMaterial());
  source.name = 'world:water'; world.add(source); scene.add(world);
  const water = new EnhancedWater({ scene, world, modelData:data, scale:1, ...options });
  return { scene, world, source, water };
}

test('water detection uses actual textures and horizontal geometry; mixed batches stay original', () => {
  const data = fixture();
  data.meshes.push(square('waterf1', 'sand'), square('water', 'urn'));
  assert.equal(extractWaterSurfaces(data,1).length, 1);
  data.meshes.push(square('vertical-decoration','water',0,10,true));
  assert.equal(extractWaterSurfaces(data,1).length, 0, 'hiding a merged mixed batch must not remove its decorative panels');
});

test('bathymetry follows the terrain floor and ray samples start below the original water collider', () => {
  const data = fixture(), surface = extractWaterSurfaces(data,1)[0];
  const depth = bakeWaterDepth(surface,data,{scale:1,size:16});
  assert.ok(Math.abs(depth.depth[0] - .1) < 1e-6);
  assert.ok(Math.abs(depth.depth[15] - 4) < 1e-6);
  let highestOrigin = -Infinity;
  const sampled = bakeWaterDepth(surface,data,{scale:1,size:8,groundSample:(x,y,z)=>{
    highestOrigin = Math.max(highestOrigin,y);
    return y >= 0 ? 0 : -2;
  }});
  assert.ok(highestOrigin < surface.level, 'otherwise the old water plane becomes a zero-depth seabed');
  assert.ok(sampled.depth.every(value => value === 2));
});

test('tessellation preserves the source footprint and has real animated geometric heights', () => {
  const {water,source} = setup();
  assert.equal(water.diagnostics.triangles,0,'no enhanced geometry allocation before enabling');
  water.setEnabled(true);
  assert.equal(source.visible,false);
  assert.ok(water.diagnostics.triangles > 2);
  const mesh = water.root.children[0], pos = mesh.geometry.attributes.position;
  for (let i=0;i<pos.count;i++) {
    assert.ok(pos.getX(i)>=-1e-6&&pos.getX(i)<=10+1e-6);
    assert.ok(pos.getZ(i)>=-1e-6&&pos.getZ(i)<=10+1e-6);
    assert.ok(Number.isFinite(pos.getY(i)));
  }
  const triangles = mesh.geometry.index.array;
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3();
  let area=0;
  for(let i=0;i<triangles.length;i+=3){a.fromBufferAttribute(pos,triangles[i]);b.fromBufferAttribute(pos,triangles[i+1]);c.fromBufferAttribute(pos,triangles[i+2]);area+=new THREE.Triangle(a,b,c).getArea();}
  assert.ok(Math.abs(area-100)<.001);
  assert.notEqual(water.heightAt(5,5,0),water.heightAt(5,5,1));
  assert.equal(water.heightAt(0,5,2),.015,'shoreline boundary does not move outside the old footprint');
  assert.equal(water.heightAt(15,5,1),undefined);
  assert.equal(mesh.material.ior,1.333);
  assert.equal(mesh.material.forceSinglePass,true);
  assert.equal(mesh.material.clearcoat,0);
  assert.equal(mesh.castShadow,false);
  assert.equal(mesh.userData.collision,false);
  water.dispose();
});

test('Gerstner offsets/normals stay finite, bounded, animated and exactly zero at pinned shores', () => {
  const waves=[[.92,.39,24,.16],[-.36,.93,13,.085],[.62,-.78,7,.035]];
  for(let time=0;time<30;time+=.17){
    const sample=evaluateWaterWaves(22,-14,time,waves);
    assert.ok(Number.isFinite(sample.offset.length()));
    assert.ok(Math.abs(sample.offset.y)<=.281);
    assert.ok(Math.abs(sample.normal.length()-1)<1e-6);
    assert.ok(sample.normal.y>.96);
    assert.deepEqual(evaluateWaterWaves(22,-14,time,waves,0).offset,new THREE.Vector3());
  }
});

test('quality switches obey geometry budgets without accumulating resources or changing originals', () => {
  const data=fixture();data.meshes=[square('sea','water',0,700)];
  const copy=structuredClone(data),{water,source}=setup(data);
  const originalGeometry=source.geometry,originalMaterial=source.material;
  water.setEnabled(true);
  assert.ok(water.diagnostics.triangles<=30000);
  const old=water.root.children[0].geometry;let oldDisposed=0;old.addEventListener('dispose',()=>oldDisposed++);
  water.update(1,null,'low');
  assert.equal(oldDisposed,1);
  assert.ok(water.diagnostics.triangles<=6000);
  assert.equal(water.root.children.length,1);
  assert.equal(water.root.children[0].material.defines.GULMAN_WATER_LOW,1);
  water.update(2,null,'high');
  assert.ok(water.diagnostics.triangles<=30000);
  assert.equal(Object.hasOwn(water.root.children[0].material.defines,'GULMAN_WATER_LOW'),false);
  assert.equal(source.geometry,originalGeometry);assert.equal(source.material,originalMaterial);
  assert.deepEqual(data,copy);
  water.dispose();
});

test('toggle/dispose restores exact visibility and disposes only owned resources once', () => {
  const normal=new THREE.Texture();let borrowedDisposals=0;normal.addEventListener('dispose',()=>borrowedDisposals++);
  const {water,source,scene}=setup(fixture(),{normalMap:normal});
  source.visible=false;
  water.setEnabled(true);
  const mesh=water.root.children[0];let ownedDisposals=0;
  mesh.geometry.addEventListener('dispose',()=>ownedDisposals++);
  mesh.material.addEventListener('dispose',()=>ownedDisposals++);
  const clone=mesh.material.normalMap;
  clone.addEventListener('dispose',()=>ownedDisposals++);
  water.setEnabled(false);
  assert.equal(source.visible,false);
  assert.equal(water.diagnostics.triangles,0);
  assert.equal(ownedDisposals,2);
  source.visible=true;
  water.setEnabled(true).setEnabled(true).setEnabled(false);
  assert.equal(source.visible,true);
  water.dispose();water.dispose();
  assert.equal(ownedDisposals,3);
  assert.equal(borrowedDisposals,0);
  assert.equal(scene.getObjectByName('enhanced-water'),undefined);
});

test('all original levels have the expected real water patches; level 7 vertical panel is excluded', async () => {
  const root=new URL('../',import.meta.url);
  const manifest=JSON.parse(await readFile(new URL('assets/manifest.json',root),'utf8'));
  const expected={1:1,2:2,3:0,4:1,5:1,6:1,7:0,8:0,9:0};
  for(const level of manifest.levels){
    const data=JSON.parse(await readFile(new URL(manifest.models[level.model],root),'utf8'));
    const surfaces=extractWaterSurfaces(data);
    assert.equal(surfaces.length,expected[level.id],`level ${level.id}`);
    if(!surfaces.length)continue;
    const scene=new THREE.Scene(),world=new THREE.Group();scene.add(world);
    for(const name of new Set(surfaces.map(s=>s.material))){const mesh=new THREE.Mesh();mesh.name=`world:${name}`;world.add(mesh);}
    const water=new EnhancedWater({scene,world,modelData:data});
    water.setEnabled(true);
    assert.ok(water.diagnostics.triangles<=30000,`level ${level.id} high budget`);
    water.update(4,null,'low');
    assert.ok(water.diagnostics.triangles<=6000,`level ${level.id} low budget`);
    water.dispose();
    assert.ok(world.children.every(mesh=>mesh.visible));
  }
});
