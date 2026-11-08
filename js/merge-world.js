import * as THREE from 'three';

/** Batch baked level triangles by material without welding vertices or normals. */
export function mergeWorldMeshes(data, materials, fallback, raw = false) {
  const batches = new Map();
  const parts = mesh => mesh.groups?.length ? mesh.groups : [{start:0, count:mesh.indices.length, material:''}];
  const materialFor = part => materials[part.material] || fallback;

  // Allocate exactly once per material, including corners shared by indexed faces.
  for (const mesh of data.meshes) {
    for (const part of parts(mesh)) {
      const material = materialFor(part);
      let batch = batches.get(material);
      if (!batch) batches.set(material, batch = {name:part.material || 'fallback', count:0, offset:0});
      batch.count += part.count;
    }
  }
  for (const batch of batches.values()) {
    batch.position = new Float32Array(batch.count * 3);
    batch.normal = new Float32Array(batch.count * 3);
    batch.uv = new Float32Array(batch.count * 2);
  }

  for (const mesh of data.meshes) {
    // Calculate normals before merging so adjacent original meshes retain their
    // distinct shading. A normal cannot be recomputed from merged positions.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.vertices, 3));
    geometry.setIndex(mesh.indices);
    if (mesh.normals?.length) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normals, 3));
    else geometry.computeVertexNormals();
    if (raw) geometry.rotateX(Math.PI / 2);
    const positions = geometry.getAttribute('position').array;
    const normals = geometry.getAttribute('normal').array;
    const uv = mesh.uv;

    for (const part of parts(mesh)) {
      const batch = batches.get(materialFor(part));
      for (let i = part.start, end = part.start + part.count; i < end; i++) {
        const source = mesh.indices[i], target = batch.offset++;
        for (let axis = 0; axis < 3; axis++) {
          batch.position[target * 3 + axis] = positions[source * 3 + axis];
          batch.normal[target * 3 + axis] = normals[source * 3 + axis];
        }
        batch.uv[target * 2] = uv?.[source * 2] ?? 0;
        batch.uv[target * 2 + 1] = uv?.[source * 2 + 1] ?? 0;
      }
    }
    geometry.dispose();
  }

  const group = new THREE.Group();
  for (const [material, batch] of batches) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(batch.position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(batch.normal, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(batch.uv, 2));
    geometry.addGroup(0, batch.count, 0);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'world:' + batch.name;
    group.add(mesh);
  }
  group.userData.sourceMeshCount = data.meshes.length;
  group.userData.materialBatchCount = batches.size;
  return group;
}
