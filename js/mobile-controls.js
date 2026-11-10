const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function readStick(dx, dy, radius, wasSprinting = false) {
  const distance = Math.hypot(dx, dy);
  const pull = Math.min(1, distance / radius);
  const travel = distance ? pull / distance : 0;
  const strength = clamp((pull - .14) / .86, 0, 1);
  const input = distance ? strength / distance : 0;
  return {
    forward: input ? -dy * input : 0,
    strafe: input ? dx * input : 0,
    x: dx * travel * radius,
    y: dy * travel * radius,
    sprint: pull >= (wasSprinting ? .75 : .87),
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
  const state = {forward: 0, strafe: 0, sprint: false};
  let originX, originY, radius, lastX, lastY;

  function updateStick(input) {
    Object.assign(state, input);
    stick.style.setProperty('--stick-x', input.x + 'px');
    stick.style.setProperty('--stick-y', input.y + 'px');
    stick.classList.toggle('sprinting', input.sprint);
  }

  const stopStick = trackPointer(stick, {
    start(event) {
      // Anchor to the initial touch, even when it lands off-center.
      originX = event.clientX;
      originY = event.clientY;
      radius = Math.max(1, stick.clientWidth * .36);
      stick.classList.add('held');
    },
    move(event) {
      updateStick(readStick(event.clientX - originX, event.clientY - originY, radius, state.sprint));
    },
    end() {
      updateStick(readStick(0, 0, radius));
      stick.classList.remove('held');
    },
  });
  function dragLook(event) {
    look(event.clientX - lastX, event.clientY - lastY);
    lastX = event.clientX;
    lastY = event.clientY;
  }
  function beginLook(event) {
    lastX = event.clientX;
    lastY = event.clientY;
  }
  const stopLook = trackPointer(root.querySelector('#touch-look'), {start: beginLook, move: dragLook});
  const stopFire = trackPointer(fireButton, {
    start(event) {
      fireButton.classList.add('held');
      fire(true, event.pointerId);
    },
    end() {
      fireButton.classList.remove('held');
      fire(false);
    },
  });
  const stopJump = trackPointer(root.querySelector('#touch-jump'), {start: jump});
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
