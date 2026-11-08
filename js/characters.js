import * as THREE from 'three';

const dataCache = new WeakMap();
const defaultGetJSON = async path => {
  const response = await fetch(new URL(`../${path}`, import.meta.url));
    if (!response.ok) throw new Error(`Character data: HTTP ${response.status}`);
    return response.json();
};

function rigData(getJSON) {
  if (!dataCache.has(getJSON)) dataCache.set(getJSON, Promise.resolve().then(() => getJSON('assets/characters.json')).catch(error => {
    dataCache.delete(getJSON);
    throw error;
  }));
  return dataCache.get(getJSON);
}

// GLScene uses Direction as local +Z, Up as local +Y. HSK's root
// rotates the z-up model into the y-up game world; keep its original basis.
function orientation(direction, up) {
  const z = new THREE.Vector3().fromArray(direction).normalize();
  const x = new THREE.Vector3().crossVectors(new THREE.Vector3().fromArray(up), z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/**
 * Assemble the shipped 18-joint HSK rig from the original separate 3DS parts.
 * loadModel(originalPath, true) must return a fresh Group in RAW z-up units.
 * The result is y-up, feet at zero in the standing pose; +Z is forward.
 * update(dt, moving, dead) also accepts an options object as its second arg:
 * {moving, running, dead, airborne, crouching, direction:'forward'|'back'|'left'|'right'}.
 */
export async function createCharacter(name, loadModel, getJSON = defaultGetJSON, options = {}) {
  const data = await rigData(getJSON);
  const definition = data.characters[String(name).toLowerCase()];
  if (!definition) throw new Error(`Unknown original character: ${name}`);
  const group = new THREE.Group();
  group.name = `character:${definition.name}`;
  const anchor = new THREE.Group();
  const rig = new THREE.Group();
  group.add(anchor);
  anchor.add(rig);
  const bones = new Map();
  const rest = new Map();
  const meshes = [];

  for (const source of definition.bones) {
    const bone = new THREE.Group();
    bone.name = source.name;
    bone.position.fromArray(source.position);
    bone.quaternion.copy(orientation(source.direction, source.up));
    rest.set(source.id, bone.quaternion.clone());
    bones.set(source.id, bone);
  }
  for (const source of definition.bones) {
    (source.parent ? bones.get(source.parent) : rig).add(bones.get(source.id));
  }

  await Promise.all(definition.bones.filter(source => source.model).map(async source => {
    const part = await loadModel(source.model, true);
    const center = new THREE.Box3().setFromObject(part).getCenter(new THREE.Vector3());
    // The exported 3DS parts still sit at their original whole-body positions.
    // HSK positions them from their individual centers at each joint.
    const centered = new THREE.Group();
    centered.add(part);
    part.position.sub(center);
    const meshPivot = new THREE.Group();
    meshPivot.position.fromArray(source.meshPosition);
    meshPivot.quaternion.copy(orientation(source.meshDirection, source.meshUp));
    centered.scale.fromArray(source.meshScale);
    meshPivot.add(centered);
    bones.get(source.id).add(meshPivot);
    part.traverse(child => { if (child.isMesh) meshes.push(child); });
  }));

  const clips = {};
  for (const [key, frames] of Object.entries(data.animations)) {
    const current = new Map([...rest].map(([id, q]) => [id, q.clone()]));
    clips[key] = frames.map(frame => {
      for (const [id, value] of Object.entries(frame.bones)) {
        current.set(Number(id), orientation(value.direction, value.up));
      }
      return {
        duration: Math.max(0.08, frame.durationTicks / 30),
        rotations: new Map([...current].map(([id, q]) => [id, q.clone()])),
      };
    });
  }
  const stand = clips.stand?.[0];
  if (stand) for (const [id, q] of stand.rotations) bones.get(id).quaternion.copy(q);
  rig.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(rig);
  const size = bounds.getSize(new THREE.Vector3());
  const scale = (options.height ?? 1.8) / Math.max(size.y, 0.01);
  anchor.scale.setScalar(scale);
  anchor.position.set(-(bounds.min.x + bounds.max.x) * scale / 2, -bounds.min.y * scale, -(bounds.min.z + bounds.max.z) * scale / 2);
  const standingAnchorY = anchor.position.y;

  const weaponSource = definition.bones.find(bone => bone.id === 17);
  const weaponSocket = new THREE.Group();
  weaponSocket.name = 'WeaponR';
  weaponSocket.position.fromArray(weaponSource.meshPosition);
  weaponSocket.quaternion.copy(orientation(weaponSource.meshDirection, weaponSource.meshUp));
  bones.get(17).add(weaponSocket);
  let weaponRoot = null;
  group.updateMatrixWorld(true);
  const socketAtRest = weaponSocket.getWorldQuaternion(new THREE.Quaternion());
  const weaponOrientation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0),
  )).premultiply(socketAtRest.invert());

  /** Attach an ORIGINAL raw z-up 3DS weapon, barrel along +X.
   * The original WeaponPistol mesh is about 41 raw units long. `length`
   * specifies its displayed length in world metres, independent of rig scale.
   */
  function attachWeapon(model, { length = 0.42 } = {}) {
    weaponRoot?.removeFromParent();
    weaponRoot = null;
    if (!model) return;
    const weaponBounds = new THREE.Box3().setFromObject(model);
    const weaponSize = weaponBounds.getSize(new THREE.Vector3());
    const grip = new THREE.Vector3(
      weaponBounds.min.x + weaponSize.x * 0.18,
      (weaponBounds.min.y + weaponBounds.max.y) * 0.5,
      weaponBounds.min.z + weaponSize.z * 0.35,
    );
    const centered = new THREE.Group();
    centered.add(model);
    model.position.sub(grip);
    centered.scale.setScalar(length / Math.max(weaponSize.x, 0.001) / scale);
    weaponRoot = new THREE.Group();
    // Calibrate the gun against the initial standing pose, then let the
    // original hand/socket keyframes carry it through every animation.
    weaponRoot.quaternion.copy(weaponOrientation);
    weaponRoot.add(centered);
    weaponSocket.add(weaponRoot);
    return weaponRoot;
  }

  let clipName = 'stand';
  let elapsed = 0;
  let disposed = false;
  const targetRotation = new THREE.Quaternion();
  const animatedBounds = new THREE.Box3();
  const originWorld = new THREE.Vector3();
  const worldScale = new THREE.Vector3();
  function update(dt, state = false, dead = false) {
    if (disposed) return;
    const s = typeof state === 'object' ? state : { moving: state, dead };
    const suffix = { back: 'b', left: 'l', right: 'r', forward: 'f' }[s.direction] ?? 'f';
    const next = s.dead ? 'death' : s.airborne ? 'inair' : s.crouching ? 'duck' : s.moving ? `${s.running === false ? 'move' : 'run'}${suffix}` : 'stand';
    if (next !== clipName) { clipName = next; elapsed = 0; }
    elapsed += Math.max(0, Math.min(dt, 0.1));
    const clip = clips[clipName] ?? clips.stand;
    if (!clip?.length) return;
    const duration = clip.reduce((sum, frame) => sum + frame.duration, 0);
    let time = clipName === 'death' ? Math.min(elapsed, duration - 0.00001) : elapsed % duration;
    let index = 0;
    while (index < clip.length - 1 && time >= clip[index].duration) time -= clip[index++].duration;
    const current = clip[index];
    const nextFrame = clip[clipName === 'death' ? Math.min(index + 1, clip.length - 1) : (index + 1) % clip.length];
    const blend = time / current.duration;
    for (const [id, bone] of bones) {
      targetRotation.copy(current.rotations.get(id)).slerp(nextFrame.rotations.get(id), blend);
      bone.quaternion.slerp(targetRotation, 1 - Math.exp(-dt * 20));
    }
    if (s.dead || s.crouching) {
      // ch_animation contains joint rotations only. Settle the rotated body
      // onto the caller's ground height instead of leaving the corpse at the
      // standing hip height. Mesh bounding boxes are cached by Three.js.
      group.updateMatrixWorld(true);
      animatedBounds.setFromObject(rig);
      group.getWorldPosition(originWorld);
      group.getWorldScale(worldScale);
      const clearance = (animatedBounds.min.y - originWorld.y) / Math.max(worldScale.y, 0.001);
      anchor.position.y -= clearance * (1 - Math.exp(-dt * 12));
    } else {
      anchor.position.y += (standingAnchorY - anchor.position.y) * (1 - Math.exp(-dt * 12));
    }
  }

  return {
    group,
    bones,
    meshes,
    height: options.height ?? 1.8,
    weaponSocket,
    attachWeapon,
    update,
    // Mesh geometry/materials are owned by the shared asset loader. Do not
    // dispose them when removing one enemy that shares them with other actors.
    dispose() { disposed = true; group.removeFromParent(); },
  };
}
