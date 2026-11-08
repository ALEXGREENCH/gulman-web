const STORAGE_KEY = 'gulman-web-player-v1';
const HEROES = { gulman: 'Gulman', dama: 'Dama', 'гульмэн': 'Gulman', 'гульмен': 'Gulman', 'гульмоника': 'Dama' };
const WEAPONS = [
  { path: 'models/weapons/weaponpistol.3ds', length: 0.42 },
  { path: 'models/weapons/weaponrifle.3ds', length: 0.7 },
  { path: 'models/weapons/granate.3ds', length: 0.2 },
  { path: 'models/weapons/weaponrifle2.3ds', length: 0.7 },
];
const defaultCharacterFactory = async (...args) => (await import('./characters.js?v=20261109-12')).createCharacter(...args);

// Physical number keys work in both Russian and English layouts. Function
// keys remain available to the browser; editing and browser shortcuts win.
export function heroForKey(event) {
  if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
  const target = event.target;
  if (target?.isContentEditable || target?.closest?.('input,select,textarea,[contenteditable="true"],[role="textbox"]')) return null;
  return event.code === 'Digit5' ? 'Gulman' : event.code === 'Digit6' ? 'Dama' : null;
}

/**
 * A race-safe, persistent Gulman / Gulmonika selection controller.
 *
 * const choice = createPlayerChoice({ assets, getPlayer:()=>player,
 *   setPlayer:value=>{player=value}, getScene:()=>scene,
 *   getPosition:()=>position, getYaw:()=>yaw, getWeapon:()=>weapon,
 *   onChange:(name,actor)=>..., onError:message=>... });
 * await choice.select('Dama'); // keeps the old player until fully ready
 * await choice.create();       // build the saved selection for a new level
 *
 * On level unload, dispose the old actor and set player=null before create().
 * getWeapon may return index 0..3, a model path, {path,length}, or null.
 * Selecting without a scene only updates the saved menu preference.
 * characterFactory/storage are injectable for tests; no Three.js is loaded
 * until the default factory is actually used.
 */
export function createPlayerChoice({ assets, getPlayer, setPlayer, getScene,
  getPosition, getYaw, getWeapon = () => 0, onChange, onError,
  characterFactory = defaultCharacterFactory, storage: suppliedStorage, storageKey = STORAGE_KEY }) {
  if (!assets || !getPlayer || !setPlayer || !getScene) throw new TypeError('Player choice requires assets and player/scene accessors');
  let storage = suppliedStorage;
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { storage = null; } }
  let value = 'Gulman', pending = null, revision = 0;
  try {
    const saved = storage?.getItem(storageKey);
    value = HEROES[String(saved || '').replace(/^"|"$/g, '').toLowerCase()] || value;
  } catch { /* Selection remains usable when storage is disabled. */ }
  const disposed = new WeakSet();
  const loadModel = assets.model.bind(assets);
  const getJSON = assets.json.bind(assets);

  function error(message, cause) {
    console.warn('[Gulman player]', message, cause || '');
    onError?.(message, cause);
  }
  function persist() { try { storage?.setItem(storageKey, value); } catch { /* optional persistence */ } }
  function notify(actor) {
    try { onChange?.(value, actor); } catch (cause) { error('Не удалось обновить выбор героя в интерфейсе', cause); }
  }
  function release(actor) {
    if (!actor || disposed.has(actor)) return;
    disposed.add(actor);
    actor.group?.removeFromParent();
    try { actor.dispose?.(); } catch (cause) { error('Не удалось освободить прежнюю модель героя', cause); }
  }
  function weaponSpec() {
    const selected = getWeapon();
    if (selected === null || selected === false) return null;
    if (typeof selected === 'string') return { path: selected, length: 0.42 };
    if (selected && typeof selected === 'object') return { path: selected.path, length: selected.length ?? 0.42 };
    return WEAPONS[Number(selected) || 0] || WEAPONS[0];
  }
  const weaponKey = spec => spec ? `${spec.path}|${spec.length}` : 'none';

  async function select(name, { replace = true, force = false } = {}) {
    const canonical = HEROES[String(name).toLowerCase()];
    if (!canonical) { error(`Неизвестный герой: ${name}`); return null; }
    const token = ++revision;
    pending = canonical;
    const scene = getScene(), previous = getPlayer();
    let replacement = null;
    const stale = () => token !== revision || getScene() !== scene || getPlayer() !== previous;
    try {
      if (!replace || !scene) {
        value = canonical; persist(); notify(previous || null); return previous || null;
      }
      const existingName = previous?.characterName ?? previous?.group?.userData?.playerChoice;
      if (!force && previous && existingName === canonical) {
        value = canonical; persist(); notify(previous); return previous;
      }
      replacement = await characterFactory(canonical, loadModel, getJSON);
      if (!replacement?.group || replacement === previous) throw new Error('Фабрика не создала новую модель героя');
      if (stale()) { release(replacement); return null; }

      // Weapon changes can race the skin download. Retry against the latest
      // selected weapon before committing so hero selection never restores an old gun.
      while (true) {
        const spec = weaponSpec();
        const model = spec ? await loadModel(spec.path, true) : null;
        if (stale()) { release(replacement); return null; }
        if (weaponKey(spec) !== weaponKey(weaponSpec())) continue;
        if (model) replacement.attachWeapon?.(model, { length: spec.length });
        break;
      }

      // Read the current transform only after all loading: the player may
      // have moved, turned, or changed camera while the new rig was loading.
      const position = getPosition?.() ?? previous?.group?.position;
      if (position) replacement.group.position.copy(position);
      replacement.group.rotation.y = getYaw?.() ?? previous?.group?.rotation?.y ?? 0;
      replacement.group.visible = previous?.group?.visible ?? true;
      replacement.group.userData ??= {};
      replacement.group.userData.playerChoice = canonical;
      replacement.characterName = canonical;
      scene.add(replacement.group);
      setPlayer(replacement);
      value = canonical;
      persist();
      release(previous);
      notify(replacement);
      return replacement;
    } catch (cause) {
      if (replacement && replacement !== previous && getPlayer() !== replacement) release(replacement);
      if (token === revision) error('Не удалось сменить героя: ' + (cause?.message || cause), cause);
      return null;
    } finally {
      if (token === revision) pending = null;
    }
  }

  return {
    get value() { return value; },
    get pending() { return pending; },
    select,
    create() { return select(value, { force: true }); },
    cancel() { revision++; pending = null; },
  };
}
