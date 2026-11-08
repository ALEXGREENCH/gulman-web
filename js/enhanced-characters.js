import * as THREE from 'three';
import { mergeGeometries } from '../vendor/addons/utils/BufferGeometryUtils.js';
import { createEnhancedCharacterMaterials } from './enhanced-character-materials.js';

const prototypes = new Map(), owners = new WeakMap();
let defaultMaterials = null, defaultUsers = 0;
const UP = new THREE.Vector3(0, 1, 0), FRONT = new THREE.Vector3(0, 0, 1);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Colors and costume cues read from the seven original 3.jpg character atlases.
 * Geometry, face anatomy, embroidery and hair below are newly authored. */
export const ENHANCED_CHARACTER_STYLES = Object.freeze({
  gulman: Object.freeze({ coat: 0x542b73, trim: 0xa78a54, shirt: 0xe0dfcf, pants: 0x242331, skin: 0xb88e78, hair: 0x8c8b71, shoes: 0x171c24, eye: 0x67838e, jacket: true, gloves: true, curls: true, boots: true }),
  dama: Object.freeze({ coat: 0x8b1e29, trim: 0x32212c, shirt: 0xc2a794, pants: 0x171a22, skin: 0xd4b5a3, hair: 0x82291c, shoes: 0x15191e, eye: 0x568ba3, female: true, gloves: true, curls: true, boots: true }),
  box: Object.freeze({ coat: 0x174c43, trim: 0xb39a57, shirt: 0xd9d5bb, pants: 0x203b37, skin: 0xb1876b, hair: 0x4b3429, shoes: 0x1a211f, eye: 0x74664b, jacket: true, furHat: true, moustache: true, boots: true }),
  bugay: Object.freeze({ coat: 0x445c69, trim: 0x97a6a5, shirt: 0x51575a, pants: 0x577c92, skin: 0xb08a6b, hair: 0x5e4c38, shoes: 0x473829, eye: 0x5c685e, vest: true, tattoo: true, hat: true, denim: true, muscular: true }),
  ded: Object.freeze({ coat: 0x61562a, trim: 0xb5a266, shirt: 0x293f65, pants: 0x273a58, skin: 0xb6937c, hair: 0xc4c6b5, shoes: 0x233245, eye: 0x7a8582, jacket: true, moustache: true, longCoat: true, boots: true }),
  brucelee: Object.freeze({ coat: 0x982d38, trim: 0xc5a250, shirt: 0x22252a, pants: 0x3d5d71, skin: 0xad8062, hair: 0x1e2024, shoes: 0x593f2c, eye: 0x433e31, jacket: true, denim: true, faceInk: true }),
  boss: Object.freeze({ coat: 0x673b23, trim: 0xb49a58, shirt: 0x692a28, pants: 0x403025, skin: 0xbd9276, hair: 0xa05c29, shoes: 0x1c2023, eye: 0x6c794a, vest: true, moustache: true, boots: true, muscular: true }),
});

function basisFor(start, end) {
  const axis = end.clone().sub(start).normalize();
  const depth = FRONT.clone().addScaledVector(axis, -FRONT.dot(axis));
  if (depth.lengthSq() < 0.05) depth.copy(UP).addScaledVector(axis, -UP.dot(axis));
  depth.normalize();
  const width = new THREE.Vector3().crossVectors(axis, depth).normalize();
  return { axis, width, depth };
}

/** Continuous elliptical cross-sections, with actual taper, joint mass and
 * subtle cloth folds. The main body surfaces are not disconnected primitives. */
function loft(start, end, profile, radial = 20, folds = 0) {
  const frame = basisFor(start, end), delta = end.clone().sub(start), vertices = [], uv = [], indices = [];
  for (let ring = 0; ring < profile.length; ring++) {
    const [t, width, depth, frontOffset = 0] = profile[ring], center = start.clone().addScaledVector(delta, t).addScaledVector(frame.depth, frontOffset);
    for (let side = 0; side <= radial; side++) {
      const angle = side / radial * Math.PI * 2;
      const fold = 1 + folds * Math.sin(angle * 3 + t * 15) * Math.sin(Math.PI * clamp(t, 0, 1));
      const p = center.clone().addScaledVector(frame.width, Math.cos(angle) * width * fold).addScaledVector(frame.depth, Math.sin(angle) * depth * fold);
      vertices.push(p.x, p.y, p.z); uv.push(side / radial, clamp(t, 0, 1));
    }
  }
  const stride = radial + 1;
  for (let ring = 0; ring < profile.length - 1; ring++) for (let side = 0; side < radial; side++) {
    const a = ring * stride + side, b = a + stride;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  // Rigid source limbs can expose a sleeve end during extreme poses. Seal
  // every loft, including shoe soles and hat crowns, instead of leaving holes.
  for (const endIndex of [0, profile.length - 1]) {
    const [t, width, depth, offset = 0] = profile[endIndex];
    if (width === 0 && depth === 0) continue;
    const center = start.clone().addScaledVector(delta, t).addScaledVector(frame.depth, offset), cap = vertices.length / 3;
    vertices.push(center.x, center.y, center.z); uv.push(.5, clamp(t, 0, 1));
    for (let side = 0; side < radial; side++) {
      const a = endIndex * stride + side;
      if (endIndex === 0) indices.push(cap, a, a + 1);
      else indices.push(cap, a + 1, a);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

// A continuous skull/face surface. Cross-sections describe the jaw, cheekbone,
// temple and cranial vault; small anatomical displacements form eye sockets and
// the bridge of the nose before the separately modelled lids and lips are added.
function sculptedHead(center, height, halfWidth, depth, scale, female) {
  const sections = [[0, .25, .42], [.06, .53, .63], [.15, .76, .75], [.25, .86, .81], [.39, 1, .91], [.50, 1, .98], [.62, .96, 1], [.75, .94, .96], [.88, .80, .82], [.96, .51, .56], [1, 0, 0]];
  const radial = 48, rings = 36, vertices = [], uv = [], tones = [], indices = [];
  const gaussian = (x, y, cx, cy, wx, wy) => Math.exp(-(((x - cx) / wx) ** 2 + ((y - cy) / wy) ** 2));
  for (let ring = 0; ring <= rings; ring++) {
    const t = ring / rings; let index = 0;
    while (index < sections.length - 2 && sections[index + 1][0] < t) index++;
    const a = sections[index], b = sections[index + 1], blend = (t - a[0]) / (b[0] - a[0]);
    const width = THREE.MathUtils.lerp(a[1], b[1], blend) * halfWidth, radius = THREE.MathUtils.lerp(a[2], b[2], blend) * depth;
    for (let side = 0; side <= radial; side++) {
      const angle = side / radial * Math.PI * 2, front = Math.max(0, Math.sin(angle)), x = Math.cos(angle) * width;
      const y = (t - .5) * height, nx = x / scale, ny = y / scale;
      let z = Math.sin(angle) * radius;
      // Flatter facial planes than an ellipsoid, with actual recessed orbits.
      if (front > 0) {
        z = radius * (0.57 * Math.sqrt(front) + 0.43 * front);
        z += scale * front ** 4 * (
          .006 * gaussian(nx, ny, -.054, -.005, .022, .026) + .006 * gaussian(nx, ny, .054, -.005, .022, .026)
          - .010 * gaussian(nx, ny, -.034, .026, .022, .013) - .010 * gaussian(nx, ny, .034, .026, .022, .013)
          + .008 * gaussian(nx, ny, -.033, .046, .025, .010) + .008 * gaussian(nx, ny, .033, .046, .025, .010)
          + .019 * gaussian(nx, ny, 0, .009, .011, .035) + .029 * gaussian(nx, ny, 0, -.018, .012, .011)
          + .007 * gaussian(Math.abs(nx), ny, .013, -.023, .007, .006)
          + .004 * gaussian(nx, ny, 0, -.055, .025, .004) + .005 * gaussian(nx, ny, 0, -.064, .025, .005)
          - .003 * gaussian(nx, ny, 0, -.059, .027, .002) + .009 * gaussian(nx, ny, 0, -.083, .026, .015));
      }
      vertices.push(center.x + x, center.y + y, center.z + z);
      uv.push(side / radial, t);
      const cheek = front * gaussian(Math.abs(nx), ny, .052, -.014, .028, .027), shadow = front * gaussian(Math.abs(nx), ny, .034, .025, .026, .019);
      const beard = female ? 0 : front * gaussian(nx, ny, 0, -.071, .073, .040) * .06;
      tones.push(1 - shadow * .10 - beard, 1 - cheek * .065 - shadow * .14 - beard, 1 - cheek * .055 - shadow * .13 - beard);
    }
  }
  for (let ring = 0; ring < rings; ring++) for (let side = 0; side < radial; side++) {
    const a = ring * (radial + 1) + side, b = a + radial + 1;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute('tone', new THREE.Float32BufferAttribute(tones, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals(); return geometry;
}

function sculptedHair(center, width, height, depth, scale, curls, female) {
  const segments = 56, rings = 20, vertices = [], uv = [], indices = [];
  for (let ring = 0; ring <= rings; ring++) for (let side = 0; side <= segments; side++) {
    const angle = side / segments * Math.PI * 2, front = Math.max(0, Math.sin(angle));
    const boundary = 2.25 - front * .99 + .05 * Math.sin(angle * 4);
    const theta = ring / rings * boundary, wave = Math.sin(angle * (curls ? 11 : 11) + theta * (curls ? 13 : 4));
    const ridges = 1 + (curls ? .095 : .018) * wave * Math.sin(theta) + (curls ? .045 : 0) * Math.cos(angle * 7 - theta * 10) * Math.sin(theta);
    const x = Math.cos(angle) * Math.sin(theta) * width * ridges;
    let y = Math.cos(theta) * height, z = Math.sin(angle) * Math.sin(theta) * depth * ridges;
    if (female && front < .3) y -= .12 * scale * (ring / rings) ** 3;
    vertices.push(center.x + x, center.y + y, center.z + z); uv.push(side / segments, ring / rings);
  }
  for (let ring = 0; ring < rings; ring++) for (let side = 0; side < segments; side++) {
    const a = ring * (segments + 1) + side, b = a + segments + 1;
    // Latitude runs downwards, so the winding is opposite the body loft.
    indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals(); return geometry;
}

// A compact set of real surface support points gives much tighter animated
// ground contact than rotating a bone-local AABB (which invents empty corners).
function cacheGroundSupport(geometry) {
  const position = geometry.attributes.position, selected = new Set();
  const directions = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let i = 0; i < 96; i++) {
    const y = 1 - (i + .5) * 2 / 96, radius = Math.sqrt(1 - y * y), angle = i * 2.399963;
    directions.push([Math.cos(angle) * radius, y, Math.sin(angle) * radius]);
  }
  for (const [x, y, z] of directions) {
    let best = -Infinity, index = 0;
    for (let i = 0; i < position.count; i++) {
      const dot = position.getX(i) * x + position.getY(i) * y + position.getZ(i) * z;
      if (dot > best) { best = dot; index = i; }
    }
    selected.add(index);
  }
  geometry.userData.enhancedBoundsPoints = new Float32Array([...selected].flatMap(i => [position.getX(i), position.getY(i), position.getZ(i)]));
}

class SkinBuilder {
  constructor(skinBasis, materials) { this.basis = skinBasis; this.materials = materials; this.parts = new Map(); this.faces = []; this.authoredDetails = 0; }
  face(id, input, name, center, scale) {
    const geometry = input.index ? input.toNonIndexed() : input;
    if (geometry !== input) input.dispose();
    geometry.deleteAttribute('tone');
    const position = geometry.attributes.position, uv = geometry.attributes.uv, rect = this.materials.faceRect(name);
    for (let triangle = 0; triangle < position.count; triangle += 3) {
      const front = (position.getZ(triangle) + position.getZ(triangle + 1) + position.getZ(triangle + 2)) / 3 > center.z;
      for (let corner = 0; corner < 3; corner++) {
        const index = triangle + corner;
        if (front) {
          const u = clamp(.5 + (position.getX(index) - center.x) / (.210 * scale), 0, 1);
          const v = clamp((position.getY(index) - center.y + .112 * scale) / (.195 * scale), 0, 1);
          uv.setXY(index, rect.x + rect.width * u, rect.y + rect.height * v);
        } else {
          // Eighth atlas tile is unmarked skin, so the back of the skull never
          // repeats a face. Each triangle owns its UVs at the temple seam.
          uv.setXY(index, .76 + .23 * clamp(.5 + (position.getX(index) - center.x) / (.22 * scale), 0, 1), .01 + .48 * clamp((position.getY(index) - center.y) / (.30 * scale) + .5, 0, 1));
        }
      }
    }
    this.faces.push({ boneId: id, geometry, material: this.materials.faceMaterial }); this.authoredDetails++;
  }
  add(id, geometry, color, kind = 'cloth', position, scale, angles) {
    if (scale) geometry.scale(...scale);
    if (angles) { geometry.rotateX(angles[0]); geometry.rotateY(angles[1]); geometry.rotateZ(angles[2]); }
    if (position) geometry.translate(...position);
    const uv = geometry.attributes.uv, rect = this.materials.uvRect(kind), rgb = new THREE.Color(color), colors = new Float32Array(geometry.attributes.position.count * 3);
    const tone = geometry.attributes.tone;
    for (let i = 0; i < colors.length; i += 3) { colors[i] = rgb.r * (tone?.array[i] ?? 1); colors[i + 1] = rgb.g * (tone?.array[i + 1] ?? 1); colors[i + 2] = rgb.b * (tone?.array[i + 2] ?? 1); }
    if (tone) geometry.deleteAttribute('tone');
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    for (let i = 0; i < uv.count; i++) uv.setXY(i, rect.x + clamp(uv.getX(i), 0, 1) * rect.width, rect.y + clamp(uv.getY(i), 0, 1) * rect.height);
    const source = geometry.index ? geometry.toNonIndexed() : geometry;
    if (source !== geometry) geometry.dispose();
    const list = this.parts.get(id) ?? []; list.push(source); this.parts.set(id, list); this.authoredDetails++;
  }
  oval(id, position, size, color, kind = 'skin', detail = 12, angles) {
    this.add(id, new THREE.SphereGeometry(1, detail, Math.max(6, Math.round(detail * 0.65))), color, kind, position, size, angles);
  }
  box(id, position, size, color, kind = 'cloth', angles) { this.add(id, new THREE.BoxGeometry(...size), color, kind, position, null, angles); }
  line(id, points, radius, color, kind = 'cloth', segments = 12) {
    const curve = new THREE.CatmullRomCurve3(points.map(point => point.isVector3 ? point : new THREE.Vector3(...point)));
    this.add(id, new THREE.TubeGeometry(curve, segments, radius, 5, false), color, kind);
  }
  panel(id, points, color, kind = 'suit') {
    let values = points.map(point => point.isVector3 ? point : new THREE.Vector3(...point));
    let area = 0; for (let i = 0; i < values.length; i++) { const a = values[i], b = values[(i + 1) % values.length]; area += a.x * b.y - b.x * a.y; }
    if (area < 0) values = values.reverse();
    const bounds = new THREE.Box3().setFromPoints(values), size = bounds.getSize(new THREE.Vector3()), uv = [];
    for (const point of values) uv.push((point.x - bounds.min.x) / Math.max(size.x, 0.001), (point.y - bounds.min.y) / Math.max(size.y, 0.001));
    const geometry = new THREE.BufferGeometry(), indices = [];
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(values.flatMap(point => point.toArray()), 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    for (let i = 1; i < values.length - 1; i++) indices.push(0, i, i + 1);
    geometry.setIndex(indices); geometry.computeVertexNormals(); this.add(id, geometry, color, kind);
  }
  finish() {
    const definitions = [];
    for (const [boneId, source] of this.parts) {
      const geometry = mergeGeometries(source);
      for (const item of source) item.dispose();
      geometry.applyMatrix4(this.basis.boneMatrices.get(boneId).clone().invert());
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      cacheGroundSupport(geometry);
      definitions.push({ boneId, geometry, material: this.materials.material });
    }
    for (const definition of this.faces) {
      definition.geometry.applyMatrix4(this.basis.boneMatrices.get(definition.boneId).clone().invert());
      definition.geometry.computeBoundingBox(); definition.geometry.computeBoundingSphere(); definitions.push(definition);
      cacheGroundSupport(definition.geometry);
    }
    this.faces.length = 0;
    this.parts.clear();
    return definitions;
  }
}

function head(b, context) {
  const { style: s, key, scale, point, bounds } = context;
  const original = bounds(2), h = clamp(original.getSize(new THREE.Vector3()).y * 0.80, 0.22 * scale, 0.26 * scale);
  const center = original.getCenter(new THREE.Vector3()); center.y = original.min.y + h * 0.5;
  const halfWidth = (s.female ? 0.087 : s.muscular ? 0.104 : 0.095) * scale, depth = (s.female ? 0.074 : 0.083) * scale;
  const p = (x, y, z) => new THREE.Vector3(center.x + x * scale, center.y + y * scale, center.z + z * scale);
  const hasFace = Boolean(b.materials.faceMaterial && b.materials.faceRect);
  const skull = sculptedHead(center, h, halfWidth, depth, scale, s.female);
  if (hasFace) b.face(2, skull, key, center, scale);
  else b.add(2, skull, s.skin, 'skin');
  // Neck shares the head bone, so turning the head does not leave a visible gap.
  const neckBase = point(2).clone(); neckBase.y = Math.min(neckBase.y - .040 * scale, original.min.y - 0.050 * scale); neckBase.z = center.z - 0.030 * scale;
  b.add(2, loft(neckBase, p(0, -h / scale * 0.28, -0.012), [[0, 0.049 * scale, 0.043 * scale], [0.4, 0.042 * scale, 0.040 * scale], [1, 0.048 * scale, 0.047 * scale]], 20), s.skin, 'skin');
  const nose = s.female ? 0.87 : 1, facialFront = depth / scale;
  for (const side of [-1, 1]) {
    b.oval(2, p(side * (halfWidth / scale + 0.005), -0.001, -0.014).toArray(), [0.015 * scale, 0.026 * scale, 0.013 * scale], s.skin, 'skin');
    b.oval(2, p(side * (halfWidth / scale + 0.012), -0.002, -0.006).toArray(), [0.004 * scale, 0.014 * scale, 0.006 * scale], 0x996e60, 'skin', 8);
    if (hasFace) continue;
    const eyeX = side * 0.035, eyeY = 0.025, eyeZ = facialFront - 0.014;
    b.oval(2, p(eyeX, eyeY, eyeZ).toArray(), [0.018 * scale, 0.010 * scale, 0.010 * scale], 0xc4c4b8, 'eye', 16);
    b.oval(2, p(eyeX, eyeY, eyeZ + 0.009).toArray(), [0.0062 * scale, 0.0062 * scale, 0.002 * scale], s.eye, 'eye', 12);
    b.oval(2, p(eyeX, eyeY, eyeZ + 0.0108).toArray(), [0.0027 * scale, 0.0037 * scale, 0.001 * scale], 0x11171b, 'eye', 10);
    for (const upper of [false, true]) b.line(2, [p(eyeX - 0.017, eyeY, eyeZ + 0.002), p(eyeX, eyeY + (upper ? 0.007 : -0.006), eyeZ + 0.009), p(eyeX + 0.017, eyeY, eyeZ + 0.002)], 0.0025 * scale, upper && s.female ? 0x3b2929 : s.skin, 'skin', 12);
    b.line(2, [p(eyeX - 0.020, 0.043, facialFront - 0.004), p(eyeX, 0.047, facialFront + 0.003), p(eyeX + 0.020, 0.040, facialFront - 0.005)], 0.0036 * scale, s.hair, 'hair', 12);
  }
  if (!hasFace) {
  b.oval(2, p(0, 0.003, facialFront + 0.003).toArray(), [0.010 * scale * nose, 0.027 * scale, 0.016 * scale], s.skin, 'skin');
  b.oval(2, p(0, -0.018, facialFront + 0.017).toArray(), [0.015 * scale * nose, 0.010 * scale, 0.017 * scale], s.skin, 'skin');
  for (const side of [-1, 1]) b.oval(2, p(side * 0.010, -0.022, facialFront + 0.015).toArray(), [0.006 * scale, 0.005 * scale, 0.008 * scale], s.skin, 'skin', 10);
  const lips = s.female ? 0x873d43 : 0x925d50;
  b.line(2, [p(-0.024, -0.049, facialFront - 0.004), p(-0.009, -0.045, facialFront + 0.003), p(0, -0.048, facialFront + 0.005), p(0.009, -0.045, facialFront + 0.003), p(0.024, -0.049, facialFront - 0.004)], 0.0026 * scale, lips, 'skin', 16);
  b.line(2, [p(-0.023, -0.050, facialFront - 0.004), p(0, -0.056, facialFront + 0.003), p(0.023, -0.050, facialFront - 0.004)], 0.003 * scale, lips, 'skin', 12);
  }
  // Sculpted cap and locks: each type has its own hair/hat silhouette.
  if (s.furHat || s.hat) {
    const hatColor = s.furHat ? 0xcdccbb : 0xb7b19b;
    b.add(2, loft(p(0, 0.106, -0.012), p(0, 0.190, -0.012), [[0, 0.117 * scale, 0.102 * scale], [0.12, 0.117 * scale, 0.102 * scale], [0.75, 0.103 * scale, 0.091 * scale], [1, 0.077 * scale, 0.067 * scale]], 24), hatColor, 'cloth');
    if (s.hat) b.add(2, loft(p(0, 0.105, -0.012), p(0, 0.117, -0.012), [[0, 0.182 * scale, 0.155 * scale], [0.45, 0.190 * scale, 0.160 * scale], [1, 0.178 * scale, 0.150 * scale]], 28), hatColor, 'cloth');
    else for (let i = 0; i < 18; i++) { const a = i / 18 * Math.PI * 2; b.oval(2, p(Math.cos(a) * 0.109, 0.118, Math.sin(a) * 0.090 - 0.012).toArray(), [0.023 * scale, 0.027 * scale, 0.023 * scale], hatColor, 'hair', 8); }
    b.line(2, Array.from({ length: 25 }, (_, i) => p(Math.cos(i / 24 * Math.PI * 2) * 0.115, 0.126, Math.sin(i / 24 * Math.PI * 2) * 0.101 - 0.012)), 0.008 * scale, s.furHat ? s.coat : 0x4d4435, 'cloth', 36);
  } else {
    const hairCenter = p(0, s.curls ? .057 : .055, -.016), hw = halfWidth * (s.curls ? 1.29 : 1.08), hh = h * (s.curls ? .50 : .43), hd = depth * (s.curls ? 1.35 : 1.13);
    b.add(2, sculptedHair(hairCenter, hw, hh, hd, scale, s.curls, s.female), s.hair, 'hair');
    // Thin swept ridges follow the continuous hair mass. This preserves curls
    // and directional highlights without disconnected bead-shaped locks.
    for (let strand = 0; strand < (s.curls ? 30 : 22); strand++) {
      const angle = strand / (s.curls ? 30 : 22) * Math.PI * 2;
      const boundary = 2.25 - Math.max(0, Math.sin(angle)) * .99 + .05 * Math.sin(angle * 4);
      const points = [];
      for (let step = 0; step < 10; step++) {
        const t = .18 + step / 9 * .82, theta = t * boundary, a = angle + Math.sin(theta * (s.curls ? 5.5 : 1.1)) * (s.curls ? .14 : .15);
        let y = Math.cos(theta) * hh;
        if (s.female && Math.sin(a) < .3) y -= .12 * scale * t ** 3;
        const ridges = 1 + (s.curls ? .095 : .018) * Math.sin(a * 11 + theta * (s.curls ? 13 : 4)) * Math.sin(theta) + (s.curls ? .045 : 0) * Math.cos(a * 7 - theta * 10) * Math.sin(theta);
        points.push(new THREE.Vector3(hairCenter.x + Math.cos(a) * Math.sin(theta) * hw * ridges * 1.012, hairCenter.y + y, hairCenter.z + Math.sin(a) * Math.sin(theta) * hd * ridges * 1.012));
      }
      b.line(2, points, (s.curls ? .0025 : .0018) * scale, new THREE.Color(s.hair).multiplyScalar(strand % 3 === 0 ? 1.10 : .83), 'hair', 14);
    }
  }
  if (s.moustache && !hasFace) {
    for (const side of [-1, 1]) b.line(2, [p(side * 0.003, -0.036, facialFront + 0.011), p(side * 0.022, -0.039, facialFront + 0.014), p(side * 0.036, -0.048, facialFront)], 0.008 * scale, s.hair, 'hair', 12);
    if (key !== 'ded') b.oval(2, p(0, -0.083, facialFront - 0.011).toArray(), [0.026 * scale, 0.022 * scale, 0.012 * scale], s.hair, 'hair');
  }
  if (s.faceInk && !hasFace) for (let i = 0; i < 5; i++) b.line(2, [p(-0.071 + i * 0.008, 0.048 - i * 0.015, facialFront - 0.022), p(-0.055 + i * 0.006, 0.032 - i * 0.015, facialFront - 0.010), p(-0.069 + i * 0.007, 0.009 - i * 0.015, facialFront - 0.017)], 0.0019 * scale, 0x384b5b, 'skin', 8);
}

function torso(b, c) {
  const { style: s, point, scale, key, bounds } = c;
  const hips = point(4).add(point(5)).multiplyScalar(0.5), shoulder = point(10).add(point(11)).multiplyScalar(0.5);
  const center = bounds(18).getCenter(new THREE.Vector3());
  const waistY = clamp(Math.max(hips.y + 0.12 * scale, point(18).y), hips.y + 0.10 * scale, shoulder.y - 0.17 * scale);
  const bottom = new THREE.Vector3(center.x, waistY - 0.04 * scale, center.z + 0.018 * scale), top = new THREE.Vector3(center.x, shoulder.y + 0.055 * scale, center.z - 0.010 * scale);
  const shoulderWidth = point(10).distanceTo(point(11)), rx = shoulderWidth * (s.female ? 0.57 : 0.59), rz = clamp(bounds(18).getSize(new THREE.Vector3()).z * 0.33, 0.09 * scale, 0.16 * scale);
  const bodyColor = s.vest ? s.skin : s.coat, kind = s.vest ? 'skin' : 'suit';
  b.add(18, loft(bottom, top, [[0, rx * 0.74, rz * 0.79], [0.15, rx * (s.female ? 0.65 : 0.78), rz * 0.78], [0.38, rx * 0.81, rz * 0.90], [0.65, rx * .98, rz * 1.04], [0.84, rx * 1.07, rz * 1.04], [0.93, rx * 1.01, rz * .95], [1, rx * 0.36, rz * 0.52]], 32, s.vest ? 0 : 0.013), bodyColor, kind);
  const front = (x, y, offset = 0.004 * scale) => new THREE.Vector3(center.x + x, y, center.z + rz * Math.sqrt(Math.max(0.1, 1 - (x / (rx * 1.07)) ** 2)) + offset);
  const high = shoulder.y + 0.018 * scale, low = bottom.y + 0.035 * scale;
  if (s.jacket || s.vest) {
    if (s.jacket) b.panel(18, [front(-rx * 0.35, high), front(rx * 0.35, high), front(0, low + (high - low) * 0.38)], s.shirt, 'cloth');
    for (const side of [-1, 1]) {
      b.panel(18, [front(side * rx * 0.12, low), front(side * rx * 0.78, low + 0.02 * scale), front(side * rx * 0.94, high - 0.045 * scale), front(side * rx * 0.42, high + 0.018 * scale), front(side * rx * 0.20, high - 0.12 * scale)], s.coat, 'suit');
      b.panel(18, [front(side * rx * 0.42, high, 0.010 * scale), front(side * rx * 0.76, high - 0.065 * scale, 0.012 * scale), front(side * rx * 0.12, high - 0.235 * scale, 0.012 * scale), front(side * rx * 0.24, high - 0.10 * scale, 0.014 * scale)], new THREE.Color(s.coat).multiplyScalar(0.77), 'suit');
      b.line(18, [front(side * rx * 0.42, high, 0.015 * scale), front(side * rx * 0.76, high - 0.065 * scale, 0.017 * scale), front(side * rx * 0.12, high - 0.235 * scale, 0.017 * scale)], 0.0018 * scale, s.trim, 'cloth', 12);
      b.line(18, [front(side * rx * 0.34, low + 0.06 * scale), front(side * rx * 0.72, low + 0.075 * scale)], 0.003 * scale, new THREE.Color(s.coat).multiplyScalar(0.60), 'suit', 2);
    }
  }
  if (s.female) {
    b.panel(18, [front(-rx * 0.43, high + 0.010 * scale), front(rx * 0.43, high + 0.010 * scale), front(0, high - 0.10 * scale)], s.skin, 'skin');
    for (const side of [-1, 1]) b.line(18, [front(side * rx * 0.17, low), front(side * rx * 0.25, (low + high) / 2), front(side * rx * 0.31, high - 0.08 * scale)], 0.004 * scale, 0x191a22, 'leather', 12);
    for (let i = 0; i < 6; i++) {
      const y = low + 0.025 * scale + i * 0.027 * scale;
      b.line(18, [front(-0.025 * scale, y), front(0.025 * scale, y + 0.023 * scale)], 0.0018 * scale, 0xd2b29a, 'cloth', 2);
      b.line(18, [front(0.025 * scale, y), front(-0.025 * scale, y + 0.023 * scale)], 0.0018 * scale, 0xd2b29a, 'cloth', 2);
    }
    const brooch = front(0, high - 0.105 * scale, 0.012 * scale);
    b.oval(18, brooch.toArray(), [0.009 * scale, 0.014 * scale, 0.005 * scale], 0x1a2028, 'metal', 10);
    for (const side of [-1, 1]) for (let i = 0; i < 4; i++) b.line(18, [brooch, brooch.clone().add(new THREE.Vector3(side * 0.019 * scale, (i - 1.5) * 0.008 * scale, 0)), brooch.clone().add(new THREE.Vector3(side * 0.028 * scale, (i - 1.5) * 0.014 * scale, -0.002 * scale))], 0.0012 * scale, 0x1a2028, 'metal', 5);
  } else {
    for (let i = 0; i < 5; i++) {
      const button = front(rx * 0.10, low + 0.040 * scale + i * (high - low) * 0.12, 0.012 * scale);
      b.oval(18, button.toArray(), [0.005 * scale, 0.005 * scale, 0.003 * scale], s.trim, 'metal', 8);
    }
    if (key === 'gulman') {
      b.oval(18, front(0, high - 0.045 * scale, 0.020 * scale).toArray(), [0.020 * scale, 0.025 * scale, 0.014 * scale], s.shirt, 'cloth');
      b.panel(18, [front(-0.021 * scale, high - 0.055 * scale, 0.025 * scale), front(0.020 * scale, high - 0.055 * scale, 0.025 * scale), front(0.012 * scale, high - 0.150 * scale, 0.025 * scale), front(-0.012 * scale, high - 0.145 * scale, 0.025 * scale)], 0x787b93, 'suit');
    }
  }
  // Raised embroidery catches light without painting an old low-res atlas on a box.
  if (key !== 'bugay' && key !== 'brucelee') for (const side of [-1, 1]) for (let curl = 0; curl < 3; curl++) {
    const y = low + 0.08 * scale + curl * 0.070 * scale, x = side * rx * 0.58;
    b.line(18, Array.from({ length: 9 }, (_, i) => { const a = i / 8 * Math.PI * 1.7; return front(x + Math.cos(a) * 0.012 * scale, y + Math.sin(a) * 0.021 * scale, 0.011 * scale); }), 0.0014 * scale, s.trim, 'cloth', 12);
  }
  if (s.tattoo) for (let i = 0; i < 7; i++) {
    const y = high - 0.050 * scale - i * 0.027 * scale;
    b.line(18, [front(-0.045 * scale, y), front(0.015 * scale, y - 0.018 * scale), front(0.048 * scale, y + 0.007 * scale)], 0.0020 * scale, 0x3f5365, 'skin', 10);
  }
  if (key === 'box' || key === 'ded' || key === 'boss') {
    const p = front(0, high - 0.155 * scale, 0.023 * scale);
    b.box(18, p.toArray(), [0.014 * scale, 0.065 * scale, 0.006 * scale], key === 'box' ? 0x813738 : s.trim, 'metal');
    b.box(18, p.clone().add(new THREE.Vector3(0, 0.010 * scale, 0)).toArray(), [0.042 * scale, 0.012 * scale, 0.008 * scale], s.trim, 'metal');
  }
  if (key === 'brucelee') {
    const backZ = center.z - rz - 0.005 * scale;
    for (const side of [-1, 1]) b.line(18, [[center.x, high - 0.10 * scale, backZ], [center.x + side * 0.075 * scale, high - 0.18 * scale, backZ], [center.x + side * 0.035 * scale, high - 0.26 * scale, backZ]], 0.006 * scale, s.trim, 'cloth', 10);
  }
  const pelvisTop = new THREE.Vector3(hips.x, waistY + 0.02 * scale, hips.z - 0.015 * scale), pelvisBottom = new THREE.Vector3(hips.x, hips.y - 0.065 * scale, hips.z);
  const hipWidth = Math.max(point(4).distanceTo(point(5)) * 0.68, rx * 0.80);
  b.add(3, loft(pelvisBottom, pelvisTop, [[0, hipWidth * 0.73, rz * 0.60], [0.20, hipWidth, rz * 0.85], [0.60, hipWidth * 1.05, rz * 0.90], [1, hipWidth * 0.90, rz * 0.78]], 22, 0.016), s.pants, s.denim ? 'denim' : 'cloth');
  const beltY = waistY - 0.006 * scale;
  b.add(3, loft(new THREE.Vector3(hips.x, beltY - 0.018 * scale, pelvisTop.z), new THREE.Vector3(hips.x, beltY + 0.018 * scale, pelvisTop.z), [[0, hipWidth * 0.94, rz * 0.84], [1, hipWidth * 0.94, rz * 0.84]], 24), 0x242327, 'leather');
  b.box(3, [hips.x, beltY, pelvisTop.z + rz * 0.87], [0.037 * scale, 0.029 * scale, 0.008 * scale], s.trim, 'metal');
  if (s.longCoat) for (const side of [-1, 1]) b.panel(3, [[hips.x + side * 0.02 * scale, beltY, hips.z + rz], [hips.x + side * hipWidth, beltY, hips.z + rz * 0.6], [hips.x + side * hipWidth * 0.95, hips.y - 0.14 * scale, hips.z + rz * 0.8], [hips.x + side * 0.035 * scale, hips.y - 0.12 * scale, hips.z + rz]], s.coat, 'suit');
  c.torso = { waistY, shoulderY: shoulder.y, rx, rz };
}

function limbs(b, c) {
  const { style: s, point, scale, key } = c;
  const legPairs = [[4, 7], [5, 6], [6, 8], [7, 9]], armPairs = [[10, 12], [11, 13], [12, 14], [13, 15]];
  for (const [id, child] of [...legPairs, ...armPairs]) {
    const leg = id < 10, upper = [4, 5, 10, 11].includes(id), start = point(id), end = point(child), frame = basisFor(start, end), length = start.distanceTo(end);
    let radius = (leg ? upper ? 0.087 : 0.060 : upper ? 0.062 : 0.044) * scale;
    if (s.muscular) radius *= leg ? 1.18 : 1.32;
    if (s.female) radius *= leg ? 0.88 : 0.80;
    const bare = !leg && (s.vest || key === 'bugay');
    const leather = leg && !upper && s.boots || !leg && !upper && s.female;
    const color = leg ? leather ? s.shoes : s.pants : bare ? s.skin : leather ? s.shoes : s.coat;
    const kind = bare ? 'skin' : leather ? 'leather' : leg ? s.denim ? 'denim' : 'cloth' : 'suit';
    // Joint cuffs extend into the neighbouring segment. The former pointed
    // ends left a puppet-like gap whenever the original animation bent a knee.
    const joint = leg ? .88 : .82;
    b.add(id, loft(start, end, [[-.20, radius * .58, radius * .55], [-.11, radius * .88, radius * .83], [.08, radius * 1.04, radius * .96], [.28, radius * (upper ? 1.10 : 1.09), radius * .99], [.58, radius * .99, radius * .91], [.82, radius * .89, radius * .83], [1.06, radius * joint, radius * (joint - .04)], [1.16, radius * .55, radius * .51]], 24, bare ? 0 : .018), color, kind);
    if (!bare) {
      const seam = [0.10, 0.35, 0.60, 0.90].map(t => start.clone().lerp(end, t).addScaledVector(frame.width, radius * (1.04 - t * 0.32)));
      b.line(id, seam, 0.0015 * scale, new THREE.Color(color).multiplyScalar(s.denim ? 1.45 : 0.68), kind, 12);
    }
    if (!leg && !upper) {
      const cuffStart = start.clone().lerp(end, 0.86), cuffEnd = start.clone().lerp(end, 1.01);
      b.add(id, loft(cuffStart, cuffEnd, [[0, radius * 0.78, radius * 0.77], [0.2, radius * 0.79, radius * 0.78], [1, radius * 0.75, radius * 0.74]], 18), bare ? 0x252b31 : key === 'gulman' ? s.shirt : s.trim, bare ? 'leather' : 'cloth');
      if (bare) for (let i = 0; i < 5; i++) {
        const angle = i / 5 * Math.PI * 2, p = cuffStart.clone().lerp(cuffEnd, 0.5).addScaledVector(frame.width, Math.cos(angle) * radius * 0.8).addScaledVector(frame.depth, Math.sin(angle) * radius * 0.8);
        b.oval(id, p.toArray(), [0.0035 * scale, 0.0035 * scale, 0.0035 * scale], 0x8f9a9d, 'metal', 6);
      }
    }
    if (s.tattoo && !leg) for (let i = 0; i < 3; i++) {
      const points = [];
      for (let j = 0; j < 11; j++) {
        const t = 0.16 + i * 0.19 + j * 0.014, angle = j / 10 * Math.PI * 1.7;
        points.push(start.clone().lerp(end, t).addScaledVector(frame.width, Math.cos(angle) * radius * 0.99).addScaledVector(frame.depth, Math.sin(angle) * radius * 0.92));
      }
      b.line(id, points, 0.0018 * scale, 0x3a5163, 'skin', 12);
    }
    if (!leg && upper && (key === 'box' || key === 'ded')) {
      const p = start.clone().addScaledVector(frame.axis, length * 0.12).addScaledVector(frame.depth, radius * 0.96);
      b.box(id, p.toArray(), [0.065 * scale, 0.018 * scale, 0.008 * scale], key === 'box' ? 0x772b32 : s.trim, 'suit');
    }
  }
}

function handsAndFeet(b, c) {
  const { style: s, point, scale, bounds } = c;
  for (const id of [14, 15]) {
    const wrist = point(id), originalCenter = bounds(id).getCenter(new THREE.Vector3());
    const direction = originalCenter.sub(wrist).normalize(), end = wrist.clone().addScaledVector(direction, 0.082 * scale), frame = basisFor(wrist, end);
    const color = s.gloves ? 0x23252b : s.skin, kind = s.gloves ? 'leather' : 'skin';
    b.add(id, loft(wrist, end, [[-.24, .023 * scale, .019 * scale], [.15, .029 * scale, .019 * scale], [.62, .034 * scale, .019 * scale], [1, .031 * scale, .016 * scale]], 18), color, kind);
    for (let finger = 0; finger < 4; finger++) {
      const x = (finger - 1.5) * 0.016 * scale, length = [0.060, 0.068, 0.064, 0.050][finger] * scale;
      const base = end.clone().addScaledVector(frame.width, x), middle = base.clone().addScaledVector(direction, length * 0.56).addScaledVector(frame.depth, -0.009 * scale), tip = base.clone().addScaledVector(direction, length * (id === 14 ? 0.72 : 0.96)).addScaledVector(frame.depth, -(id === 14 ? 0.029 : 0.016) * scale);
      b.line(id, [base, middle, tip], (finger === 3 ? 0.006 : 0.007) * scale, color, kind, 10);
      b.oval(id, tip.toArray(), [0.0065 * scale, 0.0065 * scale, 0.0065 * scale], color, kind, 8);
    }
    const thumb = wrist.clone().lerp(end, 0.40).addScaledVector(frame.width, 0.027 * scale);
    b.line(id, [thumb, thumb.clone().addScaledVector(frame.width, 0.024 * scale).addScaledVector(direction, 0.020 * scale), thumb.clone().addScaledVector(direction, 0.052 * scale).addScaledVector(frame.depth, -0.018 * scale)], 0.0085 * scale, color, kind, 12);
    if (s.gloves) b.oval(id, wrist.clone().lerp(end, 0.55).addScaledVector(frame.depth, 0.017 * scale).toArray(), [0.025 * scale, 0.012 * scale, 0.022 * scale], 0x2e323a, 'leather', 10);
  }
  for (const id of [8, 9]) {
    const original = bounds(id), center = original.getCenter(new THREE.Vector3()), ankle = point(id);
    const base = new THREE.Vector3(center.x, original.min.y, center.z + 0.026 * scale);
    const top = base.clone(); top.y += 0.14 * scale;
    b.add(id, loft(base, top, [[0, 0.066 * scale, 0.139 * scale], [0.12, 0.080 * scale, 0.149 * scale], [0.35, 0.081 * scale, 0.146 * scale, -.008 * scale], [0.63, 0.070 * scale, 0.118 * scale, -.016 * scale], [0.85, 0.055 * scale, 0.077 * scale, -.024 * scale], [1, 0.042 * scale, 0.057 * scale, -.028 * scale]], 24), s.shoes, 'leather');
    b.add(id, loft(base.clone().add(new THREE.Vector3(0, 0.002 * scale, 0)), base.clone().add(new THREE.Vector3(0, 0.022 * scale, 0)), [[0, 0.079 * scale, 0.148 * scale], [0.3, 0.083 * scale, 0.153 * scale], [1, 0.081 * scale, 0.150 * scale]], 24), 0x12191d, 'leather');
    if (s.boots) b.add(id, loft(new THREE.Vector3(ankle.x, base.y + .080 * scale, ankle.z), new THREE.Vector3(ankle.x, ankle.y + .090 * scale, ankle.z), [[0, .061 * scale, .070 * scale], [.5, .060 * scale, .064 * scale], [1, .065 * scale, .061 * scale]], 20), s.shoes, 'leather');
    for (let i = 0; i < 4; i++) {
      const y = base.y + 0.106 * scale - i * 0.005 * scale, z = base.z + 0.015 * scale + i * 0.017 * scale;
      b.line(id, [[base.x - 0.031 * scale, y, z], [base.x, y + 0.003 * scale, z + 0.010 * scale], [base.x + 0.031 * scale, y, z]], 0.0018 * scale, s.denim ? 0x91806a : 0x44454a, 'cloth', 5);
    }
  }
}

function buildPrototype(character, key, materials) {
  const basis = character.skinBasis, scale = basis.height / 1.8;
  const point = id => new THREE.Vector3().setFromMatrixPosition(basis.boneMatrices.get(id));
  const bounds = id => basis.partBounds.get(id) ?? new THREE.Box3(point(id).addScalar(-0.07 * scale), point(id).addScalar(0.07 * scale));
  const context = { style: ENHANCED_CHARACTER_STYLES[key], key, scale, point, bounds };
  const builder = new SkinBuilder(basis, materials);
  torso(builder, context); limbs(builder, context); handsAndFeet(builder, context); head(builder, context);
  const definitions = builder.finish();
  return { definitions, references: 0, stats: { meshes: definitions.length, materials: new Set(definitions.map(part => part.material)).size, triangles: definitions.reduce((sum, part) => sum + part.geometry.attributes.position.count / 3, 0), authoredDetails: builder.authoredDetails } };
}

/** Synchronous, reversible skin mounted under the existing original bones.
 * Pass one createEnhancedCharacterMaterials() library to share a single PBR
 * material across the level. Its load()/ready updates maps without crowd rebuild.
 * Mesh visibility is toggled individually because CrowdRenderer reads it directly.
 */
export function createEnhancedCharacterSkin(character, name = character?.skinBasis?.name, { enabled = true, materials: suppliedMaterials } = {}) {
  if (!character?.skinBasis?.boneMatrices || !character?.bones || !character?.meshes) throw new TypeError('Enhanced skin requires a character with standing skinBasis metadata');
  const existing = owners.get(character);
  if (existing) { existing.setEnabled(enabled); return existing; }
  const key = String(name).toLowerCase();
  if (!ENHANCED_CHARACTER_STYLES[key]) throw new RangeError(`Unknown Enhanced character: ${name}`);
  const usesDefault = !suppliedMaterials;
  const materials = suppliedMaterials ?? (defaultMaterials ??= createEnhancedCharacterMaterials());
  if (usesDefault) void materials.load();
  const cacheKey = `${key}:${character.skinBasis.height}:${materials.material.uuid}`;
  let prototype = prototypes.get(cacheKey);
  if (!prototype) { prototype = buildPrototype(character, key, materials); prototypes.set(cacheKey, prototype); }
  prototype.references++;
  if (usesDefault) defaultUsers++;
  const originals = character.meshes.map(mesh => ({ mesh, visible: mesh.visible }));
  const meshes = prototype.definitions.map(({ boneId, geometry, material }) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `enhanced:${key}:bone${boneId}`;
    mesh.userData.graphicsOwned = true; mesh.userData.enhancedCharacter = true; mesh.userData.boneId = boneId;
    mesh.castShadow = mesh.receiveShadow = true;
    character.bones.get(boneId).add(mesh);
    return mesh;
  });
  let active = false, disposed = false;
  const skin = {
    name: key, meshes, stats: prototype.stats, materials,
    get enabled() { return active; },
    get ready() { return materials.ready; },
    setEnabled(value) {
      if (disposed) return skin;
      active = Boolean(value);
      for (const original of originals) original.mesh.visible = active ? false : original.visible;
      for (const mesh of meshes) {
        mesh.visible = active;
        // Box3.setFromObject includes invisible children. Detaching the overlay
        // restores Original's exact crouch/death bounds as well as its rendering.
        if (active) character.bones.get(mesh.userData.boneId).add(mesh);
        else mesh.removeFromParent();
      }
      character.setVisualBoundsMeshes?.(active ? meshes : null);
      return skin;
    },
    dispose() {
      if (disposed) return;
      skin.setEnabled(false); disposed = true;
      for (const mesh of meshes) mesh.removeFromParent();
      owners.delete(character);
      if (--prototype.references === 0) {
        for (const part of prototype.definitions) part.geometry.dispose();
        prototypes.delete(cacheKey);
      }
      if (usesDefault && --defaultUsers === 0) { defaultMaterials?.dispose(); defaultMaterials = null; }
    },
  };
  owners.set(character, skin); skin.setEnabled(enabled);
  return skin;
}
