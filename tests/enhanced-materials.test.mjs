import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { classifyEnhancedSurface, EnhancedMaterialLibrary } from '../js/enhanced-materials.js';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('assets/enhanced/materials/manifest.json', root), 'utf8'));
const fixture = () => {
  const textures = [];
  const assets = { json: async () => manifest, url: path => path };
  const textureLoader = { async loadAsync() {
    const texture = new THREE.Texture();
    texture.disposals = 0;
    texture.addEventListener('dispose', () => texture.disposals++);
    textures.push(texture);
    return texture;
  } };
  return { assets, textureLoader, textures };
};

test('world surface classifier excludes atlas facades, water, art and character maps', () => {
  assert.equal(classifyEnhancedSurface('assets/images/beach-3aaad64c45d1.jpg'), 'sand');
  assert.equal(classifyEnhancedSurface('WOOD_LOW.JPG'), 'wood');
  assert.equal(classifyEnhancedSurface('assets/images/brick-mu-8a64af064e6e.jpg'), 'brick');
  assert.equal(classifyEnhancedSurface('assets/images/oncrete-215731505e5e.jpg'), 'concrete');
  for (const path of ['BEACH_RE.TGA', 'GROUND.JPG', 'LANDSCAP.JPG', 'TERRAIN.JPG', 'HOUSE.JPG', 'HOTEL_RE.TGA', 'WATER.JPG', 'CEIL_LOW.JPG', 'FOTO_060.JPG', 'TREE.TGA', 'BUSH.TGA', 'models/players-nano/Gulman/rock.jpg']) {
    assert.equal(classifyEnhancedSurface(path), null, path);
  }
});

test('all CC0 derivatives have correct checksums, source URLs and bounded download size', async () => {
  let total = 0;
  assert.equal(Object.keys(manifest.materials).length, 10);
  for (const record of Object.values(manifest.materials)) {
    assert.equal(record.license, 'CC0-1.0');
    assert.ok(record.tileMeters > 0 && record.tileMeters < 10);
    for (const [channel, entry] of Object.entries(record.maps)) {
      const bytes = await readFile(new URL(entry.path, root));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
      assert.equal(bytes.length, entry.bytes);
      assert.match(entry.sourceUrl, /^https:\/\/dl\.polyhaven\.org\//);
      assert.ok(Math.max(...entry.size) <= (channel === 'roughness' ? 512 : 1024));
      total += bytes.length;
    }
  }
  assert.ok(total < 8 * 1024 * 1024, `${total} bytes`);
});

test('library is lazy, creates independent materials, and frees only its owned maps', async () => {
  const f = fixture();
  const library = new EnhancedMaterialLibrary(f.assets, { textureLoader: f.textureLoader });
  assert.equal(f.textures.length, 0);
  const original = new THREE.MeshLambertMaterial({ color: 0x987654, map: new THREE.Texture() });
  let originalDisposals = 0;
  original.addEventListener('dispose', () => originalDisposals++);
  original.map.addEventListener('dispose', () => originalDisposals++);
  await Promise.all([library.load(), library.load()]);
  assert.equal(f.textures.length, 30);
  const material = library.create(original, 'BEACH.JPG', { waterLevel: -4.1 });
  assert.ok(material.isMeshStandardMaterial);
  assert.notEqual(material, original);
  assert.equal(original.color.getHex(), 0x987654);
  assert.equal(original.map.colorSpace, THREE.NoColorSpace);
  assert.equal(material.userData.enhancedUniforms.enhancedWaterLevel.value, -4.1);
  assert.equal(library.sets.get('sand').color.colorSpace, THREE.SRGBColorSpace);
  assert.equal(library.sets.get('sand').normal.colorSpace, THREE.NoColorSpace);
  library.setQuality('low');
  assert.equal(material.userData.enhancedUniforms.enhancedLow.value, 1);
  assert.equal(library.create(original, 'HOUSE.JPG'), null);
  const garden=library.create(original,'assets/images/terrain-ff344f98d7d2.jpg');
  assert.equal(garden.defines.ENHANCED_GARDEN,1);
  assert.equal(garden.userData.enhancedUniforms.enhancedAtlas.value,original.map);
  assert.equal(garden.userData.enhancedUniforms.enhancedRockColor.value,library.sets.get('limestone').color);
  assert.notEqual(garden.customProgramCacheKey(),material.customProgramCacheKey());
  assert.equal(library.create(original,'assets/images/terrain-unrelated.jpg'),null);
  original.alphaTest = 0.35;
  assert.equal(library.create(original, 'BEACH.JPG'), null);
  library.dispose();
  library.dispose();
  assert.equal(originalDisposals, 0);
  for (const texture of f.textures) assert.equal(texture.disposals, 1);
});

test('partial download failure frees completed maps and allows a clean retry', async () => {
  const f = fixture();
  const originalLoad = f.textureLoader.loadAsync;
  let fail = true;
  f.textureLoader.loadAsync = async path => {
    if (fail && path.endsWith('sand-normal.webp')) throw new Error('offline');
    return originalLoad(path);
  };
  const library = new EnhancedMaterialLibrary(f.assets, { textureLoader: f.textureLoader });
  await assert.rejects(library.load(), /offline/);
  assert.equal(library.loaded, false);
  assert.equal(library.sets.size, 0);
  for (const texture of f.textures) assert.equal(texture.disposals, 1);
  fail = false;
  await library.load();
  assert.equal(library.loaded, true);
  library.dispose();
  for (const texture of f.textures) assert.equal(texture.disposals, 1);
});
