/** Original-game ammo remains a single shared total. Magazine values below are
 * measured in that same unit (a grenade costs five, a big-gun shot three).
 * Reloading changes access to that pool, never creates or removes ammunition. */
export const COMBAT_WEAPONS = Object.freeze([
  Object.freeze({ capacity: 12, cost: 1, interval: 0.3, reload: 1.25, kick: 0.023, yawKick: 0.005, spread: 0.011, aimedSpread: 0.002 }),
  Object.freeze({ capacity: 30, cost: 1, interval: 0.1, reload: 1.75, kick: 0.015, yawKick: 0.007, spread: 0.017, aimedSpread: 0.0035 }),
  Object.freeze({ capacity: 5, cost: 5, interval: 1, reload: 1.1, kick: 0, yawKick: 0, spread: 0, aimedSpread: 0 }),
  Object.freeze({ capacity: 9, cost: 3, interval: 0.65, reload: 2.1, kick: 0.047, yawKick: 0.009, spread: 0.014, aimedSpread: 0.003 }),
]);

const totalAmmo = value => Math.max(0, Math.floor(Number.isFinite(Number(value)) ? Number(value) : 0));
const bounded = (value, low, high) => Math.max(low, Math.min(high, value));
const weaponIndex = value => Number.isInteger(value) && value >= 0 && value < COMBAT_WEAPONS.length ? value : 0;

// Exact critically damped spring: stable even after a slow frame, no wall clock.
function spring(position, velocity, frequency, dt) {
  const decay = Math.exp(-frequency * dt), slope = velocity + frequency * position;
  return [(position + slope * dt) * decay, (velocity - frequency * slope * dt) * decay];
}

export class CombatController {
  constructor({ random = Math.random } = {}) {
    this.random = random;
    this.recoil = { pitch: 0, yaw: 0 };
    this._recoilVelocity = { pitch: 0, yaw: 0 };
    this.reset();
  }

  reset({ ammo = 120, weapon = 0 } = {}) {
    this.weapon = weaponIndex(weapon);
    this.ammo = totalAmmo(ammo);
    this._magazines = COMBAT_WEAPONS.map(spec => Math.min(spec.capacity, Math.floor(this.ammo / spec.cost) * spec.cost));
    this.cooldown = 0;
    this._cadenceCredit = 0;
    this.ads = 0;
    this.sprinting = this.moving = false;
    this.grounded = true;
    this._paused = false;
    this._sprintRecovery = 0;
    this._reloadElapsed = 0;
    this._reloadWeapon = null;
    this._bloom = 0;
    this.recoil.pitch = this.recoil.yaw = 0;
    this._recoilVelocity.pitch = this._recoilVelocity.yaw = 0;
    return this;
  }

  get spec() { return COMBAT_WEAPONS[this.weapon]; }
  get capacity() { return this.spec.capacity; }
  get magazine() { return Math.min(this._magazines[this.weapon], Math.floor(this.ammo / this.spec.cost) * this.spec.cost); }
  get reloading() { return this._reloadWeapon !== null; }
  get reloadProgress() { return this.reloading ? bounded(this._reloadElapsed / this.spec.reload, 0, 1) : 0; }
  get spread() {
    return (this.spec.spread * (1 - this.ads) + this.spec.aimedSpread * this.ads)
      * (this.moving ? 1.35 : 1) * (this.grounded ? 1 : 2.2) + this._bloom;
  }
  reserve(total = this.ammo) { return Math.max(0, totalAmmo(total) - Math.min(this.magazine, totalAmmo(total))); }

  setAmmo(total) {
    this.ammo = totalAmmo(total);
    // A pickup fills reserve only. Decreasing the shared pool also caps the
    // magazines of inactive weapons, so switching can never resurrect rounds.
    for (let i = 0; i < this._magazines.length; i++) {
      const cost = COMBAT_WEAPONS[i].cost;
      this._magazines[i] = Math.min(this._magazines[i], Math.floor(this.ammo / cost) * cost);
    }
    return this;
  }

  setWeapon(index) {
    const selected = weaponIndex(index);
    if (selected === this.weapon) return this;
    this.cancelReload();
    this.weapon = selected;
    this.ads = 0;
    // Keep the remaining fire cooldown: fast weapon switching is not a fire-rate exploit.
    this._sprintRecovery = Math.max(this._sprintRecovery, 0.12);
    return this;
  }

  reload(ammo = this.ammo) {
    this.setAmmo(ammo);
    if (this._paused || this.sprinting || this.reloading || this.magazine >= this.capacity
      || this.ammo - this.magazine < this.spec.cost) return false;
    this._reloadWeapon = this.weapon;
    this._reloadElapsed = 0;
    return true;
  }

  cancelReload() {
    this._reloadWeapon = null;
    this._reloadElapsed = 0;
    return this;
  }

  /** Call once per simulation frame. paused:true freezes every timer/spring. */
  update(dt, { aiming = false, sprinting = false, moving = false, grounded = true, paused = false } = {}) {
    this._paused = Boolean(paused);
    if (this._paused) return this;
    const seconds = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.moving = Boolean(moving);
    this.grounded = Boolean(grounded);
    const sprint = Boolean(sprinting && moving);
    if (sprint) {
      this.cancelReload();
      this._sprintRecovery = 0.14;
    } else this._sprintRecovery = Math.max(0, this._sprintRecovery - seconds);
    this.sprinting = sprint;
    // Carry only this frame's boundary overshoot into a continuous burst.
    // A later idle frame discards it, so returning from a pause never bursts.
    this._cadenceCredit = this.cooldown > 0 && this.cooldown <= seconds + 1e-8
      ? Math.min(Math.max(0, seconds - this.cooldown), this.spec.interval * 0.5) : 0;
    this.cooldown = Math.max(0, this.cooldown - seconds);
    if (this.reloading) {
      this._reloadElapsed += seconds;
      if (this._reloadElapsed + 1e-8 >= this.spec.reload) {
        this._magazines[this.weapon] = Math.min(this.capacity, Math.floor(this.ammo / this.spec.cost) * this.spec.cost);
        this.cancelReload();
      }
    }
    const targetAds = aiming && !this.sprinting && !this.reloading ? 1 : 0;
    this.ads += (targetAds - this.ads) * (1 - Math.exp(-seconds * (targetAds ? 14 : 19)));
    if (Math.abs(this.ads - targetAds) < 0.0001) this.ads = targetAds;
    for (const axis of ['pitch', 'yaw']) {
      [this.recoil[axis], this._recoilVelocity[axis]] = spring(this.recoil[axis], this._recoilVelocity[axis], 19, seconds);
    }
    this._bloom *= Math.exp(-seconds * 7);
    return this;
  }

  /** Successful calls debit this.ammo and kick recoil. Assign result.ammo to
   * the game's total, or subtract result.cost exactly once in the caller. */
  tryFire(ammo = this.ammo) {
    this.setAmmo(ammo);
    let reason = null;
    if (this._paused) reason = 'paused';
    else if (this.sprinting || this._sprintRecovery > 1e-8) reason = 'sprinting';
    else if (this.reloading) reason = 'reloading';
    else if (this.cooldown > 1e-8) reason = 'cooldown';
    else if (this.ammo < this.spec.cost) reason = 'empty';
    else if (this.magazine < this.spec.cost) reason = 'reload';
    if (reason) return { fired: false, reason, cost: 0, ammo: this.ammo, weapon: this.weapon, spread: this.spread };
    const { cost, interval } = this.spec;
    const spread = this.spread;
    this._magazines[this.weapon] -= cost;
    this.setAmmo(this.ammo - cost);
    this.cooldown = interval - this._cadenceCredit;
    this._cadenceCredit = 0;
    this.onShot();
    return { fired: true, reason: null, cost, ammo: this.ammo, weapon: this.weapon, spread };
  }

  /** Return an unthrown grenade reserved by tryFire. Other weapons cannot
   * refill their magazines through this path; the caller owns one pending throw. */
  returnGrenade(ammo = this.ammo) {
    const spec = COMBAT_WEAPONS[2];
    this.setAmmo(totalAmmo(ammo) + spec.cost);
    this._magazines[2] = Math.min(spec.capacity, this._magazines[2] + spec.cost);
    return this.ammo;
  }

  /** Usually called by tryFire; exposed for an external scripted shot. */
  onShot() {
    const multiplier = 1 - this.ads * 0.25;
    const pitch = this.spec.kick * multiplier;
    const yaw = (bounded(Number(this.random()) || 0, 0, 1) * 2 - 1) * this.spec.yawKick * multiplier;
    this.recoil.pitch = Math.min(0.13, this.recoil.pitch + pitch);
    this.recoil.yaw = bounded(this.recoil.yaw + yaw, -0.045, 0.045);
    this._recoilVelocity.pitch += pitch * 7;
    this._bloom = Math.min(0.018, this._bloom + this.spec.spread * 0.14);
    return this;
  }
}
