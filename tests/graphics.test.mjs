import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GraphicsManager, getGraphicsProfile, deriveSurfacePixels, reduceEnvironmentTexture } from '../js/graphics.js';

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

test('PBR conversion shares materials, restores Original appearance, and retains baseline object shadows', () => {
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
    assert.equal(mesh.castShadow, true);
    assert.equal(mesh.receiveShadow, true);
    assert.equal(sun.castShadow, true);
    assert.equal(render.shadowMap.enabled, true);
    assert.equal(sun.target.parent, scene);
    assert.equal(scene.fog, fog);
    assert.equal(hemi.intensity, 2.1);
    assert.equal(sun.intensity, 1.5);
    assert.deepEqual([hemi.color.getHex(), hemi.groundColor.getHex(), sun.color.getHex(), material.color.getHex()], colors);
    assert.equal(shadow.visible, false);
  }
  assert.equal(scene.children.filter(child => child.name === 'enhanced-contact-shadow').length, 0);
  graphics.dispose();
  assert.equal(scene.getObjectByName('enhanced-contact-shadow'), undefined);
  assert.equal(mesh.castShadow, false);
  assert.equal(mesh.receiveShadow, false);
  assert.equal(sun.castShadow, false);
  assert.deepEqual(sun.position, lightPosition);
  assert.equal(sun.target.parent, null);
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(sun.target.matrixWorld), new THREE.Vector3());
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
  assert.equal(sun.shadow.map, null, 'Original also uses the bounded baseline shadow map');
  assert.equal(sun.shadow.mapSize.x, 1024);
  assert.equal(disposed, 0);
  graphics.releaseScene(scene);
  assert.equal(sun.shadow.map, borrowed);
  assert.equal(sun.shadow.mapSize.x, 256);
  assert.equal(sun.castShadow, true);
  assert.equal(disposed, 0);
  graphics.dispose();
  assert.equal(disposed, 0);
  borrowed.dispose();
});

test('Original tables and parasols cast onto source ground without requiring Enhanced materials; economy disables the map', () => {
  const graphics = manager(), render = renderer(), scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(0xfff0cf, 1.5); sun.position.set(80, 180, 50);
  const material = new THREE.MeshLambertMaterial({ color: 0xe0d0b0 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80).rotateX(-Math.PI / 2), material);
  const table = new THREE.Mesh(new THREE.BoxGeometry(2, .1, 2), material); table.position.set(0, 1, 8);
  const canopy = new THREE.Mesh(new THREE.ConeGeometry(2, .6, 12), material); canopy.position.set(4, 2.5, 8);
  scene.add(sun, ground, table, canopy);
  graphics.applyRenderer(render).applyScene(scene);
  assert.equal(render.shadowMap.enabled, true); assert.equal(sun.castShadow, true);
  for (const mesh of [ground, table, canopy]) { assert.equal(mesh.castShadow, true); assert.equal(mesh.receiveShadow, true); assert.equal(mesh.material, material); }
  assert.equal(sun.intensity, 1.5); assert.equal(graphics.diagnostics.pbrMaterials, 0);
  graphics.setMode('potato'); assert.equal(render.shadowMap.enabled, false);
  graphics.setMode('original'); assert.equal(render.shadowMap.enabled, true);
  graphics.dispose(); assert.equal(render.shadowMap.enabled, false);
  for (const mesh of [ground, table, canopy]) mesh.geometry.dispose(); material.dispose();
});

test('characters cast onto the world without receiving shadows from earlier poses', () => {
  const graphics = manager(), render = renderer(), scene = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshLambertMaterial();
  const character = new THREE.Mesh(geometry, material), ground = new THREE.Mesh(geometry, material);
  character.userData.characterSurface = true;
  scene.add(new THREE.DirectionalLight(), character, ground);
  graphics.applyRenderer(render).applyScene(scene);
  try {
    for (const mode of ['original', 'enhanced']) {
      graphics.setMode(mode);
      assert.equal(character.castShadow, true);
      assert.equal(character.receiveShadow, false);
      assert.equal(ground.receiveShadow, true);
    }
  } finally {
    graphics.dispose(); geometry.dispose(); material.dispose();
  }
});

test('sun shadow frustum follows distant and elevated players, covers visible nearby props, and refreshes immediately after recovery', () => {
  const graphics = manager(), render = renderer(), scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(); sun.position.set(80, 180, 50); scene.add(sun);
  const camera = new THREE.PerspectiveCamera(67, 1, .08, 1000);
  const weapon = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); weapon.userData.graphicsOwned = true; weapon.castShadow = true; camera.add(weapon);
  graphics.applyRenderer(render).applyScene(scene);
  for (const mode of ['original', 'enhanced']) {
    graphics.setMode(mode);
    for (const quality of ['high', 'low']) {
      graphics.setQuality(quality);
      const player = new THREE.Vector3(135, -22, -50); camera.position.copy(player).add(new THREE.Vector3(0, 1.4, 0)); camera.lookAt(player.clone().add(new THREE.Vector3(0, 1.4, 40)));
      graphics.update(player, { dt: 0, camera }); scene.updateMatrixWorld(true); sun.shadow.updateMatrices(sun);
      const point = player.clone().add(new THREE.Vector3(0, 1.5, 8)).applyMatrix4(sun.shadow.camera.matrixWorldInverse).applyMatrix4(sun.shadow.camera.projectionMatrix);
      assert.ok(Math.abs(point.x) < 1 && Math.abs(point.y) < 1 && Math.abs(point.z) < 1, 'nearby tabletop and ground fit inside the actual shadow frustum');
      assert.ok(sun.shadow.mapSize.x <= 1024); assert.ok(sun.shadow.normalBias <= .025);
      render.shadowMap.needsUpdate = false; sun.shadow.needsUpdate = false;
      graphics.update(new THREE.Vector3(-130, 33, 75), { dt: 0 });
      assert.equal(sun.shadow.needsUpdate, true); assert.equal(render.shadowMap.needsUpdate, true);
      assert.ok(sun.target.position.distanceTo(new THREE.Vector3(-130, 35, 75)) < .1, 'teleport/recovery does not wait for the refresh timer');
      assert.equal(weapon.castShadow, false);
    }
  }
  graphics.dispose(); weapon.geometry.dispose(); weapon.material.dispose();
});

test('stationary objects keep their shadow texel alignment when the player moves and turns', () => {
  const graphics = manager(), render = renderer(), scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(); sun.position.set(80, 180, 50); scene.add(sun);
  const camera = new THREE.PerspectiveCamera();
  const crate = new THREE.Vector3(45, 3, -14);
  graphics.applyRenderer(render).applyScene(scene);
  const shadowPixel = (player, angle) => {
    camera.rotation.y = angle;
    graphics.update(player, { dt: .1, camera });
    scene.updateMatrixWorld(true);
    sun.shadow.updateMatrices(sun);
    return crate.clone().applyMatrix4(sun.shadow.matrix).multiplyScalar(sun.shadow.mapSize.x);
  };
  try {
    for (const mode of ['original', 'enhanced']) {
      graphics.setMode(mode);
      for (const quality of ['high', 'low']) {
        graphics.setQuality(quality);
        const before = shadowPixel(new THREE.Vector3(42, 2, -13), .14);
        const after = shadowPixel(new THREE.Vector3(42.031, 2.107, -12.993), .21);
        for (const delta of [after.x - before.x, after.y - before.y]) {
          assert.ok(Math.abs(delta - Math.round(delta)) < 1e-8, `${mode}/${quality}: moved ${delta} texels`);
        }
      }
    }
  } finally { graphics.dispose(); }
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

test('HDR preparation is lazy, deduplicated, bounded, and restores the original sky exactly', async () => {
  let loads=0;
  const texture=new THREE.DataTexture(new Float32Array([1,1,1,1, 6,6,6,1, .1,.2,.3,1, .2,.3,.4,1]),2,2,THREE.RGBAFormat,THREE.FloatType);
  texture.flipY=true;let disposals=0;texture.addEventListener('dispose',()=>disposals++);
  const graphics=manager({loadEnvironment:async url=>{loads++;assert.match(url,/kloofendal_48d_partly_cloudy_puresky\.hdr$/);return texture;}});
  const assets={textures:new Map(),texture:async()=>new THREE.Texture(),url:path=>'https://local.test/'+path};
  await graphics.applyAssets(assets);
  const scene=new THREE.Scene(),original=new THREE.Color(0xacc5cc);scene.background=original;
  graphics.applyRenderer(renderer()).applyScene(scene);
  assert.equal(await graphics.prepareEnvironment(),null);
  assert.equal(loads,0);
  graphics.setMode('enhanced');
  const [a,b]=await Promise.all([graphics.prepareEnvironment(),graphics.prepareEnvironment()]);
  assert.equal(a,texture);assert.equal(b,texture);assert.equal(loads,1);
  assert.equal(scene.background,texture);
  assert.equal(graphics.diagnostics.sky,'poly-haven-hdr');
  graphics.setMode('original');
  assert.equal(scene.background,original);
  graphics.setMode('enhanced');await graphics.prepareEnvironment();assert.equal(loads,1);
  graphics.dispose();assert.equal(disposals,1);assert.equal(scene.background,original);
});

test('a late HDR load cannot re-enable enhancements after a mode switch or disposal', async () => {
  let resolve;
  const texture=new THREE.DataTexture(new Float32Array(16).fill(1),2,2,THREE.RGBAFormat,THREE.FloatType);
  let disposed=0;texture.addEventListener('dispose',()=>disposed++);
  const graphics=manager({loadEnvironment:()=>new Promise(done=>{resolve=done;})});
  await graphics.applyAssets({textures:new Map(),texture:async()=>null,url:path=>path});
  const scene=new THREE.Scene(),original=new THREE.Color(0x123456);scene.background=original;
  graphics.applyRenderer(renderer()).applyScene(scene).setMode('enhanced');
  const pending=graphics.prepareEnvironment();
  graphics.setMode('original');graphics.dispose();resolve(texture);
  assert.equal(await pending,null);assert.equal(scene.background,original);assert.equal(disposed,1);
});

test('HDR reduction averages bright radiance instead of clipping or dropping sun pixels', () => {
  const pixels=new Float32Array(8*4*4).fill(1);
  pixels[0]=pixels[1]=pixels[2]=17;
  const source=new THREE.DataTexture(pixels,8,4,THREE.RGBAFormat,THREE.FloatType);source.flipY=true;
  const result=reduceEnvironmentTexture(source,4);
  assert.equal(result.image.width,4);assert.equal(result.image.height,2);
  assert.equal(result.image.data[0],5);
  assert.equal(result.image.data[3],1);
  assert.equal(result.flipY,true);
  assert.equal(result.colorSpace,THREE.LinearSRGBColorSpace);
  assert.equal(source.image.width,8);
  result.dispose();source.dispose();
});
