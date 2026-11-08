const SETTINGS_KEY = 'gulman-web-audio-v1';
const DEFAULTS = { musicVolume: 0.6, effectsVolume: 0.8, muted: false };
const clampVolume = value => Math.min(1, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0));

/** Decode the game's standard PCM WAV without resampling a six-minute 8 kHz
 * mono track into a much larger 48 kHz buffer. This also avoids depending on
 * media-element autoplay/codec handling for the original PCM8 files. */
export function decodePCM(arrayBuffer, context) {
  const view = new DataView(arrayBuffer);
  const fourCC = offset => String.fromCharCode(...new Uint8Array(arrayBuffer, offset, 4));
  if (view.byteLength < 12 || fourCC(0) !== 'RIFF' || fourCC(8) !== 'WAVE') return null;
  let format, dataOffset = 0, dataLength = 0;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const tag = fourCC(offset), size = view.getUint32(offset + 4, true);
    const begin = offset + 8, available = Math.min(size, view.byteLength - begin);
    if (tag === 'fmt ' && available >= 16) {
      format = { codec: view.getUint16(begin, true), channels: view.getUint16(begin + 2, true),
        sampleRate: view.getUint32(begin + 4, true), blockAlign: view.getUint16(begin + 12, true), bits: view.getUint16(begin + 14, true) };
    } else if (tag === 'data') { dataOffset = begin; dataLength = available; }
    offset = begin + size + (size & 1);
  }
  if (!format || !dataOffset || format.codec !== 1 || ![8, 16].includes(format.bits)) return null;
  const { channels, sampleRate, blockAlign, bits } = format;
  if (channels < 1 || channels > 8 || sampleRate < 3000 || sampleRate > 192000 || blockAlign !== channels * bits / 8) throw new Error('Некорректный PCM WAV');
  const frames = Math.floor(dataLength / blockAlign);
  if (!frames) throw new Error('Пустой аудиофайл');
  const buffer = context.createBuffer(channels, frames, sampleRate);
  let peak = 0, sum = 0;
  for (let channel = 0; channel < channels; channel++) {
    const output = buffer.getChannelData(channel);
    for (let frame = 0; frame < frames; frame++) {
      const offset = dataOffset + frame * blockAlign + channel * bits / 8;
      const sample = bits === 8 ? (view.getUint8(offset) - 128) / 128 : view.getInt16(offset, true) / 32768;
      output[frame] = sample; peak = Math.max(peak, Math.abs(sample)); sum += sample * sample;
    }
  }
  return { buffer, peak, rms: Math.sqrt(sum / (frames * channels)), format };
}

/**
 * Usage:
 * const audio = new AudioManager(path => assets.sound(path), { onError: toast });
 * audio.setMusic('music/gulman1_sg3.wav'); // queues until the first gesture
 * button.onclick = () => { audio.unlock(); ... }; // before any await!
 * audio.play('sounds/weapons/pistol-01.wav', 0.8);
 * audio.play('sounds/гульмен/г1.wav', 0.9, {voice:true});
 *
 * Public asynchronous methods return success booleans and report failures via
 * lastError/onError; they never silently swallow autoplay/decode failures.
 */
export class AudioManager {
  constructor(resolveSound, { onError, onStateChange, storageKey = SETTINGS_KEY } = {}) {
    this.resolveSound = resolveSound;
    this.onError = onError;
    this.onStateChange = onStateChange;
    this.storageKey = storageKey;
    this._settings = { ...DEFAULTS };
    try {
      const saved = JSON.parse(globalThis.localStorage?.getItem(storageKey) || 'null');
      if (saved) {
        this._settings.musicVolume = clampVolume(saved.musicVolume ?? DEFAULTS.musicVolume);
        this._settings.effectsVolume = clampVolume(saved.effectsVolume ?? DEFAULTS.effectsVolume);
        this._settings.muted = saved.muted === true;
      }
    } catch { /* Storage may be disabled; audio still works for this session. */ }
    this.context = null;
    this.lastError = '';
    this.unlocked = false;
    this._disposed = false;
    this._buffers = new Map();
    this._effects = new Set();
    this._voice = null;
    this._musicPath = null;
    this._musicSource = null;
    this._musicRecord = null;
    this._musicOffset = 0;
    this._musicStarted = 0;
    this._musicWanted = false;
    this._musicToken = 0;
    this._startingMusic = null;
    this._lastNotice = '';
    this._lastNoticeTime = 0;
  }

  get settings() { return { ...this._settings }; }
  get muted() { return this._settings.muted; }
  set muted(value) { this._settings.muted = Boolean(value); this._settingsChanged(); }
  get musicVolume() { return this._settings.musicVolume; }
  set musicVolume(value) { this._settings.musicVolume = clampVolume(value); this._settingsChanged(); }
  get effectsVolume() { return this._settings.effectsVolume; }
  set effectsVolume(value) { this._settings.effectsVolume = clampVolume(value); this._settingsChanged(); }
  get state() { return this._disposed ? 'closed' : this.muted ? 'muted' : this.context?.state ?? 'locked'; }
  get stateLabel() {
    return ({ locked: 'Нажми, чтобы включить звук', suspended: 'Звук ожидает нажатия', running: 'Звук включён',
      interrupted: 'Звук приостановлен устройством', muted: 'Звук выключен', closed: 'Аудиосистема закрыта' })[this.state] || this.state;
  }
  get diagnostics() {
    return { state: this.state, stateLabel: this.stateLabel, contextState: this.context?.state ?? 'not-created',
      lastError: this.lastError, unlocked: this.unlocked, musicPath: this._musicPath, musicPlaying: Boolean(this._musicSource),
      activeEffects: this._effects.size, loadedSounds: this._buffers.size, ...this.settings };
  }

  _emit() { this.onStateChange?.(this.diagnostics); }
  _fail(error, action) {
    this.lastError = `${action}: ${error?.message || error}`;
    const now = Date.now();
    if (this.lastError !== this._lastNotice || now - this._lastNoticeTime > 5000) {
      this._lastNotice = this.lastError; this._lastNoticeTime = now;
      console.warn('[Gulman audio]', this.lastError);
      this.onError?.(this.lastError, error);
    }
    this._emit();
    return false;
  }
  _settingsChanged() {
    try { globalThis.localStorage?.setItem(this.storageKey, JSON.stringify(this._settings)); } catch { /* optional storage */ }
    this._applyGains(); this._emit();
  }
  _applyGains() {
    if (!this.context) return;
    const now = this.context.currentTime;
    this.masterGain.gain.setTargetAtTime(this.muted ? 0 : 1, now, 0.025);
    this.musicGain.gain.setTargetAtTime(this.musicVolume * (this._voice ? 0.35 : 1), now, 0.08);
    this.effectsGain.gain.setTargetAtTime(this.effectsVolume, now, 0.025);
  }
  _ensureContext() {
    if (this._disposed) throw new Error('Аудиосистема уже закрыта');
    if (this.context) return this.context;
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) throw new Error('В этом браузере недоступен Web Audio');
    this.context = new AudioContextClass({ latencyHint: 'interactive' });
    const context = this.context;
    this.masterGain = context.createGain(); this.musicGain = context.createGain(); this.effectsGain = context.createGain();
    this.limiter = context.createDynamicsCompressor();
    this.limiter.threshold.value = -6; this.limiter.knee.value = 3; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.15;
    this.musicGain.connect(this.masterGain); this.effectsGain.connect(this.masterGain);
    this.masterGain.connect(this.limiter); this.limiter.connect(context.destination);
    this._applyGains();
    context.onstatechange = () => {
      this.unlocked = context.state === 'running';
      if (this.unlocked && this._musicWanted) void this._startMusic();
      this._emit();
    };
    return context;
  }

  /** Call directly inside pointerdown/click/keydown, before other asynchronous work. */
  unlock() {
    try {
      const context = this._ensureContext();
      // resume() is invoked synchronously during the trusted user gesture.
      const resumed = context.state === 'running' ? Promise.resolve() : context.resume();
      const silent = context.createBufferSource();
      silent.buffer = context.createBuffer(1, 1, 22050); silent.connect(context.destination); silent.start();
      silent.onended = () => silent.disconnect();
      return resumed.then(() => {
        this.unlocked = context.state === 'running';
        if (!this.unlocked) return this._fail(new Error('Нажми кнопку звука ещё раз'), 'Браузер не включил звук');
        this.lastError = ''; this._emit();
        if (this._musicWanted) void this._startMusic();
        return true;
      }).catch(error => this._fail(error, 'Не удалось включить звук'));
    } catch (error) { return Promise.resolve(this._fail(error, 'Не удалось включить звук')); }
  }

  async _load(path) {
    const context = this._ensureContext();
    const url = this.resolveSound(path);
    if (!url) throw new Error(`Аудиофайл не найден: ${path}`);
    if (!this._buffers.has(url)) this._buffers.set(url, (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      let record = decodePCM(bytes, context);
      if (!record) {
        const buffer = await context.decodeAudioData(bytes);
        let peak = 0, sum = 0;
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) for (const sample of buffer.getChannelData(channel)) {
          peak = Math.max(peak, Math.abs(sample)); sum += sample * sample;
        }
        record = { buffer, peak, rms: Math.sqrt(sum / (buffer.length * buffer.numberOfChannels)) };
      }
      // Quiet menu/artefact recordings get independent gain compensation.
      // The untouched source buffer is mixed through the shared compressor.
      record.musicGain = Math.min(6, Math.max(0.7, 0.07 / Math.max(record.rms, 0.0001)));
      return record;
    })().catch(error => { this._buffers.delete(url); throw error; }));
    return this._buffers.get(url);
  }

  async preload(paths) {
    const results = await Promise.all(paths.map(path => this._load(path).then(() => true).catch(error => this._fail(error, 'Не удалось загрузить звук'))));
    return results.every(Boolean);
  }

  async setMusic(path, { autoplay = true } = {}) {
    if (path === this._musicPath) return autoplay ? this.resumeMusic() : (this.pauseMusic(), true);
    this._musicToken++; this._stopMusic(false);
    this._musicPath = path; this._musicOffset = 0; this._musicRecord = null; this._musicWanted = autoplay;
    const token = this._musicToken;
    if (!path) { this._emit(); return true; }
    try {
      const record = await this._load(path);
      if (token !== this._musicToken || this._disposed) return false;
      this._musicRecord = record;
      if (autoplay && this.context.state === 'running') return this._startMusic();
      this._emit(); return true; // queued until unlock()
    } catch (error) { return this._fail(error, 'Не удалось загрузить музыку'); }
  }
  _startMusic() {
    if (this._disposed || !this._musicWanted || this._musicSource || !this._musicPath || this.context?.state !== 'running') return Promise.resolve(false);
    const token = this._musicToken;
    if (this._startingMusic?.token === token) return this._startingMusic.promise;
    const promise = (async () => {
      // Yield once so the in-flight marker is assigned even for an already
      // cached track; otherwise a later pause/resume could reuse a stale promise.
      await Promise.resolve();
      try {
        const record = this._musicRecord ?? await this._load(this._musicPath);
        if (token !== this._musicToken || !this._musicWanted || this._disposed || this._musicSource) return false;
        this._musicRecord = record;
        const source = this.context.createBufferSource(), gain = this.context.createGain();
        source.buffer = record.buffer; source.loop = true; gain.gain.value = record.musicGain;
        source.connect(gain); gain.connect(this.musicGain);
        this._musicSource = source; this._musicTrackGain = gain;
        this._musicStarted = this.context.currentTime;
        source.start(0, this._musicOffset % record.buffer.duration);
        this._emit(); return true;
      } catch (error) { return this._fail(error, 'Не удалось воспроизвести музыку'); }
      finally { if (this._startingMusic?.token === token) this._startingMusic = null; }
    })();
    this._startingMusic = { token, promise };
    return promise;
  }
  _stopMusic(saveOffset) {
    if (!this._musicSource) return;
    if (saveOffset && this._musicRecord) this._musicOffset = (this._musicOffset + this.context.currentTime - this._musicStarted) % this._musicRecord.buffer.duration;
    const source = this._musicSource; this._musicSource = null;
    source.stop(); source.disconnect(); this._musicTrackGain?.disconnect(); this._musicTrackGain = null;
  }
  pauseMusic() { this._musicWanted = false; this._stopMusic(true); this._emit(); }
  resumeMusic() { this._musicWanted = true; return this._startMusic(); }

  async play(path, volume = 1, { voice = false, interrupt = false, offset = 0, duration } = {}) {
    if (this._disposed || this.muted || this.effectsVolume === 0) return false;
    if (this.context?.state !== 'running') return this._fail(new Error('Нажми кнопку звука, чтобы разрешить воспроизведение'), 'Звук заблокирован');
    if (voice && this._voice && !interrupt) return false;
    try {
      const record = await this._load(path);
      if (this._disposed || this.muted || this.context.state !== 'running') return false;
      if (voice && this._voice) { if (!interrupt) return false; this._voice.stop(); }
      while (this._effects.size >= 24) this._effects.values().next().value.stop();
      const source = this.context.createBufferSource(), gain = this.context.createGain();
      source.buffer = record.buffer; gain.gain.value = clampVolume(volume); source.connect(gain); gain.connect(this.effectsGain);
      const effect = { source, stop: () => { source.onended = null; source.stop(); cleanup(); } };
      const cleanup = () => {
        source.disconnect(); gain.disconnect(); this._effects.delete(effect);
        if (this._voice === effect) { this._voice = null; this._applyGains(); }
        this._emit();
      };
      source.onended = cleanup; this._effects.add(effect);
      if (voice) { this._voice = effect; this._applyGains(); }
      if (duration === undefined) source.start(0, Math.max(0, offset));
      else source.start(0, Math.max(0, offset), Math.max(0, duration));
      this._emit(); return true;
    } catch (error) { return this._fail(error, 'Не удалось воспроизвести звук'); }
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true; this._musicWanted = false; this._musicToken++;
    this._stopMusic(false);
    for (const effect of [...this._effects]) effect.stop();
    this._buffers.clear();
    if (this.context) { this.context.onstatechange = null; await this.context.close(); }
    this._emit();
  }
}
