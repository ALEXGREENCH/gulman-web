const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function readStick(dx, dy, radius, wasSprinting = false, wasStraight = false) {
  const distance = Math.hypot(dx, dy);
  const pull = Math.min(1, distance / radius);
  const travel = distance ? pull / distance : 0;
  // A broad walking range gives the thumb room to place feet on small ledges.
  const walk = clamp((pull - .12) / .68, 0, 1);
  const strength = walk * (0.5 + 0.5 * walk);
  const input = distance ? strength / distance : 0;
  // Keep a walking thumb on the forward/back axis through small sideways
  // drift, without switching in and out at the edge of the gate.
  const straight = strength > 0 && Math.abs(dx) <= Math.abs(dy) * (wasStraight ? .30 : .22);
  return {
    forward: strength ? (straight ? -Math.sign(dy) * strength : -dy * input) : 0,
    strafe: input && !straight ? dx * input : 0,
    x: dx * travel * radius,
    y: dy * travel * radius,
    sprint: pull >= (wasSprinting ? .84 : .94),
    straight,
  };
}

function trackPointer(element, {start, move, end}) {
  let pointerId = null;
  const stop = () => {
    if (pointerId === null) return;
    const id = pointerId;
    pointerId = null;
    if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
    end?.();
  };

  element.addEventListener('pointerdown', event => {
    if (pointerId !== null || event.button !== 0) return;
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    pointerId = event.pointerId;
    start?.(event);
  });
  element.addEventListener('pointermove', event => {
    if (event.pointerId === pointerId) move?.(event);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    element.addEventListener(type, event => {
      if (event.pointerId === pointerId) stop();
    });
  }
  return stop;
}

export function bindTouchControls(root, {look, fire, jump, interact}) {
  const stick = root.querySelector('#touch-stick');
  const fireButton = root.querySelector('#touch-fire');
  const state = {forward: 0, strafe: 0, sprint: false, straight: false, active: false};
  let originX, originY, radius;

  function updateStick(input) {
    Object.assign(state, input);
    stick.style.setProperty('--stick-x', input.x + 'px');
    stick.style.setProperty('--stick-y', input.y + 'px');
    stick.classList.toggle('sprinting', input.sprint);
  }

  const stopStick = trackPointer(stick, {
    start(event) {
      state.active = true;
      const bounds = stick.getBoundingClientRect();
      originX = bounds.left + bounds.width / 2;
      originY = bounds.top + bounds.height / 2;
      radius = Math.max(1, bounds.width * .38);
      stick.classList.add('held');
      updateStick(readStick(event.clientX - originX, event.clientY - originY, radius));
    },
    move(event) {
      updateStick(readStick(event.clientX - originX, event.clientY - originY, radius, state.sprint, state.straight));
    },
    end() {
      state.active = false;
      updateStick(readStick(0, 0, radius));
      stick.classList.remove('held');
    },
  });
  function trackLook(element, {start, end} = {}) {
    let lastX, lastY;
    return trackPointer(element, {
      start(event) {
        lastX = event.clientX;
        lastY = event.clientY;
        start?.(event);
      },
      move(event) {
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        lastX = event.clientX;
        lastY = event.clientY;
        if (dx || dy) look(dx, dy);
      },
      end,
    });
  }

  const stopLook = trackLook(root.querySelector('#touch-look'));
  const stopFire = trackLook(fireButton, {
    start(event) {
      fireButton.classList.add('held');
      fire(true, event.pointerId);
    },
    end() {
      fireButton.classList.remove('held');
      fire(false);
    },
  });
  const jumpButton = root.querySelector('#touch-jump');
  const stopJump = trackLook(jumpButton, {
    start() { jumpButton.classList.add('held'); jump?.(true); },
    end() { jumpButton.classList.remove('held'); jump?.(false); },
  });
  const stopInteract = trackPointer(root.querySelector('#touch-interact'), {start: interact});

  return {
    state,
    reset() {
      stopStick();
      stopLook();
      stopFire();
      stopJump();
      stopInteract();
    },
  };
}

export function bindFullscreen(button, {onChange, onError} = {}) {
  const root = document.documentElement;
  const enter = root.requestFullscreen ?? root.webkitRequestFullscreen;
  const exit = document.exitFullscreen ?? document.webkitExitFullscreen;
  const active = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const supported = document.fullscreenEnabled ?? document.webkitFullscreenEnabled ?? !!enter;
  button.hidden = !(supported && enter && exit);
  if (button.hidden) return;

  const orientation = window.screen.orientation;
  let locked = false;
  function sync() {
    const expanded = active();
    const label = expanded ? 'Выйти из полноэкранного режима' : 'На весь экран';
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(expanded));
    button.title = label;
    if (!expanded && locked) {
      orientation?.unlock?.();
      locked = false;
    }
    onChange?.();
  }
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
  button.addEventListener('click', async () => {
    try {
      if (active()) {
        await exit.call(document);
        return;
      }
      await enter.call(root);
      if (active() && root.hasAttribute('data-touch') && orientation?.lock) {
        try {
          await orientation.lock('landscape');
          locked = active();
          if (!locked) orientation.unlock?.();
        } catch {
          // Fullscreen remains usable with the device's current orientation.
        }
      }
    } catch {
      onError?.();
    }
  });
  sync();
}
