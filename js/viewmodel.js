import * as THREE from 'three';

const WEAPONS = [
  { path: 'models/weapons/weaponpistol.3ds', length: 0.39 },
  { path: 'models/weapons/weaponrifle.3ds', length: 0.65 },
  { path: 'models/weapons/granate.3ds', length: 0.19 },
  { path: 'models/weapons/weaponrifle2.3ds', length: 0.67 },
];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const smooth = (value, target, rate, dt) => value + (target - value) * (1 - Math.exp(-rate * dt));
const UP = new THREE.Vector3(0, 1, 0);
const ADS_CLEARANCE = 0.035;

function flashTexture() {
  const size = 64, pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x + 0.5 - size / 2) / (size / 2), dy = (y + 0.5 - size / 2) / (size / 2);
    const radius = Math.hypot(dx, dy), angle = Math.atan2(dy, dx);
    const star = Math.pow(Math.max(0, 1 - radius / (0.38 + 0.42 * Math.pow(Math.abs(Math.cos(angle * 3)), 10))), 1.4);
    const glow = Math.max(0, 1 - radius) ** 4, alpha = Math.min(1, star + glow * 0.6);
    const offset = (y * size + x) * 4;
    pixels[offset] = 255; pixels[offset + 1] = 150 + Math.round(glow * 105); pixels[offset + 2] = 35 + Math.round(glow * 200); pixels[offset + 3] = Math.round(alpha * 255);
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Original weapon meshes with our own small glove/forearm meshes. Camera space
 * uses -Z forward. Add group to the camera, and the camera to the scene.
 * Shared asset geometry/textures are retained; overlay materials are private. */
export class ProceduralViewmodel {
  constructor({ assets, onError = () => {} }) {
    this.assets = assets;
    this.onError = onError;
    this.group = new THREE.Group();
    this.group.name = 'first-person-weapons';
    this.group.userData.graphicsOwned = true;
    this.group.visible = false;
    this.mount = new THREE.Group();
    this.group.add(this.mount);
    this.weapon = 0;
    this._generation = 0;
    this._disposed = false;
    this._visible = true;
    this._model = null;
    this._modelMaterials = new Set();
    this._ownedGeometry = new Set();
    this._ownedMaterials = new Set();
    this._muzzle = new THREE.Vector3(0, 0, -0.3);
    this._hip = new THREE.Vector3(0.21, -0.205, -0.38);
    this._aim = new THREE.Vector3(0, -0.07, -0.38);
    this._position = this._hip.clone();
    this._rotation = new THREE.Vector3();
    this._aimAmount = 0;
    this._sprintAmount = 0;
    this._bob = 0;
    this._phase = 0;
    this._swayX = this._swayY = this._landing = 0;
    this._lastGrounded = true;
    this._makeHands();
    this._flashTexture = flashTexture();
    this._flashTexture.userData.graphicsOwned = true;
    this._flashes = Array.from({ length: 3 }, () => {
      const material = new THREE.SpriteMaterial({ map: this._flashTexture, color: 0xffe2ad, transparent: true,
        blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
      const sprite = new THREE.Sprite(material);
      sprite.userData.graphicsOwned = true;
      sprite.renderOrder = 10030;
      sprite.visible = false;
      this.mount.add(sprite);
      return { sprite, life: 0 };
    });
    this._flashCursor = 0;
    this.update(0, {});
  }

  _material(color, roughness = 0.82) {
    const material = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.04, emissive: 0x070909,
      transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
    this._ownedMaterials.add(material);
    return material;
  }

  _makeHands() {
    const rubber = this._material(0x171b1d), fabric = this._material(0x282d2b), cuff = this._material(0x3b4138);
    const sphere = new THREE.SphereGeometry(1, 12, 8), cylinder = new THREE.CylinderGeometry(0.82, 1, 1, 12), box = new THREE.BoxGeometry(1, 1, 1);
    for (const geometry of [sphere, cylinder, box]) this._ownedGeometry.add(geometry);
    const mesh = (parent, geometry, material, position, scale, order = 10010) => {
      const object = new THREE.Mesh(geometry, material);
      object.userData.graphicsOwned = true;
      object.position.set(...position); object.scale.set(...scale); object.renderOrder = order; object.frustumCulled = false;
      parent.add(object); return object;
    };
    const limb = (parent, from, to, radius, material) => {
      const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to), direction = b.clone().sub(a);
      const object = mesh(parent, cylinder, material, a.clone().add(b).multiplyScalar(0.5).toArray(), [radius, direction.length(), radius]);
      object.quaternion.setFromUnitVectors(UP, direction.normalize());
      return object;
    };
    const hand = side => {
      const root = new THREE.Group();
      root.name = side > 0 ? 'right-gloved-hand' : 'left-gloved-hand';
      this.mount.add(root);
      // Soft volumes form a closed glove around the original weapon grip.
      mesh(root, sphere, fabric, [0, 0, 0], [0.039, 0.031, 0.052]);
      mesh(root, sphere, rubber, [0, 0.021, -0.006], [0.035, 0.015, 0.043]);
      for (let finger = 0; finger < 4; finger++) {
        const z = -0.037 + finger * 0.020;
        mesh(root, sphere, rubber, [-side * 0.026, 0.015, z], [0.016, 0.015, 0.010]);
        mesh(root, sphere, fabric, [-side * 0.027, -0.005, z - 0.002], [0.013, 0.022, 0.010]);
      }
      const thumb = mesh(root, sphere, fabric, [side * 0.034, 0.005, -0.015], [0.015, 0.022, 0.030]);
      thumb.rotation.z = side * 0.6;
      limb(root, [0.006 * side, -0.014, 0.044], [0.095 * side, -0.16, 0.20], 0.039, fabric);
      limb(root, [0.079 * side, -0.13, 0.17], [0.16 * side, -0.27, 0.29], 0.049, cuff);
      const strap = mesh(root, box, rubber, [0.011 * side, -0.020, 0.052], [0.082, 0.026, 0.038]);
      strap.rotation.x = -0.35;
      mesh(root, box, cuff, [0.023 * side, -0.025, 0.068], [0.023, 0.014, 0.009]);
      return root;
    };
    this.rightHand = hand(1);
    this.leftHand = hand(-1);
    this.rightHand.position.set(0.004, -0.034, 0.012);
    this.rightHand.rotation.set(-0.15, 0, -0.1);
    this.leftHand.position.set(-0.045, -0.05, -0.015);
    this.leftHand.rotation.set(-0.15, -0.3, 0.3);
  }

  _releaseModel() {
    this._model?.removeFromParent();
    this._model = null;
    for (const material of this._modelMaterials) material.dispose();
    this._modelMaterials.clear();
  }

  async setWeapon(index) {
    const selected = Number.isInteger(index) && WEAPONS[index] ? index : 0;
    const token = ++this._generation;
    try {
      const spec = WEAPONS[selected];
      const model = await this.assets.model(spec.path, true);
      if (this._disposed || token !== this._generation) return false;
      // The asset wrapper may already have converted this mesh to PBR and
      // cached its world-material state. Mark the camera-owned objects before
      // installing our overlay copies so scene/quality refreshes leave them
      // alone. A flag on the parent is insufficient for Scene.traverse().
      model.traverse(object => {
        if (!object.isMesh && !object.isSprite) return;
        object.userData.graphicsOwned = true;
        object.castShadow = object.receiveShadow = false;
      });
      model.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(model), size = bounds.getSize(new THREE.Vector3());
      if (!Number.isFinite(size.x) || size.x < 0.0001) throw new Error('Пустая модель оружия');
      const grip = new THREE.Vector3(bounds.min.x + size.x * 0.18, (bounds.min.y + bounds.max.y) / 2, bounds.min.z + size.z * 0.35);
      // Average the actual foremost vertices, not the box corner: this tracks
      // the barrel height of each original model when aligning ADS and flash.
      const muzzleRaw = new THREE.Vector3(), point = new THREE.Vector3();
      let muzzleVertices = 0;
      model.traverse(object => {
        if (!object.isMesh) return;
        const positions = object.geometry.getAttribute('position');
        for (let vertex = 0; vertex < positions.count; vertex++) {
          point.fromBufferAttribute(positions, vertex).applyMatrix4(object.matrixWorld);
          if (point.x >= bounds.max.x - size.x * 0.025) { muzzleRaw.add(point); muzzleVertices++; }
        }
      });
      if (muzzleVertices) muzzleRaw.divideScalar(muzzleVertices);
      else muzzleRaw.set(bounds.max.x, grip.y, grip.z);
      const rotation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
        new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)));
      const scalar = spec.length / size.x;
      const holder = new THREE.Group();
      holder.name = 'original-viewmodel-weapon';
      model.position.sub(grip);
      holder.add(model); holder.quaternion.copy(rotation); holder.scale.setScalar(scalar);
      // A weapon's rear sight/casing can sit above its barrel. Keep the whole
      // normalized silhouette below the reticle, not just the muzzle center.
      // Measure before attaching to the moving mount so this remains local.
      const weaponBounds = new THREE.Box3().setFromObject(holder);
      const materials = new Map();
      model.traverse(object => {
        if (!object.isMesh) return;
        const overlayMaterial = original => {
          if (!materials.has(original)) {
            const material = original.clone();
            material.depthTest = false; material.depthWrite = false; material.transparent = true;
            material.fog = false; material.toneMapped = false;
            materials.set(original, material);
          }
          return materials.get(original);
        };
        object.material = Array.isArray(object.material) ? object.material.map(overlayMaterial) : overlayMaterial(object.material);
        object.renderOrder = 10020; object.frustumCulled = false;
      });
      this._releaseModel();
      this._model = holder;
      this._modelMaterials = new Set(materials.values());
      this.mount.add(holder);
      this.weapon = selected;
      this._muzzle.copy(muzzleRaw).sub(grip).multiplyScalar(scalar).applyQuaternion(rotation);
      this._aim.set(-this._muzzle.x, -weaponBounds.max.y - ADS_CLEARANCE, -0.38);
      this._hip.set(selected === 2 ? 0.22 : 0.21, selected === 2 ? -0.18 : -0.205, selected === 2 ? -0.42 : -0.38);
      this.leftHand.visible = selected !== 2;
      this.leftHand.position.set(-0.045, -0.05, selected === 0 ? -0.015 : -0.28);
      this.group.visible = this._visible;
      this._position.copy(this._hip);
      return true;
    } catch (error) {
      if (!this._disposed && token === this._generation) this.onError('Не удалось загрузить оружие от первого лица: ' + error.message, error);
      return false;
    }
  }

  setVisible(visible) { this._visible = Boolean(visible); this.group.visible = this._visible && Boolean(this._model) && !this._disposed; return this; }

  update(dt, { speed = 0, sprinting = false, aiming = 0, reloadProgress = 0, reloading = false,
    recoil = {}, movementX = 0, movementY = 0, grounded = true, landing = 0 } = {}) {
    if (this._disposed) return this;
    const seconds = clamp(finite(dt), 0, 0.25), aimTarget = clamp(Number(aiming) || 0, 0, 1);
    this._aimAmount = smooth(this._aimAmount, sprinting || reloading ? 0 : aimTarget, 18, seconds);
    this._sprintAmount = smooth(this._sprintAmount, sprinting ? 1 : 0, 13, seconds);
    const walk = clamp(Math.abs(finite(speed)) / 4.3, 0, 1.8) * (grounded ? 1 : 0);
    this._bob = smooth(this._bob, walk, 10, seconds);
    this._phase += seconds * (sprinting ? 13 : 9) * Math.max(0.25, walk);
    const lookX = clamp(finite(movementX) * 0.0018, -0.07, 0.07), lookY = clamp(finite(movementY) * 0.0018, -0.05, 0.05);
    this._swayX = smooth(this._swayX, lookX, 15, seconds);
    this._swayY = smooth(this._swayY, lookY, 15, seconds);
    if ((!this._lastGrounded && grounded) || landing) this._landing = Math.max(this._landing, clamp(finite(landing) || 0.7, 0, 1.5));
    this._lastGrounded = Boolean(grounded);
    this._landing *= Math.exp(-seconds * 10);
    const aim = this._aimAmount, sprint = this._sprintAmount, bob = this._bob * (1 - aim * 0.94);
    const reload = reloading ? Math.sin(Math.PI * clamp(finite(reloadProgress), 0, 1)) : 0;
    const recoilPitch = clamp(finite(recoil.pitch), -0.1, 0.2), recoilYaw = clamp(finite(recoil.yaw), -0.1, 0.1);
    const x = this._hip.x * (1 - aim) + this._aim.x * aim + Math.sin(this._phase) * 0.006 * bob - this._swayX * 0.13 * (1 - aim * 0.8) - sprint * 0.08;
    const y = this._hip.y * (1 - aim) + this._aim.y * aim + Math.cos(this._phase * 2) * 0.005 * bob - this._landing * 0.022 - sprint * 0.11 - reload * 0.13;
    const z = this._hip.z * (1 - aim) + this._aim.z * aim + recoilPitch * 1.2 + sprint * 0.075 + reload * 0.10;
    this._position.set(smooth(this._position.x, x, 22, seconds), smooth(this._position.y, y, 22, seconds), smooth(this._position.z, z, 28, seconds));
    this.mount.position.copy(this._position);
    this._rotation.set(recoilPitch * 1.5 - this._swayY * (1 - aim * 0.85) - sprint * 0.30 - reload * 0.7,
      recoilYaw - this._swayX * (1 - aim * 0.85) + sprint * 0.35 + reload * 0.3,
      Math.sin(this._phase) * 0.014 * bob - sprint * 0.45 - reload * 0.55);
    this.mount.rotation.set(this._rotation.x, this._rotation.y, this._rotation.z);
    // Support hand leaves the fore-end during the middle of the reload.
    this.leftHand.position.y = -0.05 - reload * 0.15;
    this.leftHand.rotation.x = -0.15 + reload * 1.1;
    for (const flash of this._flashes) {
      flash.life = Math.max(0, flash.life - seconds);
      flash.sprite.visible = flash.life > 0;
      flash.sprite.material.opacity = clamp(flash.life / 0.045, 0, 1);
    }
    return this;
  }

  flash() {
    if (this._disposed || !this._model || this.weapon === 2) return false;
    const flash = this._flashes[this._flashCursor++ % this._flashes.length];
    flash.life = 0.045;
    flash.sprite.position.copy(this._muzzle); flash.sprite.position.z -= 0.012;
    flash.sprite.scale.setScalar(this.weapon === 3 ? 0.24 : this.weapon === 1 ? 0.17 : 0.13);
    flash.sprite.material.rotation = (this._flashCursor * 2.39996) % (Math.PI * 2);
    flash.sprite.material.opacity = 1; flash.sprite.visible = true;
    return true;
  }

  muzzleWorldPosition(target = new THREE.Vector3()) {
    this.group.updateWorldMatrix(true, true);
    return this.mount.localToWorld(target.copy(this._muzzle));
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true; this._generation++;
    this.group.removeFromParent(); this.group.visible = false;
    this._releaseModel();
    for (const geometry of this._ownedGeometry) geometry.dispose();
    for (const material of this._ownedMaterials) material.dispose();
    for (const { sprite } of this._flashes) sprite.material.dispose();
    this._flashTexture.dispose();
    this._ownedGeometry.clear(); this._ownedMaterials.clear();
  }
}
