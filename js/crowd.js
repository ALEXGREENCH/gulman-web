import * as THREE from 'three';

/**
 * Instance the original articulated enemies while keeping their HSK rigs as
 * CPU-side transform sources. The player is deliberately not part of this.
 *
 * const crowd = new CrowdRenderer(scene, actors);
 * // After char.update(), actor positions and rotations have been applied:
 * crowd.update(camera.position);
 * // Before unloading the level:
 * crowd.dispose();
 *
 * Source character groups are detached from the scene. Their transforms and
 * animation methods remain usable. Shared loader geometry/materials remain
 * owned by the loader and are never disposed by this class.
 */
export class CrowdRenderer {
  constructor(scene, actors, { maxDistance = 75 } = {}) {
    this.root = new THREE.Group();
    this.root.name = 'instanced-enemies';
    scene.add(this.root);
    this.actors = actors;
    this.maxDistance = maxDistance;
    this.batches = [];
    this.mirroredGeometries = new Map();
    this.disposed = false;
    this.stats = { batches: 0, drawCalls: 0, instances: 0, visibleActors: 0 };
    this._visible = new Set();
    this._inverseRoot = new THREE.Matrix4();
    this._matrix = new THREE.Matrix4();
    this._reflection = new THREE.Matrix4().makeScale(-1, 1, 1);
    this._frustum = new THREE.Frustum();
    this._projection = new THREE.Matrix4();
    this._actorBounds = new THREE.Sphere(new THREE.Vector3(), 2);
    const groups = new Map();

    for (const actor of actors) {
      const source = actor.char?.group;
      if (!source) continue;
      // updateEnemies may assign group.visible later, so detaching also avoids
      // accidentally rendering the ordinary meshes alongside the instances.
      source.removeFromParent();
      source.updateMatrixWorld(true);
      source.traverse(mesh => {
        if (!mesh.isMesh || mesh.isInstancedMesh || !mesh.geometry) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const mirrored = mesh.matrixWorld.determinant() < 0;
        const key = [mesh.geometry.uuid, ...materials.map(m => m?.uuid), mirrored ? 'mirror' : 'normal'].join(':');
        let entry = groups.get(key);
        if (!entry) {
          entry = { geometry: mesh.geometry, material: mesh.material, mirrored, records: [], name: mesh.name, graphicsOwned: !!mesh.userData.graphicsOwned, castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow };
          groups.set(key, entry);
        }
        entry.records.push({ actor, mesh });
      });
    }

    for (const entry of groups.values()) {
      let geometry = entry.geometry;
      // InstancedMesh does not support matrices with negative determinants.
      // A few original HSK parts are mirrored. Bake that reflection into an
      // owned geometry and multiply it back out of each instance matrix.
      if (entry.mirrored) {
        if (!this.mirroredGeometries.has(geometry.uuid)) {
          const reflected = geometry.clone();
          reflected.applyMatrix4(this._reflection);
          if (reflected.index) {
            const indices = reflected.index.array;
            for (let i = 0; i < indices.length; i += 3) {
              const swap = indices[i + 1];
              indices[i + 1] = indices[i + 2];
              indices[i + 2] = swap;
            }
            reflected.index.needsUpdate = true;
          } else {
            // The game converter emits indexed meshes; handle non-indexed
            // geometry as well if a future loader supplies it.
            for (const attribute of Object.values(reflected.attributes)) {
              const array = attribute.array;
              for (let i = 0; i < attribute.count; i += 3) {
                for (let j = 0; j < attribute.itemSize; j++) {
                  const a = (i + 1) * attribute.itemSize + j;
                  const b = (i + 2) * attribute.itemSize + j;
                  const swap = array[a]; array[a] = array[b]; array[b] = swap;
                }
              }
              attribute.needsUpdate = true;
            }
          }
          this.mirroredGeometries.set(geometry.uuid, reflected);
        }
        geometry = this.mirroredGeometries.get(geometry.uuid);
      }
      const mesh = new THREE.InstancedMesh(geometry, entry.material, entry.records.length);
      mesh.name = `crowd:${entry.name}`;
      if(entry.graphicsOwned){mesh.userData.graphicsOwned=true;mesh.castShadow=entry.castShadow;mesh.receiveShadow=entry.receiveShadow;}
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false; // Individual distance culling happens below.
      mesh.count = 0;
      mesh.visible = false;
      this.root.add(mesh);
      this.batches.push({ ...entry, instance: mesh });
    }
    this.stats.batches = this.batches.length;
  }

  update(cameraPosition) {
    if (this.disposed) return this.stats;
    const camera=cameraPosition?.isCamera?cameraPosition:null;
    if(camera){camera.updateMatrixWorld();this._projection.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);this._frustum.setFromProjectionMatrix(this._projection);cameraPosition=camera.position;}
    const visible = this._visible;
    visible.clear();
    const distanceSq = this.maxDistance * this.maxDistance;
    for (const actor of this.actors) {
      const source = actor.char?.group;
      if (!source) continue;
      // A detached group uses its world-space position directly. pos is the
      // game simulation's authoritative feet location when it is available.
      const position = actor.pos ?? source.position;
      if(camera){this._actorBounds.center.copy(position);this._actorBounds.center.y+=(actor.char.height||1.8)*.5;if(!this._frustum.intersectsSphere(this._actorBounds))continue;}
      if (cameraPosition) {
        const dx = position.x - cameraPosition.x;
        const dy = position.y - cameraPosition.y;
        const dz = position.z - cameraPosition.z;
        if (dx * dx + dy * dy + dz * dz > distanceSq) continue;
      }
      source.updateMatrixWorld(true);
      visible.add(actor);
    }
    this.root.updateWorldMatrix(true, false);
    this._inverseRoot.copy(this.root.matrixWorld).invert();
    let instances = 0;
    let drawCalls = 0;
    for (const batch of this.batches) {
      let count = 0;
      for (const { actor, mesh } of batch.records) {
        if (!visible.has(actor) || !mesh.visible) continue;
        this._matrix.multiplyMatrices(this._inverseRoot, mesh.matrixWorld);
        if (batch.mirrored) this._matrix.multiply(this._reflection);
        batch.instance.setMatrixAt(count++, this._matrix);
      }
      batch.instance.count = count;
      batch.instance.visible = count > 0;
      if (count) {
        batch.instance.instanceMatrix.needsUpdate = true;
        instances += count;
        drawCalls += Array.isArray(batch.material) ? Math.max(1, batch.geometry.groups.length) : 1;
      }
    }
    this.stats.instances = instances;
    this.stats.drawCalls = drawCalls;
    this.stats.visibleActors = visible.size;
    return this.stats;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    for (const { instance } of this.batches) instance.dispose();
    for (const geometry of this.mirroredGeometries.values()) geometry.dispose();
    this.mirroredGeometries.clear();
    this.batches.length = 0;
    this._visible.clear();
  }
}
