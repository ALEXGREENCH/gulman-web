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
  assert.equal(readStick(93, 0, 100).sprint, false);
  assert.equal(readStick(94, 0, 100).sprint, true);
  assert.equal(readStick(87, 0, 100, true).sprint, true);
  const walking = readStick(83, 0, 100, true);
  assert.equal(walking.sprint, false);
  assert.ok(walking.strafe > .65);
});

class PointerSurface extends EventTarget {
  captures = new Set();
  style = {setProperty() {}};
  classList = {add() {}, remove() {}, toggle() {}};
  clientWidth = 100;

  getBoundingClientRect() { return {left:0,top:0,width:100,height:100}; }
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

test('rim touch starts running immediately and returning to the visible center stops it', () => {
  const elements = Object.fromEntries(['stick','look','fire','jump','interact'].map(name => ['#touch-'+name,new PointerSurface()]));
  const controls = bindTouchControls({querySelector: selector => elements[selector]}, {look() {}, fire() {}});
  const stick = elements['#touch-stick'];
  stick.send('pointerdown', 1, 50, 12);
  assert.equal(controls.state.sprint, true);
  assert.equal(controls.state.forward, 1);
  stick.send('pointermove', 1, 50, 37);
  assert.equal(controls.state.sprint, false);
  assert.ok(controls.state.forward > .1 && controls.state.forward < .25, 'fine movement near the center');
  stick.send('pointermove', 1, 50, 50);
  assert.equal(controls.state.forward, 0);
  stick.send('pointercancel', 1);
  stick.send('pointerdown', 2, 50, 75);
  assert.ok(controls.state.forward < 0, 'new touch is relative to the visible center');
  controls.reset();
  assert.equal(controls.state.forward, 0);
});

test('jump can be held and used for camera look independently of the moving stick', () => {
  const elements = Object.fromEntries(['stick','look','fire','jump','interact'].map(name => ['#touch-'+name,new PointerSurface()]));
  const presses = [], moves = [];
  const controls = bindTouchControls({querySelector: selector => elements[selector]}, {
    look: (...delta) => moves.push(delta), fire() {}, jump: held => presses.push(held),
  });
  elements['#touch-stick'].send('pointerdown', 1, 50, 12);
  elements['#touch-jump'].send('pointerdown', 2, 250, 180);
  elements['#touch-jump'].send('pointermove', 2, 270, 170);
  assert.deepEqual(presses, [true]);
  assert.deepEqual(moves, [[20,-10]]);
  assert.equal(controls.state.sprint, true);
  elements['#touch-jump'].send('pointerup', 2);
  assert.deepEqual(presses, [true,false]);
  assert.equal(controls.state.sprint, true);
  controls.reset();
});

test('small thumb drift retains rope heading assistance while deliberate diagonal movement remains available', () => {
  assert.equal(readStick(.4,-30,40).strafe,0);
  assert.equal(readStick(2,-30,40).strafe,0);
  assert.equal(readStick(-2,30,40).strafe,0);
  const diagonal=readStick(12,-30,40);
  assert.ok(diagonal.strafe>.1&&diagonal.forward>0);
});
