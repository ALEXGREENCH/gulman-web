import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GraphicsManager, getGraphicsProfile } from '../js/graphics.js';

function renderer(maxAnisotropy = 4) {
  return {
    toneMapping: THREE.NoToneMapping, toneMappingExposure: 1,
    outputColorSpace: THREE.SRGBColorSpace, ratio: 1.25,
    shadowMap: { enabled: false }, capabilities: { getMaxAnisotropy: () => maxAnisotropy },
    getPixelRatio() { return this.ratio; }, setPixelRatio(value) { this.ratio = value; },
  };
}

const manager = options => new GraphicsManager({ storage: null, document: null, ...options });

test('quality profiles cap high-density displays without extra passes', () => {
  assert.equal(getGraphicsProfile('enhanced', 4).pixelRatio, 1.5);
  assert.equal(getGraphicsProfile('potato', 4).pixelRatio, 0.75);
  assert.equal(getGraphicsProfile('original', 1).pixelRatio, 1);
  assert.equal(getGraphicsProfile('original', Infinity).pixelRatio, 1);
  assert.equal(getGraphicsProfile('original', NaN).pixelRatio, 1);
  assert.equal(getGraphicsProfile('unknown', 2).mode, 'original');
  for (const mode of ['original', 'enhanced', 'potato']) assert.equal(getGraphicsProfile(mode).postPasses, 0);
});

test('settings survive reload; blocked/corrupt storage falls back to original', () => {
  let saved = null;
  const storage = { getItem: () => saved, setItem: (_, value) => { saved = value; } };
  const graphics = manager({ storage });
  assert.equal(graphics.mode, 'original');
  graphics.setMode('potato').setLighting(false);
  const restored = manager({ storage });
  assert.equal(restored.mode, 'potato');
  assert.equal(restored.lighting, false);
  assert.throws(() => graphics.setMode('ultra'), RangeError);
  saved = '{invalid';
  assert.equal(manager({ storage }).mode, 'original');
  const unavailable = manager({ storage: { getItem() { throw Error('disabled'); }, setItem() { throw Error('disabled'); } } });
  assert.doesNotThrow(() => unavailable.setMode('enhanced'));
});

test('pending asset textures use the current mode, respect GPU caps, and retain identity', async () => {
  const texture = new THREE.Texture();
  texture.anisotropy = 4;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const assets = { textures: new Map([['shared', pending]]), texture() { return pending; } };
  const originalMethod = assets.texture;
  const graphics = manager();
  const render = renderer(2);
  graphics.applyRenderer(render);
  const cached = graphics.applyAssets(assets);
  const requested = assets.texture({ map: 'shared' });
  graphics.setMode('enhanced');
  resolve(texture);
  await cached;
  assert.equal(await requested, texture);
  assert.equal(assets.textures.get('shared'), pending);
  assert.equal(texture.anisotropy, 2);
  assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
  assert.equal(texture.generateMipmaps, true);
  graphics.setMode('potato');
  assert.equal(texture.anisotropy, 1);
  assert.equal(render.ratio, 0.75);
  graphics.setMode('original');
  assert.equal(texture.anisotropy, 4);
  assert.equal(texture.minFilter, THREE.NearestFilter);
  assert.equal(texture.magFilter, THREE.NearestFilter);
  assert.equal(texture.generateMipmaps, false);
  graphics.dispose();
  assert.equal(assets.texture, originalMethod);
  assert.equal(render.ratio, 1.25);
});

test('scene lighting, fog and shared materials restore exactly through repeated toggles', () => {
  const graphics = manager();
  const render = renderer(16);
  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xf1f1df, 0x626d55, 2.1);
  const sun = new THREE.DirectionalLight(0xfff0cf, 1.5);
  const fog = new THREE.Fog(0xacc5cc, 180, 650);
  scene.fog = fog;
  const material = new THREE.MeshLambertMaterial({ color: 0x986641, map: new THREE.Texture() });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  const other = mesh.clone();
  const player = { group: new THREE.Group() };
  scene.add(hemi, sun, mesh, other, player.group);
  const colors = [hemi.color.getHex(), hemi.groundColor.getHex(), sun.color.getHex(), material.color.getHex()];
  graphics.applyRenderer(render).applyScene(scene, player);
  for (let i = 0; i < 3; i++) {
    graphics.setMode('enhanced');
    assert.equal(render.toneMapping, THREE.ACESFilmicToneMapping);
    assert.equal(render.shadowMap.enabled, false);
    assert.equal(mesh.material, other.material);
    assert.equal(mesh.material, material);
    assert.notEqual(scene.fog, fog);
    const shadow = scene.getObjectByName('enhanced-contact-shadow');
    assert.equal(shadow.geometry.index.count / 3, 2);
    graphics.update(new THREE.Vector3(2, 4, 3), { grounded: false });
    assert.equal(shadow.visible, false, 'airborne decal must not float at the feet');
    graphics.update(new THREE.Vector3(2, 4, 3), { grounded: false, groundY: 3 });
    assert.equal(shadow.visible, true);
    assert.equal(shadow.position.y, 3.018);
    graphics.setMode('original');
    assert.equal(render.toneMapping, THREE.NoToneMapping);
    assert.equal(render.toneMappingExposure, 1);
    assert.equal(scene.fog, fog);
    assert.equal(hemi.intensity, 2.1);
    assert.equal(sun.intensity, 1.5);
    assert.deepEqual([hemi.color.getHex(), hemi.groundColor.getHex(), sun.color.getHex(), material.color.getHex()], colors);
    assert.equal(shadow.visible, false);
  }
  assert.equal(scene.children.filter(child => child.name === 'enhanced-contact-shadow').length, 1);
  graphics.dispose();
  assert.equal(scene.getObjectByName('enhanced-contact-shadow'), undefined);
});

test('turning optional lighting off keeps enhanced textures but disables the contact decal', async () => {
  const graphics = manager();
  const render = renderer(8);
  const texture = new THREE.Texture();
  const assets = { textures: new Map([['t', texture]]), texture: async () => texture };
  const scene = new THREE.Scene();
  const player = { group: new THREE.Group() };
  scene.add(player.group);
  graphics.applyRenderer(render).applyScene(scene, player);
  await graphics.applyAssets(assets);
  graphics.setMode('enhanced');
  graphics.setLighting(false);
  assert.equal(graphics.mode, 'enhanced');
  assert.equal(texture.anisotropy, 8);
  assert.equal(render.toneMapping, THREE.NoToneMapping);
  assert.equal(scene.getObjectByName('enhanced-contact-shadow').visible, false);
  graphics.dispose();
});
