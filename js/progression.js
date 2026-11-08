import { Vector3 } from 'three';

const COMMANDS = new Set(['GameKey', 'GameEnd', 'МАГАЗИН', 'АПТЕЧКА', 'ПАТРОНЫ', 'БАКСЫ']);

// Original rooftop routes: level 4 bridge dx403 climbs at 53–54 degrees;
// level 6 roof dx3/dx00013 reaches 55–56 degrees. Preserve their geometry.
export function maxSlopeForLevel(levelId){const id=Number(levelId);return id===4?55:id===6?56:50;}
// Original rock/roof approaches in levels 3 and 4 need a higher running jump.
// Level 5 also has a 7.8 m running jump between a crate and the dome rim.
// Level 6 needs a small margin at its upper opening across 25–120 Hz physics.
// Retain the existing geometry and repair the reconstructed jump for each map.
export function jumpSpeedForLevel(levelId){const id=Number(levelId);return id===3||id===4||id===6?9.5:id===5?11:8;}

/** Pick a visible usable interaction, preserving the game's 2.8 m eye range.
 * Required objectives win over optional supplies. A full-health medkit cannot
 * permanently mask the adjacent objective, and a locked exit cannot mask a key.
 */
export function selectInteraction(items, position, world, { health = 100, collected = 0, totalKeys = 0, radius = 2.8 } = {}) {
  const eye = new Vector3(position.x, position.y + 0.9, position.z);
  const direction = new Vector3();
  let selected = null, bestPriority = Infinity, bestDistance = radius;
  for (const item of items) {
    const command = item.entry?.command;
    if (item.collected || !COMMANDS.has(command) || (command === 'АПТЕЧКА' && health >= 100)) continue;
    const distance = eye.distanceTo(item.pos);
    if (distance >= radius) continue;
    const priority = command === 'GameKey' ? 0 : command === 'GameEnd' ? (collected >= totalKeys ? 0 : 3) : command === 'МАГАЗИН' ? 1 : 2;
    if (priority > bestPriority || (priority === bestPriority && distance >= bestDistance)) continue;
    direction.copy(item.pos).sub(eye);
    if (world?.ray?.(eye, direction, Math.max(0, distance - 0.25))) continue;
    selected = item; bestPriority = priority; bestDistance = distance;
  }
  return selected;
}
