/** Consume only the materials rebuilt by one visual layer. Builders return
 * every unmodified triangle of those materials in retainedMeshes. Passing the
 * remaining source to the next builder prevents two layers sharing an atlas
 * from restoring each other's removed triangles. Original arrays are borrowed.
 */
export function remainingEnhancedSource(data, hiddenMaterialNames, retainedMeshes = []) {
  const hidden = new Set(hiddenMaterialNames || []);
  if (!hidden.size) return data;
  const meshes = [];
  for (const source of data.meshes || []) {
    const sourceGroups = source.groups?.length ? source.groups : [{start:0,count:source.indices.length,material:''}];
    if (!sourceGroups.some(group => hidden.has(group.material))) { meshes.push(source); continue; }
    const indices = [], groups = [];
    for (const group of sourceGroups) {
      if (hidden.has(group.material)) continue;
      const start = indices.length;
      for (let i = group.start; i < group.start + group.count; i++) indices.push(source.indices[i]);
      if (indices.length > start) groups.push({...group,start,count:indices.length-start});
    }
    if (indices.length) meshes.push({...source,indices,groups});
  }
  // Some whole-object builders return a retained mesh with additional groups.
  // Those groups already survived above and must not be appended a second time.
  const retained=selectEnhancedSourceMaterials({...data,meshes:retainedMeshes},hidden);
  return {...data,meshes:[...meshes,...retained.meshes]};
}

/** Filter the final remainder to material batches hidden in the source world.
 * Visible originals already render their other triangles, so copying those
 * again would cause double surfaces and z-fighting.
 */
export function selectEnhancedSourceMaterials(data, materialNames) {
  const wanted = new Set(materialNames), meshes = [];
  for (const source of data.meshes || []) {
    const indices = [], groups = [];
    for (const group of source.groups?.length ? source.groups : [{start:0,count:source.indices.length,material:''}]) {
      if (!wanted.has(group.material)) continue;
      const start = indices.length;
      for (let i = group.start; i < group.start + group.count; i++) indices.push(source.indices[i]);
      if (indices.length > start) groups.push({...group,start,count:indices.length-start});
    }
    if (indices.length) meshes.push({...source,indices,groups});
  }
  return {...data,meshes};
}
