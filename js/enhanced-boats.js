import * as THREE from 'three';
import { mergeGeometries } from '../vendor/addons/utils/BufferGeometryUtils.js';
import { meshPlacement } from './enhanced-props.js';

const Y = new THREE.Vector3(0, 1, 0);

function builder() {
  const parts = new Map();
  const add = (geometry, material, position = [0, 0, 0], angles = [0, 0, 0], scale = [1, 1, 1]) => {
    geometry.scale(...scale); geometry.rotateX(angles[0]); geometry.rotateY(angles[1]); geometry.rotateZ(angles[2]); geometry.translate(...position);
    const list = parts.get(material) ?? []; list.push(geometry); parts.set(material, list);
  };
  const box = (size, material, position, angles) => add(new THREE.BoxGeometry(...size), material, position, angles);
  const rod = (a, b, radius, material) => {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), delta = end.clone().sub(start);
    const geometry = new THREE.CylinderGeometry(radius, radius, delta.length(), 10);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y, delta.normalize()));
    add(geometry, material, start.add(end).multiplyScalar(0.5).toArray());
  };
  const tube = (points, radius, material, steps = 48) => {
    const curve = new THREE.CatmullRomCurve3(points.map(point => new THREE.Vector3(...point)));
    add(new THREE.TubeGeometry(curve, steps, radius, 8, false), material);
  };
  const finish = () => [...parts].map(([material, sources]) => {
    const flat = sources.map(geometry => geometry.index ? geometry.toNonIndexed() : geometry);
    const geometry = mergeGeometries(flat);
    for (const source of new Set([...sources, ...flat])) source.dispose();
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    return { geometry, material };
  });
  return { add, box, rod, tube, finish };
}

function surface(rows, columns, point) {
  const positions = [], uv = [], indices = [];
  for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
    positions.push(...point(row / rows, column / columns)); uv.push(column / columns, row / rows);
  }
  const stride = columns + 1;
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const a = row * stride + column, b = a + stride;
    indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

/** A new generic runabout, not a reconstruction of a branded boat. Bow is +Z.
 * Smooth longitudinal sections make a proper rounded V hull and foredeck. */
function boatPrototype(materials) {
  const b = builder(), m = materials;
  const sections = [
    [-2.55, 0.88, 0.93], [-2.1, 0.99, 0.95], [-1.4, 1.065, 0.97], [-0.5, 1.08, 0.99],
    [0.4, 1.025, 1.02], [1.2, 0.91, 1.07], [1.9, 0.72, 1.12], [2.5, 0.44, 1.16], [2.95, 0.16, 1.20], [3.15, 0.012, 1.215],
  ];
  const curve = new THREE.CatmullRomCurve3(sections.map(values => new THREE.Vector3(...values)));
  const sample = t => {
    const p = curve.getPoint(t);
    const keel = 0.025 + Math.max(0, p.x - 1.1) ** 2 * 0.22;
    return { z: p.x, width: Math.max(0.01, p.y), top: p.z, keel: Math.min(p.z - 0.03, keel) };
  };
  b.add(surface(56, 16, (longitudinal, transverse) => {
    const { z, width, top, keel } = sample(longitudinal), angle = (transverse - 0.5) * Math.PI;
    return [Math.sin(angle) * width, keel + (top - keel) * (1 - Math.cos(angle)) ** 0.72, z];
  }), m.hull);
  // Close transom and leave a genuine recessed cockpit behind the foredeck.
  b.box([1.76, 0.60, 0.055], m.hull, [0, 0.62, -2.55]);
  b.add(surface(27, 12, (longitudinal, transverse) => {
    const { z, width, top } = sample(0.49 + longitudinal * 0.51), lateral = transverse * 2 - 1;
    return [lateral * width, top + Math.max(0, 1 - lateral * lateral) * 0.055, z];
  }), m.hull);
  for (const side of [-1, 1]) {
    b.add(surface(56, 3, (longitudinal, transverse) => {
      const { z, width, top } = sample(longitudinal);
      return [side * width * (0.79 + transverse * 0.21), top + 0.02 + Math.sin(transverse * Math.PI) * 0.018, z];
    }), m.hull);
    const rubbing = [], accent = [];
    for (let i = 0; i <= 28; i++) {
      const p = sample(i / 28);
      rubbing.push([side * (p.width + 0.005), p.top - 0.025, p.z]);
      accent.push([side * p.width * 0.965, p.top - 0.19, p.z]);
    }
    b.tube(rubbing, 0.027, m.rubber, 64);
    b.tube(accent, 0.025, m.blue, 64);
    b.box([0.035, 0.37, 2.6], m.upholstery, [side * 0.80, 0.77, -1.00]);
    b.box([0.10, 0.06, 1.75], m.upholstery, [side * 0.73, 0.98, -1.21]);
  }
  b.box([1.58, 0.045, 2.75], m.rubber, [0, 0.53, -1.04]);
  for (let i = -5; i <= 5; i++) b.box([0.125, 0.018, 2.42], m.teak, [i * 0.136, 0.566, -1.02]);
  // Aft bench, two contoured bucket seats and their hardware.
  b.box([1.50, 0.25, 0.48], m.hull, [0, 0.69, -1.98]);
  b.add(new THREE.SphereGeometry(1, 20, 10), m.upholstery, [0, 0.84, -1.98], [0, 0, 0], [0.76, 0.08, 0.25]);
  b.box([1.48, 0.26, 0.10], m.upholstery, [0, 1.00, -2.22], [-0.08, 0, 0]);
  for (const x of [-0.44, 0.44]) {
    b.rod([x, 0.57, -0.64], [x, 0.79, -0.64], 0.065, m.steel);
    b.add(new THREE.SphereGeometry(1, 20, 12), m.upholstery, [x, 0.83, -0.60], [0, 0, 0], [0.28, 0.09, 0.32]);
    b.add(new THREE.SphereGeometry(1, 20, 12), m.upholstery, [x, 1.04, -0.86], [0.16, 0, 0], [0.28, 0.28, 0.075]);
    b.tube([[x - 0.27, 0.85, -0.46], [x - 0.28, 0.98, -0.72], [x - 0.23, 1.20, -0.86]], 0.025, m.upholstery, 12);
    b.tube([[x + 0.27, 0.85, -0.46], [x + 0.28, 0.98, -0.72], [x + 0.23, 1.20, -0.86]], 0.025, m.upholstery, 12);
  }
  // Dashboard: curved fairing, visible dark instruments, steering wheel.
  b.box([1.53, 0.25, 0.35], m.hull, [0, 0.99, 0.21], [-0.12, 0, 0]);
  b.box([0.56, 0.17, 0.028], m.rubber, [0.43, 1.09, 0.012], [-0.16, 0, 0]);
  for (const [x, r] of [[0.33, 0.048], [0.47, 0.048], [0.58, 0.026]]) {
    b.add(new THREE.CylinderGeometry(r, r, 0.015, 16), m.steel, [x, 1.11, -0.01], [Math.PI / 2, 0, 0]);
    b.add(new THREE.CylinderGeometry(r * 0.78, r * 0.78, 0.017, 16), m.rubber, [x, 1.11, -0.02], [Math.PI / 2, 0, 0]);
    b.rod([x, 1.11, -0.032], [x + r * 0.5, 1.13, -0.032], 0.003, m.upholstery);
  }
  b.rod([0.44, 0.96, 0.08], [0.44, 1.04, -0.15], 0.025, m.steel);
  b.add(new THREE.TorusGeometry(0.145, 0.017, 8, 28), m.rubber, [0.44, 1.05, -0.17], [-0.23, 0, 0]);
  for (let i = 0; i < 3; i++) {
    const angle = i / 3 * Math.PI * 2;
    b.rod([0.44, 1.05, -0.17], [0.44 + Math.cos(angle) * 0.13, 1.05 + Math.sin(angle) * 0.13, -0.17], 0.009, m.steel);
  }
  // Three raked windscreen panes, no opaque image stretched over the cockpit.
  const lower = [[-0.83, 1.05, 0.35], [-0.34, 1.07, 0.43], [0.34, 1.07, 0.43], [0.83, 1.05, 0.35]];
  const upper = [[-0.73, 1.48, -0.02], [-0.31, 1.54, 0.02], [0.31, 1.54, 0.02], [0.73, 1.48, -0.02]];
  for (let i = 0; i < 3; i++) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([...lower[i], ...lower[i + 1], ...upper[i + 1], ...upper[i]], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]); geometry.computeVertexNormals(); b.add(geometry, m.glass);
    b.rod(upper[i], upper[i + 1], 0.016, m.steel); b.rod(lower[i], lower[i + 1], 0.016, m.steel);
  }
  for (let i = 0; i < 4; i++) b.rod(lower[i], upper[i], 0.014, m.steel);
  // Bow rail with stanchions, stern cleats and small hanging fenders.
  for (const side of [-1, 1]) {
    const rail = [];
    for (const t of [0.54, 0.64, 0.74, 0.84, 0.93, 0.99]) {
      const p = sample(t); rail.push([side * p.width * 0.90, p.top + 0.23, p.z]);
      if (t < 0.94) b.rod([side * p.width * 0.9, p.top + 0.03, p.z], [side * p.width * 0.9, p.top + 0.23, p.z], 0.012, m.steel);
    }
    b.tube(rail, 0.016, m.steel, 32);
    for (const z of [-2.11, 1.36]) {
      const x = side * (z < 0 ? 0.88 : 0.74), y = z < 0 ? 1.00 : 1.14;
      b.box([0.11, 0.015, 0.055], m.steel, [x, y, z]);
      b.rod([x, y, z], [x, y + 0.055, z], 0.013, m.steel);
      b.rod([x - 0.085, y + 0.055, z], [x + 0.085, y + 0.055, z], 0.014, m.steel);
    }
    b.add(new THREE.SphereGeometry(1, 14, 10), m.upholstery, [side * 1.09, 0.66, -1.28], [0, 0, side * 0.12], [0.10, 0.28, 0.10]);
    b.tube([[side * 0.96, 1.00, -1.28], [side * 1.07, 0.98, -1.28], [side * 1.10, 0.88, -1.28]], 0.007, m.rubber, 8);
  }
  // Outboard cowl, bracket, lower unit, propeller and anti-cavitation plate.
  b.box([0.45, 0.31, 0.12], m.steel, [0, 0.80, -2.62]);
  b.add(new THREE.SphereGeometry(1, 24, 14), m.rubber, [0, 0.97, -2.86], [0.08, 0, 0], [0.26, 0.37, 0.29]);
  b.box([0.38, 0.035, 0.38], m.blue, [0, 0.95, -2.91]);
  b.box([0.15, 0.55, 0.14], m.rubber, [0, 0.49, -2.87], [0.12, 0, 0]);
  b.box([0.35, 0.025, 0.35], m.rubber, [0, 0.32, -2.92]);
  b.add(new THREE.CylinderGeometry(0.075, 0.075, 0.26, 16), m.steel, [0, 0.20, -2.98], [Math.PI / 2, 0, 0]);
  for (let i = 0; i < 3; i++) b.add(new THREE.SphereGeometry(1, 10, 6), m.steel, [0, 0.20, -3.12], [0.14, 0, i / 3 * Math.PI * 2], [0.055, 0.16, 0.018]);
  return b.finish();
}

function boatFacing(mesh, placement) {
  const p = new THREE.Vector3(), local = [];
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    p.fromArray(mesh.vertices, i).multiplyScalar(0.01).sub(placement.position).applyAxisAngle(Y, -placement.yaw);
    local.push([p.x, p.z]); min = Math.min(min, p.z); max = Math.max(max, p.z);
  }
  const width = end => {
    const points = local.filter(point => end ? point[1] > max - (max - min) * 0.18 : point[1] < min + (max - min) * 0.18);
    return Math.max(...points.map(point => point[0])) - Math.min(...points.map(point => point[0]));
  };
  // Principal axes are sign-ambiguous. Point our bow at the narrower source end.
  return placement.yaw + (width(true) > width(false) * 1.12 ? Math.PI : 0);
}

export function buildEnhancedBoats(modelData) {
  const group = new THREE.Group(); group.name = 'Enhanced authored speedboats'; group.userData.graphicsOwned = true; group.userData.collision = false;
  const hiddenMaterialNames = new Set(), retainedMeshes = [], geometries = [], materials = [];
  const empty = { group, hiddenMaterialNames, retainedMeshes, geometries, materials, replacements: 0 };
  const source = String(modelData?.source ?? '').toLowerCase().replaceAll('\\', '/');
  if (!/(?:^|\/)levels\/1\//.test(source)) return empty;
  const boatMaterials = new Set(Object.entries(modelData.materials ?? {}).filter(([, value]) => String(value.originalMap ?? '').replaceAll('\\', '/').split('/').at(-1).toLowerCase() === 'boat.jpg').map(([name]) => name));
  if (!boatMaterials.size) return empty;
  const selected = [];
  for (const mesh of modelData.meshes ?? []) {
    if (!mesh.groups?.length || !mesh.groups.every(part => boatMaterials.has(part.material))) continue;
    const placement = meshPlacement(mesh);
    // BOAT.JPG is also painted onto entire piers. Never replace the long
    // dx30/dx32 pier meshes or anything outside the small runabout envelope.
    if (!(placement.length > 2.5 && placement.length < 10 && placement.width > 0.65 && placement.width < 4 && placement.size.y > 0.4 && placement.size.y < 3)) continue;
    selected.push({ mesh, placement, yaw: boatFacing(mesh, placement) });
    for (const part of mesh.groups) hiddenMaterialNames.add(part.material);
  }
  if (!selected.length) return empty;
  const replaced = new Set(selected.map(item => item.mesh));
  retainedMeshes.push(...modelData.meshes.filter(mesh => !replaced.has(mesh) && mesh.groups?.some(part => hiddenMaterialNames.has(part.material))));
  const m = {
    hull: new THREE.MeshPhysicalMaterial({ color: 0xe7e7dc, roughness: 0.27, metalness: 0, clearcoat: 0.9, clearcoatRoughness: 0.18, side: THREE.DoubleSide }),
    blue: new THREE.MeshStandardMaterial({ color: 0x194963, roughness: 0.32, metalness: 0.12 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x182226, roughness: 0.76, metalness: 0.08 }),
    upholstery: new THREE.MeshStandardMaterial({ color: 0xcacbbb, roughness: 0.82, metalness: 0 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xa1aeb0, roughness: 0.23, metalness: 0.92 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x7aa8b5, roughness: 0.12, metalness: 0.08, transparent: true, opacity: 0.33, depthWrite: false, side: THREE.DoubleSide }),
    teak: new THREE.MeshStandardMaterial({ color: 0x8e7150, roughness: 0.82, metalness: 0 }),
  };
  materials.push(...Object.values(m));
  for (const material of materials) material.userData.graphicsOwned = true;
  const parts = boatPrototype(m), prototypeBounds = new THREE.Box3();
  for (const part of parts) prototypeBounds.union(part.geometry.boundingBox);
  const prototypeSize = prototypeBounds.getSize(new THREE.Vector3()), origin = prototypeBounds.getCenter(new THREE.Vector3()); origin.y = prototypeBounds.min.y;
  for (const part of parts) {
    part.geometry.translate(-origin.x, -origin.y, -origin.z); part.geometry.computeBoundingBox(); part.geometry.computeBoundingSphere(); geometries.push(part.geometry);
  }
  const matrices = [], transform = new THREE.Object3D();
  for (const { placement: p, yaw } of selected) {
    transform.position.copy(p.position); transform.rotation.set(0, yaw, 0);
    transform.scale.set(p.width / prototypeSize.x, p.size.y / prototypeSize.y, p.length / prototypeSize.z); transform.updateMatrix();
    const bounds = new THREE.Box3();
    for (const part of parts) bounds.union(part.geometry.boundingBox.clone().applyMatrix4(transform.matrix));
    // A rotated bounding box can overhang a tapered source. Fit the complete
    // replacement envelope inside the source collider's world-space footprint.
    const size = bounds.getSize(new THREE.Vector3()), fit = Math.min(1, p.size.x / size.x, p.size.z / size.z);
    transform.scale.x *= fit; transform.scale.z *= fit; transform.updateMatrix();
    const fitted = new THREE.Box3();
    for (const part of parts) fitted.union(part.geometry.boundingBox.clone().applyMatrix4(transform.matrix));
    const center = fitted.getCenter(new THREE.Vector3()), sourceCenter = p.box.getCenter(new THREE.Vector3());
    transform.position.x += sourceCenter.x - center.x; transform.position.z += sourceCenter.z - center.z; transform.updateMatrix();
    matrices.push(transform.matrix.clone());
  }
  for (const part of parts) {
    const batch = new THREE.InstancedMesh(part.geometry, part.material, selected.length);
    batch.name = 'enhanced:speedboat'; batch.userData.graphicsOwned = true; batch.userData.collision = false;
    batch.castShadow = part.material !== m.glass; batch.receiveShadow = true;
    matrices.forEach((matrix, index) => batch.setMatrixAt(index, matrix)); batch.instanceMatrix.needsUpdate = true;
    batch.computeBoundingBox(); batch.computeBoundingSphere(); group.add(batch);
  }
  group.userData.sourceNames = selected.map(item => item.mesh.name);
  return { group, hiddenMaterialNames, retainedMeshes, materials, geometries, replacements: selected.length };
}
