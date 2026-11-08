import * as THREE from 'three';

// Explicit material names only. Facades, foliage cards, characters and terrain
// atlases that contain roads/buildings must retain their original artwork.
const SURFACES = Object.freeze({
  beach: 'sand', rock: 'rock', wood: 'wood', wood_low: 'wood',
  floor: 'concrete', oncret: 'concrete', oncrete: 'concrete', concret: 'concrete', concrete: 'concrete',
  'brick mu': 'brick', 'brick-mu': 'brick', wall1: 'brick', grass4: 'grass',
});

export function classifyEnhancedSurface(path = '') {
  const value = String(path).replaceAll('\\', '/').toLowerCase();
  if (/players|weapons|menus|interface|comics/.test(value)) return null;
  const file = value.split('/').pop().split('?')[0];
  const stem = file.replace(/\.(?:jpg|jpeg|png|tga|webp)$/i, '').replace(/-[a-f0-9]{12}$/, '');
  return SURFACES[stem] ?? null;
}

const DECLARATIONS = /* glsl */`
varying vec3 vEnhancedMaterialWorld;
uniform sampler2D enhancedColor;
uniform sampler2D enhancedNormal;
uniform sampler2D enhancedRoughness;
uniform float enhancedTileMeters;
uniform float enhancedNormalStrength;
uniform float enhancedLow;
uniform float enhancedWaterLevel;
#ifdef ENHANCED_ATLAS
varying vec2 vEnhancedAtlasUV;
uniform sampler2D enhancedAtlas;
#endif
#if defined(ENHANCED_SAND) || defined(ENHANCED_GARDEN)
uniform sampler2D enhancedRockColor;
uniform sampler2D enhancedRockNormal;
uniform sampler2D enhancedRockRoughness;
uniform float enhancedRockMeters;
#endif

vec3 enhancedWeights( vec3 n ) {
  vec3 w = pow( abs( n ), vec3( 6.0 ) );
  if ( enhancedLow > 0.5 ) {
    if ( w.y >= max( w.x, w.z ) ) return vec3( 0.0, 1.0, 0.0 );
    return w.x > w.z ? vec3( 1.0, 0.0, 0.0 ) : vec3( 0.0, 0.0, 1.0 );
  }
  return w / max( dot( w, vec3( 1.0 ) ), 0.0001 );
}

vec3 enhancedDetailCoordinates( vec3 p ) {
  #ifdef ENHANCED_NATURAL
    // Continuous domain warping breaks the visible square tiling without extra
    // texture reads, and is shared by color, normals and roughness.
    p += vec3( sin( p.z * 0.17 + sin( p.y * 0.11 ) ),
               sin( p.x * 0.13 + sin( p.z * 0.09 ) ),
               sin( p.x * 0.19 + sin( p.y * 0.15 ) ) ) * 1.7;
  #endif
  return p;
}

vec3 enhancedCoastalRock( vec3 color ) {
  // Keep the scan's cracks and albedo variation, with a neutral coastal palette.
  float luminance = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
  return mix( vec3( luminance ), color, 0.55 );
}

vec4 enhancedTriplanar( sampler2D tex, vec3 p, vec3 w ) {
  vec4 color = vec4( 0.0 );
  // Flat ground takes one lookup, rather than three zero-weight lookups.
  if ( w.x > 0.001 ) color += texture2D( tex, p.zy ) * w.x;
  if ( w.y > 0.001 ) color += texture2D( tex, vec2( p.x, -p.z ) ) * w.y;
  if ( w.z > 0.001 ) color += texture2D( tex, p.xy ) * w.z;
  return color;
}

vec3 enhancedNormalGradient( sampler2D tex, vec3 p, vec3 w ) {
  vec3 gradient = vec3( 0.0 );
  if ( w.x > 0.001 ) {
    vec2 n = texture2D( tex, p.zy ).xy * 2.0 - 1.0;
    gradient += vec3( 0.0, n.y, n.x ) * w.x;
  }
  if ( w.y > 0.001 ) {
    vec2 n = texture2D( tex, vec2( p.x, -p.z ) ).xy * 2.0 - 1.0;
    gradient += vec3( n.x, 0.0, -n.y ) * w.y;
  }
  if ( w.z > 0.001 ) {
    vec2 n = texture2D( tex, p.xy ).xy * 2.0 - 1.0;
    gradient += vec3( n.x, n.y, 0.0 ) * w.z;
  }
  return gradient;
}
`;

const COLOR = /* glsl */`
vec3 enhancedWorldN;
#ifdef FLAT_SHADED
  enhancedWorldN = normalize( cross( dFdx( vEnhancedMaterialWorld ), dFdy( vEnhancedMaterialWorld ) ) );
#else
  enhancedWorldN = inverseTransformDirection( normalize( vNormal ), viewMatrix );
#endif
vec3 enhancedW = enhancedWeights( enhancedWorldN );
vec3 enhancedP = enhancedDetailCoordinates( vEnhancedMaterialWorld / enhancedTileMeters );
float enhancedWet = 0.0;
vec4 enhancedTexel = enhancedTriplanar( enhancedColor, enhancedP, enhancedW );
#ifdef ENHANCED_ROCK_SURFACE
  enhancedTexel.rgb = enhancedCoastalRock( enhancedTexel.rgb );
#endif
#if defined(ENHANCED_SAND) || defined(ENHANCED_GARDEN)
  vec3 enhancedGeometricN = normalize( cross( dFdx( vEnhancedMaterialWorld ), dFdy( vEnhancedMaterialWorld ) ) );
  float enhancedRockBlend = 1.0 - smoothstep( 0.53, 0.84, abs( enhancedGeometricN.y ) );
  #ifdef ENHANCED_ATLAS
    // The 2009 atlas locates the rocky hills even where their slopes are gentle.
    // It contributes only a broad material mask; all surface detail is scanned.
    vec3 atlasColor = texture2D( enhancedAtlas, vEnhancedAtlasUV ).rgb;
    float atlasLuma = dot( atlasColor, vec3( 0.2126, 0.7152, 0.0722 ) );
    #ifdef ENHANCED_GARDEN
      float hi = max(atlasColor.r,max(atlasColor.g,atlasColor.b));
      float lo = min(atlasColor.r,min(atlasColor.g,atlasColor.b));
      enhancedRockBlend = 1.0-smoothstep(0.12,0.30,(hi-lo)/max(hi,0.001));
    #else
      enhancedRockBlend = max( enhancedRockBlend, 1.0 - smoothstep( 0.18, 0.36, atlasLuma ) );
    #endif
  #endif
  #ifdef ENHANCED_GARDEN
    vec3 enhancedRockP = vEnhancedMaterialWorld / enhancedRockMeters;
  #else
    vec3 enhancedRockP = enhancedDetailCoordinates( vEnhancedMaterialWorld / enhancedRockMeters );
  #endif
  if ( enhancedRockBlend > 0.001 ) {
    vec4 coastalRock = enhancedTriplanar( enhancedRockColor, enhancedRockP, enhancedW );
    coastalRock.rgb = enhancedCoastalRock( coastalRock.rgb );
    enhancedTexel = mix( enhancedTexel, coastalRock, enhancedRockBlend );
  }
  #ifndef ENHANCED_GARDEN
    enhancedWet = ( 1.0 - smoothstep( enhancedWaterLevel + 0.08, enhancedWaterLevel + 1.25, vEnhancedMaterialWorld.y ) ) * ( 1.0 - enhancedRockBlend );
  #endif
  enhancedTexel.rgb *= mix( 1.0, 0.54, enhancedWet );
#endif
// Low-frequency albedo variation interrupts repetition while preserving scans.
float enhancedMacro = sin( vEnhancedMaterialWorld.x * 0.21 + sin( vEnhancedMaterialWorld.z * 0.17 ) ) * sin( vEnhancedMaterialWorld.z * 0.13 );
diffuseColor.rgb *= enhancedTexel.rgb * ( 1.0 + enhancedMacro * 0.085 );
`;

const ROUGHNESS = /* glsl */`
float roughnessFactor = roughness * enhancedTriplanar( enhancedRoughness, enhancedP, enhancedW ).g;
#if defined(ENHANCED_SAND) || defined(ENHANCED_GARDEN)
  if ( enhancedRockBlend > 0.001 ) roughnessFactor = mix( roughnessFactor, roughness * enhancedTriplanar( enhancedRockRoughness, enhancedRockP, enhancedW ).g, enhancedRockBlend );
  roughnessFactor = mix( roughnessFactor, 0.28, enhancedWet * 0.82 );
#endif
roughnessFactor = clamp( roughnessFactor, 0.18, 1.0 );
`;

const NORMAL = /* glsl */`
vec3 enhancedGradient = enhancedNormalGradient( enhancedNormal, enhancedP, enhancedW );
float enhancedReliefStrength = enhancedNormalStrength;
#if defined(ENHANCED_SAND) || defined(ENHANCED_GARDEN)
  if ( enhancedRockBlend > 0.001 ) enhancedGradient = mix( enhancedGradient, enhancedNormalGradient( enhancedRockNormal, enhancedRockP, enhancedW ), enhancedRockBlend );
  enhancedReliefStrength = mix( enhancedNormalStrength, 0.65, enhancedRockBlend ) * ( 1.0 - enhancedWet * 0.2 );
#endif
// The scan's tangent-space XY slopes are projected into world axes. Removing
// their normal component keeps relief continuous across triplanar blends.
enhancedGradient -= enhancedWorldN * dot( enhancedGradient, enhancedWorldN );
vec3 enhancedReliefN = normalize( enhancedWorldN + enhancedGradient * enhancedReliefStrength );
normal = normalize( mat3( viewMatrix ) * enhancedReliefN );
#ifdef DOUBLE_SIDED
  normal *= faceDirection;
#endif
`;

export function installEnhancedMaterialShader(material, uniforms, sand = false) {
  if (sand) material.defines = { ...material.defines, ENHANCED_SAND: 1 };
  const atlas = Boolean(uniforms.enhancedAtlas);
  if (atlas) material.defines = { ...material.defines, ENHANCED_ATLAS: 1 };
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = `varying vec3 vEnhancedMaterialWorld;\n#ifdef ENHANCED_ATLAS\nvarying vec2 vEnhancedAtlasUV;\nuniform mat3 enhancedAtlasTransform;\n#endif\n${shader.vertexShader}`;
    shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
      #ifdef ENHANCED_ATLAS
        vEnhancedAtlasUV = ( enhancedAtlasTransform * vec3( uv, 1.0 ) ).xy;
      #endif
    `);
    shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      vec4 enhancedWorldPosition = vec4( transformed, 1.0 );
      #ifdef USE_BATCHING
        enhancedWorldPosition = batchingMatrix * enhancedWorldPosition;
      #endif
      #ifdef USE_INSTANCING
        enhancedWorldPosition = instanceMatrix * enhancedWorldPosition;
      #endif
      vEnhancedMaterialWorld = ( modelMatrix * enhancedWorldPosition ).xyz;
    `);
    shader.fragmentShader = `${DECLARATIONS}\n${shader.fragmentShader}`;
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', COLOR)
      .replace('#include <roughnessmap_fragment>', ROUGHNESS)
      .replace('#include <normal_fragment_maps>', NORMAL);
  };
  material.customProgramCacheKey = () => `gulman-cc0-triplanar-v3-${material.defines?.ENHANCED_GARDEN ? 'garden' : sand ? 'shore' : 'surface'}-${atlas ? 'atlas' : 'plain'}`;
  return material;
}

/** Optional, lazily loaded CC0 textures. Never alters an original material/map.
 * Mark meshes using these materials userData.graphicsOwned = true, so the
 * GraphicsManager leaves their deliberate shader/material setup intact.
 */
export class EnhancedMaterialLibrary {
  constructor(assets, { textureLoader = new THREE.TextureLoader(), anisotropy = 4 } = {}) {
    this.assets = assets;
    this.loader = textureLoader;
    this.anisotropy = anisotropy;
    this.sets = new Map();
    this.materials = new Set();
    this.quality = 'high';
    this.loaded = false;
    this.disposed = false;
    this._promise = null;
  }

  async load() {
    if (this.disposed) throw new Error('Enhanced material library was disposed');
    if (this._promise) return this._promise;
    this._promise = (async () => {
      const manifest = await this.assets.json('assets/enhanced/materials/manifest.json');
      const loads = await Promise.allSettled(Object.entries(manifest.materials).map(async ([kind, record]) => {
        const set = { tileMeters: record.tileMeters, asset: record.asset };
        this.sets.set(kind, set);
        const maps = await Promise.allSettled(Object.entries(record.maps).map(async ([channel, entry]) => {
          const texture = await this.loader.loadAsync(this.assets.url(entry.path));
          if (this.disposed) { texture.dispose(); return; }
          texture.colorSpace = channel === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
          texture.anisotropy = this.anisotropy;
          texture.userData.graphicsOwned = true;
          set[channel] = texture;
        }));
        const failure = maps.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
      }));
      const failure = loads.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      if (this.disposed) throw new Error('Enhanced material library was disposed while loading');
      this.loaded = true;
      return this;
    })().catch(error => {
      for (const set of this.sets.values()) for (const value of Object.values(set)) if (value?.isTexture) value.dispose();
      this.sets.clear();
      this._promise = null;
      this.loaded = false;
      throw error;
    });
    return this._promise;
  }

  create(source, sourceMapPath = '', options = {}) {
    if (!source || source.alphaTest > 0 || (source.transparent && source.opacity < 1)) return null;
    const path = sourceMapPath || source.map?.image?.currentSrc || source.map?.image?.src || '';
    if(/(?:^|\/)terrain-ff344f98d7d2\.jpg(?:\?|$)/i.test(path)&&source.map)return this.createKind('grass',{side:source.side,atlas:source.map,garden:true,...options});
    const kind = classifyEnhancedSurface(path);
    if (!kind) return null;
    return this.createKind(kind, { side: source.side, atlas: kind === 'sand' ? source.map : null, ...options });
  }

  createKind(kind, { waterLevel = -1000000, tileMeters, normalStrength, color = 0xffffff, side = THREE.DoubleSide, atlas = null, garden = false } = {}) {
    if (!this.loaded || this.disposed) return null;
    const set = this.sets.get(kind);
    if (!set) return null;
    const uniforms = {
      enhancedColor: { value: set.color }, enhancedNormal: { value: set.normal },
      enhancedRoughness: { value: set.roughness },
      enhancedTileMeters: { value: tileMeters ?? set.tileMeters },
      enhancedNormalStrength: { value: normalStrength ?? (kind === 'sand' ? 0.36 : 0.65) },
      enhancedLow: { value: this.quality === 'low' ? 1 : 0 },
      enhancedWaterLevel: { value: Number.isFinite(waterLevel) ? waterLevel : -1000000 },
    };
    if (kind === 'sand'||garden) {
      const rock = this.sets.get(garden?'limestone':'rock');
      uniforms.enhancedRockColor = { value: rock.color };
      uniforms.enhancedRockNormal = { value: rock.normal };
      uniforms.enhancedRockRoughness = { value: rock.roughness };
      uniforms.enhancedRockMeters = { value: rock.tileMeters };
      if (atlas?.isTexture) {
        uniforms.enhancedAtlas = { value: atlas };
        uniforms.enhancedAtlasTransform = { value: new THREE.Matrix3().setUvTransform(atlas.offset.x, atlas.offset.y, atlas.repeat.x, atlas.repeat.y, atlas.rotation, atlas.center.x, atlas.center.y) };
      }
    }
    const material = new THREE.MeshStandardMaterial({ color, side, roughness: 1, metalness: 0, envMapIntensity: 0.55 });
    material.name = `Enhanced CC0 ${kind}`;
    material.userData = { graphicsOwned: true, enhancedSurface: kind, sourceAsset: set.asset, enhancedUniforms: uniforms };
    if (['sand', 'rock', 'grass'].includes(kind)) material.defines = { ENHANCED_NATURAL: 1 };
    if (kind === 'rock') material.defines.ENHANCED_ROCK_SURFACE = 1;
    if (garden) material.defines={...material.defines,ENHANCED_GARDEN:1};
    installEnhancedMaterialShader(material, uniforms, kind === 'sand');
    this.materials.add(material);
    return material;
  }

  setQuality(quality) {
    this.quality = quality === 'low' ? 'low' : 'high';
    for (const material of this.materials) material.userData.enhancedUniforms.enhancedLow.value = this.quality === 'low' ? 1 : 0;
  }

  disposeMaterial(material) {
    if (this.materials.delete(material)) material.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const material of this.materials) material.dispose();
    this.materials.clear();
    for (const set of this.sets.values()) for (const value of Object.values(set)) if (value?.isTexture) value.dispose();
    this.sets.clear();
    this.loaded = false;
  }
}
