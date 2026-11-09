import { Box3, Triangle, Vector3 } from 'three';

const triangleKey = points => points.map(p => p.toArray().map(x => Math.round(x * 10000)).join(',')).sort().join('|');
const halfWidth = .76;

// Surveyed from the original meshes, including the first span's sag. The
// first span starts under the rock ledge and ends just short of the lower roof.
const crossings = [
  { meshes: ['dx246', 'dx247'], rows: [
    [65.83, -9.43, 29.50], [50.86, -9.36, 28.45], [35.98, -8.18, 27.40],
    [21.18, -5.87, 26.35], [20.55, -5.61, 26.30],
  ] },
  { meshes: ['dx244', 'dx245'], rows: [
    [12.55, -5.16, 26.60], [12.55, -6.07, 25.65], [12.55, 5.67, -7.72],
  ] },
];

/** Continuous footing across the two paired ropes on the Acropolis route. */
export function ropeSupport(levelId, modelData) {
  if (levelId !== 3) return undefined;
  const support = [], removed = new Set(), bounds = [], spans = [];
  for (const { meshes, rows } of crossings) {
    const beams = meshes.map(name => modelData.meshes.find(mesh => mesh.name === name));
    if (beams.some(mesh => !mesh?.vertices?.length)) continue;
    const box = new Box3();
    for (const { vertices, indices } of beams) {
      for (let i = 0; i < indices.length; i += 3) {
        const points = indices.slice(i, i + 3).map(ix => new Vector3().fromArray(vertices, ix * 3).multiplyScalar(.01));
        removed.add(triangleKey(points));
        for (const point of points) box.expandByPoint(point);
      }
    }
    bounds.push(box.expandByScalar(.001));
    const centers = rows.map(row => new Vector3(...row));
    const delta = centers.at(-1).clone().sub(centers[0]);
    const side = new Vector3(delta.z, 0, -delta.x).normalize().multiplyScalar(halfWidth);
    for (let i = 1; i < centers.length; i++) {
      const start = centers[i - 1], end = centers[i];
      const a = start.clone().add(side), b = start.clone().sub(side);
      const c = end.clone().add(side), d = end.clone().sub(side);
      support.push(new Triangle(a, b, c), new Triangle(b, d, c));
      spans.push({ start, end });
    }
  }
  return {
    support,
    exclude: points => bounds.some(box => points.every(p => box.containsPoint(p))) && removed.has(triangleKey(points)),
    heading(position, yaw, forward, strafe) {
      if (!forward || strafe) return yaw;
      for (const { start, end } of spans) {
        const dx = end.x - start.x, dz = end.z - start.z;
        const x = position.x - start.x, z = position.z - start.z;
        const length = Math.hypot(dx, dz);
        const along = (x * dx + z * dz) / length;
        if (along < 0 || along > length || Math.abs(x * dz - z * dx) / length >= halfWidth) continue;
        const y = start.y + (end.y - start.y) * along / length;
        if (position.y < y - .12 || position.y > y + .45) continue;
        const heading = Math.atan2(dx, dz);
        const difference = Math.cos(yaw - heading);
        // Follow the rope if W/S already point nearly along it. Looking and
        // aiming stay free, and sideways input can still walk off the edge.
        if (Math.abs(difference) > .98) return difference > 0 ? heading : heading + Math.PI;
      }
      return yaw;
    },
  };
}
