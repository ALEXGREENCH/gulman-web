import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GraphicsManager, getGraphicsProfile, deriveSurfacePixels } from '../js/graphics.js';

function renderer(maxAnisotropy = 4) {
  return {
    toneMapping: THREE.NoToneMapping, toneMappingExposure: 1,
    outputColorSpace: THREE.SRGBColorSpace, ratio: 1.25,
    shadowMap: { enabled: false, type: THREE.PCFShadowMap, autoUpdate: true, needsUpdate: false }, capabilities: { getMaxAnisotropy: () => maxAnisotropy },
    getPixelRatio() { return this.ratio; }, setPixelRatio(value) { this.ratio = value; },
    getSize(value) { return value.set(1920, 1080); },
    render() { this.renderCalls = (this.renderCalls ?? 0) + 1; },
  };
}

const manager = options => new GraphicsManager({ storage: null, document: null, ...options });

test('quality profiles cap high-density displays and preserve one-pass original/economy', () => {
  assert.equal(getGraphicsProfile('enhanced', 4).pixelRatio, 1.5);
  assert.equal(getGraphicsProfile('potato', 4).pixelRatio, 0.75);
  assert.equal(getGraphicsProfile('original', 1).pixelRatio, 1);
  assert.equal(getGraphicsProfile('original', Infinity).pixelRatio, 1);
  assert.equal(getGraphicsProfile('original', NaN).pixelRatio, 1);
  assert.equal(getGraphicsProfile('unknown', 2).mode, 'original');
  for (const mode of ['original', 'potato']) assert.equal(getGraphicsProfile(mode).postPasses, 0);
  assert.equal(getGraphicsProfile('enhanced').postPasses, 4);
});

test('settings survive reload; blocked/corrupt storage falls back to original', () => {
  let saved = null;
  const storage = { getItem: () => saved, setItem: (_, value) => { saved = value; } };
  const graphics = manager({ storage });
  assert.equal(graphics.mode, 'original');
  graphics.setMode('potato').setLighting(false).setQuality('low');
  const restored = manager({ storage });
  assert.equal(restored.mode, 'potato');
  assert.equal(restored.lighting, false);
  assert.equal(restored.quality, 'low');
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

test('PBR conversion shares materials and restores light targets, fog, materials and shadow flags', () => {
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
  const lightPosition = sun.position.clone();
  graphics.applyRenderer(render).applyScene(scene, player);
  for (let i = 0; i < 3; i++) {
    graphics.setMode('enhanced');
    assert.equal(render.toneMapping, THREE.ACESFilmicToneMapping);
    assert.equal(render.shadowMap.enabled, true);
    assert.equal(sun.castShadow, true);
    assert.equal(sun.shadow.mapSize.x, 1024);
    assert.equal(mesh.castShadow, true);
    assert.equal(mesh.receiveShadow, true);
    assert.equal(mesh.material, other.material);
    assert.equal(mesh.material.isMeshStandardMaterial, true);
    assert.notEqual(mesh.material, material);
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
    assert.equal(mesh.material, material);
    assert.equal(other.material, material);
    assert.equal(mesh.castShadow, false);
    assert.equal(mesh.receiveShadow, false);
    assert.equal(sun.castShadow, false);
    assert.deepEqual(sun.position, lightPosition);
    assert.equal(sun.target.parent, null);
    assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(sun.target.matrixWorld), new THREE.Vector3());
    assert.equal(scene.fog, fog);
    assert.equal(hemi.intensity, 2.1);
    assert.equal(sun.intensity, 1.5);
    assert.deepEqual([hemi.color.getHex(), hemi.groundColor.getHex(), sun.color.getHex(), material.color.getHex()], colors);
    assert.equal(shadow.visible, false);
  }
  assert.equal(scene.children.filter(child => child.name === 'enhanced-contact-shadow').length, 0);
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
  assert.equal(render.shadowMap.enabled, false);
  assert.equal(scene.getObjectByName('enhanced-contact-shadow').visible, false);
  graphics.dispose();
});

function detailTexture() {
  const pixels = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < 64; i++) {
    pixels[i * 4] = i % 2 ? 120 : 200;
    pixels[i * 4 + 1] = 140;
    pixels[i * 4 + 2] = 160;
    pixels[i * 4 + 3] = 255;
  }
  return new THREE.DataTexture(pixels, 8, 8);
}

test('derived surface pixels are deterministic, bounded normals with roughness in the green channel', () => {
  const source = detailTexture().image;
  const data = deriveSurfacePixels(source.data, 8, 8);
  assert.deepEqual(data, deriveSurfacePixels(source.data, 8, 8));
  for (let i = 0; i < 64; i++) {
    const n = new THREE.Vector3(...data.normal.slice(i * 4, i * 4 + 3)).divideScalar(255).multiplyScalar(2).subScalar(1);
    assert.ok(Math.abs(n.length() - 1) < 0.015);
    assert.ok(n.z > 0.7, 'relief should not radically alter the original surface');
    assert.ok(data.roughness[i * 4 + 1] >= 166 && data.roughness[i * 4 + 1] <= 255);
  }
});

test('quality low removes detail samplers, bounds pixels, and uses a 512 shadow map', () => {
  const graphics = manager();
  const render = renderer(8);
  const scene = new THREE.Scene();
  const source = new THREE.MeshLambertMaterial({ map: detailTexture() });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), source);
  mesh.name = 'world:stone';
  const sun = new THREE.DirectionalLight();
  scene.add(mesh, sun);
  graphics.applyRenderer(render).applyScene(scene).setMode('enhanced');
  assert.ok(mesh.material.normalMap);
  assert.ok(mesh.material.roughnessMap);
  assert.equal(mesh.material.defines.GULMAN_MICRODETAIL, 1);
  graphics.setQuality('low');
  assert.equal(mesh.material.normalMap, null);
  assert.equal(mesh.material.roughnessMap, null);
  assert.equal(Object.hasOwn(mesh.material.defines, 'GULMAN_MICRODETAIL'), false);
  assert.equal(sun.shadow.mapSize.x, 512);
  graphics.resize(7680, 4320);
  assert.ok(graphics.diagnostics.pixelRatio ** 2 * 7680 * 4320 <= 1000001);
  graphics.setQuality('high');
  assert.ok(mesh.material.normalMap);
  assert.equal(mesh.material.defines.GULMAN_MICRODETAIL, 1);
  assert.equal(sun.shadow.mapSize.x, 1024);
  graphics.dispose();
});

test('releasing levels frees only owned PBR/detail/shadow resources, including instanced batches', async () => {
  const graphics = manager();
  const render = renderer(8);
  const texture = detailTexture();
  const original = new THREE.MeshLambertMaterial({ map: texture });
  let originalDisposals = 0;
  original.addEventListener('dispose', () => originalDisposals++);
  texture.addEventListener('dispose', () => originalDisposals++);
  const assets = { textures: new Map([['t', texture]]), texture: async () => texture, model: async () => {
    const group = new THREE.Group(); group.add(new THREE.Mesh(new THREE.BoxGeometry(), original)); return group;
  } };
  const originalModel = assets.model;
  await graphics.applyAssets(assets);
  graphics.applyRenderer(render).setMode('enhanced');
  for (let level = 0; level < 3; level++) {
    const sourceGroup = await assets.model('model');
    const converted = sourceGroup.children[0].material;
    const instance = new THREE.InstancedMesh(sourceGroup.children[0].geometry, converted, 5);
    const scene = new THREE.Scene();
    const sun = new THREE.DirectionalLight();
    scene.add(instance, sun);
    graphics.applyScene(scene);
    assert.equal(instance.material, converted, 'crowd retains one shared PBR material');
    let ownedDisposals = 0;
    converted.addEventListener('dispose', () => ownedDisposals++);
    converted.normalMap.addEventListener('dispose', () => ownedDisposals++);
    converted.roughnessMap.addEventListener('dispose', () => ownedDisposals++);
    sun.shadow.map = new THREE.WebGLRenderTarget(8, 8);
    sun.shadow.map.addEventListener('dispose', () => ownedDisposals++);
    const lateWeapon = await assets.model('late weapon');
    scene.add(lateWeapon);
    graphics.releaseScene(scene);
    assert.equal(instance.material, original);
    assert.equal(lateWeapon.children[0].material, original);
    assert.equal(instance.castShadow, false);
    assert.equal(sun.shadow.map, null);
    assert.equal(ownedDisposals, 4);
    assert.equal(graphics.diagnostics.pbrMaterials, 0);
    assert.equal(graphics.diagnostics.detailTextures, 0);
  }
  graphics.dispose();
  assert.equal(originalDisposals, 0);
  assert.equal(assets.model, originalModel);
});

test('an existing application-owned shadow map is restored rather than disposed', () => {
  const graphics = manager();
  const render = renderer();
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight();
  const borrowed = new THREE.WebGLRenderTarget(256, 256);
  let disposed = 0;
  borrowed.addEventListener('dispose', () => disposed++);
  sun.castShadow = true;
  sun.shadow.map = borrowed;
  sun.shadow.mapSize.set(256, 256);
  scene.add(sun);
  graphics.applyRenderer(render).applyScene(scene).setMode('enhanced');
  assert.equal(sun.shadow.map, null, 'owned enhanced map is allocated by the renderer later');
  graphics.setMode('original');
  assert.equal(sun.shadow.map, borrowed);
  assert.equal(sun.shadow.mapSize.x, 256);
  assert.equal(sun.castShadow, true);
  assert.equal(disposed, 0);
  graphics.dispose();
  assert.equal(disposed, 0);
  borrowed.dispose();
});

test('automatic quality responds to sustained slow frames, but original/economy stay direct', () => {
  const graphics = manager();
  const render = renderer();
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  graphics.applyRenderer(render).setMode('enhanced');
  graphics._post = { setQuality() {}, setSize() {}, render() {}, dispose() {} };
  for (let frame = 0; frame < 300; frame++) graphics.render(render, scene, camera, 0.05);
  assert.equal(graphics.diagnostics.effectiveQuality, 'low');
  assert.ok(graphics.diagnostics.renderScale <= 0.7);
  assert.ok(render.ratio < 0.75);
  graphics.setMode('potato');
  for (let frame = 0; frame < 20; frame++) graphics.render(render, scene, camera, 0.1);
  assert.equal(render.renderCalls, 20);
  assert.equal(render.ratio, 0.75);
  assert.equal(graphics.diagnostics.postprocessing, null);
  graphics.setMode('original');
  graphics.render(render, scene, camera, 0.1);
  assert.equal(render.renderCalls, 21);
  assert.equal(graphics.diagnostics.pbrMaterials, 0);
  graphics.dispose();
});

test('water uses archived texture names and horizontal geometry, not misleading old material names', async () => {
  const graphics = manager();
  const names = ['levels/1/beach.jpg', 'levels/1/water.jpg', 'levels/7/water.jpg', 'levels/3/urna.jpg'];
  const textures = names.map(detailTexture);
  const assets = {
    manifest: { images: Object.fromEntries(names.map((name, index) => [name, `assets/${index}.jpg`])) },
    textures: new Map(), texture: async ({ map }) => textures[Number(map.match(/(\d+)\.jpg/)[1])],
  };
  await graphics.applyAssets(assets);
  await Promise.all(textures.map((_, index) => assets.texture({ map: `assets/${index}.jpg` })));
  const sand = new THREE.Mesh(new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: textures[0] }));
  sand.name = 'world:waterf1';
  const water = new THREE.Mesh(sand.geometry, new THREE.MeshLambertMaterial({ map: textures[1] }));
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(3, 2), new THREE.MeshLambertMaterial({ map: textures[2] }));
  const urn = new THREE.Mesh(sand.geometry, new THREE.MeshLambertMaterial({ map: textures[3] }));
  urn.name = 'world:water';
  const scene = new THREE.Scene(); scene.add(sand, water, panel, urn);
  graphics.applyRenderer(renderer()).applyScene(scene).setMode('enhanced');
  assert.equal(sand.material.userData.water, false);
  assert.equal(sand.material.metalness, 0);
  assert.equal(sand.material.defines.GULMAN_MICRODETAIL, 1);
  assert.equal(water.material.userData.water, true);
  assert.equal(Object.hasOwn(water.material.defines, 'GULMAN_MICRODETAIL'), false);
  assert.equal(panel.material.userData.water, false);
  assert.equal(urn.material.userData.water, false);
  const initial = water.material.normalMap.offset.clone();
  graphics.update(new THREE.Vector3(), { time: 10 });
  assert.notDeepEqual(water.material.normalMap.offset, initial);
  graphics.setMode('original');
  assert.equal(water.material.isMeshLambertMaterial, true);
  graphics.dispose();
});
