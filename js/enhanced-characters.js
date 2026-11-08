import * as THREE from 'three';
import { poseAnatomicalHandPoint } from './human-hand-pose.js?v=20261109-10';
export { poseAnatomicalHandPoint } from './human-hand-pose.js?v=20261109-10';
import { mergeGeometries } from '../vendor/addons/utils/BufferGeometryUtils.js?v=20261109-10';
import { humanAnatomy } from '../assets/enhanced/characters/human-anatomy.js?v=20261109-10';
import { humanHead } from '../assets/enhanced/characters/human-head.js?v=20261109-10';
import { createEnhancedCharacterMaterials } from './enhanced-character-materials.js?v=20261109-10';

const prototypes = new Map(), owners = new WeakMap();
let defaultMaterials = null, defaultUsers = 0;
const UP = new THREE.Vector3(0, 1, 0), FRONT = new THREE.Vector3(0, 0, 1);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Colors and costume cues read from the seven original 3.jpg character atlases.
 * The original tailored silhouette/UVs are retained; only the face is reconstructed. */
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
  face(id, input, name, center, scale, projection) {
    const geometry = input.index ? input.toNonIndexed() : input;
    if (geometry !== input) input.dispose();
    geometry.deleteAttribute('tone');
    const position = geometry.attributes.position, uv = geometry.attributes.uv, rect = this.materials.faceRect(name);
    for (let triangle = 0; triangle < position.count; triangle += 3) {
      const front = (position.getZ(triangle) + position.getZ(triangle + 1) + position.getZ(triangle + 2)) / 3 > center.z;
      for (let corner = 0; corner < 3; corner++) {
        const index = triangle + corner;
        if (front) {
          const u = clamp(.5 + (position.getX(index) - center.x) / projection.width, 0, 1);
          const v = projection.vertical(position.getY(index));
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

// Descendant transforms are static even while the HSK bones animate. Rebuilding
// from these matrices makes a late quality toggle identical to a standing load.
function originalParts(character) {
  const ids = new Map([...character.bones].map(([id, bone]) => [bone, id]));
  return character.meshes.map(mesh => {
    const matrix = new THREE.Matrix4(); let node = mesh;
    while (node && !ids.has(node)) { node.updateMatrix(); matrix.premultiply(node.matrix); node = node.parent; }
    return { mesh, boneId: ids.get(node), matrix };
  }).sort((a, b) => a.boneId - b.boneId || a.mesh.name.localeCompare(b.mesh.name));
}

function weaveTextures() {
  const size = 64, normal = new Uint8Array(size * size * 4), rough = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, alternating = ((x >> 3) + (y >> 3)) % 2 ? 1 : -1;
    normal.set([128 + Math.round(17 * Math.sin(x * Math.PI / 4) * alternating), 128 + Math.round(17 * Math.sin(y * Math.PI / 4) * -alternating), 253, 255], i);
    const value = 226 + Math.round(13 * Math.sin((x + y) * Math.PI / 8)); rough.set([value, value, value, 255], i);
  }
  return [normal, rough].map(data => {
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.channel = 1;
    texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true; texture.needsUpdate = true; texture.userData.graphicsOwned = true;
    return texture;
  });
}

// Keep the actual swept locks, asymmetric hairline and hats. Dama's hair is an
// independent original rig part (bone 16). Other heads share a UV atlas, so the
// small masks below select its hair islands instead of keeping an old face.
function hairTriangle(key, uv, points, box) {
  const u = uv.reduce((sum, p) => sum + p.x, 0) / 3;
  const v = 1 - uv.reduce((sum, p) => sum + p.y, 0) / 3;
  const y = points.reduce((sum, p) => sum + p.y, 0) / 3;
  const z = points.reduce((sum, p) => sum + p.z, 0) / 3;
  const fraction = (y - box.min.y) / (box.max.y - box.min.y);
  if (key === 'gulman') return fraction > .60 || (fraction > .42 && (u < .115 || u > .280)) || (fraction > .40 && z < box.min.z + .075);
  if (key === 'dama') return false;
  if (key === 'box') return fraction > .74 && v > .25;
  if (key === 'bugay') return fraction > .65;
  if (key === 'ded') return u > .735 && v < .31;
  if (key === 'brucelee') return u < .44 && v < .41;
  if (key === 'boss') return u > .50 && v < .26;
  return false;
}

function sourceBody(character, key) {
  const definitions = [], ownedMaterials = [], ownedTextures = [], materialCache = new Map();
  const [normalMap, roughnessMap] = weaveTextures(); ownedTextures.push(normalMap, roughnessMap);
  const materialFor = (source, hair) => {
    const cacheKey = `${source?.map?.uuid ?? source?.uuid}:${hair}`;
    if (materialCache.has(cacheKey)) return materialCache.get(cacheKey);
    const map = source?.map?.clone() ?? null;
    if (map) { map.anisotropy = Math.max(4, map.anisotropy); map.needsUpdate = true; ownedTextures.push(map); }
    const material = new THREE.MeshStandardMaterial({
      map, color: source?.color?.clone() ?? 0xffffff, side: THREE.DoubleSide,
      roughness: hair ? .82 : .83, metalness: 0, envMapIntensity: .40,
      normalMap: hair ? null : normalMap, normalScale: new THREE.Vector2(.20, .20),
      roughnessMap: hair ? null : roughnessMap, alphaTest: source?.alphaTest ?? 0,
    });
    material.name = `Enhanced ${key} original ${hair ? 'hair' : 'costume'}`;
    material.userData.graphicsOwned = true;
    materialCache.set(cacheKey, material); ownedMaterials.push(material); return material;
  };
  for (const { mesh, boneId, matrix } of originalParts(character)) {
    if (boneId === 14 || boneId === 15) continue; // Replaced by the CC0 anatomical hands below.
    const headPart = boneId === 2, hair = headPart || boneId === 16;
    const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    geometry.applyMatrix4(matrix);
    const rest = character.skinBasis.boneMatrices.get(boneId), world = geometry.clone().applyMatrix4(rest);
    const p = world.attributes.position, uv = geometry.attributes.uv, selected = [];
    for (let i = 0; i < p.count; i += 3) {
      if (headPart && !hairTriangle(key, [0, 1, 2].map(j => new THREE.Vector2().fromBufferAttribute(uv, i + j)), [0, 1, 2].map(j => new THREE.Vector3().fromBufferAttribute(p, i + j)), character.skinBasis.partBounds.get(2))) continue;
      selected.push(i, i + 1, i + 2);
    }
    if (!selected.length) { geometry.dispose(); world.dispose(); continue; }
    const output = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      const values = [];
      for (const index of selected) for (let channel = 0; channel < attribute.itemSize; channel++) values.push(attribute.array[index * attribute.itemSize + channel]);
      output.setAttribute(name, new THREE.Float32BufferAttribute(values, attribute.itemSize));
    }
    // Independent metric UVs add only a subtle weave: the painted ornament,
    // lapels, cuffs, tattoo and coat borders keep their exact original UV0.
    const detailUV = [];
    for (const i of selected) detailUV.push((p.getX(i) + p.getZ(i) * .67) * 22, p.getY(i) * 22);
    output.setAttribute('uv1', new THREE.Float32BufferAttribute(detailUV, 2));
    output.computeBoundingBox(); output.computeBoundingSphere(); cacheGroundSupport(output);
    const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    definitions.push({ boneId, geometry: output, material: materialFor(source, hair), sourceSilhouette: true, sourceHair: hair });
    geometry.dispose(); world.dispose();
  }
  const batches = new Map();
  for (const part of definitions) {
    const key = `${part.boneId}:${part.material.uuid}`;
    const group = batches.get(key) ?? []; group.push(part); batches.set(key, group);
  }
  const combined = [];
  for (const parts of batches.values()) {
    if (parts.length === 1) { combined.push(parts[0]); continue; }
    const geometry = mergeGeometries(parts.map(part => part.geometry));
    for (const part of parts) part.geometry.dispose();
    geometry.computeBoundingBox(); geometry.computeBoundingSphere(); cacheGroundSupport(geometry);
    combined.push({ ...parts[0], geometry });
  }
  return { definitions: combined, ownedMaterials, ownedTextures };
}

function anatomicalHead(builder, context) {
  const { bounds, scale, style, key } = context, original = bounds(2);
  const size = original.getSize(new THREE.Vector3()), center = original.getCenter(new THREE.Vector3());
  // Preserve the original hairline and collar, while fitting an actual human
  // skull between them. Hat widths must never inflate the underlying head.
  const width = clamp(size.x * .90, (style.female ? .128 : .150) * scale, .184 * scale);
  const xScale = width / (humanHead.skullBounds.max[0] - humanHead.skullBounds.min[0]);
  const yScale = clamp(size.y * .75, .220 * scale, .250 * scale) / (humanHead.bounds.max[1] - humanHead.chinY);
  const zScale = (style.female ? .88 : .97) * scale;
  const origin = new THREE.Vector3(center.x, original.min.y + .045 * scale - humanHead.chinY * yScale, original.max.z + .010 * scale - humanHead.noseTip[2] * zScale);
  const geometry = new THREE.BufferGeometry(), vertices = [];
  for (let i = 0; i < humanHead.positions.length; i += 3) {
    const x = humanHead.positions[i]; let y = humanHead.positions[i + 1], z = humanHead.positions[i + 2];
    // The source pompadour has a swept-back scalp. Keep the imported forehead
    // inside that actual envelope instead of allowing skin to poke through it.
    if (key === 'gulman' && y > .160) { const upper = clamp((y - .160) / .055, 0, 1); z -= .042 * upper; y = .160 + (y - .160) * .77; }
    // The low neck edge includes the start of trapezius. Tuck that existing
    // anatomy inside the original collar without changing the jaw/skull.
    const neck = .67 + .33 * clamp((y - humanHead.chinY) / .035, 0, 1);
    vertices.push(origin.x + x * xScale * neck, origin.y + y * yScale, origin.z + z * zScale);
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(humanHead.uv, 2));
  geometry.setIndex(humanHead.indices); geometry.computeVertexNormals();
  const levels = [[humanHead.chinY, .02], [humanHead.mouthY, .26], [humanHead.noseTip[1], .47], [humanHead.eyesY, .71], [humanHead.eyesY + .060, .99]];
  const vertical = worldY => {
    const y = (worldY - origin.y) / yScale;
    if (y <= levels[0][0]) return .02;
    for (let i = 1; i < levels.length; i++) if (y <= levels[i][0]) {
      const [a, v] = levels[i - 1], [b, w] = levels[i]; return THREE.MathUtils.lerp(v, w, (y - a) / (b - a));
    }
    return .99;
  };
  const faceCenter = new THREE.Vector3(origin.x, origin.y + humanHead.headCenter[1] * yScale, origin.z + humanHead.headCenter[2] * zScale);
  builder.face(2, geometry, key, faceCenter, scale, {
    width: Math.abs(humanHead.eyes.left[0] - humanHead.eyes.right[0]) * xScale / .34,
    vertical,
  });
}


function anatomicalHands(builder, context) {
  const { style, scale, point, bounds } = context;
  for (const id of [14, 15]) {
    const source = humanAnatomy.parts[id === 14 ? 'rightHand' : 'leftHand'];
    const wrist = point(id), center = bounds(id).getCenter(new THREE.Vector3());
    const direction = center.clone().sub(wrist).normalize(), frame = basisFor(wrist, center);
    // The real source hand is wrist-local +Y. Retarget its palm plane to the
    // original hand, keeping the source wrist/finger joint topology intact.
    const handScale = scale * (style.female ? .76 : style.muscular ? 1.05 : .86);
    const geometry = new THREE.BufferGeometry();
    const vertices = [];
    for (let i = 0; i < source.positions.length; i += 3) {
      const [x, yy, zz] = poseAnatomicalHandPoint(source, source.positions[i], source.positions[i + 1], source.positions[i + 2], id === 14);
      const position = wrist.clone().addScaledVector(frame.width, x * handScale)
        .addScaledVector(direction, yy * handScale).addScaledVector(frame.depth, zz * handScale);
      vertices.push(...position.toArray());
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(source.uv, 2));
    geometry.setIndex(source.indices); geometry.computeVertexNormals();
    builder.add(id, geometry, style.gloves ? style.shoes : style.skin, style.gloves ? 'leather' : 'skin');
    if (id === 14) context.weaponGripOffset = direction.clone().multiplyScalar(.080 * handScale).addScaledVector(frame.depth, -.028 * handScale).addScaledVector(frame.width, .010 * handScale);
  }
}

function buildPrototype(character, key, materials) {
  const basis = character.skinBasis, scale = basis.height / 1.8;
  const point = id => new THREE.Vector3().setFromMatrixPosition(basis.boneMatrices.get(id));
  const bounds = id => basis.partBounds.get(id) ?? new THREE.Box3(point(id).addScalar(-0.07 * scale), point(id).addScalar(0.07 * scale));
  const context = { style: ENHANCED_CHARACTER_STYLES[key], key, scale, point, bounds, sourceHair: true };
  const builder = new SkinBuilder(basis, materials);
  anatomicalHead(builder, context); anatomicalHands(builder, context);
  const source = sourceBody(character, key), definitions = [...source.definitions, ...builder.finish()];
  return { ...source, definitions, weaponGripOffset: context.weaponGripOffset, references: 0, stats: { meshes: definitions.length, materials: new Set(definitions.map(part => part.material)).size, triangles: definitions.reduce((sum, part) => sum + part.geometry.attributes.position.count / 3, 0), sourceBodyParts: source.definitions.filter(part => !part.sourceHair).length, sourceHairParts: source.definitions.filter(part => part.sourceHair).length, anatomicalHands: 2, anatomicalHead: true, authoredDetails: builder.authoredDetails } };
}

/** Synchronous, reversible skin mounted under the existing original bones.
 * Pass one createEnhancedCharacterMaterials() library for shared skin/face PBR.
 * Costume and hair retain their source maps; same-type actors share those PBR
 * materials and their exact source silhouette. Imported anatomy shares the rig.
 * The library's load()/ready updates maps without a crowd rebuild.
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
  const meshes = prototype.definitions.map(({ boneId, geometry, material, sourceSilhouette, sourceHair }) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `enhanced:${key}:bone${boneId}`;
    mesh.userData.graphicsOwned = true; mesh.userData.enhancedCharacter = true; mesh.userData.boneId = boneId;
    mesh.userData.sourceSilhouette = Boolean(sourceSilhouette); mesh.userData.sourceHair = Boolean(sourceHair);
    if (!sourceSilhouette && [2, 14, 15].includes(boneId)) mesh.userData.anatomicalSource = 'MakeHuman hm08 CC0';
    mesh.castShadow = mesh.receiveShadow = true;
    character.bones.get(boneId).add(mesh);
    return mesh;
  });
  let active = false, disposed = false, originalGrip = null;
  const skin = {
    name: key, meshes, stats: prototype.stats, materials,
    get enabled() { return active; },
    get ready() { return materials.ready; },
    setEnabled(value) {
      if (disposed) return skin;
      const next = Boolean(value);
      if (next && !active) originalGrip = character.getWeaponGripOffset?.() ?? null;
      if (next) character.setWeaponGripOffset?.(prototype.weaponGripOffset);
      else if (active) character.setWeaponGripOffset?.(originalGrip);
      active = next;
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
        for (const material of prototype.ownedMaterials) material.dispose();
        for (const texture of prototype.ownedTextures) texture.dispose();
        prototypes.delete(cacheKey);
      }
      if (usesDefault && --defaultUsers === 0) { defaultMaterials?.dispose(); defaultMaterials = null; }
    },
  };
  owners.set(character, skin); skin.setEnabled(enabled);
  return skin;
}
