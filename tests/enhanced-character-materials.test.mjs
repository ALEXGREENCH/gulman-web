import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { createEnhancedCharacterMaterials } from '../js/enhanced-character-materials.js';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('assets/enhanced/characters/manifest.json', root), 'utf8'));
const counted = texture => {
  texture.disposals = 0;
  texture.addEventListener('dispose', () => texture.disposals++);
  return texture;
};

test('packed character surfaces match source records and UV gutters', async () => {
  const library = createEnhancedCharacterMaterials();
  let total = 0;
  for (const [kind, rect] of Object.entries(manifest.rects)) {
    assert.deepEqual(library.uvRect(kind), rect);
    assert.ok(rect.x > 0 && rect.y > 0 && rect.x + rect.width < 1 && rect.y + rect.height < 1);
  }
  for (const record of manifest.sources) assert.equal(record.license, 'CC0-1.0');
  for (const entry of Object.values(manifest.maps)) {
    const bytes = await readFile(new URL(entry.path, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    assert.equal(bytes.byteLength, entry.bytes);
    assert.deepEqual(entry.size, [1024, 512]);
    total += bytes.byteLength;
  }
  assert.ok(total < 600 * 1024);
  library.dispose();
});

test('character library loads lazily once and retains one shared vertex-color material', async () => {
  const textures = [];
  const library = createEnhancedCharacterMaterials({
    assets: { url: path => 'https://self.test/' + path },
    textureLoader: { async loadAsync(url) {
      assert.match(url, /^https:\/\/self\.test\/assets\/enhanced\/characters\//);
      const texture = counted(new THREE.Texture()); textures.push(texture); return texture;
    } },
  });
  assert.equal(textures.length, 0);
  assert.equal(library.material.vertexColors, true);
  assert.equal(library.loaded, false);
  const material = library.material, uuid = material.uuid;
  const old = [...new Set([material.map, material.normalMap, material.roughnessMap])]; old.forEach(counted);
  const pending = library.load(); assert.equal(library.ready, pending);
  assert.equal(await pending, true);
  assert.equal(textures.length, 4);
  assert.equal(library.material, material); assert.equal(material.uuid, uuid);
  assert.equal(material.map.colorSpace, THREE.SRGBColorSpace);
  assert.equal(material.normalMap.colorSpace, THREE.NoColorSpace);
  assert.equal(material.roughnessMap, material.metalnessMap);
  assert.equal(library.loaded, true);
  for (const texture of old) assert.equal(texture.disposals, 1);
  library.dispose(); library.dispose();
  for (const texture of textures) assert.equal(texture.disposals, 1);
});

test('late character textures cannot attach after disposal and are freed exactly once', async () => {
  const release = [], textures = [];
  const library = createEnhancedCharacterMaterials({ textureLoader: { loadAsync() {
    return new Promise(resolve => release.push(() => { const texture = counted(new THREE.Texture()); textures.push(texture); resolve(texture); }));
  } } });
  const pending = library.load();
  library.dispose();
  release.forEach(resolve => resolve());
  assert.equal(await pending, false);
  assert.equal(library.loaded, false);
  for (const texture of textures) assert.equal(texture.disposals, 1);
  assert.equal(await library.load(), false);
});

test('partial character map failure retains fallback, frees downloads, and can retry', async () => {
  let fail = true; const textures = [], errors = [];
  const library = createEnhancedCharacterMaterials({ onError: error => errors.push(error), textureLoader: { async loadAsync(url) {
    if (fail && url.includes('character-normal')) throw new Error('offline');
    const texture = counted(new THREE.Texture()); textures.push(texture); return texture;
  } } });
  const fallback = library.material.map;
  assert.equal(await library.load(), false);
  assert.equal(library.material.map, fallback);
  assert.equal(errors.length, 1);
  for (const texture of textures) assert.equal(texture.disposals, 1);
  fail = false;
  assert.equal(await library.load(), true);
  library.dispose();
  for (const texture of textures) assert.equal(texture.disposals, 1);
});


test('reconstructed face atlas has all seven UV cells and recorded provenance',async()=>{
  const record=JSON.parse(await readFile(new URL('assets/enhanced/characters/face-generation.json',root),'utf8'));
  const bytes=await readFile(new URL(record.output.path,root));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),record.output.sha256);
  assert.equal(bytes.byteLength,record.output.bytes);
  const library=createEnhancedCharacterMaterials();
  for(const name of record.cells.slice(0,7)){
    const r=library.faceRect(name);assert.ok(r.x>=0&&r.y>=0&&r.x+r.width<=1&&r.y+r.height<=1);
  }
  assert.equal(library.faceMaterial.vertexColors,false);library.dispose();
});
