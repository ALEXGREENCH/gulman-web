import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {Assets} from '../js/assets.js';
import {createCharacter} from '../js/characters.js';
import {safeProjectileOrigin} from '../js/original-combat.js';

test('barrel overlap never starts a projectile beyond a thin wall',()=>{
  const eye=new THREE.Vector3(0,1.4,0),muzzle=new THREE.Vector3(0,1.4,1);
  const world={ray:(origin,direction,distance)=>({position:origin.clone().addScaledVector(direction,distance*.4)})};
  const safe=safeProjectileOrigin(eye,muzzle,world);
  assert.ok(Math.abs(safe.z-.36)<1e-8);
  assert.equal(muzzle.z,1,'borrowed barrel transform is untouched');
  assert.deepEqual(safeProjectileOrigin(eye,muzzle,{ray:()=>null}).toArray(),muzzle.toArray());
});

test('projectile origin follows the actual original weapon barrel and character transform',async()=>{
  const assets=new Assets(),root=new URL('../',import.meta.url);
  assets.json=async path=>JSON.parse(await readFile(new URL(path,root),'utf8'));
  assets.texture=async()=>new THREE.Texture();await assets.init();
  for(const name of ['Gulman','Dama']){
    const character=await createCharacter(name,assets.model.bind(assets),assets.json.bind(assets));
    assert.equal(character.weaponMuzzlePosition(),null);
    const model=await assets.model('models/weapons/weaponpistol.3ds',true);
    character.attachWeapon(model);character.group.updateMatrixWorld(true);
    const first=character.weaponMuzzlePosition();
    assert.ok(first.toArray().every(Number.isFinite));
    assert.ok(first.y>.6&&first.y<2.5,'muzzle belongs to the raised weapon, not the feet');
    character.group.position.set(10,2,-4);character.group.updateMatrixWorld(true);
    assert.ok(character.weaponMuzzlePosition().sub(first).distanceTo(new THREE.Vector3(10,2,-4))<1e-6);
    character.attachWeapon(null);assert.equal(character.weaponMuzzlePosition(),null);character.dispose();
  }
});
