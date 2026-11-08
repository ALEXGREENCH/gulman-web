import * as THREE from 'three';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

/** Subdivide only the Enhanced visual terrain, retaining source coordinates.
 * The source geometry and collision mesh are borrowed and never modified.
 * Every original triangle edge stays fixed, so adjacent source pieces cannot
 * crack. New relief is bounded to 8 mm on sand and 10 cm on steep rock.
 */
export function createEnhancedTerrainGeometry(source, scale = 0.01, { triangleBudget = 12000, maxSubdivisions = 3 } = {}) {
  const position = source.getAttribute('position');
  if (!position || !(scale > 0)) throw new TypeError('Terrain requires positions and a positive metre scale');
  const normal = source.getAttribute('normal'), uv = source.getAttribute('uv');
  const originalCount = Math.floor((source.index?.count ?? position.count) / 3);
  let subdivisions = 0;
  while (subdivisions < maxSubdivisions && originalCount * 4 ** (subdivisions + 1) <= triangleBudget) subdivisions++;
  const n = 2 ** subdivisions, positions = [], normals = [], uvs = [], indices = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), face = new THREE.Vector3();
  const na = new THREE.Vector3(), nb = new THREE.Vector3(), nc = new THREE.Vector3();
  const point = new THREE.Vector3(), baseNormal = new THREE.Vector3(), reliefNormal = new THREE.Vector3();
  const tangentB = new THREE.Vector3(), tangentC = new THREE.Vector3();

  for (let triangle = 0; triangle < originalCount; triangle++) {
    const refs = [0, 1, 2].map(i => source.index ? source.index.getX(triangle * 3 + i) : triangle * 3 + i);
    a.fromBufferAttribute(position, refs[0]).multiplyScalar(scale);
    b.fromBufferAttribute(position, refs[1]).multiplyScalar(scale);
    c.fromBufferAttribute(position, refs[2]).multiplyScalar(scale);
    ab.subVectors(b, a); ac.subVectors(c, a); face.crossVectors(ab, ac).normalize();
    if (!face.lengthSq()) continue;
    if (normal) {
      na.fromBufferAttribute(normal, refs[0]); nb.fromBufferAttribute(normal, refs[1]); nc.fromBufferAttribute(normal, refs[2]);
    } else na.copy(face), nb.copy(face), nc.copy(face);
    const rocky = 1 - smooth((Math.abs(face.y) - 0.55) / 0.35);
    const amplitude = 0.008 + rocky * 0.092;
    const height = (u, v) => {
      const edge = Math.min(u, v, 1 - u - v);
      if (edge <= 0) return 0;
      const x = a.x + ab.x * u + ac.x * v;
      const y = a.y + ab.y * u + ac.y * v;
      const z = a.z + ab.z * u + ac.z * v;
      // Coarse rock undulations, with a smaller second octave. Their sum never
      // exceeds one; the polynomial edge fade also has a zero edge derivative.
      const noise = Math.sin(x * 1.51 + Math.sin(z * 0.71)) * Math.cos(z * 1.17 + y * 0.83) * 0.72
        + Math.sin(x * 3.47 - z * 2.91 + y * 1.53) * 0.28;
      return noise * amplitude * smooth(edge / 0.18);
    };
    const grid = new Map();
    const key = (i, j) => i * (n + 1) + j;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, v = j / n, w = 1 - u - v;
      const h = height(u, v), epsilon = 0.0001;
      const du = (height(u + epsilon, v) - height(u - epsilon, v)) / (2 * epsilon);
      const dv = (height(u, v + epsilon) - height(u, v - epsilon)) / (2 * epsilon);
      point.copy(a).addScaledVector(ab, u).addScaledVector(ac, v).addScaledVector(face, h).divideScalar(scale);
      tangentB.copy(ab).addScaledVector(face, du); tangentC.copy(ac).addScaledVector(face, dv);
      reliefNormal.crossVectors(tangentB, tangentC).normalize().sub(face);
      baseNormal.copy(na).multiplyScalar(w).addScaledVector(nb, u).addScaledVector(nc, v).normalize().add(reliefNormal).normalize();
      grid.set(key(i, j), positions.length / 3);
      positions.push(point.x, point.y, point.z);
      normals.push(baseNormal.x, baseNormal.y, baseNormal.z);
      if (uv) uvs.push(uv.getX(refs[0]) * w + uv.getX(refs[1]) * u + uv.getX(refs[2]) * v, uv.getY(refs[0]) * w + uv.getY(refs[1]) * u + uv.getY(refs[2]) * v);
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
      const ia = grid.get(key(i, j)), ib = grid.get(key(i + 1, j)), ic = grid.get(key(i, j + 1));
      indices.push(ia, ib, ic);
      if (i + j < n - 1) indices.push(ib, grid.get(key(i + 1, j + 1)), ic);
    }
  }
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  result.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  if (uv) result.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  result.setIndex(indices);
  result.computeBoundingBox(); result.computeBoundingSphere();
  result.userData = { enhancedTerrain: true, originalTriangles: originalCount, subdivisions, triangleBudget, maxDisplacementMeters: 0.1 };
  return result;
}
