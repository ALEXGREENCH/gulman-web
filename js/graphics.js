import * as THREE from 'three';
import { EnhancedPostprocessing } from './postprocessing.js?v=20261109-10';

const STORAGE_KEY = 'gulman-web-graphics-v1';
const SHARPEN_ID = 'gulman-art-sharpen';
const SVG_NS = 'http://www.w3.org/2000/svg';
const ENVIRONMENT_PATH = 'assets/enhanced/sky/kloofendal_48d_partly_cloudy_puresky.hdr';

export const GRAPHICS_MODES = Object.freeze({
  original: Object.freeze({ label: 'Оригинал', pixelRatioCap: 1.5, anisotropy: 4, artEnhancement: false }),
  enhanced: Object.freeze({ label: 'Улучшенный', pixelRatioCap: 1.5, anisotropy: 8, artEnhancement: true }),
  potato: Object.freeze({ label: 'Экономный', pixelRatioCap: 0.75, anisotropy: 1, artEnhancement: false }),
});

export const ENHANCED_QUALITY = Object.freeze({
  high: Object.freeze({ shadowSize: 1024, shadowRadius: 30, shadowFPS: 24, detailMaps: true, bloom: true, pixelRatioCap: 1.5, maxPixels: 3000000 }),
  low: Object.freeze({ shadowSize: 512, shadowRadius: 22, shadowFPS: 12, detailMaps: false, bloom: false, pixelRatioCap: 1, maxPixels: 1000000 }),
});

// Original artwork still needs the source game's object shadows. Keep that
// baseline single-map pass independent from optional Enhanced PBR/post effects.
const ORIGINAL_SHADOW_QUALITY = Object.freeze({ shadowSize: 1024, shadowRadius: 24, shadowFPS: 20 });

/** Original/economy stay single-pass; enhanced quality is bounded separately. */
export function getGraphicsProfile(mode = 'original', deviceRatio = globalThis.devicePixelRatio ?? 1) {
  const resolved = Object.hasOwn(GRAPHICS_MODES, mode) ? mode : 'original';
  const ratio = Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1;
  return { mode: resolved, ...GRAPHICS_MODES[resolved], pixelRatio: Math.min(ratio, GRAPHICS_MODES[resolved].pixelRatioCap), postPasses: resolved === 'enhanced' ? 4 : 0 };
}

function surfaceKind(label) {
  const value = String(label).toLowerCase();
  if (/water|ocean|pool|вода|море/.test(value)) return { roughness: 0.22, metalness: 0.06, normal: 0.8, water: true };
  if (/metal|steel|chrome|bronze|gold|желез|сталь|металл|weapon|rifle|pistol/.test(value)) return { roughness: 0.38, metalness: 0.65, normal: 0.18 };
  if (/marble|tile|мрамор|плитк/.test(value)) return { roughness: 0.48, metalness: 0, normal: 0.2 };
  if (/face|skin|body|голов|лицо|тело|players/.test(value)) return { roughness: 0.8, metalness: 0, normal: 0.1 };
  return { roughness: 0.88, metalness: 0, normal: 0.4 };
}

/** Conservative image-derived relief: luminance edges plus fine surface grain.
 * Colour images do not encode true geometry; amplitude deliberately stays low.
 */
export function deriveSurfacePixels(pixels, width, height) {
  const luma = new Float32Array(width * height);
  const normal = new Uint8Array(width * height * 4);
  const roughness = new Uint8Array(width * height * 4);
  for (let i = 0; i < luma.length; i++) luma[i] = (pixels[i * 4] * 0.2126 + pixels[i * 4 + 1] * 0.7152 + pixels[i * 4 + 2] * 0.0722) / 255;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, offset = i * 4;
    const grain = ((((x * 73856093) ^ (y * 19349663)) >>> 0) % 997) / 997 - 0.5;
    const dx = (luma[y * width + (x + 1) % width] - luma[y * width + (x + width - 1) % width]) * 1.8 + grain * 0.05;
    const dy = (luma[((y + 1) % height) * width + x] - luma[((y + height - 1) % height) * width + x]) * 1.8 - grain * 0.05;
    const inverse = 1 / Math.hypot(dx, dy, 1);
    normal[offset] = Math.round((-dx * inverse * 0.5 + 0.5) * 255);
    normal[offset + 1] = Math.round((dy * inverse * 0.5 + 0.5) * 255);
    normal[offset + 2] = Math.round((inverse * 0.5 + 0.5) * 255);
    normal[offset + 3] = 255;
    const r = Math.round(THREE.MathUtils.clamp(0.91 - luma[i] * 0.12 + grain * 0.05, 0.65, 1) * 255);
    roughness[offset] = roughness[offset + 1] = roughness[offset + 2] = r;
    roughness[offset + 3] = 255;
  }
  return { normal, roughness, width, height };
}

function copyTextureTransform(texture, source) {
  texture.wrapS = source.wrapS; texture.wrapT = source.wrapT;
  texture.repeat.copy(source.repeat); texture.offset.copy(source.offset);
  texture.center.copy(source.center); texture.rotation = source.rotation;
  texture.channel = source.channel; texture.flipY = source.flipY;
}

function shadowState(light) {
  const shadow = light.shadow;
  if (!shadow) return null;
  const camera = shadow.camera;
  return {
    map: shadow.map, mapPass: shadow.mapPass, mapSize: shadow.mapSize.clone(),
    bias: shadow.bias, normalBias: shadow.normalBias, radius: shadow.radius,
    autoUpdate: shadow.autoUpdate, needsUpdate: shadow.needsUpdate,
    camera: { left: camera.left, right: camera.right, top: camera.top, bottom: camera.bottom, near: camera.near, far: camera.far },
  };
}

// Fine world-space grain avoids stretching a 96px relief map over a 200m beach.
// Derivative fading removes frequencies smaller than a screen pixel. This is
// deliberately limited to opaque static architecture/terrain at High quality.
function installMicroDetail(material) {
  material.onBeforeCompile = shader => {
    shader.vertexShader = `#ifdef GULMAN_MICRODETAIL\nvarying vec3 vGulmanWorldPosition;\n#endif\n${shader.vertexShader}`;
    shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      #ifdef GULMAN_MICRODETAIL
        vec4 gulmanWorld = vec4( transformed, 1.0 );
        #ifdef USE_BATCHING
          gulmanWorld = batchingMatrix * gulmanWorld;
        #endif
        #ifdef USE_INSTANCING
          gulmanWorld = instanceMatrix * gulmanWorld;
        #endif
        vGulmanWorldPosition = ( modelMatrix * gulmanWorld ).xyz;
      #endif
    `);
    shader.fragmentShader = `#ifdef GULMAN_MICRODETAIL\nvarying vec3 vGulmanWorldPosition;\n#endif\n${shader.fragmentShader}`;
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      #ifdef GULMAN_MICRODETAIL
        vec3 gulmanP = vGulmanWorldPosition * 75.3982;
        float gulmanFootprint = max( length( dFdx( gulmanP ) ), length( dFdy( gulmanP ) ) );
        float gulmanFade = 1.0 - smoothstep( 0.7, 3.5, gulmanFootprint );
        if ( gulmanFade > 0.001 ) {
          vec3 gulmanA = vec3( 0.80, 0.17, 0.56 );
          vec3 gulmanB = vec3( -0.32, 0.93, 0.25 );
          vec3 gulmanC = vec3( 0.13, 0.31, 0.94 );
          float gulmanX = dot( gulmanP, gulmanA );
          float gulmanY = dot( gulmanP, gulmanB );
          float gulmanZ = dot( gulmanP, gulmanC );
          float gulmanGrain = sin( gulmanX ) * sin( gulmanY ) * 0.65 + sin( gulmanZ * 1.73 ) * 0.35;
          vec3 gulmanGradient = gulmanA * cos( gulmanX ) * sin( gulmanY ) * 0.65
            + gulmanB * sin( gulmanX ) * cos( gulmanY ) * 0.65
            + gulmanC * cos( gulmanZ * 1.73 ) * 0.6;
          vec3 gulmanViewGradient = mat3( viewMatrix ) * gulmanGradient;
          gulmanViewGradient -= normal * dot( normal, gulmanViewGradient );
          normal = normalize( normal - gulmanViewGradient * ( 0.075 * gulmanFade ) );
          roughnessFactor = clamp( roughnessFactor + gulmanGrain * ( 0.05 * gulmanFade ), 0.08, 1.0 );
          diffuseColor.rgb *= 1.0 + gulmanGrain * ( 0.018 * gulmanFade );
        }
      #endif
    `);
  };
  material.customProgramCacheKey = () => 'gulman-world-microdetail-v1';
}

function browserStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}

/** Bound decoded HDR dimensions before Three creates the background cubemap.
 * Box averaging retains small bright sun pixels, unlike nearest downsampling.
 */
export function reduceEnvironmentTexture(source, maximumWidth = 1024) {
  const image = source?.image;
  if (!image?.data || image.width <= maximumWidth || !image.height) return source;
  const factor = Math.max(1, Math.ceil(image.width / maximumWidth));
  const width = Math.max(1, Math.floor(image.width / factor)), height = Math.max(1, Math.floor(image.height / factor));
  const half = source.type === THREE.HalfFloatType;
  const pixels = half ? new Uint16Array(width * height * 4) : new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sum = [0, 0, 0, 0];
    let count = 0;
    for (let dy = 0; dy < factor && y * factor + dy < image.height; dy++) for (let dx = 0; dx < factor && x * factor + dx < image.width; dx++) {
      const offset = ((y * factor + dy) * image.width + x * factor + dx) * 4;
      for (let c = 0; c < 4; c++) sum[c] += half ? THREE.DataUtils.fromHalfFloat(image.data[offset + c]) : image.data[offset + c];
      count++;
    }
    const offset = (y * width + x) * 4;
    for (let c = 0; c < 4; c++) pixels[offset + c] = half ? THREE.DataUtils.toHalfFloat(sum[c] / count) : sum[c] / count;
  }
  const reduced = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, source.type);
  reduced.name = 'Poly Haven / Kloofendal 48d Partly Cloudy Pure Sky (CC0)';
  reduced.colorSpace = THREE.LinearSRGBColorSpace;
  reduced.mapping = THREE.EquirectangularReflectionMapping;
  reduced.flipY = source.flipY;
  reduced.minFilter = reduced.magFilter = THREE.LinearFilter;
  reduced.needsUpdate = true;
  return reduced;
}

async function defaultEnvironmentLoader(url) {
  const { HDRLoader } = await import('../vendor/addons/loaders/HDRLoader.js?v=20261109-10');
  return new HDRLoader().loadAsync(url);
}

/**
 * Reversible PBR, image-derived detail, environment lighting, local sun shadows
 * and a bounded HDR pipeline. Original/economy do not allocate that pipeline.
 *
 * Call applyAssets once before loading models; it also handles cached promises.
 * After loading: applyRenderer(renderer); applyScene(scene, player).
 * On resize: resize(width,height). Each frame: update(feet,{grounded,dt,camera})
 * then render(renderer,scene,camera,elapsed). elapsed is real frame duration.
 * groundY can instead provide the measured floor under an airborne player.
 */
export class GraphicsManager {
  constructor({ onChange = () => {}, storage = browserStorage(), document: ownerDocument = globalThis.document, loadEnvironment = defaultEnvironmentLoader } = {}) {
    this.onChange = onChange;
    this.storage = storage;
    this.document = ownerDocument;
    this._loadEnvironment = loadEnvironment;
    this._assets = null;
    this._environmentSource = null;
    this._loadedEnvironmentTexture = null;
    this._environmentTexturePromise = null;
    this._environmentLoading = false;
    this._environmentLoadError = null;
    this._skyOwned = false;
    this.mode = 'original';
    this.lighting = true;
    this.quality = 'auto';
    try {
      const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
      if (Object.hasOwn(GRAPHICS_MODES, saved?.mode)) this.mode = saved.mode;
      if (typeof saved?.lighting === 'boolean') this.lighting = saved.lighting;
      if (['auto', 'high', 'low'].includes(saved?.quality)) this.quality = saved.quality;
    } catch { /* Storage is optional, including private browsing. */ }
    this._renderer = null;
    this._scene = null;
    this._player = null;
    this._rendererStates = new WeakMap();
    this._sceneStates = new WeakMap();
    this._textureStates = new WeakMap();
    this._objectStates = new WeakMap();
    this._pbrMaterials = new Map();
    this._pbrSources = new WeakMap();
    this._detailMaps = new Map();
    this._waterMaps = new Set();
    this._textureLabels = new WeakMap();
    this._assetImageNames = new WeakMap();
    this._textures = new Set();
    this._assetBindings = new Map();
    this._maxAnisotropy = 1;
    this._shadow = null;
    this._sun = null;
    this._environment = null;
    this._skyTexture = null;
    this._post = null;
    this._postFailed = false;
    this._fallbackReason = null;
    this._environmentFailed = false;
    this._effectiveQuality = this.quality === 'low' ? 'low' : 'high';
    this._renderScale = 1;
    this._averageFrame = 1 / 60;
    this._adaptiveElapsed = 0;
    this._warmup = 2;
    this._shadowElapsed = 1;
    this._time = 0;
    this._width = 1;
    this._height = 1;
    this._pixelRatio = 1;
    this._lastPosition = new THREE.Vector3();
    this._sunDirection = new THREE.Vector3(0.55, 0.72, 0.34).normalize();
    this._originalSunDirection = new THREE.Vector3();
    this._shadowFocus = new THREE.Vector3();
    this._shadowRight = new THREE.Vector3();
    this._shadowUp = new THREE.Vector3();
    this._shadowAnchor = new THREE.Vector3(NaN, NaN, NaN);
    this._viewDirection = new THREE.Vector3();
    this._rendererSize = new THREE.Vector2();
    this._disposed = false;
    this._applyDocument();
  }

  get profile() { return getGraphicsProfile(this.mode); }
  get enhancedLighting() { return this.mode === 'enhanced' && this.lighting; }
  get shadowsEnabled() { return this.mode === 'original' || this.enhancedLighting; }
  get shadowQuality() { return this.mode === 'original' ? ORIGINAL_SHADOW_QUALITY : ENHANCED_QUALITY[this._effectiveQuality]; }
  get diagnostics() {
    return {
      mode: this.mode, quality: this.quality, effectiveQuality: this._effectiveQuality,
      pixelRatio: this._pixelRatio, renderScale: this._renderScale,
      estimatedFPS: Math.round(1 / this._averageFrame),
      shadowSize: this.shadowsEnabled ? this.shadowQuality.shadowSize : 0,
      pbrMaterials: this._pbrMaterials.size, detailTextures: this._detailMaps.size * 2,
      environment: Boolean(this._environment), postprocessing: this._post?.diagnostics ?? null,
      fallback: this._postFailed,
      fallbackReason: this._fallbackReason,
      environmentFallback: this._environmentFailed,
      sky: this._environmentSource ? 'poly-haven-hdr' : 'procedural',
      environmentLoading: this._environmentLoading,
      environmentLoadError: this._environmentLoadError,
    };
  }

  _persist() {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify({ mode: this.mode, lighting: this.lighting, quality: this.quality })); } catch { /* Keep working without persistent storage. */ }
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
    this._assets = assets;
    if (!this._assetBindings.has(assets)) {
      const original = assets.texture;
      const manager = this;
      const wrapped = async function (...args) {
        const texture = await original.apply(this, args);
        if (!manager._disposed) {
          let names = manager._assetImageNames.get(assets);
          if (!names || names.manifest !== assets.manifest) {
            names = { manifest: assets.manifest, paths: new Map(Object.entries(assets.manifest?.images ?? {}).map(([name, path]) => [path, name])) };
            manager._assetImageNames.set(assets, names);
          }
          manager._textureLabels.set(texture, names.paths.get(args[0]?.map) ?? args[0]?.map ?? '');
          manager._configureTexture(texture);
        }
        return texture;
      };
      const originalModel = assets.model;
      const wrappedModel = typeof originalModel === 'function' ? async function (...args) {
        const object = await originalModel.apply(this, args);
        if (!manager._disposed && manager.mode === 'enhanced') {
          object.traverse(child => manager._configureObject(child, String(args[0] ?? '')));
        }
        return object;
      } : null;
      this._assetBindings.set(assets, { original, wrapped, originalModel, wrappedModel });
      assets.texture = wrapped;
      if (wrappedModel) assets.model = wrappedModel;
    }
    // Do not replace cache entries or create duplicate textures/materials.
    return Promise.all([...assets.textures?.values() ?? []].map(value => Promise.resolve(value)
      .then(texture => { if (!this._disposed) this._configureTexture(texture); return texture; })
      .catch(() => undefined)));
  }

  /** Lazy, optional CC0 HDRI. Original/economy never initiate this download.
   * Root may await it alongside EnhancedWorld.load() for a single loading screen.
   */
  async prepareEnvironment(assets = this._assets) {
    if (this._disposed || this.mode !== 'enhanced' || !assets?.url) return null;
    if (this._environmentSource) return this._environmentSource;
    if (this._environmentTexturePromise) return this._environmentTexturePromise;
    this._environmentLoading = true;
    this._environmentLoadError = null;
    this._environmentTexturePromise = (async () => {
      try {
        const loaded = await this._loadEnvironment(assets.url(ENVIRONMENT_PATH));
        if (this._disposed) { loaded.dispose(); return null; }
        const texture = reduceEnvironmentTexture(loaded);
        if (texture !== loaded) loaded.dispose();
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.userData.graphicsOwned = true;
        this._loadedEnvironmentTexture = texture;
        this.setEnvironment(texture);
        return texture;
      } catch (error) {
        this._environmentLoadError = String(error?.message ?? error);
        this._environmentTexturePromise = null;
        console.warn('Photographic sky unavailable; procedural daylight remains active:', error);
        return null;
      } finally { this._environmentLoading = false; }
    })();
    return this._environmentTexturePromise;
  }

  /** Borrow an already-loaded equirectangular texture; ownership stays with caller. */
  setEnvironment(texture) {
    if (this._disposed || this._environmentSource === texture) return this;
    this._environment?.dispose(); this._environment = null;
    if (this._skyOwned) this._skyTexture?.dispose();
    this._skyTexture = null; this._skyOwned = false;
    this._environmentSource = texture ?? null;
    this._environmentFailed = false;
    if (texture) {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      this._matchSunToEnvironment(texture);
    }
    if (this.enhancedLighting && this._scene) this.applyScene(this._scene, this._player);
    return this;
  }

  _matchSunToEnvironment(texture) {
    const image = texture.image;
    if (!image?.data || !image.width || !image.height) return;
    const half = texture.type === THREE.HalfFloatType;
    let strongest = 0, bestX = 0, bestY = 0, sum = 0, count = 0;
    for (let y = 0; y < image.height; y++) {
      const v = texture.flipY ? 1 - (y + 0.5) / image.height : (y + 0.5) / image.height;
      if (v < 0.56) continue;
      for (let x = 0; x < image.width; x++) {
        const index = (y * image.width + x) * 4;
        const r = half ? THREE.DataUtils.fromHalfFloat(image.data[index]) : image.data[index];
        const g = half ? THREE.DataUtils.fromHalfFloat(image.data[index + 1]) : image.data[index + 1];
        const b = half ? THREE.DataUtils.fromHalfFloat(image.data[index + 2]) : image.data[index + 2];
        const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
        sum += luminance; count++;
        if (luminance > strongest) { strongest = luminance; bestX = x; bestY = v; }
      }
    }
    if (strongest < sum / Math.max(1, count) * 3) return;
    const azimuth = ((bestX + 0.5) / image.width - 0.5) * Math.PI * 2;
    const elevation = (bestY - 0.5) * Math.PI;
    this._sunDirection.set(Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth)).normalize();
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

  _surfaceMaps(texture, water = false) {
    if (!texture?.image || texture.isVideoTexture || texture.isRenderTargetTexture) return null;
    if (this._detailMaps.has(texture)) return this._detailMaps.get(texture);
    let pixels, width, height;
    const source = texture.image;
    if (source.data instanceof Uint8Array && source.width && source.height && source.data.length === source.width * source.height * 4) {
      // Small test/procedural textures can be sampled without a DOM.
      width = source.width; height = source.height; pixels = source.data;
    } else {
      if (!this.document?.createElement) return null;
      const imageWidth = source.naturalWidth ?? source.width;
      const imageHeight = source.naturalHeight ?? source.height;
      if (!imageWidth || !imageHeight) return null;
      const ratio = Math.min(1, 96 / Math.max(imageWidth, imageHeight));
      width = Math.max(4, Math.round(imageWidth * ratio));
      height = Math.max(4, Math.round(imageHeight * ratio));
      try {
        const canvas = this.document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(source, 0, 0, width, height);
        pixels = context.getImageData(0, 0, width, height).data;
      } catch { this._detailMaps.set(texture, null); return null; }
    }
    const data = deriveSurfacePixels(pixels, width, height);
    if (water) {
      // Seamless overlapping wave trains, independent of the low-res water
      // photograph. Only their normals move; level geometry/collision is intact.
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const u = x / width * Math.PI * 2, v = y / height * Math.PI * 2;
        const dx = Math.cos(u * 3 + Math.sin(v) * 0.8) * 0.32 + Math.cos((u + v) * 5) * 0.16 + Math.cos((u - v) * 9) * 0.08;
        const dy = Math.cos(u * 3 + Math.sin(v) * 0.8) * Math.cos(v) * 0.09 + Math.cos((u + v) * 5) * 0.16 - Math.cos((u - v) * 9) * 0.08;
        const inverse = 1 / Math.hypot(dx, dy, 1), i = (y * width + x) * 4;
        data.normal[i] = Math.round((dx * inverse * 0.5 + 0.5) * 255);
        data.normal[i + 1] = Math.round((dy * inverse * 0.5 + 0.5) * 255);
        data.normal[i + 2] = Math.round((inverse * 0.5 + 0.5) * 255);
      }
    }
    const maps = {};
    for (const key of ['normal', 'roughness']) {
      const map = new THREE.DataTexture(data[key], width, height);
      map.name = `enhanced-${key}`;
      map.userData.graphicsOwned = true;
      map.colorSpace = THREE.NoColorSpace;
      map.minFilter = THREE.LinearMipmapLinearFilter;
      map.magFilter = THREE.LinearFilter;
      map.generateMipmaps = true;
      map.anisotropy = Math.min(4, this._maxAnisotropy);
      copyTextureTransform(map, texture);
      if (water && key === 'normal') {
        map.repeat.multiplyScalar(3);
        map.wrapS = map.wrapT = THREE.RepeatWrapping;
        map.userData.baseOffset = map.offset.clone();
        this._waterMaps.add(map);
      }
      map.needsUpdate = true;
      maps[key] = map;
    }
    this._detailMaps.set(texture, maps);
    return maps;
  }

  _pbrMaterial(source, label, object) {
    source = this._pbrSources.get(source) ?? source;
    if (!source?.isMeshLambertMaterial && !source?.isMeshPhongMaterial) return source;
    if (this._pbrMaterials.has(source)) return this._pbrMaterials.get(source);
    // Some original material names are misleading: beach sand is "waterf1".
    // Prefer the actual archived image path (beach.jpg versus water.jpg).
    let kind = surfaceKind(this._textureLabels.get(source.map) || `${label} ${source.name}`);
    if (kind.water && object?.geometry) {
      object.geometry.computeBoundingBox();
      const box = object.geometry.boundingBox;
      const horizontal = box && (box.max.y - box.min.y) < Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.035 + 0.001;
      if (!horizontal) kind = { roughness: 0.86, metalness: 0, normal: 0.25 };
    }
    const material = new THREE.MeshStandardMaterial({
      color: source.color, map: source.map, alphaMap: source.alphaMap,
      side: source.side, opacity: source.opacity, transparent: source.transparent,
      alphaTest: source.alphaTest, depthTest: source.depthTest, depthWrite: source.depthWrite,
      vertexColors: source.vertexColors, flatShading: source.flatShading,
      emissive: source.emissive ?? 0, emissiveMap: source.emissiveMap ?? null,
      emissiveIntensity: source.emissiveIntensity ?? 1,
      roughness: kind.roughness, metalness: kind.metalness, envMapIntensity: kind.water ? 1.2 : 0.55,
      dithering: true, fog: source.fog, toneMapped: source.toneMapped,
    });
    material.name = `enhanced:${source.name || label}`;
    material.normalScale.setScalar(kind.normal);
    const worldDetail = !kind.water && !source.transparent && source.alphaTest <= 0 && /world:|levels\//i.test(label);
    material.userData = { ...source.userData, graphicsOwned: true, originalRoughness: kind.roughness, water: Boolean(kind.water), worldDetail };
    if (worldDetail) installMicroDetail(material);
    if (kind.water) material.color.multiply(new THREE.Color(0x92b7be));
    this._pbrSources.set(material, source);
    this._pbrMaterials.set(source, material);
    this._configurePBRDetail(material, source);
    return material;
  }

  _configurePBRDetail(material, source) {
    const detail = ENHANCED_QUALITY[this._effectiveQuality].detailMaps;
    const maps = detail ? this._surfaceMaps(source.map, material.userData.water) : null;
    const micro = Boolean(detail && material.userData.worldDetail);
    const hadMicro = Object.hasOwn(material.defines, 'GULMAN_MICRODETAIL');
    if (micro !== hadMicro) {
      if (micro) material.defines.GULMAN_MICRODETAIL = 1;
      else delete material.defines.GULMAN_MICRODETAIL;
      material.needsUpdate = true;
    }
    const normal = maps?.normal ?? null, roughness = maps?.roughness ?? null;
    if (material.normalMap !== normal || material.roughnessMap !== roughness) {
      material.normalMap = normal;
      material.roughnessMap = roughness;
      material.needsUpdate = true;
    }
  }

  _configureObject(object, label = '') {
    if (!object.isMesh || !object.material || object.userData?.graphicsOwned) return;
    let saved = this._objectStates.get(object);
    if (!saved) {
      const original = material => this._pbrSources.get(material) ?? material;
      // Instanced crowd batches may be built from an already-enhanced actor.
      const materials = Array.isArray(object.material) && object.material.some(m => this._pbrSources.has(m))
        ? object.material.map(original) : Array.isArray(object.material) ? object.material : original(object.material);
      saved = { material: materials, castShadow: object.castShadow, receiveShadow: object.receiveShadow };
      this._objectStates.set(object, saved);
    }
    if (this.mode === 'enhanced') {
      const convert = material => this._pbrMaterial(material, `${label} ${object.name}`, object);
      object.material = Array.isArray(saved.material) ? saved.material.map(convert) : convert(saved.material);
    } else {
      object.material = saved.material;
      object.castShadow = saved.castShadow;
      object.receiveShadow = saved.receiveShadow;
    }
    if (this.shadowsEnabled) {
      let viewmodel = false;
      for (let parent = object.parent; parent; parent = parent.parent) if (parent.isCamera) { viewmodel = true; break; }
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const solid = materials.some(material => (material.isMeshStandardMaterial || material.isMeshLambertMaterial || material.isMeshPhongMaterial) && (!material.transparent || material.alphaTest > 0));
      object.castShadow = solid && !viewmodel;
      // The cached world shadow map holds older bone poses between refreshes.
      // Don't project those silhouettes back onto the moving character skin.
      object.receiveShadow = solid && !viewmodel && !object.userData.characterSurface;
    } else if (this.mode === 'enhanced') { object.castShadow = false; object.receiveShadow = false; }
  }

  _disposeMaterials() {
    for (const material of this._pbrMaterials.values()) material.dispose();
    for (const maps of this._detailMaps.values()) {
      maps?.normal.dispose(); maps?.roughness.dispose();
    }
    this._pbrMaterials.clear();
    this._detailMaps.clear();
    this._waterMaps.clear();
    // Keep source links weakly while asynchronous model requests finish; they
    // allow a stale converted clone to recover its borrowed original material.
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
      shadowType: renderer.shadowMap?.type,
      shadowAutoUpdate: renderer.shadowMap?.autoUpdate,
      shadowNeedsUpdate: renderer.shadowMap?.needsUpdate,
    });
    const original = this._rendererStates.get(renderer);
    const maximum = Number(renderer.capabilities?.getMaxAnisotropy?.() ?? 1);
    this._maxAnisotropy = Number.isFinite(maximum) ? Math.max(1, maximum) : 1;
    if (renderer.getSize) {
      renderer.getSize(this._rendererSize);
      this._width = Math.max(1, this._rendererSize.x);
      this._height = Math.max(1, this._rendererSize.y);
    }
    this._applyResolution();
    renderer.toneMapping = this.mode === 'enhanced' ? THREE.ACESFilmicToneMapping : original.toneMapping;
    renderer.toneMappingExposure = this.mode === 'enhanced' ? 0.9 : original.toneMappingExposure;
    renderer.outputColorSpace = original.outputColorSpace;
    if (renderer.shadowMap) {
      renderer.shadowMap.enabled = this.shadowsEnabled;
      renderer.shadowMap.type = this.shadowsEnabled ? THREE.PCFSoftShadowMap : original.shadowType;
      renderer.shadowMap.autoUpdate = this.shadowsEnabled ? false : original.shadowAutoUpdate;
      if (!this.shadowsEnabled) renderer.shadowMap.needsUpdate = original.shadowNeedsUpdate;
    }
    for (const texture of this._textures) this._configureTexture(texture);
    return this;
  }

  _applyResolution() {
    if (!this._renderer) return;
    let ratio = this.profile.pixelRatio;
    if (this.mode === 'enhanced') {
      const quality = ENHANCED_QUALITY[this._effectiveQuality];
      ratio = Math.min(ratio, quality.pixelRatioCap, Math.sqrt(quality.maxPixels / (this._width * this._height))) * this._renderScale;
    }
    this._pixelRatio = Math.max(0.01, ratio);
    this._renderer.setPixelRatio(this._pixelRatio);
    this._post?.setQuality(this._effectiveQuality);
    this._post?.setSize(this._width, this._height, this._pixelRatio);
  }

  resize(width, height) {
    this._width = Math.max(1, Number(width) || 1);
    this._height = Math.max(1, Number(height) || 1);
    this._applyResolution();
    return this;
  }

  applyScene(scene, player = this._player) {
    if (!scene || this._disposed) return this;
    if (this._scene && scene !== this._scene) this.releaseScene(this._scene);
    this._scene = scene;
    this._player = player;
    if (this.mode === 'enhanced') void this.prepareEnvironment();
    let original = this._sceneStates.get(scene);
    if (!original) {
      original = {
        fog: scene.fog, background: scene.background, environment: scene.environment,
        environmentIntensity: scene.environmentIntensity, backgroundIntensity: scene.backgroundIntensity,
        backgroundBlurriness: scene.backgroundBlurriness, lights: new Map(), objects: new Set(),
      };
      this._sceneStates.set(scene, original);
    }
    scene.traverse(object => {
      if (object.userData?.graphicsOwned) return;
      if (object.isHemisphereLight || object.isAmbientLight || object.isDirectionalLight) {
        if (!original.lights.has(object)) original.lights.set(object, {
          intensity: object.intensity, color: object.color.clone(), groundColor: object.groundColor?.clone(),
          position: object.position.clone(), castShadow: object.castShadow,
          targetPosition: object.target?.position.clone(), targetParent: object.target?.parent,
          shadow: shadowState(object),
        });
      }
      if (object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) for (const value of Object.values(material)) {
          if (value?.isTexture) this._configureTexture(value);
        }
        this._configureObject(object);
        original.objects.add(object);
      }
    });
    for (const [light, saved] of original.lights) {
      light.intensity = saved.intensity;
      light.color.copy(saved.color);
      if (saved.groundColor) light.groundColor.copy(saved.groundColor);
      if (this.enhancedLighting) {
        if (light.isDirectionalLight) {
          light.intensity = Math.max(2.1, saved.intensity * 1.5);
          light.color.set(0xffdfb3);
        } else {
          light.intensity = saved.intensity * 0.23;
          light.color.set(0xc7ddf5);
          light.groundColor?.set(0x857458);
        }
      }
    }
    scene.fog = original.fog;
    scene.background = original.background;
    scene.environment = original.environment;
    scene.environmentIntensity = original.environmentIntensity;
    scene.backgroundIntensity = original.backgroundIntensity;
    scene.backgroundBlurriness = original.backgroundBlurriness;
    if (this.enhancedLighting && original.fog?.isFog) {
      const fog = original.enhancedFog ??= original.fog.clone();
      fog.near = Math.min(original.fog.near, 100);
      fog.far = Math.max(fog.near + 1, Math.min(original.fog.far, 460));
      fog.color.copy(original.fog.color).lerp(new THREE.Color(0xc7d8e1), 0.5);
      scene.fog = fog;
    }
    if (this.enhancedLighting) {
      this._ensureEnvironment();
      if (this._skyTexture) {
        scene.background = this._skyTexture;
        scene.backgroundIntensity = this._environmentSource ? 0.75 : 1;
        scene.backgroundBlurriness = 0;
      }
      if (this._environment) {
        scene.environment = this._environment.texture;
        scene.environmentIntensity = this._environmentSource ? 0.45 : 0.55;
      }
    }
    if (this.shadowsEnabled) {
      this._sun = [...original.lights.keys()].find(light => light.isDirectionalLight) ?? null;
      if (this._sun) {
        const saved = original.lights.get(this._sun);
        this._originalSunDirection.copy(saved.position).sub(saved.targetPosition);
        if (this._originalSunDirection.lengthSq() < 1e-8) this._originalSunDirection.set(.4, .85, .25);
        this._originalSunDirection.normalize();
        if (!this._sun.target.parent) scene.add(this._sun.target);
        this._sun.castShadow = true;
        this._configureSun();
      }
    } else {
      this._restoreSun(original);
      this._sun = null;
    }
    if (this.enhancedLighting && player) {
      this._ensureShadow();
      scene.add(this._shadow);
    } else if (this._shadow) this._shadow.visible = false;
    if (this.shadowsEnabled) this.update(player ? (player.group ?? player).position : this._lastPosition);
    return this;
  }

  _ensureEnvironment() {
    if (!this._skyTexture && this._environmentSource) {
      this._skyTexture = this._environmentSource;
      this._skyOwned = false;
    }
    if (!this._skyTexture) {
      const width = 512, height = 256;
      const pixels = new Uint16Array(width * height * 4);
      const zenith = new THREE.Color(0x2368ad), horizon = new THREE.Color(0xb8d4e3);
      const ground = new THREE.Color(0x6b6655);
      const direction = new THREE.Vector3(), color = new THREE.Color();
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const theta = ((x + 0.5) / width - 0.5) * Math.PI * 2;
        const elevation = ((y + 0.5) / height - 0.5) * Math.PI;
        direction.set(Math.cos(elevation) * Math.cos(theta), Math.sin(elevation), Math.cos(elevation) * Math.sin(theta));
        if (direction.y >= 0) color.copy(horizon).lerp(zenith, Math.pow(direction.y, 0.45)).multiplyScalar(0.95);
        else color.copy(horizon).lerp(ground, Math.min(1, -direction.y * 4)).multiplyScalar(0.7);
        const sunlight = Math.max(0, direction.dot(this._sunDirection));
        const halo = Math.pow(sunlight, 180) * 0.8 + Math.pow(sunlight, 4500) * 24;
        // Layered low-frequency wisps, brighter toward the sun-facing side.
        const coverage = Math.sin(direction.x * 8 + direction.z * 4 + Math.sin(direction.z * 11) * 0.6)
          + Math.sin(direction.z * 13 - direction.y * 5) * 0.42
          + Math.sin(direction.x * 29 + direction.z * 17) * 0.14;
        const cloud = direction.y > 0.025 ? THREE.MathUtils.smoothstep(coverage, 0.25, 1.15) * (0.26 + sunlight * 0.1) * Math.min(1, direction.y * 8) : 0;
        const i = (y * width + x) * 4;
        pixels[i] = THREE.DataUtils.toHalfFloat(color.r + halo + cloud);
        pixels[i + 1] = THREE.DataUtils.toHalfFloat(color.g + halo * 0.86 + cloud);
        pixels[i + 2] = THREE.DataUtils.toHalfFloat(color.b + halo * 0.65 + cloud);
        pixels[i + 3] = THREE.DataUtils.toHalfFloat(1);
      }
      const sky = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
      sky.name = 'enhanced-procedural-daylight';
      sky.userData.graphicsOwned = true;
      sky.mapping = THREE.EquirectangularReflectionMapping;
      sky.colorSpace = THREE.LinearSRGBColorSpace;
      sky.minFilter = sky.magFilter = THREE.LinearFilter;
      sky.needsUpdate = true;
      this._skyTexture = sky;
      this._skyOwned = true;
    }
    if (!this._environment && !this._environmentFailed && this._renderer?.isWebGLRenderer) {
      let generator;
      try {
        generator = new THREE.PMREMGenerator(this._renderer);
        this._environment = generator.fromEquirectangular(this._skyTexture);
        this._environment.texture.userData.graphicsOwned = true;
      } catch (error) {
        // An unsupported float target must not make the game unplayable.
        console.warn('Enhanced environment unavailable:', error);
        this._environmentFailed = true;
      } finally { generator?.dispose(); }
    }
  }

  _configureSun() {
    if (!this._sun) return;
    const quality = this.shadowQuality;
    const shadow = this._sun.shadow;
    const borrowed = this._sceneStates.get(this._scene)?.lights.get(this._sun)?.shadow;
    if (shadow.map && shadow.map === borrowed?.map) shadow.map = null;
    if (shadow.mapPass && shadow.mapPass === borrowed?.mapPass) shadow.mapPass = null;
    if (shadow.mapSize.x !== quality.shadowSize) {
      shadow.map?.dispose(); shadow.map = null;
      shadow.mapPass?.dispose(); shadow.mapPass = null;
    }
    shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
    const camera = shadow.camera;
    camera.left = camera.bottom = -quality.shadowRadius;
    camera.right = camera.top = quality.shadowRadius;
    camera.near = 1; camera.far = 190;
    camera.updateProjectionMatrix();
    const direction = this.mode === 'original' ? this._originalSunDirection : this._sunDirection;
    const lightBasis = new THREE.Matrix4().lookAt(direction, new THREE.Vector3(), camera.up);
    this._shadowRight.setFromMatrixColumn(lightBasis, 0);
    this._shadowUp.setFromMatrixColumn(lightBasis, 1);
    shadow.bias = -0.00012;
    shadow.normalBias = this.mode === 'original' ? .018 : .025;
    shadow.radius = 1;
    shadow.autoUpdate = false;
    shadow.needsUpdate = true;
    this._shadowElapsed = 1;
    this._shadowAnchor.set(NaN, NaN, NaN);
    if (this._renderer?.shadowMap) this._renderer.shadowMap.needsUpdate = true;
  }

  _restoreSun(original) {
    for (const [light, saved] of original.lights) {
      if (!light.isDirectionalLight) continue;
      light.castShadow = saved.castShadow;
      light.position.copy(saved.position);
      light.target.position.copy(saved.targetPosition);
      if (!saved.targetParent) light.target.removeFromParent();
      else if (light.target.parent !== saved.targetParent) saved.targetParent.add(light.target);
      light.target.updateMatrixWorld(true);
      const shadow = light.shadow, previous = saved.shadow;
      if (shadow.map && shadow.map !== previous.map) shadow.map.dispose();
      if (shadow.mapPass && shadow.mapPass !== previous.mapPass) shadow.mapPass.dispose();
      shadow.map = previous.map; shadow.mapPass = previous.mapPass;
      shadow.mapSize.copy(previous.mapSize);
      for (const key of ['bias', 'normalBias', 'radius', 'autoUpdate', 'needsUpdate']) shadow[key] = previous[key];
      Object.assign(shadow.camera, previous.camera);
      shadow.camera.updateProjectionMatrix();
    }
  }

  releaseScene(scene = this._scene) {
    const saved = scene && this._sceneStates.get(scene);
    if (!saved) return this;
    // Include weapons attached asynchronously since the last applyScene call.
    scene.traverse(object => { if (this._objectStates.has(object) && !object.userData?.graphicsOwned) saved.objects.add(object); });
    for (const object of saved.objects) {
      if (object.userData?.graphicsOwned) continue;
      const original = this._objectStates.get(object);
      if (original) { object.material = original.material; object.castShadow = original.castShadow; object.receiveShadow = original.receiveShadow; }
    }
    for (const [light, original] of saved.lights) {
      light.intensity = original.intensity; light.color.copy(original.color);
      if (original.groundColor) light.groundColor.copy(original.groundColor);
    }
    this._restoreSun(saved);
    scene.fog = saved.fog; scene.background = saved.background; scene.environment = saved.environment;
    scene.environmentIntensity = saved.environmentIntensity;
    scene.backgroundIntensity = saved.backgroundIntensity; scene.backgroundBlurriness = saved.backgroundBlurriness;
    this._sceneStates.delete(scene);
    if (this._scene === scene) {
      this._shadow?.removeFromParent();
      this._sun = this._scene = this._player = null;
      this._disposeMaterials();
    }
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

  /** Track only a local sun frustum; schedule shadow refresh independently of FPS. */
  update(position, { groundY, grounded = true, dt = 1 / 60, time, camera } = {}) {
    this._time = Number.isFinite(time) ? time : this._time + Math.max(0, dt);
    if (this.mode === 'enhanced' && ENHANCED_QUALITY[this._effectiveQuality].detailMaps) {
      for (const map of this._waterMaps) map.offset.set(map.userData.baseOffset.x + this._time * 0.012, map.userData.baseOffset.y + this._time * 0.007);
    }
    if (position && Number.isFinite(position.x + position.y + position.z)) this._lastPosition.copy(position);
    if (this.shadowsEnabled && this._sun) {
      const quality = this.shadowQuality;
      this._shadowElapsed += Math.min(0.25, Math.max(0, dt));
      this._shadowFocus.copy(this._lastPosition);
      if (camera?.isCamera) {
        camera.getWorldDirection(this._viewDirection); this._viewDirection.y = 0;
        if (this._viewDirection.lengthSq() > .001) this._shadowFocus.addScaledVector(this._viewDirection.normalize(), this.mode === 'original' ? 6 : 8);
      }
      this._shadowFocus.y += 2;
      const relocated = !Number.isFinite(this._shadowAnchor.x) || this._shadowAnchor.distanceToSquared(this._shadowFocus) > 25;
      if (relocated || this._shadowElapsed >= 1 / quality.shadowFPS) {
        this._shadowElapsed = 0;
        // Snap in the shadow camera's plane so a static point keeps the same
        // subpixel offset as the player looks around or changes elevation.
        const texel = quality.shadowRadius * 2 / quality.shadowSize;
        const target = this._sun.target.position.copy(this._shadowFocus);
        const x = target.dot(this._shadowRight), y = target.dot(this._shadowUp);
        target.addScaledVector(this._shadowRight, Math.round(x / texel) * texel - x);
        target.addScaledVector(this._shadowUp, Math.round(y / texel) * texel - y);
        this._sun.position.copy(this._sun.target.position).addScaledVector(this.mode === 'original' ? this._originalSunDirection : this._sunDirection, 100);
        this._shadowAnchor.copy(this._shadowFocus);
        this._sun.updateMatrixWorld();
        this._sun.target.updateMatrixWorld();
        this._sun.shadow.needsUpdate = true;
        if (this._renderer?.shadowMap) this._renderer.shadowMap.needsUpdate = true;
      }
    }
    // First-person arms/weapons must never cast a huge camera-attached shadow.
    if (camera && this.shadowsEnabled) camera.traverse(object => {
      if (object.isMesh) { object.castShadow = false; object.receiveShadow = false; }
    });
    const shadow = this._shadow;
    if (!shadow) return;
    const measuredGround = Number.isFinite(groundY);
    const floor = measuredGround ? groundY : position?.y;
    const height = position ? Math.max(0, position.y - floor) : Infinity;
    shadow.visible = Boolean(this.enhancedLighting && position && Number.isFinite(position.x) && Number.isFinite(position.z) && Number.isFinite(floor) && (grounded || measuredGround) && height < 2.5);
    if (!shadow.visible) return;
    shadow.position.set(position.x, floor + 0.018, position.z);
    shadow.scale.setScalar(1 + Math.min(height, 2) * 0.22);
    shadow.material.opacity = Math.max(0, 1 - height / 2.5) * 0.6;
  }

  setMode(mode, { renderer = this._renderer, scene = this._scene, player = this._player } = {}) {
    if (!Object.hasOwn(GRAPHICS_MODES, mode)) throw new RangeError(`Неизвестный режим графики: ${mode}`);
    const previous = this.mode;
    this.mode = mode;
    if (mode === 'enhanced') void this.prepareEnvironment();
    if (previous !== mode) { this._warmup = 2; this._adaptiveElapsed = 0; this._renderScale = 1; }
    this._persist();
    this._applyDocument();
    if (renderer) this.applyRenderer(renderer);
    else for (const texture of this._textures) this._configureTexture(texture);
    if (scene) this.applyScene(scene, player);
    if (mode !== 'enhanced') this._disposeEnhanced();
    this.onChange(this.mode, { lighting: this.lighting, quality: this.quality, profile: this.profile });
    return this;
  }

  setLighting(enabled, context) {
    this.lighting = Boolean(enabled);
    return this.setMode(this.mode, context);
  }

  setQuality(quality, context) {
    if (!['auto', 'high', 'low'].includes(quality)) throw new RangeError(`Неизвестное качество: ${quality}`);
    this.quality = quality;
    this._effectiveQuality = quality === 'low' ? 'low' : 'high';
    this._renderScale = 1;
    this._warmup = 2;
    this._adaptiveElapsed = 0;
    for (const [source, material] of this._pbrMaterials) this._configurePBRDetail(material, source);
    return this.setMode(this.mode, context);
  }

  _adapt(dt) {
    if (this.mode !== 'enhanced' || this.quality !== 'auto' || !Number.isFinite(dt) || dt <= 0 || dt > 0.25) return;
    if (this._warmup > 0) { this._warmup -= dt; return; }
    this._averageFrame += (dt - this._averageFrame) * 0.04;
    this._adaptiveElapsed += dt;
    if (this._adaptiveElapsed < 3) return;
    let changed = false;
    if (this._averageFrame > 1 / 40) {
      const next = Math.max(0.6, this._renderScale - 0.15);
      changed = next !== this._renderScale;
      this._renderScale = next;
      if (this._averageFrame > 1 / 30 || this._renderScale <= 0.7) { changed ||= this._effectiveQuality !== 'low'; this._effectiveQuality = 'low'; }
    } else if (this._averageFrame < 1 / 57 && this._adaptiveElapsed > 8) {
      if (this._renderScale < 1) { this._renderScale = Math.min(1, this._renderScale + 0.1); changed = true; }
      else if (this._effectiveQuality === 'low') { this._effectiveQuality = 'high'; this._renderScale = 0.8; changed = true; }
    }
    if (!changed) return;
    this._adaptiveElapsed = 0;
    this._applyResolution();
    this._configureSun();
    for (const [source, material] of this._pbrMaterials) this._configurePBRDetail(material, source);
  }

  render(renderer, scene, camera, dt = 1 / 60) {
    if (!renderer || !scene || !camera) return;
    if (renderer !== this._renderer) this.applyRenderer(renderer);
    if (this.mode !== 'enhanced') { renderer.render(scene, camera); return; }
    this._adapt(dt);
    if (!this._postFailed) {
      try {
        if (!this._post) {
          this._post = new EnhancedPostprocessing(renderer);
          this._post.setQuality(this._effectiveQuality);
        }
        this._post.depthAO = this.enhancedLighting;
        this._post.bloomStrength = this.enhancedLighting ? 0.12 : 0;
        // Read logical dimensions here as root may resize after applyRenderer.
        if (renderer.getSize) {
          renderer.getSize(this._rendererSize);
          if (this._rendererSize.x !== this._width || this._rendererSize.y !== this._height) this.resize(this._rendererSize.x, this._rendererSize.y);
        }
        this._post.setSize(this._width, this._height, this._pixelRatio);
        this._post.render(scene, camera, dt);
        return;
      } catch (error) {
        console.warn('Enhanced postprocessing unavailable; direct rendering continues:', error);
        this._post?.dispose(); this._post = null; this._postFailed = true;
        this._fallbackReason = String(error?.message ?? error);
      }
    }
    renderer.render(scene, camera);
  }

  _disposeEnhanced() {
    this._post?.dispose(); this._post = null;
    this._environment?.dispose(); this._environment = null;
    if (this._skyOwned) this._skyTexture?.dispose();
    this._skyTexture = null; this._skyOwned = false;
    this._disposeMaterials();
    if (this._shadow) {
      this._shadow.removeFromParent();
      this._shadow.geometry.dispose(); this._shadow.material.map.dispose(); this._shadow.material.dispose();
      this._shadow = null;
    }
    this._postFailed = false;
    this._fallbackReason = null;
    this._environmentFailed = false;
  }

  dispose() {
    if (this._disposed) return;
    this.mode = 'original';
    if (this._scene) this.releaseScene(this._scene);
    for (const texture of this._textures) this._configureTexture(texture, true);
    for (const [assets, binding] of this._assetBindings) {
      if (assets.texture === binding.wrapped) assets.texture = binding.original;
      if (assets.model === binding.wrappedModel) assets.model = binding.originalModel;
    }
    const renderer = this._renderer;
    const saved = renderer && this._rendererStates.get(renderer);
    if (saved) {
      renderer.toneMapping = saved.toneMapping;
      renderer.toneMappingExposure = saved.toneMappingExposure;
      renderer.outputColorSpace = saved.outputColorSpace;
      renderer.setPixelRatio(saved.pixelRatio);
      if (renderer.shadowMap) {
        renderer.shadowMap.enabled = saved.shadows;
        renderer.shadowMap.type = saved.shadowType;
        renderer.shadowMap.autoUpdate = saved.shadowAutoUpdate;
        renderer.shadowMap.needsUpdate = saved.shadowNeedsUpdate;
      }
    }
    this._disposeEnhanced();
    this._loadedEnvironmentTexture?.dispose(); this._loadedEnvironmentTexture = null;
    this._environmentSource = this._assets = null;
    this._shadow = this._scene = this._player = this._renderer = null;
    this._assetBindings.clear();
    this._textures.clear();
    this._applyDocument();
    this._disposed = true;
  }
}
