import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EnhancedPostprocessing } from '../js/postprocessing.js';

function renderer({ hdr = true, maxTextureSize = 8192 } = {}) {
  return {
    extensions: { has: () => hdr }, capabilities: { maxTextureSize },
    autoClear: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.12,
    viewport: new THREE.Vector4(3, 5, 320, 240), scissor: new THREE.Vector4(4, 6, 300, 200),
    scissorTest: true, target: null, face: 0, mipmap: 0, calls: [], clears: 0,
    info: { autoReset: true, resetCount: 0, reset() { this.resetCount++; } },
    getSize: target => target.set(320, 240), getPixelRatio: () => 1.5,
    getRenderTarget() { return this.target; },
    getActiveCubeFace() { return this.face; }, getActiveMipmapLevel() { return this.mipmap; },
    getViewport(target) { return target.copy(this.viewport); },
    getScissor(target) { return target.copy(this.scissor); },
    getScissorTest() { return this.scissorTest; },
    setViewport(value) { this.viewport.copy(value); },
    setScissor(value) { this.scissor.copy(value); },
    setScissorTest(value) { this.scissorTest = value; },
    setRenderTarget(target, face = 0, mipmap = 0) { this.target = target; this.face = face; this.mipmap = mipmap; },
    clear() { this.clears++; },
    render(scene) {
      const material = scene.children[0]?.material;
      this.calls.push({ target: this.target, toneMapping: this.toneMapping, material: material?.name,
        source: material?.uniforms.tSource?.value, bloom: material?.uniforms.tBloom?.value });
      if (this.failOn === this.calls.length) throw new Error('simulated GPU failure');
    },
  };
}

test('HDR targets have bounded resolution and low quality releases bloom allocations', () => {
  const gpu = renderer();
  const post = new EnhancedPostprocessing(gpu);
  post.setSize(7680, 4320, 3);
  assert.equal(post._sceneTarget.texture.type, THREE.HalfFloatType);
  assert.equal(post._sceneTarget.depthTexture, post._depth);
  assert.equal(post._depth.type, THREE.UnsignedIntType);
  assert.ok(post.diagnostics.renderWidth * post.diagnostics.renderHeight <= 2560 * 1440);
  assert.ok(Math.abs(post.diagnostics.renderWidth / post.diagnostics.renderHeight - 16 / 9) < 0.002);
  assert.equal(post.diagnostics.bloomWidth, Math.ceil(post.diagnostics.renderWidth / 4));
  assert.equal(post.diagnostics.passes, 5);
  const bloom = [post._bloomA, post._bloomB];
  const disposed = [0, 0];
  bloom.forEach((target, index) => target.addEventListener('dispose', () => disposed[index]++));
  post.setQuality('low');
  assert.deepEqual(disposed, [1, 1]);
  assert.equal(post.diagnostics.bloomWidth, 0);
  assert.equal(post.diagnostics.bloomHeight, 0);
  assert.equal(post.diagnostics.passes, 2);
  assert.equal(post.diagnostics.depthAO, false);
  assert.equal(post._sceneTarget.depthTexture, null);
  assert.ok(post.diagnostics.renderWidth * post.diagnostics.renderHeight <= 1920 * 1080);
  post.setQuality('high');
  assert.notEqual(post._bloomA, bloom[0]);
  assert.notEqual(post._bloomB, bloom[1]);
  post.dispose();
});

test('unsupported HDR falls back to byte targets and obeys the GPU texture limit', () => {
  const post = new EnhancedPostprocessing(renderer({ hdr: false, maxTextureSize: 512 }));
  post.setSize(4096, 2160, 2);
  assert.equal(post._sceneTarget.texture.type, THREE.UnsignedByteType);
  assert.equal(post.diagnostics.hdr, false);
  assert.ok(post.diagnostics.renderWidth <= 512);
  assert.ok(post.diagnostics.renderHeight <= 512);
  post.setSize(NaN, 0, Infinity);
  assert.equal(post.diagnostics.renderWidth, 1);
  assert.equal(post.diagnostics.renderHeight, 1);
  assert.throws(() => post.setQuality('ultra'), RangeError);
  post.dispose();
});

test('high render uses distinct bloom input/output targets and restores renderer state', () => {
  const gpu = renderer();
  const post = new EnhancedPostprocessing(gpu);
  const viewport = gpu.viewport.clone();
  const scissor = gpu.scissor.clone();
  post.render(new THREE.Scene(), new THREE.Camera());
  assert.equal(gpu.calls.length, 5);
  assert.equal(gpu.calls[0].target, post._sceneTarget);
  assert.equal(gpu.calls[4].target, null);
  for (const call of gpu.calls) {
    assert.equal(call.toneMapping, THREE.NoToneMapping, 'HDR must not be tone-mapped before the final shader');
    if (call.source) assert.notEqual(call.source, call.target?.texture, 'a pass cannot read and write the same texture');
  }
  assert.equal(gpu.calls[4].material, 'enhanced-hdr-output');
  assert.equal(gpu.target, null);
  assert.equal(gpu.autoClear, true);
  assert.equal(gpu.toneMapping, THREE.ACESFilmicToneMapping);
  assert.equal(gpu.scissorTest, true);
  assert.deepEqual(gpu.viewport, viewport);
  assert.deepEqual(gpu.scissor, scissor);
  assert.equal(gpu.info.autoReset, true);
  assert.equal(gpu.info.resetCount, 1);
  assert.equal(post._composite.uniforms.exposure.value, 1.12);
  post.dispose();
});

test('low quality needs only scene and final draws; failed render also restores destination', () => {
  const gpu = renderer();
  const post = new EnhancedPostprocessing(gpu);
  post.setQuality('low');
  const destination = new THREE.WebGLRenderTarget(32, 32);
  gpu.setRenderTarget(destination, 2, 1);
  post.render(new THREE.Scene(), new THREE.Camera());
  assert.equal(gpu.calls.length, 2);
  assert.equal(gpu.calls[1].target, destination);
  assert.equal(post._composite.uniforms.bloomStrength.value, 0);
  assert.equal(gpu.face, 2);
  assert.equal(gpu.mipmap, 1);
  gpu.calls.length = 0;
  gpu.failOn = 2;
  assert.throws(() => post.render(new THREE.Scene(), new THREE.Camera()), /simulated GPU failure/);
  assert.equal(gpu.target, destination);
  assert.equal(gpu.face, 2);
  assert.equal(gpu.mipmap, 1);
  assert.equal(gpu.autoClear, true);
  assert.equal(gpu.toneMapping, THREE.ACESFilmicToneMapping);
  assert.equal(gpu.info.autoReset, true);
  post.dispose();
  destination.dispose();
});

test('dispose releases every current GPU resource exactly once', () => {
  const post = new EnhancedPostprocessing(renderer());
  const owned = [post._sceneTarget, post._depth, post._bloomA, post._bloomB, post._bright, post._blur, post._composite, post._geometry];
  const counts = owned.map(() => 0);
  owned.forEach((resource, index) => resource.addEventListener('dispose', () => counts[index]++));
  post.dispose();
  post.dispose();
  assert.deepEqual(counts, owned.map(() => 1));
  assert.throws(() => post.render(new THREE.Scene(), new THREE.Camera()), /disposed/);
});

test('depth contact AO retains its allocation at a stable size and releases it on resize/low quality', () => {
  const gpu = renderer();
  const post = new EnhancedPostprocessing(gpu);
  const depth = post._depth;
  let releases = 0;
  depth.addEventListener('dispose', () => releases++);
  post.setSize(320, 240, 1.5);
  assert.equal(post._depth, depth, 'steady frames must not reallocate the depth attachment');
  assert.equal(releases, 0);
  post.setSize(640, 360, 1);
  assert.equal(releases, 1);
  assert.notEqual(post._depth, depth);
  assert.equal(post._depth.image.width, 640);
  assert.equal(post._depth.image.height, 360);
  const resizedDepth = post._depth;
  let lowReleases = 0;
  resizedDepth.addEventListener('dispose', () => lowReleases++);
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.08, 1000);
  post.render(new THREE.Scene(), camera);
  assert.equal(post._composite.uniforms.useAO.value, true);
  assert.equal(post._composite.uniforms.cameraNear.value, camera.near);
  assert.equal(post._composite.uniforms.cameraFar.value, camera.far);
  assert.deepEqual(post._composite.uniforms.inverseProjection.value, camera.projectionMatrixInverse);
  assert.equal(gpu.calls.length, 5, 'AO must share the existing composite pass');
  post.setQuality('low');
  assert.equal(lowReleases, 1);
  assert.equal(post._depth, null);
  assert.equal(post._sceneTarget.depthTexture, null);
  gpu.calls.length = 0;
  post.render(new THREE.Scene(), camera);
  assert.equal(post._composite.uniforms.useAO.value, false);
  assert.equal(gpu.calls.length, 2);
  post.dispose();
  assert.equal(lowReleases, 1);
});
