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
 * {moving, running, dead, airborne, crouching, enhanced, direction:'forward'|'back'|'left'|'right'}.
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
  const meshesByBone = new Map();

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
    const bodyMeshes = [];
    part.traverse(child => {
      if (!child.isMesh) return;
      child.userData.characterSurface = true;
      meshes.push(child);
      bodyMeshes.push(child);
    });
    meshesByBone.set(source.id, bodyMeshes);
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
  // These source clips begin with the same reference pose. Playing it every
  // cycle jerks the torso and arms out of the authored run or crouch.
  const enhancedClips = { ...clips };
  for (const key of ['runf', 'runl', 'runr', 'duck', 'inair']) {
    if (clips[key]?.length > 1) enhancedClips[key] = clips[key].slice(1);
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
  // Immutable standing-space measurements for optional visual skins. Recording
  // these before gameplay avoids deriving a new body from a running/dead pose.
  // The original hierarchy, animation and render geometry are unchanged.
  const inverseRoot = group.matrixWorld.clone().invert();
  const skinBasis = { boneMatrices: new Map(), partBounds: new Map(), height: options.height ?? 1.8, name: definition.name };
  for (const [id, bone] of bones) skinBasis.boneMatrices.set(id, new THREE.Matrix4().multiplyMatrices(inverseRoot, bone.matrixWorld));
  for (const [id, bodyMeshes] of meshesByBone) {
    const box = new THREE.Box3();
    for (const mesh of bodyMeshes) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      box.union(mesh.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverseRoot, mesh.matrixWorld)));
    }
    skinBasis.partBounds.set(id, box);
  }
  const socketAtRest = weaponSocket.getWorldQuaternion(new THREE.Quaternion());
  const weaponOrientation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0),
  )).premultiply(socketAtRest.invert());
  const gripOffset = new THREE.Vector3();
  const gripOffsetToSocket = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().multiplyMatrices(inverseRoot, weaponSocket.matrixWorld).invert());
  // Optional visual grip fit, in character standing-space metres. Bones and
  // source animation stay untouched; zero is the exact original attachment.
  function setWeaponGripOffset(value = null) {
    if (value?.isVector3) gripOffset.copy(value);
    else if (value) gripOffset.fromArray(value);
    else gripOffset.set(0, 0, 0);
    if (weaponRoot) { weaponRoot.position.copy(gripOffset).applyMatrix3(gripOffsetToSocket); weaponRoot.updateWorldMatrix(true, true); }
  }

  /** Attach an ORIGINAL raw z-up 3DS weapon, barrel along +X.
   * The original WeaponPistol mesh is about 41 raw units long. `length`
   * specifies its displayed length in world metres, independent of rig scale.
   */
  let muzzleAnchor=null, heldObjectAnchor=null;
  function weaponMuzzlePosition(target=new THREE.Vector3()){if(!muzzleAnchor)return null;muzzleAnchor.updateWorldMatrix(true,false);return muzzleAnchor.getWorldPosition(target);}
  function attachWeapon(model, { length = 0.42 } = {}) {
    cancelGrenadeThrow();
    weaponRoot?.removeFromParent();
    weaponRoot = null;muzzleAnchor=null;heldObjectAnchor=null;
    if (!model) return;
    model.traverse(child => {
      if (!child.isMesh) return;
      child.userData.characterSurface = true;
      child.receiveShadow = false;
    });
    const weaponBounds = new THREE.Box3().setFromObject(model);
    const weaponSize = weaponBounds.getSize(new THREE.Vector3());
    const grip = new THREE.Vector3(
      weaponBounds.min.x + weaponSize.x * 0.18,
      (weaponBounds.min.y + weaponBounds.max.y) * 0.5,
      weaponBounds.min.z + weaponSize.z * 0.35,
    );
    muzzleAnchor=new THREE.Object3D();muzzleAnchor.position.set(weaponBounds.max.x,(weaponBounds.min.y+weaponBounds.max.y)*.5,(weaponBounds.min.z+weaponBounds.max.z)*.5);model.add(muzzleAnchor);
    heldObjectAnchor=new THREE.Object3D();weaponBounds.getCenter(heldObjectAnchor.position);model.add(heldObjectAnchor);
    const centered = new THREE.Group();
    centered.add(model);
    model.position.sub(grip);
    centered.scale.setScalar(length / Math.max(weaponSize.x, 0.001) / scale);
    weaponRoot = new THREE.Group();
    // Calibrate the gun against the initial standing pose, then let the
    // original hand/socket keyframes carry it through every animation.
    weaponRoot.quaternion.copy(weaponOrientation);
    weaponRoot.position.copy(gripOffset).applyMatrix3(gripOffsetToSocket);
    weaponRoot.add(centered);
    weaponSocket.add(weaponRoot);
    return weaponRoot;
  }

  let clipName = 'stand';
  let elapsed = 0;
  let disposed = false;
  const targetRotation = new THREE.Quaternion();
  const animatedBounds = new THREE.Box3();
  const partWorldBounds = new THREE.Box3();
  const supportPoint = new THREE.Vector3();
  let visualBoundsMeshes = null;
  const originWorld = new THREE.Vector3();
  const worldScale = new THREE.Vector3();
  const throwDuration = 1.05, throwRelease = .46;
  let throwTime = -1, throwReleased = false, throwPending = false, throwWeaponVisibility = true;
  const throwPose = new Map();
  const throwShoulderRest = new THREE.Vector3().setFromMatrixPosition(skinBasis.boneMatrices.get(10));
  const throwHandRest = new THREE.Vector3().setFromMatrixPosition(skinBasis.boneMatrices.get(14)).sub(throwShoulderRest);
  function restoreThrowPose() {
    for (const [id, quaternion] of throwPose) bones.get(id).quaternion.copy(quaternion);
    throwPose.clear();
  }
  function cancelGrenadeThrow() {
    restoreThrowPose(); throwTime = -1; throwReleased = throwPending = false;
    if (weaponRoot) weaponRoot.visible = throwWeaponVisibility;
  }
  function beginGrenadeThrow({ immediate = false } = {}) {
    if (disposed || throwTime >= 0) return false;
    throwTime = immediate ? throwRelease : 0; throwReleased = immediate; throwPending = false;
    throwWeaponVisibility = weaponRoot?.visible ?? true;
    if (weaponRoot) weaponRoot.visible = !immediate;
    return true;
  }
  function consumeGrenadeRelease(target = new THREE.Vector3()) {
    if (!throwPending || disposed) return null;
    throwPending = false;
    const source = heldObjectAnchor ?? weaponSocket;
    source.updateWorldMatrix(true, false); return source.getWorldPosition(target);
  }
  function throwPoseAt(time) {
    // The archive has no throw clip. These authored key poses act on its real
    // shoulder/elbow/wrist bones; the original character geometry stays intact.
    const h = (options.height ?? 1.8) / 1.8;
    const keys = [[0, throwHandRest], [.16, new THREE.Vector3(-.06, .10, .18).multiplyScalar(h)],
      [.34, new THREE.Vector3(-.10, .24, -.27).multiplyScalar(h)],
      [throwRelease, new THREE.Vector3(.06, .13, .48).multiplyScalar(h)],
      [.64, new THREE.Vector3(.06, -.12, .43).multiplyScalar(h)], [throwDuration, throwHandRest]];
    let i = 0; while (i < keys.length - 2 && time > keys[i + 1][0]) i++;
    const t = THREE.MathUtils.clamp((time - keys[i][0]) / (keys[i + 1][0] - keys[i][0]), 0, 1), smooth = t * t * (3 - 2 * t);
    const offset = keys[i][1].clone().lerp(keys[i + 1][1], smooth);
    for (const id of [10, 12, 14]) throwPose.set(id, bones.get(id).quaternion.clone());
    group.updateMatrixWorld(true);
    const shoulder = bones.get(10), elbow = bones.get(12), wrist = bones.get(14);
    const s = shoulder.getWorldPosition(new THREE.Vector3()), e = elbow.getWorldPosition(new THREE.Vector3()), w = wrist.getWorldPosition(new THREE.Vector3());
    const target = group.localToWorld(group.worldToLocal(s.clone()).add(offset));
    const l1 = s.distanceTo(e), l2 = e.distanceTo(w), axis = target.clone().sub(s), d = THREE.MathUtils.clamp(axis.length(), .03, l1 + l2 - .005);
    axis.normalize(); target.copy(s).addScaledVector(axis, d);
    const pole = new THREE.Vector3(-1, .10, -.12).transformDirection(group.matrixWorld);
    pole.addScaledVector(axis, -pole.dot(axis)).normalize();
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), elbowTarget = s.clone().addScaledVector(axis, a).addScaledVector(pole, Math.sqrt(Math.max(0, l1 * l1 - a * a)));
    const aimBone = (bone, child, point) => {
      const origin = bone.getWorldPosition(new THREE.Vector3()), from = child.getWorldPosition(new THREE.Vector3()).sub(origin).normalize(), to = point.clone().sub(origin).normalize();
      const worldQ = new THREE.Quaternion().setFromUnitVectors(from, to).multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
      bone.quaternion.copy(bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(worldQ));
      bone.updateWorldMatrix(true, true);
    };
    aimBone(shoulder, elbow, elbowTarget); aimBone(elbow, wrist, target);
    const ease = (a, b) => { const v = THREE.MathUtils.clamp((time - a) / (b - a), 0, 1); return v * v * (3 - 2 * v); };
    const weight = ease(0, .12) * (1 - ease(.85, throwDuration));
    for (const [id, base] of throwPose) bones.get(id).quaternion.copy(base.clone().slerp(bones.get(id).quaternion, weight));
    group.updateMatrixWorld(true);
  }
  function walkingPhase(clip) {
    let bestScore = Infinity, bestTime = 0, offset = 0;
    for (let i = 0; i < clip.length; i++) {
      const frame = clip[i], following = clip[(i + 1) % clip.length];
      for (let sample = 0; sample < 4; sample++) {
        const blend = sample / 4;
        let score = 0;
        for (const id of [4, 5, 6, 7, 8, 9]) {
          targetRotation.copy(frame.rotations.get(id)).slerp(following.rotations.get(id), blend);
          score += 1 - Math.abs(targetRotation.dot(bones.get(id).quaternion));
        }
        if (score < bestScore) {
          bestScore = score;
          bestTime = offset + blend * frame.duration;
        }
      }
      offset += frame.duration;
    }
    return bestTime;
  }

  function update(dt, state = false, dead = false) {
    if (disposed) return;
    const s = typeof state === 'object' ? state : { moving: state, dead };
    restoreThrowPose();
    if (s.dead) cancelGrenadeThrow();
    const suffix = { back: 'b', left: 'l', right: 'r', forward: 'f' }[s.direction] ?? 'f';
    const next = s.dead ? 'death' : s.airborne ? 'inair' : s.crouching ? 'duck' : s.moving ? `${s.running === false ? 'move' : 'run'}${suffix}` : 'stand';
    const clip = (s.enhanced ? enhancedClips : clips)[next] ?? clips.stand;
    if (!clip?.length) return;
    const step = Math.max(0, Math.min(dt, 0.1));
    if (next !== clipName) {
      // The walk and run clips put the feet at different points in the
      // stride. On sprint release, continue from the closest walking pose.
      elapsed = clipName === `run${suffix}` && next === `move${suffix}` ? walkingPhase(clip) : step;
      clipName = next;
    } else elapsed += step;
    // Keep the stock idle rhythm with a small motion around its opening
    // pose so the torso and gun stay steady in Enhanced.
    const quietIdle = s.enhanced && clipName === 'stand' && stand;
    const duration = clip.reduce((sum, frame) => sum + frame.duration, 0);
    const holdLast = clipName === 'death' || (s.enhanced && clipName === 'inair');
    let time = holdLast ? Math.min(elapsed, duration - 0.00001) : elapsed % duration;
    let index = 0;
    while (index < clip.length - 1 && time >= clip[index].duration) time -= clip[index++].duration;
    const current = clip[index];
    const nextFrame = clip[holdLast ? Math.min(index + 1, clip.length - 1) : (index + 1) % clip.length];
    const blend = time / current.duration;
    const poseWeight = 1 - Math.exp(-dt * (s.enhanced && s.moving ? 32 : 20));
    for (const [id, bone] of bones) {
      targetRotation.copy(current.rotations.get(id)).slerp(nextFrame.rotations.get(id), blend);
      if (quietIdle) targetRotation.slerp(stand.rotations.get(id), .8);
      bone.quaternion.slerp(targetRotation, poseWeight);
    }
    if (throwTime >= 0) {
      throwTime = Math.min(throwDuration, throwTime + Math.max(0, Math.min(dt, .1)));
      throwPoseAt(throwTime);
      if (!throwReleased && throwTime >= throwRelease) { throwReleased = throwPending = true; if (weaponRoot) weaponRoot.visible = false; }
      if (throwTime >= throwDuration) { restoreThrowPose(); throwTime = -1; if (weaponRoot) weaponRoot.visible = throwWeaponVisibility; }
    }
    if (s.dead || s.crouching) {
      // ch_animation contains joint rotations only. Settle the rotated body
      // onto the caller's ground height instead of leaving the corpse at the
      // standing hip height. Mesh bounding boxes are cached by Three.js.
      group.updateMatrixWorld(true);
      if (visualBoundsMeshes?.length) {
        animatedBounds.makeEmpty();
        for (const mesh of visualBoundsMeshes) {
          if (!mesh.visible || !mesh.geometry) continue;
          const support = mesh.geometry.userData.enhancedBoundsPoints;
          if (support) {
            for (let i = 0; i < support.length; i += 3) animatedBounds.expandByPoint(supportPoint.fromArray(support, i).applyMatrix4(mesh.matrixWorld));
          } else {
            if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
            animatedBounds.union(partWorldBounds.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
          }
        }
        if (animatedBounds.isEmpty()) animatedBounds.setFromObject(rig);
      } else animatedBounds.setFromObject(rig);
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
    skinBasis,
    setVisualBoundsMeshes(value = null) { visualBoundsMeshes = value; },
    height: options.height ?? 1.8,
    weaponSocket,
    attachWeapon,
    setWeaponGripOffset,
    getWeaponGripOffset: () => gripOffset.clone(),
    weaponMuzzlePosition,
    beginGrenadeThrow,
    consumeGrenadeRelease,
    cancelGrenadeThrow,
    get grenadeThrow() { return { active: throwTime >= 0, time: Math.max(0, throwTime), progress: throwTime < 0 ? 0 : throwTime / throwDuration, released: throwReleased, releaseAt: throwRelease, duration: throwDuration }; },
    update,
    // Mesh geometry/materials are owned by the shared asset loader. Do not
    // dispose them when removing one enemy that shares them with other actors.
    dispose() { cancelGrenadeThrow(); disposed = true; group.removeFromParent(); },
  };
}
