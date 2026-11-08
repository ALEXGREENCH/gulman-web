const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function poseAnatomicalHandPoint(source, x, y, z, firearm = false) {
  if (!firearm) {
    const distal = Math.max(0, y - .096), angle = distal * 5;
    return [x, y - distal + Math.sin(angle) / 5, z - source.dorsalAxis[2] * (1 - Math.cos(angle)) / 5];
  }
  // Use the real finger chains: the thumb and index overlap in X around the web.
  let finger = 0, closest = Infinity;
  for (let f = 1; f <= 5; f++) {
    const a = source.landmarks[`finger-${f}-1`], b = source.landmarks[`finger-${f}-4`];
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const t = clamp(((x - a[0]) * dx + (y - a[1]) * dy + (z - a[2]) * dz) / (dx * dx + dy * dy + dz * dz), 0, 1);
    const d = (x - a[0] - t * dx) ** 2 + (y - a[1] - t * dy) ** 2 + (z - a[2] - t * dz) ** 2;
    if (d < closest) { closest = d; finger = f; }
  }
  const base = source.landmarks[`finger-${finger}-1`];
  if (finger === 1) {
    if (y <= base[1] + .004 || x >= base[0] - .003) return [x, y, z];
    const dx = x - base[0], dy = y - base[1], blend = clamp(Math.hypot(dx, dy) / .032, 0, 1), angle = -.85 * blend;
    return [base[0] + dx * Math.cos(angle) - dy * Math.sin(angle), base[1] + dx * Math.sin(angle) + dy * Math.cos(angle), z - .007 * blend];
  }
  if (y <= base[1]) return [x, y, z];
  const curl = finger === 2 ? 9 : finger === 5 ? 48 : 34;
  const distal = y - base[1], angle = distal * curl, depth = z - base[2];
  return [base[0] + (x - base[0]) * (1 - .55 * clamp(distal / .035, 0, 1)), base[1] + Math.sin(angle) / curl + depth * Math.sin(angle), base[2] - (1 - Math.cos(angle)) / curl + depth * Math.cos(angle)];
}
