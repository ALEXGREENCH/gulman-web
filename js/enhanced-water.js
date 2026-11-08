import * as THREE from 'three';

// Independent implementation of layered Gerstner/sine surface waves.
// Physical model reference: NVIDIA GPU Gems, ch. 1, Mark Finch / Cyan Worlds.
// https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models
const QUALITY = Object.freeze({
  high: Object.freeze({ triangleBudget: 30000, spacing: 1.35, rippleLayers: 4 }),
  low: Object.freeze({ triangleBudget: 6000, spacing: 3, rippleLayers: 2 }),
});
const MAX_DEPTH = 12;
const MAX_EDGE = 12;
const BATHYMETRY_SIZE = 128;
const isWaterPath = path => /(?:^|[/\\])water(?:[-_.]|$)/i.test(String(path ?? ''));
const edgeKey = (a, b) => {
  const point = p => `${Math.round(p[0] * 10000)},${Math.round(p[2] * 10000)}`;
  const x = point(a), y = point(b);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
};
const crossXZ = (a, b, c) => (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]);
const pointAt = (mesh, index, scale) => [mesh.vertices[index * 3] * scale, mesh.vertices[index * 3 + 1] * scale, mesh.vertices[index * 3 + 2] * scale];

function triangleGroups(mesh) {
  return mesh.groups?.length ? mesh.groups : [{ start: 0, count: mesh.indices.length, material: '' }];
}

function pointDistanceToEdge(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[2] - a[2];
  const t = THREE.MathUtils.clamp(((x - a[0]) * dx + (z - a[2]) * dz) / Math.max(1e-12, dx * dx + dz * dz), 0, 1);
  return Math.hypot(x - a[0] - dx * t, z - a[2] - dz * t);
}

function shoreDistance(surface, x, z) {
  let result = Infinity;
  for (const [a, b] of surface.edges) result = Math.min(result, pointDistanceToEdge(x, z, a, b));
  return Number.isFinite(result) ? result : MAX_EDGE;
}

function barycentricXZ(x, z, triangle) {
  const [a, b, c] = triangle;
  const determinant = crossXZ(a, b, c);
  if (Math.abs(determinant) < 1e-10) return null;
  const u = ((x - a[0]) * (c[2] - a[2]) - (z - a[2]) * (c[0] - a[0])) / determinant;
  const v = ((b[0] - a[0]) * (z - a[2]) - (b[2] - a[2]) * (x - a[0])) / determinant;
  return [1 - u - v, u, v];
}

/** Read exact horizontal original footprints, never material-name guesses.
 * BEACH.JPG labelled waterf1 and URNA.JPG labelled water are not water.
 * Vertical WATER.JPG panels remain part of the original world.
 */
export function extractWaterSurfaces(modelData, scale = 0.01) {
  const materials = new Set(Object.entries(modelData?.materials ?? {}).filter(([, value]) => isWaterPath(value.map)).map(([name]) => name));
  const surfaces = [];
  const unsafeMaterials = new Set();
  for (const mesh of modelData?.meshes ?? []) for (const group of triangleGroups(mesh)) {
    if (!materials.has(group.material)) continue;
    const triangles = [];
    for (let i = group.start; i < group.start + group.count; i += 3) {
      const triangle = mesh.indices.slice(i, i + 3).map(index => pointAt(mesh, index, scale));
      const [a, b, c] = triangle;
      const ab = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const ac = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      const normal = ab.cross(ac);
      const horizontal = normal.lengthSq() > 1e-12 && Math.abs(normal.y) / normal.length() > 0.995
        && Math.max(a[1], b[1], c[1]) - Math.min(a[1], b[1], c[1]) < 0.025;
      if (!horizontal) { unsafeMaterials.add(group.material); continue; }
      if (normal.y < 0) [triangle[1], triangle[2]] = [triangle[2], triangle[1]];
      triangles.push(triangle);
    }
    if (!triangles.length) continue;
    const bounds = new THREE.Box3();
    const edges = new Map();
    let area = 0, longestEdge = 0;
    for (const triangle of triangles) {
      for (const point of triangle) bounds.expandByPoint(new THREE.Vector3(...point));
      area += Math.abs(crossXZ(...triangle)) / 2;
      for (let i = 0; i < 3; i++) {
        const a = triangle[i], b = triangle[(i + 1) % 3], key = edgeKey(a, b);
        longestEdge = Math.max(longestEdge, Math.hypot(a[0] - b[0], a[2] - b[2]));
        if (edges.has(key)) edges.get(key).count++;
        else edges.set(key, { count: 1, points: [a, b] });
      }
    }
    surfaces.push({
      name: mesh.name ?? 'water', material: group.material, triangles, bounds, area, longestEdge,
      level: (bounds.min.y + bounds.max.y) / 2, ocean: area > 1200,
      edges: [...edges.values()].filter(edge => edge.count === 1).map(edge => edge.points),
    });
  }
  // A merged original batch cannot hide just some triangles. Keep mixed
  // horizontal/vertical materials entirely original instead of losing panels.
  return surfaces.filter(surface => !unsafeMaterials.has(surface.material));
}

/** Rasterize only static surfaces beneath the water into a small bathymetry map.
 * Unknown ocean floor is deep; geometry above the water is never a fake bottom.
 */
export function bakeWaterDepth(surface, modelData, { scale = 0.01, size = BATHYMETRY_SIZE, groundSample } = {}) {
  size = Math.max(8, Math.min(256, Math.round(size)));
  const heights = new Float32Array(size * size).fill(-Infinity);
  const width = Math.max(0.001, surface.bounds.max.x - surface.bounds.min.x);
  const length = Math.max(0.001, surface.bounds.max.z - surface.bounds.min.z);
  const xmin = surface.bounds.min.x, zmin = surface.bounds.min.z;
  const worldX = x => xmin + x / (size - 1) * width;
  const worldZ = z => zmin + z / (size - 1) * length;
  if (groundSample) {
    for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
      // The game's collision world includes the old water plane. Start just
      // underneath it, or every sample would incorrectly report zero depth.
      const floor = groundSample(worldX(x), surface.level - 0.04, worldZ(z));
      if (Number.isFinite(floor) && floor <= surface.level - 0.03) heights[z * size + x] = floor;
    }
  } else {
    for (const mesh of modelData.meshes ?? []) for (const group of triangleGroups(mesh)) {
      if (isWaterPath(modelData.materials?.[group.material]?.map)) continue;
      for (let i = group.start; i < group.start + group.count; i += 3) {
        const triangle = mesh.indices.slice(i, i + 3).map(index => pointAt(mesh, index, scale));
        const ys = triangle.map(point => point[1]);
        if (Math.min(...ys) > surface.level + 0.4 || Math.max(...ys) < surface.level - MAX_DEPTH) continue;
        const txmin = Math.min(...triangle.map(point => point[0])), txmax = Math.max(...triangle.map(point => point[0]));
        const tzmin = Math.min(...triangle.map(point => point[2])), tzmax = Math.max(...triangle.map(point => point[2]));
        if (txmax < xmin || txmin > xmin + width || tzmax < zmin || tzmin > zmin + length || Math.abs(crossXZ(...triangle)) < 1e-8) continue;
        const x0 = Math.max(0, Math.floor((txmin - xmin) / width * (size - 1)));
        const x1 = Math.min(size - 1, Math.ceil((txmax - xmin) / width * (size - 1)));
        const z0 = Math.max(0, Math.floor((tzmin - zmin) / length * (size - 1)));
        const z1 = Math.min(size - 1, Math.ceil((tzmax - zmin) / length * (size - 1)));
        for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
          const weights = barycentricXZ(worldX(x), worldZ(z), triangle);
          if (!weights || Math.min(...weights) < -1e-5) continue;
          const y = weights[0] * ys[0] + weights[1] * ys[1] + weights[2] * ys[2];
          if (y <= surface.level + 0.4) heights[z * size + x] = Math.max(heights[z * size + x], y);
        }
      }
    }
  }
  const pixels = new Uint8Array(size * size * 4);
  const depth = new Float32Array(size * size);
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    const i = z * size + x, measured = Number.isFinite(heights[i]);
    depth[i] = measured ? THREE.MathUtils.clamp(surface.level - heights[i], 0, MAX_DEPTH) : surface.ocean ? 8 : 1.7;
    pixels[i * 4] = Math.round(depth[i] / MAX_DEPTH * 255);
    pixels[i * 4 + 1] = measured ? 255 : 0;
    pixels[i * 4 + 2] = Math.round(Math.min(MAX_EDGE, shoreDistance(surface, worldX(x), worldZ(z))) / MAX_EDGE * 255);
    pixels[i * 4 + 3] = 255;
  }
  return { pixels, depth, size, bounds: [xmin, zmin, width, length] };
}

function sampleDepth(map, x, z) {
  const [xmin, zmin, width, length] = map.bounds;
  const u = THREE.MathUtils.clamp((x - xmin) / width, 0, 1) * (map.size - 1);
  const v = THREE.MathUtils.clamp((z - zmin) / length, 0, 1) * (map.size - 1);
  const x0 = Math.floor(u), z0 = Math.floor(v), x1 = Math.min(map.size - 1, x0 + 1), z1 = Math.min(map.size - 1, z0 + 1);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(map.depth[z0 * map.size + x0], map.depth[z0 * map.size + x1], u - x0),
    THREE.MathUtils.lerp(map.depth[z1 * map.size + x0], map.depth[z1 * map.size + x1], u - x0), v - z0);
}

function waveParameters(surface, divisions) {
  const cell = surface.longestEdge / divisions;
  const scale = surface.ocean ? 1 : 0.24;
  return [
    [0.92, 0.39, Math.max(surface.ocean ? 24 : 4.8, cell * 5), 0.16 * scale],
    [-0.36, 0.93, Math.max(surface.ocean ? 13 : 2.8, cell * 3), 0.085 * scale],
    [0.62, -0.78, Math.max(surface.ocean ? 7 : 1.7, cell * 2), 0.035 * scale],
  ];
}

/** CPU counterpart supports floating props and deterministic animation tests. */
export function evaluateWaterWaves(x, z, time, waves, attenuation = 1, layers = 3) {
  const offset = new THREE.Vector3();
  const tangent = new THREE.Vector3(1, 0, 0), binormal = new THREE.Vector3(0, 0, 1);
  for (const [dx, dz, wavelength, amplitude] of waves.slice(0, layers)) {
    const k = Math.PI * 2 / wavelength, a = amplitude * attenuation;
    const phase = k * (dx * x + dz * z) - Math.sqrt(9.81 * k) * time;
    const sine = Math.sin(phase), cosine = Math.cos(phase), horizontal = a * 0.32;
    offset.x += dx * horizontal * cosine; offset.y += a * sine; offset.z += dz * horizontal * cosine;
    tangent.x -= dx * dx * horizontal * k * sine; tangent.y += dx * a * k * cosine; tangent.z -= dx * dz * horizontal * k * sine;
    binormal.x -= dx * dz * horizontal * k * sine; binormal.y += dz * a * k * cosine; binormal.z -= dz * dz * horizontal * k * sine;
  }
  return { offset, normal: binormal.cross(tangent).normalize() };
}

function tessellate(surface, divisions, bathymetry) {
  const verticesPerTriangle = (divisions + 1) * (divisions + 2) / 2;
  const count = verticesPerTriangle * surface.triangles.length;
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2), waterData = new Float32Array(count * 2);
  const indices = count > 65535 ? new Uint32Array(surface.triangles.length * divisions * divisions * 3) : new Uint16Array(surface.triangles.length * divisions * divisions * 3);
  let base = 0, indexOffset = 0;
  for (const [a, b, c] of surface.triangles) {
    let vertex = base;
    for (let i = 0; i <= divisions; i++) for (let j = 0; j <= divisions - i; j++) {
      const u = i / divisions, v = j / divisions;
      const x = a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v;
      const z = a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * v;
      positions.set([x, surface.level + 0.015, z], vertex * 3);
      normals[vertex * 3 + 1] = 1;
      uv.set([x / 3, -z / 3], vertex * 2);
      waterData.set([sampleDepth(bathymetry, x, z), shoreDistance(surface, x, z)], vertex * 2);
      vertex++;
    }
    const row = i => base + i * (divisions + 1) - i * (i - 1) / 2;
    for (let i = 0; i < divisions; i++) for (let j = 0; j < divisions - i; j++) {
      indices.set([row(i) + j, row(i + 1) + j, row(i) + j + 1], indexOffset); indexOffset += 3;
      if (j < divisions - i - 1) { indices.set([row(i + 1) + j, row(i + 1) + j + 1, row(i) + j + 1], indexOffset); indexOffset += 3; }
    }
    base += verticesPerTriangle;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('waterData', new THREE.BufferAttribute(waterData, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox(); geometry.boundingBox.expandByScalar(0.6);
  geometry.computeBoundingSphere(); geometry.boundingSphere.radius += 0.6;
  return geometry;
}

const vertexPrelude = /* glsl */`
  uniform float waterTime;
  uniform vec4 waterWaves[3];
  attribute vec2 waterData;
  varying vec2 vWaterXZ;
  varying float vWaterCrest;
  void waterDisplace(vec2 point, float attenuation, out vec3 displacement, out vec3 resultNormal) {
    displacement = vec3(0.0);
    vec3 tangent = vec3(1.0, 0.0, 0.0);
    vec3 binormal = vec3(0.0, 0.0, 1.0);
    for (int i = 0; i < 3; i++) {
      #ifdef GULMAN_WATER_LOW
        if (i == 2) break;
      #endif
      vec4 wave = waterWaves[i];
      float k = 6.28318530718 / wave.z;
      float a = wave.w * attenuation;
      float phase = k * dot(wave.xy, point) - sqrt(9.81 * k) * waterTime;
      float s = sin(phase), c = cos(phase), horizontal = a * 0.32;
      displacement += vec3(wave.x * horizontal * c, a * s, wave.y * horizontal * c);
      tangent += vec3(-wave.x * wave.x * horizontal * k * s, wave.x * a * k * c, -wave.x * wave.y * horizontal * k * s);
      binormal += vec3(-wave.x * wave.y * horizontal * k * s, wave.y * a * k * c, -wave.y * wave.y * horizontal * k * s);
    }
    resultNormal = normalize(cross(binormal, tangent));
  }
`;

const fragmentPrelude = /* glsl */`
  uniform float waterTime;
  uniform sampler2D waterDepth;
  uniform vec4 waterBounds;
  uniform vec3 waterShallowColor;
  uniform vec3 waterDeepColor;
  varying vec2 vWaterXZ;
  varying float vWaterCrest;
  float waterNoise(vec2 point) {
    vec2 cell = floor(point), f = fract(point);
    f = f * f * (3.0 - 2.0 * f);
    float a = fract(sin(dot(cell, vec2(127.1,311.7))) * 43758.5453);
    float b = fract(sin(dot(cell + vec2(1.0,0.0), vec2(127.1,311.7))) * 43758.5453);
    float c = fract(sin(dot(cell + vec2(0.0,1.0), vec2(127.1,311.7))) * 43758.5453);
    float d = fract(sin(dot(cell + vec2(1.0,1.0), vec2(127.1,311.7))) * 43758.5453);
    return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
  }
`;

function createMaterial(surface, bathymetry, normalMap, quality) {
  const depthTexture = new THREE.DataTexture(bathymetry.pixels, bathymetry.size, bathymetry.size);
  depthTexture.name = `water-depth:${surface.name}`;
  depthTexture.minFilter = depthTexture.magFilter = THREE.LinearFilter;
  depthTexture.generateMipmaps = false;
  depthTexture.userData.graphicsOwned = true;
  depthTexture.needsUpdate = true;
  const uniforms = {
    waterTime: { value: 0 }, waterWaves: { value: [] }, waterDepth: { value: depthTexture },
    waterBounds: { value: new THREE.Vector4(...bathymetry.bounds) },
    waterShallowColor: { value: new THREE.Color(surface.ocean ? 0x36a8a4 : 0x53b9be) },
    waterDeepColor: { value: new THREE.Color(surface.ocean ? 0x073841 : 0x125060) },
  };
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.16, ior: 1.333,
    clearcoat: 0,
    transparent: true, opacity: 0.96, depthWrite: false, side: THREE.DoubleSide,
    envMapIntensity: 1.4, normalMap, normalScale: new THREE.Vector2(0.32, 0.32),
    dithering: true, fog: true,
  });
  material.name = `enhanced-water:${surface.name}`;
  // The water sheet has no thickness; rendering both transparent faces in two
  // separate scene submissions adds cost without adding a visible surface.
  material.forceSinglePass = true;
  material.userData.graphicsOwned = true;
  if (quality === 'low') material.defines.GULMAN_WATER_LOW = 1;
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = vertexPrelude + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `
      float waterAttenuation = smoothstep(0.0, 1.25, waterData.y) * smoothstep(0.0, 0.65, waterData.x);
      vec3 waterOffset, objectNormal;
      waterDisplace(position.xz, waterAttenuation, waterOffset, objectNormal);
      #ifdef USE_TANGENT
        vec3 objectTangent = vec3(tangent.xyz);
      #endif
    `);
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      transformed += waterOffset;
      vWaterXZ = position.xz;
      vWaterCrest = waterOffset.y;
    `);
    shader.fragmentShader = fragmentPrelude + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      vec2 waterUV = clamp((vWaterXZ - waterBounds.xy) / waterBounds.zw, 0.0, 1.0);
      vec3 waterBed = texture2D(waterDepth, waterUV).rgb;
      float waterMeters = waterBed.r * 12.0;
      float waterEdge = waterBed.b * 12.0;
      float waterTransmission = exp(-waterMeters * 0.3);
      float waterBreakup = waterNoise(vWaterXZ * 2.1 + vec2(waterTime * 0.11, -waterTime * 0.07));
      float waterShore = (1.0 - smoothstep(0.015, 0.48, waterMeters)) * waterBed.g;
      float waterRim = (1.0 - smoothstep(0.02, 0.75, waterEdge)) * (1.0 - smoothstep(1.2, 2.8, waterMeters));
      float waterPulse = 0.45 + 0.55 * sin(waterMeters * 12.0 - waterTime * 1.7 + waterBreakup * 3.0);
      float waterFoam = clamp((waterShore + waterRim * 0.4) * smoothstep(0.18, 0.7, waterBreakup) * waterPulse, 0.0, 0.68);
      #ifndef GULMAN_WATER_LOW
        waterFoam += smoothstep(0.17, 0.25, vWaterCrest) * smoothstep(0.58, 0.85, waterBreakup) * 0.14;
      #endif
      diffuseColor.rgb = mix(waterDeepColor, waterShallowColor, waterTransmission);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.86, 0.82), waterFoam);
      diffuseColor.a = mix(0.97, 0.78, waterTransmission) + waterFoam * 0.08;
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      vec2 ripplePoint = vWaterXZ;
      float rippleA = dot(ripplePoint, vec2(2.2, 1.15)) - waterTime * 1.6;
      float rippleB = dot(ripplePoint, vec2(-3.4, 4.8)) - waterTime * 2.2;
      vec2 waterSlope = vec2(0.12, 0.064) * cos(rippleA) + vec2(-0.05, 0.071) * cos(rippleB);
      #ifndef GULMAN_WATER_LOW
        float rippleC = dot(ripplePoint, vec2(13.7, -7.3)) + waterTime * 3.4;
        float rippleD = dot(ripplePoint, vec2(27.1, 18.9)) - waterTime * 4.6;
        float rippleFade = 1.0 - smoothstep(0.7, 4.0, max(length(dFdx(ripplePoint * 27.1)), length(dFdy(ripplePoint * 27.1))));
        waterSlope += (vec2(0.027, -0.014) * cos(rippleC) + vec2(0.018, 0.012) * cos(rippleD)) * rippleFade;
      #endif
      vec3 waterViewSlope = mat3(viewMatrix) * vec3(waterSlope.x, 0.0, waterSlope.y);
      waterViewSlope -= normal * dot(normal, waterViewSlope);
      normal = normalize(normal - waterViewSlope * (1.0 - waterFoam * 0.7));
      roughnessFactor = mix(0.13, 0.68, waterFoam);
    `);
  };
  material.customProgramCacheKey = () => 'gulman-enhanced-water-v1';
  return { material, depthTexture, uniforms };
}

/** Tessellated replacement surfaces. No original geometry/material is mutated.
 * Configure after GraphicsManager.applyScene, before rendering. Geometry follows
 * the source model's exact triangles; collision remains the original game's.
 */
export class EnhancedWater {
  constructor({ scene, world, modelData, quality = 'high', scale = 0.01, normalMap = null, groundSample = null } = {}) {
    if (!scene || !world || !modelData) throw new TypeError('EnhancedWater requires scene, world and original modelData');
    this.scene = scene; this.world = world; this.modelData = modelData; this.scale = scale;
    this.quality = quality === 'low' ? 'low' : 'high';
    this.groundSample = groundSample;
    this.surfaces = extractWaterSurfaces(modelData, scale);
    this.root = new THREE.Group();
    this.root.name = 'enhanced-water';
    this.root.userData.graphicsOwned = true; this.root.userData.collision = false;
    this.root.visible = false;
    scene.add(this.root);
    this.enabled = false; this.disposed = false; this.time = 0;
    this._parts = [];
    this._visibility = new Map();
    this._sourceNormal = null;
    this._normalMap = null;
    this.setNormalMap(normalMap);
  }

  get diagnostics() {
    return {
      enabled: this.enabled, quality: this.quality, surfaces: this.surfaces.length,
      drawCalls: this.enabled ? this._parts.length : 0,
      triangles: this._parts.reduce((sum, part) => sum + part.mesh.geometry.index.count / 3, 0),
      vertices: this._parts.reduce((sum, part) => sum + part.mesh.geometry.attributes.position.count, 0),
      triangleBudget: QUALITY[this.quality].triangleBudget,
      hiddenOriginalBatches: this._visibility.size,
    };
  }

  setNormalMap(texture) {
    if (this.disposed || texture === this._sourceNormal) return this;
    this._normalMap?.dispose();
    this._sourceNormal = texture;
    this._normalMap = texture?.clone() ?? null;
    if (this._normalMap) {
      this._normalMap.colorSpace = THREE.NoColorSpace;
      this._normalMap.wrapS = this._normalMap.wrapT = THREE.RepeatWrapping;
      this._normalMap.repeat.set(1, 1);
      this._normalMap.anisotropy = Math.min(8, texture.anisotropy || 4);
      this._normalMap.userData.graphicsOwned = true;
      this._normalMap.needsUpdate = true;
    }
    for (const part of this._parts) { part.material.normalMap = this._normalMap; part.material.needsUpdate = true; }
    return this;
  }

  _divisions(surface) {
    const sourceTriangles = this.surfaces.reduce((sum, body) => sum + body.triangles.length, 0);
    const cap = Math.max(1, Math.floor(Math.sqrt(QUALITY[this.quality].triangleBudget / Math.max(1, sourceTriangles))));
    return Math.max(1, Math.min(cap, Math.ceil(surface.longestEdge / QUALITY[this.quality].spacing)));
  }

  _build() {
    for (const surface of this.surfaces) {
      const bathymetry = bakeWaterDepth(surface, this.modelData, { scale: this.scale, groundSample: this.groundSample });
      const divisions = this._divisions(surface);
      const data = createMaterial(surface, bathymetry, this._normalMap, this.quality);
      const mesh = new THREE.Mesh(tessellate(surface, divisions, bathymetry), data.material);
      mesh.name = `enhanced-water:${surface.name}`;
      mesh.userData.graphicsOwned = true; mesh.userData.collision = false;
      mesh.castShadow = false; mesh.receiveShadow = true;
      mesh.renderOrder = 2;
      const waves = waveParameters(surface, divisions);
      data.uniforms.waterWaves.value = waves.map(wave => new THREE.Vector4(...wave));
      this._parts.push({ ...data, mesh, surface, bathymetry, waves });
      this.root.add(mesh);
    }
  }

  _clear() {
    for (const part of this._parts) {
      part.mesh.removeFromParent(); part.mesh.geometry.dispose(); part.material.dispose(); part.depthTexture.dispose();
    }
    this._parts.length = 0;
  }

  setEnabled(enabled) {
    if (this.disposed || Boolean(enabled) === this.enabled) return this;
    this.enabled = Boolean(enabled);
    if (this.enabled) {
      if (!this._parts.length) this._build();
      const names = new Set(this.surfaces.map(surface => `world:${surface.material}`));
      this.world.traverse(object => {
        if (!object.isMesh || !names.has(object.name)) return;
        this._visibility.set(object, object.visible); object.visible = false;
      });
      this.root.visible = true;
      this.update(this.time, null, this.quality);
    } else {
      this.root.visible = false;
      for (const [object, visible] of this._visibility) object.visible = visible;
      this._visibility.clear();
      this._clear();
    }
    return this;
  }

  update(time, camera, quality = this.quality) {
    if (this.disposed) return this;
    this.time = Number.isFinite(time) ? time : this.time;
    const nextQuality = quality === 'low' ? 'low' : 'high';
    if (nextQuality !== this.quality) {
      this.quality = nextQuality;
      for (const part of this._parts) {
        const divisions = this._divisions(part.surface);
        part.mesh.geometry.dispose(); part.mesh.geometry = tessellate(part.surface, divisions, part.bathymetry);
        part.waves = waveParameters(part.surface, divisions);
        part.uniforms.waterWaves.value = part.waves.map(wave => new THREE.Vector4(...wave));
        if (this.quality === 'low') part.material.defines.GULMAN_WATER_LOW = 1;
        else delete part.material.defines.GULMAN_WATER_LOW;
        part.material.clearcoat = 0;
        part.material.needsUpdate = true;
      }
    }
    for (const part of this._parts) part.uniforms.waterTime.value = this.time;
    if (this._normalMap) this._normalMap.offset.set(this.time * 0.008, -this.time * 0.005);
    return this;
  }

  heightAt(x, z, time = this.time) {
    for (const part of this._parts) {
      const inside = part.surface.triangles.some(triangle => {
        const weights = barycentricXZ(x, z, triangle);
        return weights && Math.min(...weights) >= -1e-5;
      });
      if (!inside) continue;
      const edge = shoreDistance(part.surface, x, z), depth = sampleDepth(part.bathymetry, x, z);
      const fade = THREE.MathUtils.smoothstep(edge, 0, 1.25) * THREE.MathUtils.smoothstep(depth, 0, 0.65);
      return part.surface.level + 0.015 + evaluateWaterWaves(x, z, time, part.waves, fade, this.quality === 'low' ? 2 : 3).offset.y;
    }
    return undefined;
  }

  dispose() {
    if (this.disposed) return;
    this.setEnabled(false);
    this._clear();
    this._normalMap?.dispose(); this._normalMap = null; this._sourceNormal = null;
    this.root.removeFromParent();
    this.disposed = true;
  }
}
