import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Vector3 } from 'three';
import { selectInteraction } from '../js/progression.js';

const manifest = JSON.parse(await readFile(new URL('../assets/manifest.json', import.meta.url), 'utf8'));
const item = entry => ({ entry, pos: new Vector3(entry.x / 100, entry.y / 100, entry.z / 100), collected: false });
const openWorld = { ray: () => null };

test('original level 1 and 9 medkits cannot mask their adjacent mandatory keys', () => {
  for (const [levelId, keyId, healthId] of [[1, 5, 95], [9, 5, 33]]) {
    const entities = manifest.levels.find(level => level.id === levelId).entities;
    const key = item(entities.find(entry => entry.id === keyId));
    const medkit = item(entities.find(entry => entry.id === healthId));
    assert.equal(medkit.entry.command, 'АПТЕЧКА');
    // Put the player closest to the real medkit, with both source coordinates
    // in range: this was the nearest-only selection's blocking arrangement.
    const feet = medkit.pos.clone().lerp(key.pos, 0.1); feet.y -= 0.9;
    assert.equal(selectInteraction([medkit, key], feet, openWorld, { health: 100, totalKeys: 1 }), key);
    assert.equal(selectInteraction([medkit, key], feet, openWorld, { health: 50, totalKeys: 1 }), key);
    key.collected = true;
    assert.equal(selectInteraction([medkit, key], feet, openWorld, { health: 100, collected: 1, totalKeys: 1 }), null);
    assert.equal(selectInteraction([medkit, key], feet, openWorld, { health: 50, collected: 1, totalKeys: 1 }), medkit);
  }
});

test('available key/exit outrank shops and supplies; locked exit never masks a key', () => {
  const make = (command, x) => item({ command, x: x * 100, y: 90, z: 0 });
  const key = make('GameKey', 2), exit = make('GameEnd', 0.1), shop = make('МАГАЗИН', 0.3), ammo = make('ПАТРОНЫ', 0.2);
  const feet = new Vector3();
  assert.equal(selectInteraction([exit, ammo, shop, key], feet, openWorld, { collected: 0, totalKeys: 1 }), key);
  key.collected = true;
  assert.equal(selectInteraction([exit, ammo, shop, key], feet, openWorld, { collected: 0, totalKeys: 1 }), shop);
  assert.equal(selectInteraction([exit, ammo, shop, key], feet, openWorld, { collected: 1, totalKeys: 1 }), exit);
});

test('range, line of sight, collected state and unknown commands still gate interactions', () => {
  const feet = new Vector3(), key = item({ command: 'GameKey', x: 100, y: 90, z: 0 });
  assert.equal(selectInteraction([key], feet, { ray: () => ({ distance: 0.5 }) }), null);
  key.pos.x = 2.8;
  assert.equal(selectInteraction([key], feet, openWorld), null);
  key.pos.x = 1; key.collected = true;
  assert.equal(selectInteraction([key], feet, openWorld), null);
  key.collected = false; key.entry.command = 'unimplemented';
  assert.equal(selectInteraction([key], feet, openWorld), null);
});
