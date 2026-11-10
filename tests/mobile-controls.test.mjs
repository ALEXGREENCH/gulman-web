import test from 'node:test';
import assert from 'node:assert/strict';
import {bindTouchControls, readStick} from '../js/mobile-controls.js';

test('the analog stick has a radial dead zone and caps diagonal speed', () => {
  assert.equal(readStick(5, 5, 100).forward, 0);
  assert.equal(readStick(5, 5, 100).strafe, 0);
  const half = readStick(0, -50, 100);
  assert.ok(half.forward > .4 && half.forward < .5);
  assert.equal(half.sprint, false);
  const diagonal = readStick(100, -100, 100);
  assert.ok(diagonal.forward > 0 && diagonal.strafe > 0);
  assert.ok(Math.abs(Math.hypot(diagonal.forward, diagonal.strafe) - 1) < 1e-8);
  assert.equal(diagonal.sprint, true);
});

test('running starts near the rim and has hysteresis when easing back', () => {
  assert.equal(readStick(86, 0, 100).sprint, false);
  assert.equal(readStick(87, 0, 100).sprint, true);
  assert.equal(readStick(80, 0, 100, true).sprint, true);
  const walking = readStick(74, 0, 100, true);
  assert.equal(walking.sprint, false);
  assert.ok(walking.strafe > .65);
});

class PointerSurface extends EventTarget {
  captures = new Set();
  style = {setProperty() {}};
  classList = {add() {}, remove() {}, toggle() {}};
  clientWidth = 100;

  hasPointerCapture(id) { return this.captures.has(id); }
  setPointerCapture(id) { this.captures.add(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  send(type, id, x = 0, y = 0) {
    const event = new Event(type, {cancelable: true});
    Object.assign(event, {pointerId: id, clientX: x, clientY: y, button: 0});
    this.dispatchEvent(event);
  }
}

test('dragging from fire aims while holding the movement stick and preserves independent look coordinates', () => {
  const [stick, surface, trigger, jump, action] = Array.from({length:5}, () => new PointerSurface());
  const elements = {'#touch-stick':stick,'#touch-look':surface,'#touch-fire':trigger,'#touch-jump':jump,'#touch-interact':action};
  const moves = [], shots = [];
  const controls = bindTouchControls({querySelector: selector => elements[selector]}, {
    look: (...delta) => moves.push(delta),
    fire: held => shots.push(held),
  });

  stick.send('pointerdown', 1, 50, 50);
  surface.send('pointerdown', 2, 150, 100);
  trigger.send('pointerdown', 3, 280, 180);
  trigger.send('pointermove', 3, 214, 162);
  stick.send('pointermove', 1, 50, 10);
  surface.send('pointermove', 2, 158, 95);
  assert.equal(controls.state.sprint, true);
  assert.deepEqual(moves, [[-66,-18],[8,-5]]);
  assert.deepEqual(shots, [true]);

  trigger.send('pointercancel', 3);
  assert.deepEqual(shots, [true,false]);
  trigger.send('pointermove', 3, 150, 150);
  assert.equal(controls.state.forward, 1);
  stick.send('lostpointercapture', 1);
  assert.equal(controls.state.forward, 0);
  assert.equal(controls.state.sprint, false);
  controls.reset();
  surface.send('pointermove', 2, 200, 200);
  assert.equal(surface.captures.size, 0);
  assert.deepEqual(moves, [[-66,-18],[8,-5]]);
});
