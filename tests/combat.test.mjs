import test from 'node:test';
import assert from 'node:assert/strict';
import { CombatController, COMBAT_WEAPONS } from '../js/combat.js';

const controller = options => new CombatController({ random: () => 0.75, ...options });
const settle = (combat, seconds, state = {}) => combat.update(seconds, state);

test('all four weapons debit the legacy shared ammo exactly once and cannot fire without a full cost', () => {
  for (let weapon = 0; weapon < 4; weapon++) {
    const combat = controller().reset({ weapon, ammo: 13 });
    const { cost, interval } = COMBAT_WEAPONS[weapon];
    const shot = combat.tryFire(13);
    assert.equal(shot.fired, true);
    assert.equal(shot.cost, cost);
    assert.equal(shot.ammo, 13 - cost);
    assert.equal(combat.ammo, shot.ammo);
    assert.equal(combat.magazine, Math.min(COMBAT_WEAPONS[weapon].capacity, Math.floor(13 / cost) * cost) - cost);
    const blocked = combat.tryFire();
    assert.equal(blocked.fired, false);
    assert.equal(blocked.reason, 'cooldown');
    assert.equal(combat.ammo, 13 - cost);
    settle(combat, interval);
    combat.setAmmo(cost - 1);
    assert.equal(combat.tryFire().reason, 'empty');
    assert.equal(combat.magazine, 0);
  }
});

test('reload transfers access to existing reserve, never creates ammo, and repeats cannot restore spent rounds', () => {
  const combat = controller().reset({ ammo: 15 });
  for (let shot = 0; shot < 12; shot++) {
    assert.equal(combat.tryFire().fired, true);
    settle(combat, 0.3);
  }
  assert.equal(combat.ammo, 3);
  assert.equal(combat.magazine, 0);
  assert.equal(combat.reserve(), 3);
  assert.equal(combat.tryFire().reason, 'reload');
  assert.equal(combat.reload(), true);
  settle(combat, 0.5);
  assert.equal(combat.magazine, 0);
  assert.equal(combat.ammo, 3);
  assert.ok(combat.reloadProgress > 0 && combat.reloadProgress < 1);
  assert.equal(combat.tryFire().reason, 'reloading');
  settle(combat, 0.75);
  assert.equal(combat.reloading, false);
  assert.equal(combat.magazine, 3);
  assert.equal(combat.reserve(), 0);
  assert.equal(combat.ammo, 3);
  assert.equal(combat.reload(), false);
  for (let shot = 0; shot < 3; shot++) { assert.equal(combat.tryFire().fired, true); settle(combat, 0.3); }
  assert.equal(combat.ammo, 0);
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(combat.reload(), false); settle(combat, 10); assert.equal(combat.tryFire().fired, false);
  }
  combat.setAmmo(20);
  assert.equal(combat.magazine, 0, 'a pickup adds reserve; it does not silently refill the gun');
  assert.equal(combat.reload(), true); settle(combat, 1.25);
  assert.equal(combat.magazine, 12); assert.equal(combat.reserve(), 8); assert.equal(combat.ammo, 20);
});

test('switching preserves each magazine, cancels unfinished reload, and preserves fire cooldown', () => {
  const combat = controller();
  assert.equal(combat.tryFire().fired, true);
  combat.setWeapon(1);
  assert.equal(combat.magazine, 30);
  settle(combat, 0.15);
  assert.equal(combat.tryFire().reason, 'cooldown');
  settle(combat, 0.15); assert.equal(combat.tryFire().fired, true);
  combat.setWeapon(0); settle(combat, 0.2);
  assert.equal(combat.magazine, 11);
  assert.equal(combat.reload(), true); settle(combat, 0.6);
  combat.setWeapon(1);
  assert.equal(combat.reloading, false);
  assert.equal(combat.magazine, 29);
  combat.setWeapon(0); settle(combat, 3);
  assert.equal(combat.magazine, 11);
});

test('pause freezes reload, cadence and recoil; leaving sprint has a short recovery before firing', () => {
  const combat = controller();
  combat.tryFire();
  assert.equal(combat.reload(), true);
  settle(combat, 0.25);
  const before = { cooldown: combat.cooldown, progress: combat.reloadProgress, recoil: { ...combat.recoil } };
  settle(combat, 500, { paused: true });
  assert.equal(combat.cooldown, before.cooldown);
  assert.equal(combat.reloadProgress, before.progress);
  assert.deepEqual(combat.recoil, before.recoil);
  assert.equal(combat.tryFire().reason, 'paused');
  settle(combat, 0.1, { moving: true, sprinting: true, aiming: true });
  assert.equal(combat.reloading, false);
  assert.equal(combat.ads, 0);
  assert.equal(combat.tryFire().reason, 'sprinting');
  settle(combat, 0.1);
  assert.equal(combat.tryFire().reason, 'sprinting');
  settle(combat, 0.05);
  assert.equal(combat.tryFire().fired, true);
});

test('automatic cadence is the same at 30, 60 and 120 FPS without burst catch-up after pauses', () => {
  for (const fps of [30, 60, 120]) {
    const combat = controller().reset({ ammo: 120, weapon: 1 });
    let shots = 0;
    for (let frame = 0; frame < fps * 2; frame++) {
      if (combat.tryFire().fired) shots++;
      settle(combat, 1 / fps);
    }
    assert.equal(shots, 20, `${fps} FPS`);
    settle(combat, 300, { paused: true });
    settle(combat, 0);
    assert.equal(combat.tryFire().fired, true);
    assert.equal(combat.tryFire().reason, 'cooldown');
  }
});

test('ADS narrows spread and spring recoil returns to neutral independently of frame rate', () => {
  const coarse = controller(), fine = controller();
  const hipSpread = coarse.spread;
  settle(coarse, 1, { aiming: true });
  assert.equal(coarse.ads, 1);
  assert.ok(coarse.spread < hipSpread * 0.3);
  coarse.reset(); fine.reset(); coarse.tryFire(); fine.tryFire();
  assert.ok(coarse.recoil.pitch > 0); assert.ok(coarse.recoil.yaw > 0);
  settle(coarse, 1);
  for (let step = 0; step < 60; step++) settle(fine, 1 / 60);
  assert.ok(Math.abs(coarse.recoil.pitch - fine.recoil.pitch) < 1e-12);
  assert.ok(coarse.recoil.pitch < 0.0001);
  assert.ok(Number.isFinite(coarse.spread));
});

test('an interrupted grenade returns its reserved round without refilling other magazines or resetting cooldown', () => {
  const combat = controller().reset({ ammo: 30, weapon: 0 });
  combat.tryFire();
  const pistol = combat.magazine;
  combat.setWeapon(2); settle(combat, 1);
  const shot = combat.tryFire();
  assert.equal(shot.fired, true);
  assert.equal(combat.magazine, 0);
  assert.ok(Math.abs(combat.recoil.pitch) < 1e-6);
  const cooldown = combat.cooldown;
  assert.equal(combat.returnGrenade(shot.ammo), 29);
  assert.equal(combat.magazine, 5);
  assert.equal(combat.cooldown, cooldown);
  combat.setWeapon(0);
  assert.equal(combat.magazine, pistol);
});
