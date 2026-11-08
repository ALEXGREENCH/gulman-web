import * as THREE from 'three';

const STORAGE_KEY = 'gulman-web-graphics-v1';
const SHARPEN_ID = 'gulman-art-sharpen';
const SVG_NS = 'http://www.w3.org/2000/svg';

export const GRAPHICS_MODES = Object.freeze({
  original: Object.freeze({ label: 'Оригинал', pixelRatioCap: 1.5, anisotropy: 4, artEnhancement: false }),
  enhanced: Object.freeze({ label: 'Улучшенный', pixelRatioCap: 1.5, anisotropy: 8, artEnhancement: true }),
  potato: Object.freeze({ label: 'Экономный', pixelRatioCap: 0.75, anisotropy: 1, artEnhancement: false }),
});

/** One bounded render resolution, with no post-processing render targets. */
export function getGraphicsProfile(mode = 'original', deviceRatio = globalThis.devicePixelRatio ?? 1) {
  const resolved = Object.hasOwn(GRAPHICS_MODES, mode) ? mode : 'original';
  const ratio = Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1;
  return { mode: resolved, ...GRAPHICS_MODES[resolved], pixelRatio: Math.min(ratio, GRAPHICS_MODES[resolved].pixelRatioCap), postPasses: 0 };
}

function browserStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}

/**
 * Optional, reversible improvements to the original assets. No AI upscaling,
 * ray tracing, screen-space effects or extra scene render are performed.
 *
 * Call applyAssets once before loading models; it also handles cached promises.
 * After loading: applyRenderer(renderer); applyScene(scene, player).
 * On resize: applyRenderer(renderer). Each frame: update(feet, {grounded}).
 * groundY can instead provide the measured floor under an airborne player.
 */
export class GraphicsManager {
  constructor({ onChange = () => {}, storage = browserStorage(), document: ownerDocument = globalThis.document } = {}) {
    this.onChange = onChange;
    this.storage = storage;
    this.document = ownerDocument;
    this.mode = 'original';
    this.lighting = true;
    try {
      const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
      if (Object.hasOwn(GRAPHICS_MODES, saved?.mode)) this.mode = saved.mode;
      if (typeof saved?.lighting === 'boolean') this.lighting = saved.lighting;
    } catch { /* Storage is optional, including private browsing. */ }
    this._renderer = null;
    this._scene = null;
    this._player = null;
    this._rendererStates = new WeakMap();
    this._sceneStates = new WeakMap();
    this._textureStates = new WeakMap();
    this._textures = new Set();
    this._assetBindings = new Map();
    this._maxAnisotropy = 1;
    this._shadow = null;
    this._disposed = false;
    this._applyDocument();
  }

  get profile() { return getGraphicsProfile(this.mode); }
  get enhancedLighting() { return this.mode === 'enhanced' && this.lighting; }

  _persist() {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify({ mode: this.mode, lighting: this.lighting })); } catch { /* Keep working without persistent storage. */ }
  }

  _applyDocument() {
    const doc = this.document;
    if (!doc?.documentElement) return;
    doc.documentElement.dataset.graphics = this.mode;
    doc.documentElement.dataset.graphicsLighting = String(this.enhancedLighting);
    // A small convolution is applied to static original illustrations only.
    // Unlike display:none, a zero-size SVG keeps its filter available in Safari.
    if (this.mode !== 'enhanced' || doc.getElementById(SHARPEN_ID)) return;
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('focusable', 'false');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    const defs = doc.createElementNS(SVG_NS, 'defs');
    const filter = doc.createElementNS(SVG_NS, 'filter');
    filter.id = SHARPEN_ID;
    filter.setAttribute('x', '0');
    filter.setAttribute('y', '0');
    filter.setAttribute('width', '100%');
    filter.setAttribute('height', '100%');
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const sharpen = doc.createElementNS(SVG_NS, 'feConvolveMatrix');
    sharpen.setAttribute('order', '3');
    sharpen.setAttribute('kernelMatrix', '0 -0.065 0 -0.065 1.26 -0.065 0 -0.065 0');
    sharpen.setAttribute('divisor', '1');
    sharpen.setAttribute('bias', '0');
    sharpen.setAttribute('edgeMode', 'duplicate');
    sharpen.setAttribute('preserveAlpha', 'true');
    filter.append(sharpen);
    defs.append(filter);
    svg.append(defs);
    (doc.body ?? doc.documentElement).append(svg);
  }

  applyAssets(assets) {
    if (!assets || this._disposed) return Promise.resolve([]);
    if (!this._assetBindings.has(assets)) {
      const original = assets.texture;
      const manager = this;
      const wrapped = async function (...args) {
        const texture = await original.apply(this, args);
        if (!manager._disposed) manager._configureTexture(texture);
        return texture;
      };
      this._assetBindings.set(assets, { original, wrapped });
      assets.texture = wrapped;
    }
    // Do not replace cache entries or create duplicate textures/materials.
    return Promise.all([...assets.textures?.values() ?? []].map(value => Promise.resolve(value)
      .then(texture => { if (!this._disposed) this._configureTexture(texture); return texture; })
      .catch(() => undefined)));
  }

  _configureTexture(texture, restore = false) {
    if (!texture?.isTexture || texture.userData?.graphicsOwned) return;
    let original = this._textureStates.get(texture);
    if (!original) {
      original = { anisotropy: texture.anisotropy, minFilter: texture.minFilter, magFilter: texture.magFilter, generateMipmaps: texture.generateMipmaps };
      this._textureStates.set(texture, original);
      this._textures.add(texture);
    }
    const desired = { ...original };
    if (!restore && this.mode !== 'original') {
      desired.anisotropy = Math.min(this.profile.anisotropy, this._maxAnisotropy);
      // Special textures can have externally supplied mip chains or live data.
      // Only ordinary loaded images get automatic mipmaps.
      if (!texture.isVideoTexture && !texture.isCompressedTexture && !texture.isDepthTexture && !texture.isDataTexture && !texture.isDataArrayTexture && !texture.isRenderTargetTexture) {
        desired.generateMipmaps = true;
        desired.minFilter = THREE.LinearMipmapLinearFilter;
        desired.magFilter = THREE.LinearFilter;
      }
    }
    let changed = false;
    for (const [key, value] of Object.entries(desired)) {
      if (texture[key] !== value) { texture[key] = value; changed = true; }
    }
    if (changed) texture.needsUpdate = true;
  }

  applyRenderer(renderer) {
    if (!renderer || this._disposed) return this;
    this._renderer = renderer;
    if (!this._rendererStates.has(renderer)) this._rendererStates.set(renderer, {
      toneMapping: renderer.toneMapping,
      toneMappingExposure: renderer.toneMappingExposure,
      outputColorSpace: renderer.outputColorSpace,
      pixelRatio: renderer.getPixelRatio?.() ?? 1,
      shadows: renderer.shadowMap?.enabled,
    });
    const original = this._rendererStates.get(renderer);
    const maximum = Number(renderer.capabilities?.getMaxAnisotropy?.() ?? 1);
    this._maxAnisotropy = Number.isFinite(maximum) ? Math.max(1, maximum) : 1;
    renderer.setPixelRatio(this.profile.pixelRatio);
    renderer.toneMapping = this.enhancedLighting ? THREE.ACESFilmicToneMapping : original.toneMapping;
    renderer.toneMappingExposure = this.enhancedLighting ? 1.08 : original.toneMappingExposure;
    renderer.outputColorSpace = original.outputColorSpace;
    if (renderer.shadowMap) renderer.shadowMap.enabled = this.mode === 'potato' ? false : original.shadows;
    for (const texture of this._textures) this._configureTexture(texture);
    return this;
  }

  applyScene(scene, player = this._player) {
    if (!scene || this._disposed) return this;
    if (scene !== this._scene) this._shadow?.removeFromParent();
    this._scene = scene;
    this._player = player;
    let original = this._sceneStates.get(scene);
    if (!original) {
      original = { fog: scene.fog, lights: new Map() };
      this._sceneStates.set(scene, original);
    }
    scene.traverse(object => {
      if (object.userData?.graphicsOwned) return;
      if (object.isHemisphereLight || object.isAmbientLight || object.isDirectionalLight) {
        if (!original.lights.has(object)) original.lights.set(object, {
          intensity: object.intensity, color: object.color.clone(), groundColor: object.groundColor?.clone(),
        });
      }
      if (object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) for (const value of Object.values(material)) {
          if (value?.isTexture) this._configureTexture(value);
        }
      }
    });
    for (const [light, saved] of original.lights) {
      light.intensity = saved.intensity;
      light.color.copy(saved.color);
      if (saved.groundColor) light.groundColor.copy(saved.groundColor);
      if (this.enhancedLighting) {
        if (light.isDirectionalLight) {
          light.intensity *= 1.25;
          light.color.lerp(new THREE.Color(0xffefcf), 0.16);
        } else {
          light.intensity *= 0.78;
          light.color.lerp(new THREE.Color(0xe2edff), 0.12);
          light.groundColor?.lerp(new THREE.Color(0x685e4a), 0.2);
        }
      }
    }
    scene.fog = original.fog;
    if (this.enhancedLighting && original.fog?.isFog) {
      const fog = original.enhancedFog ??= original.fog.clone();
      fog.near = original.fog.near * 1.05;
      fog.far = Math.max(fog.near + 1, original.fog.far * 0.94);
      scene.fog = fog;
    }
    if (this.enhancedLighting && player) {
      this._ensureShadow();
      scene.add(this._shadow);
      this.update((player.group ?? player).position);
    } else if (this._shadow) this._shadow.visible = false;
    return this;
  }

  _ensureShadow() {
    if (this._shadow) return;
    const size = 32;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const radius = Math.hypot((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1);
      const alpha = Math.pow(Math.max(0, 1 - radius), 1.7) * 0.48;
      data[(y * size + x) * 4 + 3] = Math.round(alpha * 255);
    }
    const texture = new THREE.DataTexture(data, size, size);
    texture.userData.graphicsOwned = true;
    texture.magFilter = texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    const material = new THREE.MeshBasicMaterial({
      map: texture, color: 0x000000, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      toneMapped: false,
    });
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.65, 1.25), material);
    shadow.name = 'enhanced-contact-shadow';
    shadow.rotation.x = -Math.PI / 2;
    shadow.userData.graphicsOwned = true;
    shadow.userData.collision = false;
    shadow.renderOrder = 1;
    this._shadow = shadow;
  }

  /** A single 2-triangle contact decal, no geometry raycasts or shadow pass. */
  update(position, { groundY, grounded = true } = {}) {
    const shadow = this._shadow;
    if (!shadow) return;
    const measuredGround = Number.isFinite(groundY);
    const floor = measuredGround ? groundY : position?.y;
    const height = position ? Math.max(0, position.y - floor) : Infinity;
    shadow.visible = Boolean(this.enhancedLighting && position && Number.isFinite(position.x) && Number.isFinite(position.z) && Number.isFinite(floor) && (grounded || measuredGround) && height < 2.5);
    if (!shadow.visible) return;
    shadow.position.set(position.x, floor + 0.018, position.z);
    shadow.scale.setScalar(1 + Math.min(height, 2) * 0.22);
    shadow.material.opacity = Math.max(0, 1 - height / 2.5);
  }

  setMode(mode, { renderer = this._renderer, scene = this._scene, player = this._player } = {}) {
    if (!Object.hasOwn(GRAPHICS_MODES, mode)) throw new RangeError(`Неизвестный режим графики: ${mode}`);
    this.mode = mode;
    this._persist();
    this._applyDocument();
    if (renderer) this.applyRenderer(renderer);
    else for (const texture of this._textures) this._configureTexture(texture);
    if (scene) this.applyScene(scene, player);
    this.onChange(this.mode, { lighting: this.lighting, profile: this.profile });
    return this;
  }

  setLighting(enabled, context) {
    this.lighting = Boolean(enabled);
    return this.setMode(this.mode, context);
  }

  dispose() {
    if (this._disposed) return;
    this.mode = 'original';
    if (this._scene) this.applyScene(this._scene, null);
    for (const texture of this._textures) this._configureTexture(texture, true);
    for (const [assets, binding] of this._assetBindings) if (assets.texture === binding.wrapped) assets.texture = binding.original;
    const renderer = this._renderer;
    const saved = renderer && this._rendererStates.get(renderer);
    if (saved) {
      renderer.toneMapping = saved.toneMapping;
      renderer.toneMappingExposure = saved.toneMappingExposure;
      renderer.outputColorSpace = saved.outputColorSpace;
      renderer.setPixelRatio(saved.pixelRatio);
      if (renderer.shadowMap) renderer.shadowMap.enabled = saved.shadows;
    }
    if (this._shadow) {
      this._shadow.removeFromParent();
      this._shadow.geometry.dispose();
      this._shadow.material.map.dispose();
      this._shadow.material.dispose();
    }
    this._shadow = this._scene = this._player = this._renderer = null;
    this._assetBindings.clear();
    this._textures.clear();
    this._applyDocument();
    this._disposed = true;
  }
}
