import * as THREE from 'three';

const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const smooth = (from, to, value) => { const t = clamp((value - from) / (to - from)); return t * t * (3 - 2 * t); };
const pulse = (from, peak, to, value) => smooth(from, peak, value) * (1 - smooth(peak, to, value));

/** Small, authored layers over the original HSK clips. The app applies these
 * only in Enhanced. Original joint quaternions are restored exactly before the
 * next clip update, a character swap or reset; offsets never accumulate. */
export class MotionController {
  constructor() { this._poses = new WeakMap(); this._lastCharacter = null; this.reset(); }

  reset() {
    if (this._lastCharacter) this.prepare(this._lastCharacter);
    this.slideTime = this.slideCooldown = this.phase = this.speed = 0;
    this.crouched = this.sprinting = false;
    this.wasGrounded = true;
    this.landing = this.landingVelocity = this.bob = this.roll = this.lean = this.clock = 0;
    this.stance = this.gait = this.sprintBlend = this.inertia = this._bobOffset = 0;
    this._lastCharacter = null;
    return this;
  }

  get sliding() { return this.slideTime > 0; }
  get eyeHeight() { return 1.4 - this.stance * 0.38; }

  update(dt, { moving = false, sprinting = false, aiming = 0, crouchPressed = false,
    crouchHeld = false, grounded = true, verticalSpeed = 0, strafe = 0, paused = false } = {}) {
    if (paused) return this;
    dt = Math.min(0.1, Math.max(0, Number.isFinite(dt) ? dt : 0));
    this.clock += dt;
    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    if (crouchPressed && grounded && sprinting && this.speed > 5 && this.slideCooldown === 0) {
      this.slideTime = 0.72; this.slideCooldown = 1.2;
    }
    this.slideTime = Math.max(0, this.slideTime - dt);
    this.crouched = crouchHeld || this.sliding;
    this.sprinting = sprinting && moving && !this.crouched && aiming < 0.15;
    this.stance = damp(this.stance, this.crouched ? 1 : 0, this.sliding ? 17 : 12, dt);
    this.sprintBlend = damp(this.sprintBlend, this.sprinting ? 1 : 0, 10, dt);
    const previousSpeed = this.speed;
    const target = this.sliding ? 7 + 5 * this.slideTime / 0.72 : !moving ? 0
      : this.crouched ? 2.2 : this.sprinting ? 8.7 : 4.7 - clamp(aiming) * 2;
    this.speed = damp(this.speed, target, this.sliding ? 18 : moving ? 12 : 15, dt);
    const acceleration = dt > 0 ? (this.speed - previousSpeed) / dt : 0;
    this.inertia = damp(this.inertia, clamp(acceleration * 0.001, -0.025, 0.025), 10, dt);
    this.gait = damp(this.gait, grounded && moving && !this.sliding ? clamp(this.speed / 4.7, 0, 1.4) : 0, 9, dt);
    if (grounded && !this.wasGrounded) {
      // Keep a measured impact supplied by collision: the next update often
      // sees verticalSpeed=0 after collision has already stopped the fall.
      this.landingVelocity = Math.min(this.landingVelocity, -Math.min(0.9, Math.abs(verticalSpeed) * 0.055 + 0.12));
    }
    this.wasGrounded = grounded;
    const frequency = 12, slope = this.landingVelocity + frequency * this.landing, decay = Math.exp(-frequency * dt);
    this.landing = (this.landing + slope * dt) * decay;
    this.landingVelocity = (this.landingVelocity - frequency * slope * dt) * decay;
    this.phase += this.speed * dt * (2.6 - this.sprintBlend * 0.5);
    const step = Math.sin(this.phase * 2) + Math.sin(this.phase * 4) * 0.12;
    this._bobOffset = damp(this._bobOffset, step * (0.014 + this.sprintBlend * 0.010) * this.gait * (1 - clamp(aiming) * 0.78), 15, dt);
    this.bob = this._bobOffset;
    this.roll = damp(this.roll, this.sliding ? -0.045 : strafe * -0.011 + Math.sin(this.phase) * this.gait * 0.002, 11, dt);
    this.lean = damp(this.lean, strafe * -0.055, 10, dt);
    return this;
  }

  /** Restore the unmodified clip pose, even after thousands of updates. */
  prepare(character) {
    const prior = this._poses.get(character);
    if (prior) for (const [id, quaternion] of prior) character.bones.get(id)?.quaternion.copy(quaternion);
    this._poses.delete(character);
    if (this._lastCharacter === character) this._lastCharacter = null;
    return this;
  }

  apply(character, { aiming = 0, reloading = false, reloadProgress = 0, recoil = 0, moving = false } = {}) {
    if (!character?.bones) return this;
    if (this._lastCharacter && this._lastCharacter !== character) this.prepare(this._lastCharacter);
    this.prepare(character);
    const poses = new Map(), ads = clamp(aiming), time = clamp(reloadProgress);
    const breath = (Math.sin(this.clock * 1.65) + Math.sin(this.clock * 2.43) * 0.22) * 0.008 * (1 - ads * 0.5) * (moving ? 0.55 : 1);
    const gait = Math.sin(this.phase) * this.gait, settle = Math.sin(this.phase * 2) * this.gait;
    const reach = reloading ? pulse(0.04, 0.32, 0.80, time) : 0;
    const rack = reloading ? pulse(0.78, 0.87, 0.99, time) : 0;
    const add = (id, x, y, z) => {
      const bone = character.bones.get(id); if (!bone) return;
      poses.set(id, bone.quaternion.clone());
      bone.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z)));
    };
    // HSK: 18 chest, 2 head, 3 pelvis; 10/11 shoulders, 12/13 elbows,
    // 14/15 wrists. Legs retain the game's authored walking/running clips.
    add(18, this.sprintBlend * 0.065 + breath + this.inertia, this.lean * 0.20 + gait * 0.007, this.lean + recoil * 0.23);
    add(2, -breath * 0.5 - this.inertia * 0.45, -gait * 0.005, -this.lean * 0.40);
    add(3, -this.inertia * 0.3, -gait * 0.006, -this.lean * 0.20 + settle * 0.003);
    if (character.grenadeThrow?.active) { this._poses.set(character, poses); this._lastCharacter = character; return this; }
    add(10, -ads * 0.11 + reach * 0.10 + recoil * 0.72 + breath * 0.3, gait * 0.006, -this.sprintBlend * 0.075);
    add(11, -ads * 0.10 + reach * 0.43 + rack * 0.14, -gait * 0.006, -reach * 0.28);
    add(12, -breath * 0.4 + recoil * 0.20, 0, settle * 0.005);
    add(13, reach * 0.67 + rack * 0.35, reach * 0.08, 0);
    add(14, recoil * 0.18, 0, breath * 0.25);
    add(15, reach * 0.20 - rack * 0.14, 0, -reach * 0.15);
    this._poses.set(character, poses); this._lastCharacter = character;
    return this;
  }
}
