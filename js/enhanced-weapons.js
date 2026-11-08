import * as THREE from 'three';

/** New, code-authored models and surface maps for Enhanced mode. These are not
 * retouched copies of the original game meshes or models from another game.
 * Coordinates: metres, grip at the origin, +Y up, barrel pointing along -Z. */
export const ENHANCED_WEAPON_SPECS = Object.freeze([
  Object.freeze({ name: 'G12 compact', muzzle: [0, 0.057, -0.255], support: [-0.039, -0.045, -0.022], length: 0.32 }),
  Object.freeze({ name: 'AR30 carbine', muzzle: [0, 0.065, -0.49], support: [-0.038, -0.024, -0.275], length: 0.70 }),
  Object.freeze({ name: 'Fragmentation grenade', muzzle: [0, 0.040, -0.045], support: [0, 0, 0], length: 0.11 }),
  Object.freeze({ name: 'BG9 heavy launcher', muzzle: [0, 0.069, -0.515], support: [-0.052, -0.056, -0.305], length: 0.72 }),
]);

const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const ease = (a, b, value) => { const t = clamp((value - a) / (b - a)); return t * t * (3 - 2 * t); };
const pulse = (start, peak, end, time) => ease(start, peak, time) * (1 - ease(peak, end, time));
const rotation = values => new THREE.Quaternion().setFromEuler(new THREE.Euler(...values));

/** Subtle deterministic brushed metal / molded-polymer maps, generated once
 * for a model. No canvas, network request, random runtime mutation or image IO. */
function surfaceMaps(kind) {
  const size = 128, normals = new Uint8Array(size * size * 4), roughness = new Uint8Array(size * size * 4);
  let seed = kind === 'metal' ? 0x46182fa1 : 0x172bc53d;
  const noise = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const offset = (y * size + x) * 4, grain = noise() - 0.5;
    const brushed = Math.sin(y * 2.65) * 0.5 + Math.sin(y * 0.69) * 0.2;
    normals[offset] = 128 + Math.round(grain * (kind === 'metal' ? 3 : 19));
    normals[offset + 1] = 128 + Math.round((kind === 'metal' ? brushed : noise() - 0.5) * (kind === 'metal' ? 8 : 19));
    normals[offset + 2] = 254; normals[offset + 3] = 255;
    const value = clamp(Math.round((kind === 'metal' ? 176 : 218) + grain * 23 + (kind === 'metal' ? brushed * 10 : 0)), 0, 255);
    roughness.set([value, value, value, 255], offset);
  }
  const make = bytes => {
    const texture = new THREE.DataTexture(bytes, size, size);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(6, 6);
    texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true; texture.needsUpdate = true;
    texture.userData.graphicsOwned = true;
    return texture;
  };
  return { normal: make(normals), roughness: make(roughness) };
}

function bevelBox(width, height, depth, radius = Math.min(width, height, depth) * 0.12) {
  const r = Math.max(0.0001, Math.min(radius, Math.min(width, height, depth) * 0.4));
  const x = width / 2 - r, y = height / 2 - r;
  const outline = new THREE.Shape();
  outline.moveTo(-x, -y); outline.lineTo(x, -y); outline.lineTo(x, y); outline.lineTo(-x, y); outline.closePath();
  const geometry = new THREE.ExtrudeGeometry(outline, {
    depth: depth - 2 * r, steps: 1, bevelEnabled: true, bevelThickness: r, bevelSize: r, bevelSegments: 2, curveSegments: 2,
  });
  geometry.translate(0, 0, -(depth - 2 * r) / 2);
  return geometry;
}

/** Merge static detail by material inside each independently animated part. */
class Builder {
  constructor(materials) { this.materials = materials; this.batches = new Map(); this.authoredParts = 0; }
  add(parent, geometry, material, position = [0, 0, 0], angles = [0, 0, 0], scale = [1, 1, 1]) {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat !== geometry) geometry.dispose();
    flat.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...position), rotation(angles), new THREE.Vector3(...scale)));
    let batches = this.batches.get(parent);
    if (!batches) { batches = new Map(); this.batches.set(parent, batches); }
    const list = batches.get(material) ?? [];
    list.push(flat); batches.set(material, list); this.authoredParts++;
  }
  box(parent, material, size, position, angles = [0, 0, 0], radius) { this.add(parent, bevelBox(...size, radius), material, position, angles); }
  cylinder(parent, material, radius, length, position, angles = [Math.PI / 2, 0, 0], topRadius = radius, segments = 20) {
    this.add(parent, new THREE.CylinderGeometry(topRadius, radius, length, segments), material, position, angles);
  }
  torus(parent, material, radius, tube, position, angles = [0, 0, 0], segments = 24) {
    this.add(parent, new THREE.TorusGeometry(radius, tube, 6, segments), material, position, angles);
  }
  tube(parent, material, points, radius = 0.004) {
    const curve = new THREE.CatmullRomCurve3(points.map(point => new THREE.Vector3(...point)));
    this.add(parent, new THREE.TubeGeometry(curve, 18, radius, 6, false), material);
  }
  finish(geometries) {
    for (const [parent, materials] of this.batches) for (const [key, source] of materials) {
      const vertices = source.reduce((sum, geometry) => sum + geometry.attributes.position.count, 0), merged = new THREE.BufferGeometry();
      for (const [name, width] of [['position', 3], ['normal', 3], ['uv', 2]]) {
        const values = new Float32Array(vertices * width);
        let offset = 0;
        for (const geometry of source) { const data = geometry.attributes[name].array; values.set(data, offset); offset += data.length; }
        merged.setAttribute(name, new THREE.BufferAttribute(values, width));
      }
      merged.computeBoundingBox(); merged.computeBoundingSphere(); geometries.add(merged);
      const mesh = new THREE.Mesh(merged, this.materials[key]);
      mesh.name = `${parent.name}:${key}`;
      mesh.userData.graphicsOwned = true; mesh.userData.enhancedWeapon = true;
      mesh.castShadow = mesh.receiveShadow = false; mesh.frustumCulled = false;
      mesh.renderOrder = 10020 + (key === 'marking' || key === 'glass' ? 3 : key === 'steel' ? 1 : 0);
      parent.add(mesh);
      for (const geometry of source) geometry.dispose();
    }
    this.batches.clear();
  }
}

function commonGrip(b, body, magazine, long = false) {
  b.box(body, 'polymer', [0.045, 0.106, 0.057], [0, -0.052, 0.019], [-0.21, 0, 0], 0.006);
  for (const side of [-1, 1]) {
    b.box(body, 'rubber', [0.0035, 0.079, 0.041], [side * 0.0225, -0.055, 0.019], [-0.21, 0, 0], 0.001);
    for (let n = 0; n < 6; n++) b.box(body, 'polymer', [0.005, 0.004, 0.034], [side * 0.024, -0.024 - n * 0.011, 0.012 + n * 0.0025], [-0.21, 0, 0], 0.001);
  }
  b.tube(body, 'polymer', [[0, 0.005, -0.047], [0, -0.034, -0.059], [0, -0.043, -0.021], [0, -0.010, -0.009]], 0.006);
  b.tube(body, 'steel', [[0, 0.006, -0.032], [0, -0.017, -0.038], [0, -0.029, -0.025]], 0.0035);
  if (!long) {
    b.box(magazine, 'metal', [0.031, 0.085, 0.039], [0, -0.065, 0.020], [-0.21, 0, 0], 0.003);
    b.box(magazine, 'rubber', [0.048, 0.012, 0.060], [0, -0.112, 0.030], [-0.21, 0, 0], 0.003);
  }
}

function screws(b, body, x, y, zPositions) {
  for (const z of zPositions) for (const side of [-1, 1]) {
    b.cylinder(body, 'steel', 0.0032, 0.002, [side * x, y, z], [0, 0, Math.PI / 2], 0.0032, 8);
    b.box(body, 'rubber', [0.0022, 0.001, 0.004], [side * (x + 0.001), y, z]);
  }
}

function pistol(b, body, parts) {
  commonGrip(b, body, parts.magazine);
  b.box(body, 'polymer', [0.048, 0.041, 0.205], [0, 0.018, -0.071], [0, 0, 0], 0.005);
  b.box(body, 'rubber', [0.036, 0.018, 0.072], [0, -0.007, -0.123], [0, 0, 0], 0.002);
  for (let n = 0; n < 4; n++) b.box(body, 'metal', [0.043, 0.005, 0.006], [0, -0.010, -0.145 + n * 0.016], [0, 0, 0], 0.001);
  b.box(parts.action, 'metal', [0.046, 0.043, 0.244], [0, 0.058, -0.09], [0, 0, 0], 0.006);
  b.box(parts.action, 'rubber', [0.032, 0.0018, 0.167], [0, 0.080, -0.095], [0, 0, 0], 0.0004);
  b.box(parts.action, 'rubber', [0.003, 0.021, 0.040], [0.023, 0.062, -0.068], [0, 0, 0], 0.001);
  b.box(parts.action, 'steel', [0.0032, 0.012, 0.026], [0.024, 0.065, -0.073], [0, 0, 0], 0.001);
  for (const side of [-1, 1]) for (let n = 0; n < 7; n++) b.box(parts.action, 'rubber', [0.0018, 0.028, 0.0028], [side * 0.0235, 0.056, 0.020 - n * 0.007], [0.16, 0, 0], 0.0005);
  b.cylinder(body, 'steel', 0.0115, 0.205, [0, 0.057, -0.148]);
  b.cylinder(body, 'metal', 0.0145, 0.027, [0, 0.057, -0.240]);
  b.cylinder(body, 'rubber', 0.0078, 0.001, [0, 0.057, -0.2548]);
  for (let n = 0; n < 3; n++) b.torus(body, 'steel', 0.0133, 0.001, [0, 0.057, -0.23 - n * 0.005]);
  for (const side of [-1, 1]) {
    b.box(parts.action, 'metal', [0.008, 0.013, 0.014], [side * 0.013, 0.086, 0.010]);
    b.box(parts.action, 'marking', [0.003, 0.003, 0.0015], [side * 0.013, 0.087, 0.0178]);
  }
  b.box(parts.action, 'metal', [0.008, 0.012, 0.012], [0, 0.086, -0.190]);
  b.box(parts.action, 'marking', [0.003, 0.003, 0.0015], [0, 0.087, -0.1838]);
  b.box(body, 'steel', [0.004, 0.007, 0.024], [-0.026, 0.021, -0.004], [0.1, 0, 0]);
  screws(b, body, 0.025, 0.016, [-0.035, 0.018]);
}

function rail(b, body, zStart, length, y) {
  b.box(body, 'metal', [0.034, 0.009, length], [0, y, zStart - length / 2]);
  for (let n = 0; n < Math.floor(length / 0.014); n++) b.box(body, 'metal', [0.041, 0.006, 0.007], [0, y + 0.006, zStart - n * 0.014], [0, 0, 0], 0.001);
}

function optic(b, body, z, heavy = false) {
  // A hollow open sight frame leaves the target visible; no solid box lens.
  const width = heavy ? 0.062 : 0.048, height = heavy ? 0.040 : 0.032, y = 0.125;
  b.box(body, 'metal', [width + 0.010, 0.013, 0.065], [0, 0.099, z]);
  for (const side of [-1, 1]) b.box(body, 'metal', [0.006, height, 0.027], [side * width / 2, y, z]);
  b.box(body, 'metal', [width, 0.006, 0.027], [0, y + height / 2, z]);
  b.box(body, 'glass', [width - 0.010, height - 0.004, 0.0012], [0, y, z + 0.008], [0.12, 0, 0], 0.0002);
  b.cylinder(body, 'rubber', 0.010, 0.007, [width / 2 + 0.005, 0.120, z], [0, 0, Math.PI / 2], 0.009, 12);
  b.box(body, 'marking', [0.0022, 0.0022, 0.0015], [0, 0.123, z + 0.010], [0, 0, 0], 0.0002);
}

function carbine(b, body, parts) {
  commonGrip(b, body, parts.magazine, true);
  b.box(body, 'metal', [0.061, 0.067, 0.227], [0, 0.048, -0.073], [0, 0, 0], 0.007);
  b.box(body, 'polymer', [0.055, 0.039, 0.160], [0, 0.009, -0.080], [0, 0, 0], 0.005);
  b.box(body, 'sand', [0.061, 0.067, 0.211], [0, 0.048, -0.281], [0, 0, 0], 0.010);
  for (const side of [-1, 1]) for (let n = 0; n < 7; n++) {
    b.box(body, 'rubber', [0.0025, 0.015, 0.018], [side * 0.031, 0.052, -0.199 - n * 0.025], [0, 0, 0], 0.001);
    b.box(body, 'metal', [0.0029, 0.003, 0.017], [side * 0.032, 0.063, -0.199 - n * 0.025], [0, 0, 0], 0.0005);
  }
  b.cylinder(body, 'metal', 0.011, 0.285, [0, 0.065, -0.345]);
  b.cylinder(body, 'metal', 0.020, 0.039, [0, 0.065, -0.469]);
  b.cylinder(body, 'rubber', 0.010, 0.001, [0, 0.065, -0.4895]);
  for (let n = 0; n < 3; n++) b.torus(body, 'steel', 0.018, 0.0018, [0, 0.065, -0.455 - n * 0.011]);
  rail(b, body, 0.023, 0.385, 0.085);
  optic(b, body, -0.065);
  b.cylinder(body, 'metal', 0.014, 0.155, [0, 0.045, 0.114]);
  b.box(body, 'sand', [0.055, 0.085, 0.113], [0, 0.018, 0.153], [0, 0, 0], 0.010);
  b.box(body, 'rubber', [0.061, 0.103, 0.014], [0, 0.007, 0.208], [0, 0, 0], 0.004);
  b.box(body, 'sand', [0.052, 0.026, 0.102], [0, 0.064, 0.145], [0, 0, 0], 0.008);
  b.box(body, 'rubber', [0.002, 0.026, 0.051], [0.031, 0.048, -0.058], [0, 0, 0], 0.001);
  b.box(parts.action, 'steel', [0.003, 0.021, 0.035], [0.0325, 0.048, -0.054], [0, 0, 0], 0.001);
  b.box(parts.action, 'metal', [0.049, 0.007, 0.014], [0, 0.081, 0.024]);
  b.box(parts.magazine, 'polymer', [0.043, 0.145, 0.068], [0, -0.071, -0.094], [-0.16, 0, 0], 0.006);
  b.box(parts.magazine, 'rubber', [0.049, 0.013, 0.073], [0, -0.142, -0.082], [-0.16, 0, 0], 0.003);
  for (const side of [-1, 1]) for (let n = 0; n < 7; n++) b.box(parts.magazine, 'metal', [0.002, 0.004, 0.053], [side * 0.022, -0.027 - n * 0.015, -0.099 + n * 0.0024], [-0.16, 0, 0], 0.0005);
  screws(b, body, 0.032, 0.021, [-0.149, -0.044, 0.015]);
}

function grenade(b, body, parts) {
  const profile = [[0, -0.070], [0.022, -0.068], [0.038, -0.047], [0.044, -0.013], [0.042, 0.020], [0.030, 0.047], [0.019, 0.057], [0, 0.057]];
  b.add(body, new THREE.LatheGeometry(profile.map(point => new THREE.Vector2(...point)), 28), 'olive');
  for (let band = 0; band < 4; band++) {
    const y = -0.045 + band * 0.024, radius = band === 0 || band === 3 ? 0.034 : 0.041;
    b.torus(body, 'rubber', radius, 0.0016, [0, y, 0], [Math.PI / 2, 0, 0]);
    for (let n = 0; n < 10; n++) {
      const a = n / 10 * Math.PI * 2;
      b.box(body, 'olive', [0.017, 0.018, 0.005], [Math.sin(a) * radius, y + 0.010, Math.cos(a) * radius], [0, a, 0], 0.002);
    }
  }
  b.cylinder(body, 'metal', 0.018, 0.025, [0, 0.058, 0], [0, 0, 0], 0.015);
  b.cylinder(body, 'brass', 0.019, 0.004, [0, 0.071, 0], [0, 0, 0]);
  b.box(parts.action, 'steel', [0.018, 0.007, 0.051], [0, 0.077, 0.008], [0.10, 0, 0], 0.002);
  b.box(parts.action, 'metal', [0.017, 0.087, 0.006], [0, 0.032, 0.039], [-0.16, 0, 0], 0.002);
  b.torus(parts.magazine, 'steel', 0.015, 0.0022, [0.028, 0.065, 0], [0, Math.PI / 2, 0]);
  b.cylinder(parts.magazine, 'steel', 0.0025, 0.043, [0.014, 0.063, 0], [0, 0, Math.PI / 2], 0.0025, 8);
  b.torus(body, 'brass', 0.039, 0.003, [0, -0.036, 0], [Math.PI / 2, 0, 0]);
  b.box(body, 'marking', [0.015, 0.008, 0.001], [0, -0.004, 0.045], [0, 0, 0], 0.0002);
}

function heavy(b, body, parts) {
  commonGrip(b, body, parts.magazine, true);
  b.box(body, 'metal', [0.091, 0.084, 0.240], [0, 0.048, -0.093], [0, 0, 0], 0.012);
  b.box(body, 'sand', [0.081, 0.053, 0.145], [0, 0.005, -0.062], [0, 0, 0], 0.007);
  b.cylinder(body, 'metal', 0.034, 0.300, [0, 0.069, -0.358]);
  b.cylinder(body, 'steel', 0.039, 0.053, [0, 0.069, -0.477]);
  b.cylinder(body, 'metal', 0.043, 0.015, [0, 0.069, -0.507]);
  b.cylinder(body, 'rubber', 0.030, 0.001, [0, 0.069, -0.515]);
  for (let n = 0; n < 8; n++) b.torus(body, 'metal', 0.039, 0.003, [0, 0.069, -0.260 - n * 0.021]);
  b.box(body, 'polymer', [0.068, 0.044, 0.155], [0, -0.006, -0.307], [0, 0, 0], 0.008);
  b.cylinder(body, 'polymer', 0.072, 0.104, [0, -0.012, -0.142], [0, 0, Math.PI / 2], 0.072, 24);
  for (const side of [-1, 1]) {
    b.cylinder(body, 'metal', 0.060, 0.006, [side * 0.054, -0.012, -0.142], [0, 0, Math.PI / 2], 0.060, 24);
    for (let n = 0; n < 6; n++) {
      const angle = n * Math.PI / 3;
      b.cylinder(body, 'rubber', 0.012, 0.007, [side * 0.057, -0.012 + Math.sin(angle) * 0.040, -0.142 + Math.cos(angle) * 0.040], [0, 0, Math.PI / 2], 0.012, 12);
    }
    b.box(body, 'brass', [0.003, 0.006, 0.083], [side * 0.047, 0.049, -0.052]);
  }
  rail(b, body, 0.016, 0.172, 0.096);
  optic(b, body, -0.044, true);
  b.box(parts.action, 'metal', [0.068, 0.017, 0.112], [0, 0.093, -0.103], [0, 0, 0], 0.004);
  b.box(parts.action, 'steel', [0.049, 0.004, 0.072], [0, 0.104, -0.103], [0, 0, 0], 0.001);
  b.box(parts.magazine, 'metal', [0.061, 0.104, 0.086], [0, -0.074, -0.047], [0, 0, 0], 0.007);
  b.box(parts.magazine, 'rubber', [0.070, 0.015, 0.090], [0, -0.131, -0.047], [0, 0, 0], 0.003);
  for (let n = 0; n < 3; n++) b.box(parts.magazine, 'brass', [0.003, 0.037, 0.008], [0.032, -0.075, -0.070 + n * 0.023]);
  b.box(body, 'polymer', [0.070, 0.074, 0.160], [0, 0.038, 0.112], [0, 0, 0], 0.010);
  b.box(body, 'rubber', [0.077, 0.096, 0.016], [0, 0.027, 0.196], [0, 0, 0], 0.006);
  screws(b, body, 0.047, 0.022, [-0.191, -0.019]);
}

export function createEnhancedWeapon(index = 0) {
  const selected = Number.isInteger(index) && ENHANCED_WEAPON_SPECS[index] ? index : 0, spec = ENHANCED_WEAPON_SPECS[selected];
  const group = new THREE.Group(); group.name = 'enhanced-viewmodel-weapon';
  group.userData.graphicsOwned = true; group.userData.authoredModel = spec.name;
  const body = new THREE.Group(); body.name = 'receiver'; group.add(body);
  const parts = {};
  for (const name of ['action', 'magazine']) { const part = new THREE.Group(); part.name = name; group.add(part); parts[name] = part; }
  const metal = surfaceMaps('metal'), polymer = surfaceMaps('polymer'), geometries = new Set();
  const make = (color, roughness, metalness, kind = polymer, extra = {}) => new THREE.MeshStandardMaterial({
    color, roughness, metalness, normalMap: kind.normal, roughnessMap: kind.roughness, normalScale: new THREE.Vector2(0.24, 0.24),
    transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false, ...extra,
  });
  const materials = {
    metal: make(0x46525a, 0.46, 0.85, metal), steel: make(0xa0a9ac, 0.28, 0.95, metal),
    polymer: make(0x293037, 0.82, 0.07), rubber: make(0x101417, 0.95, 0),
    sand: make(0x8a806b, 0.77, 0.09), olive: make(0x566346, 0.83, 0.12),
    brass: make(0xa79766, 0.45, 0.75, metal),
    marking: make(0xd4e0b0, 0.62, 0.05, polymer, { emissive: 0x65844b, emissiveIntensity: 0.35 }),
    glass: make(0x529da8, 0.17, 0.20, metal, { opacity: 0.13, normalMap: null, roughnessMap: null, side: THREE.DoubleSide }),
  };
  for (const material of Object.values(materials)) { material.userData.graphicsOwned = true; material.name = `enhanced-weapon:${spec.name}`; }
  const builder = new Builder(materials);
  [pistol, carbine, grenade, heavy][selected](builder, body, parts);
  builder.finish(geometries);
  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(group), muzzle = new THREE.Vector3(...spec.muzzle), support = new THREE.Vector3(...spec.support);
  const stats = { meshes: geometries.size, triangles: [...geometries].reduce((sum, geometry) => sum + geometry.attributes.position.count / 3, 0), authoredParts: builder.authoredParts, textures: 4 };
  let shotTime = Infinity, disposed = false;

  return {
    group, muzzle, support, bounds, parts, stats, name: spec.name, index: selected,
    shot() { if (!disposed) shotTime = 0; },
    update(dt, { reloading = false, reloadProgress = 0 } = {}) {
      if (disposed) return;
      shotTime += Math.max(0, Number.isFinite(dt) ? dt : 0);
      const kick = shotTime < 0.16 ? Math.sin(Math.PI * clamp(shotTime / 0.16)) * Math.exp(-shotTime * 12) : 0;
      const t = reloading ? clamp(reloadProgress) : 0;
      const drop = pulse(0.12, 0.35, 0.78, t), rack = pulse(0.79, 0.87, 0.98, t);
      parts.action.position.set(0, 0, selected === 0 ? 0.038 * kick + rack * 0.036 : selected === 1 ? 0.028 * kick + rack * 0.045 : 0);
      parts.action.rotation.set(selected === 3 ? -drop * 0.65 : selected === 2 ? -drop * 0.9 : 0, 0, 0);
      parts.magazine.position.set(selected === 2 ? drop * 0.070 : -drop * 0.025, selected === 2 ? drop * 0.014 : -drop * 0.18, selected === 2 ? 0 : drop * 0.035);
      parts.magazine.rotation.set(selected === 2 ? 0 : drop * 0.18, 0, selected === 2 ? drop * 0.45 : -drop * 0.20);
      parts.magazine.visible = selected === 2 || !(reloading && t > 0.38 && t < 0.48);
    },
    dispose() {
      if (disposed) return; disposed = true;
      group.removeFromParent();
      for (const geometry of geometries) geometry.dispose();
      for (const material of Object.values(materials)) material.dispose();
      for (const maps of [metal, polymer]) { maps.normal.dispose(); maps.roughness.dispose(); }
    },
  };
}
