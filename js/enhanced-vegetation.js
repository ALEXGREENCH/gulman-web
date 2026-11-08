import * as THREE from 'three';

const ROOT = 'assets/enhanced/vegetation/';
const UP = new THREE.Vector3(0, 1, 0);
const own = object => { object.userData.graphicsOwned = true; object.userData.collision = false; return object; };
const kindFor = map => {
  const name = String(map || '').replaceAll('\\', '/').split('/').at(-1).toLowerCase();
  if (name === 'tree.tga') return 'broadleaf';
  if (/^tuia[12]?\.(jpg|tga)$/.test(name)) return 'conifer';
  if (name === 'palma.tga') return 'palm';
  if (name === 'bush.tga') return 'shrub';
  if (name === 'flowers.tga') return 'flower';
  return null;
};

/** Identify complete vegetation objects and preserve all unconsumed groups.
 * Atlas terrain (including GRASS4/TX3) is deliberately not classified as plants.
 * Source arrays and original materials are borrowed read-only.
 */
export function vegetationPlacements(data) {
  const placements = [], hiddenMaterialNames = new Set(), consumed = new Set();
  const point = new THREE.Vector3();
  for (let mi = 0; mi < data.meshes.length; mi++) {
    const mesh = data.meshes[mi];
    for (let gi = 0; gi < (mesh.groups || []).length; gi++) {
      const part = mesh.groups[gi], kind = kindFor(data.materials[part.material]?.originalMap);
      if (!kind || part.count < 3) continue;
      const bounds = new THREE.Box3();
      for (let i = part.start; i < part.start + part.count; i++) bounds.expandByPoint(point.fromArray(mesh.vertices, mesh.indices[i] * 3).multiplyScalar(.01));
      const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
      if (![...size.toArray(), ...center.toArray()].every(Number.isFinite) || size.y < .12 || size.y > 40 || Math.max(size.x, size.z) > 45) continue;
      const position = new THREE.Vector3(center.x, bounds.min.y, center.z);
      // Three overlapping bush cards become one volumetric shrub. Adjacent
      // individual bushes remain distinct, even when their canopies overlap.
      const duplicate = kind === 'shrub' && placements.find(p => p.kind === kind && p.materialName === part.material && Math.abs(p.position.y - position.y) < .15 && Math.hypot(p.position.x - position.x, p.position.z - position.z) < Math.max(.10, size.y * .13));
      if (duplicate) { duplicate.bounds.union(bounds); duplicate.size.copy(duplicate.bounds.getSize(point)); duplicate.sourceParts++; }
      else placements.push({ kind, position, size, bounds, materialName: part.material, sourceParts: 1, sourceName: mesh.name, yaw: (mi * 2.3999632297 + gi) % (Math.PI * 2) });
      hiddenMaterialNames.add(part.material); consumed.add(mi + ':' + gi);
    }
  }
  const retainedMeshes = [];
  for (let mi = 0; mi < data.meshes.length; mi++) {
    const source = data.meshes[mi], indices = [], groups = [];
    for (let gi = 0; gi < (source.groups || []).length; gi++) {
      const part = source.groups[gi];
      if (!hiddenMaterialNames.has(part.material) || consumed.has(mi + ':' + gi)) continue;
      groups.push({ ...part, start: indices.length }); for (let i = part.start; i < part.start + part.count; i++) indices.push(source.indices[i]);
    }
    if (indices.length) retainedMeshes.push({ ...source, indices, groups });
  }
  return { placements, hiddenMaterialNames, retainedMeshes, sourceParts: consumed.size };
}

function wind(material, time, height, strength, foliage) {
  const common = `uniform float vegetationTime;\n`;
  const begin = `#include <begin_vertex>
    vec3 plantOrigin = vec3(0.0);
    #ifdef USE_INSTANCING
      plantOrigin = instanceMatrix[3].xyz;
    #endif
    float h = clamp(position.y / ${height.toFixed(6)}, 0.0, 1.0);
    float phase = plantOrigin.x * .21 + plantOrigin.z * .17;
    float bend = sin(vegetationTime * .8 + phase) * h * h;
    float flutter = sin(vegetationTime * 2.1 + position.x * 4.0 + phase) * h * ${foliage ? '.22' : '.03'};
    transformed.x += (bend + flutter) * ${strength.toFixed(6)};
    transformed.z += cos(vegetationTime * .65 + phase) * h * h * ${(strength * .4).toFixed(6)};
  `;
  material.onBeforeCompile = shader => { shader.uniforms.vegetationTime = time; shader.vertexShader = common + shader.vertexShader; shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', begin); };
  material.customProgramCacheKey = () => `network-vegetation-wind-v1-${height}-${strength}-${foliage}`;
}

/** Owns all imported resources. The caller owns source visibility and collision.
 * Geometry is rendered in world metres, independently from the original 0.01 rig.
 */
export class EnhancedVegetation {
  constructor({ assets, modelData, quality = 'high', loadModel } = {}) {
    Object.assign(this, { assets, modelData, quality, loadModel });
    this.group = own(new THREE.Group()); this.group.name = 'CC0 imported vegetation';
    this.hiddenMaterialNames = new Set(); this.retainedMeshes = [];
    this.geometries = new Set(); this.materials = new Set(); this.textures = new Set();
    this.batches = []; this.time = { value: 0 }; this.disposed = false; this.ready = false;
    this.stats = { replacements: 0, sourceParts: 0, trees: 0, shrubs: 0, flowers: 0, visible: 0, high: 0, low: 0, batches: 0, triangles: 0, source: 'Poly Haven / Yughues CC0' };
    this._lastUpdate = -Infinity; this._camera = new THREE.Vector3(); this._matrix = new THREE.Matrix4(); this._frustum = new THREE.Frustum(); this._sphere = new THREE.Sphere();
  }
  load() {
    if (!this.promise) this.promise = this._load().catch(error => { this.dispose(); throw error; });
    return this.promise;
  }
  async _parse(kind) {
    if (this.loadModel) return this.loadModel(kind);
    const { GLTFLoader } = await import('../vendor/addons/loaders/GLTFLoader.js?v=20261109-10');
    const folder = ROOT + kind + '/', data = structuredClone(await this.assets.json(folder + 'model.gltf'));
    for (const item of [...data.buffers || [], ...data.images || []]) if (item.uri) item.uri = this.assets.url(folder + item.uri);
    return (await new GLTFLoader().parseAsync(data, '')).scene;
  }
  async _load() {
    const plan = vegetationPlacements(this.modelData), kinds = [...new Set(plan.placements.map(p => p.kind))];
    const loaded = await Promise.allSettled(kinds.map(async kind => [kind, await this._parse(kind)]));
    // Record resources from all successful imports even if a sibling failed.
    for (const result of loaded) if (result.status === 'fulfilled') {
      result.value[1].traverse(o => { if (o.geometry) this.geometries.add(o.geometry); for (const m of o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []) { this.materials.add(m); for (const value of Object.values(m)) if (value?.isTexture) this.textures.add(value); } });
    }
    if (this.disposed) { this._release(); return this; }
    const failure = loaded.find(r => r.status === 'rejected'); if (failure) throw failure.reason;
    for (const { value: [kind, prototype] } of loaded) {
      const records = plan.placements.filter(p => p.kind === kind);
      this._build(kind, prototype, records);
    }
    this.hiddenMaterialNames = plan.hiddenMaterialNames; this.retainedMeshes = plan.retainedMeshes;
    Object.assign(this.stats, { replacements: plan.placements.length, sourceParts: plan.sourceParts, trees: plan.placements.filter(p => !['shrub', 'flower'].includes(p.kind)).length, shrubs: plan.placements.filter(p => p.kind === 'shrub').length, flowers: plan.placements.filter(p => p.kind === 'flower').length, batches: this.batches.length });
    this.ready = true; return this;
  }
  _build(kind, prototype, placements) {
    prototype.updateMatrixWorld(true);
    const high = prototype.getObjectByName('high'), low = prototype.getObjectByName('low');
    if (!high || !low) throw new Error('Vegetation LOD missing: ' + kind);
    const bounds = new THREE.Box3().setFromObject(high), size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
    const translate = new THREE.Matrix4().makeTranslation(-center.x, -bounds.min.y, -center.z);
    const records = placements.map(p => {
      const object = new THREE.Object3D(); object.position.copy(p.position); object.rotation.y = p.yaw;
      const width = Math.max(p.size.x, p.size.z, p.size.y * (kind === 'conifer' ? .2 : .35));
      // Use a single horizontal scale to preserve botanical shape; don't squash
      // a model into the near-zero thickness of one original card.
      const horizontal = width / Math.max(size.x, size.z, .01);
      object.scale.set(horizontal, p.size.y / Math.max(size.y, .01), horizontal); object.updateMatrix();
      return { matrix: object.matrix.clone(), position: p.position, center: p.position.clone().addScaledVector(UP, p.size.y * .5), radius: Math.hypot(width * .5, p.size.y * .5), kind: p.kind };
    });
    for (const [lod, node] of [['high', high], ['low', low]]) node.traverse(source => {
      if (!source.isMesh) return;
      const geometry = source.geometry.clone().applyMatrix4(source.matrixWorld).applyMatrix4(translate); this.geometries.add(geometry);
      const materials = (Array.isArray(source.material) ? source.material : [source.material]).map(original => {
        const material = original.clone(); this.materials.add(material);
        const foliage = /leaves|twig|shrub|palm/i.test(material.name);
        material.userData.graphicsOwned = true; material.envMapIntensity = .6; material.roughness = Math.max(.72, material.roughness || .8);
        if (foliage || material.alphaTest > 0 || material.transparent) { material.alphaTest = kind==='broadleaf'?(lod==='low'?.30:.38):.42; material.transparent = false; material.side = THREE.DoubleSide; material.alphaToCoverage = false; }
        for (const value of Object.values(material)) if (value?.isTexture) value.anisotropy = 8;
        wind(material, this.time, Math.max(size.y, .01), size.y * (kind === 'shrub' ? .025 : .006), foliage);
        return material;
      });
      const mesh = own(new THREE.InstancedMesh(geometry, materials.length === 1 ? materials[0] : materials, records.length));
      mesh.name = 'vegetation:' + kind + ':' + lod; mesh.castShadow = lod === 'high'; mesh.receiveShadow = true; mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.count = 0; this.group.add(mesh);
      this.batches.push({ mesh, records, lod, kind, triangleCount: (geometry.index?.count || geometry.attributes.position.count) / 3 });
    });
  }
  update(time, camera, quality = this.quality) {
    if (!this.ready || this.disposed || !camera) return;
    this.time.value = time;
    const position = camera.isCamera ? camera.getWorldPosition(this._camera) : this._camera.copy(camera);
    if (time - this._lastUpdate < .16 && quality === this.quality) return;
    this._lastUpdate = time; this.quality = quality;
    const lowQuality = quality === 'low', medium = quality === 'medium';
    let useFrustum = false;
    if (camera.isCamera) { this._matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); this._frustum.setFromProjectionMatrix(this._matrix); useFrustum = true; }
    let triangles = 0, highCount = 0, lowCount = 0;
    const counted = new Set();
    for (const batch of this.batches) {
      const small = batch.kind === 'shrub' || batch.kind === 'flower', near = small ? (lowQuality ? 8 : medium ? 15 : 22) : (lowQuality ? 20 : medium ? 32 : 44);
      const far = small ? (lowQuality ? 45 : 72) : (lowQuality ? 150 : 240);
      let count = 0;
      for (let i = 0; i < batch.records.length; i++) {
        const record = batch.records[i], distance = position.distanceTo(record.center), isHigh = distance < near;
        if (distance > far + record.radius || (batch.lod === 'high') !== isHigh) continue;
        this._sphere.set(record.center, record.radius * 1.08);
        if (useFrustum && !this._frustum.intersectsSphere(this._sphere)) continue;
        batch.mesh.setMatrixAt(count++, record.matrix);
        const key = batch.kind + ':' + i; if (!counted.has(key)) { counted.add(key); if (isHigh) highCount++; else lowCount++; }
      }
      batch.mesh.count = count; batch.mesh.visible = count > 0; batch.mesh.castShadow = batch.lod === 'high' && !lowQuality; batch.mesh.instanceMatrix.needsUpdate = true;
      triangles += count * batch.triangleCount;
    }
    Object.assign(this.stats, { visible: counted.size, high: highCount, low: lowCount, triangles });
  }
  _release() {
    for (const batch of this.batches) batch.mesh.dispose();
    for (const g of this.geometries) g.dispose(); for (const m of this.materials) m.dispose(); for (const t of this.textures) t.dispose();
    this.geometries.clear(); this.materials.clear(); this.textures.clear(); this.group.clear(); this.batches.length = 0;
  }
  dispose() { if (this.disposed) return; this.disposed = true; this.ready = false; this.group.removeFromParent(); this._release(); }
}
