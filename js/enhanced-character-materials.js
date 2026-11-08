import * as THREE from 'three';

const KINDS = Object.freeze(['skin', 'cloth', 'suit', 'leather', 'hair', 'metal', 'eye', 'denim']);
const ROOT = 'assets/enhanced/characters/';
const FACES = ['gulman','dama','box','bugay','ded','brucelee','boss'];
const RECT = new Map(KINDS.map((kind, index) => [kind, Object.freeze({
  x: (index % 4 * 256 + 8) / 1024,
  y: 1 - (Math.floor(index / 4) * 256 + 248) / 512,
  width: 240 / 1024,
  height: 240 / 512,
})]));

function dataTexture(data, width = 1, height = 1, color = false) {
  const texture = new THREE.DataTexture(new Uint8Array(data), width, height, THREE.RGBAFormat);
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.userData.graphicsOwned = true;
  texture.needsUpdate = true;
  return texture;
}

/** One shared material UUID for all Enhanced people and all skeleton pieces.
 * Primitive UVs are remapped into uvRect(kind); vertex colors carry each
 * character's costume/skin palette. Constructor is synchronous and never loads.
 * Call await load() only for Enhanced; ready is a lazy alias for the same promise.
 * The caller owns this library and must dispose it after all its skins/crowds.
 */
export function createEnhancedCharacterMaterials(options = {}) {
  if (typeof options.url === 'function') options = { assets: options };
  const { assets, textureLoader = new THREE.TextureLoader(), onError = () => {}, anisotropy = 4 } = options;
  const url = path => assets?.url ? assets.url(path) : new URL('../' + path, import.meta.url).href;
  const color = dataTexture([255, 255, 255, 255], 1, 1, true);
  const normal = dataTexture([128, 128, 255, 255]);
  // DataTexture row 0 is UV bottom. Image atlases are flipped on upload and
  // place skin/cloth/suit/leather in the upper row, so reverse fallback rows.
  const orm = dataTexture([
    255, 155, 0, 255, 255, 68, 255, 255, 255, 32, 0, 255, 255, 210, 0, 255,
    255, 150, 0, 255, 255, 215, 0, 255, 255, 180, 0, 255, 255, 135, 0, 255,
  ], 4, 2);
  const owned = new Set([color, normal, orm]);
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, map: color, normalMap: normal,
    roughness: 1, roughnessMap: orm, metalness: 1, metalnessMap: orm,
    normalScale: new THREE.Vector2(1, 1), envMapIntensity: 0.5,
  });
  material.name = 'Enhanced shared character atlas';
  material.userData.graphicsOwned = true;
  material.userData.enhancedCharacterAtlas = true;
  const faceMaterial = new THREE.MeshStandardMaterial({color:0xffffff,map:color,roughness:.7,metalness:0,envMapIntensity:.5});
  faceMaterial.name='Enhanced reconstructed face atlas';faceMaterial.userData.graphicsOwned=true;
  let pending = null, disposed = false, loaded = false;

  const bundle = {
    material,
    faceMaterial,
    faceRect(name){const index=FACES.indexOf(String(name).toLowerCase());if(index<0)throw new RangeError(`Unknown face: ${name}`);return {x:index%4/4+.001,y:1-(Math.floor(index/4)+1)/2+.001,width:.248,height:.498};},
    uvRect(kind) {
      const rect = RECT.get(kind);
      if (!rect) throw new RangeError(`Unknown Enhanced character surface: ${kind}`);
      return rect;
    },
    get loaded() { return loaded; },
    get disposed() { return disposed; },
    get ready() { return bundle.load(); },
    load() {
      if (disposed) return Promise.resolve(false);
      if (pending) return pending;
      pending = (async () => {
        const results = await Promise.allSettled(['color', 'normal', 'orm', 'face'].map(async channel => {
          const texture = await textureLoader.loadAsync(url(`${ROOT}${channel==='face'?'face-color':'character-'+channel}.webp`));
          texture.colorSpace = channel === 'color'||channel==='face' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          texture.flipY = true;
          texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
          texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter;
          texture.anisotropy = anisotropy;
          texture.userData.graphicsOwned = true;
          return texture;
        }));
        const textures = results.filter(result => result.status === 'fulfilled').map(result => result.value);
        const failure = results.find(result => result.status === 'rejected');
        if (disposed || failure) {
          for (const texture of textures) texture.dispose();
          if (failure && !disposed) { pending = null; onError(`Character materials: ${failure.reason?.message ?? failure.reason}`); }
          return false;
        }
        const [newColor, newNormal, newORM, newFace] = results.map(result => result.value);
        material.map = newColor; material.normalMap = newNormal;
        material.roughnessMap = material.metalnessMap = newORM;
        faceMaterial.map=newFace;faceMaterial.needsUpdate=true;
        for (const old of owned) old.dispose();
        owned.clear(); for (const texture of textures) owned.add(texture);
        material.needsUpdate = true;
        loaded = true;
        return true;
      })();
      return pending;
    },
    dispose() {
      if (disposed) return;
      disposed = true; loaded = false;
      material.dispose();
      faceMaterial.dispose();
      for (const texture of owned) texture.dispose();
      owned.clear();
    },
  };
  return bundle;
}
