import * as THREE from 'three';

const QUALITY = Object.freeze({
  high: Object.freeze({ bloom: true, maxPixels: 2560 * 1440 }),
  low: Object.freeze({ bloom: false, maxPixels: 1920 * 1080 }),
});

const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const brightShader = /* glsl */`
  uniform sampler2D tSource;
  uniform vec2 texel;
  uniform float threshold;
  varying vec2 vUv;
  void main() {
    // Four taps reduce isolated bright pixels before the quarter-size blur.
    vec3 color = texture2D(tSource, vUv + texel * vec2(-1.0, -1.0)).rgb;
    color += texture2D(tSource, vUv + texel * vec2(1.0, -1.0)).rgb;
    color += texture2D(tSource, vUv + texel * vec2(-1.0, 1.0)).rgb;
    color += texture2D(tSource, vUv + texel * vec2(1.0, 1.0)).rgb;
    color *= 0.25;
    float brightness = max(max(color.r, color.g), color.b);
    float knee = threshold * 0.45;
    float soft = clamp(brightness - threshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / max(4.0 * knee, 0.0001);
    float contribution = max(brightness - threshold, soft) / max(brightness, 0.0001);
    gl_FragColor = vec4(color * contribution, 1.0);
  }
`;

const blurShader = /* glsl */`
  uniform sampler2D tSource;
  uniform vec2 direction;
  varying vec2 vUv;
  void main() {
    // Bilinear filtering turns these five reads into a nine-tap Gaussian.
    vec3 color = texture2D(tSource, vUv).rgb * 0.2270270270;
    color += texture2D(tSource, vUv + direction * 1.3846153846).rgb * 0.3162162162;
    color += texture2D(tSource, vUv - direction * 1.3846153846).rgb * 0.3162162162;
    color += texture2D(tSource, vUv + direction * 3.2307692308).rgb * 0.0702702703;
    color += texture2D(tSource, vUv - direction * 3.2307692308).rgb * 0.0702702703;
    gl_FragColor = vec4(color, 1.0);
  }
`;

const compositeShader = /* glsl */`
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform sampler2D tDepth;
  uniform vec2 texel;
  uniform mat4 inverseProjection;
  uniform float projectionScale;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform float exposure;
  uniform float bloomStrength;
  uniform float vignette;
  uniform float saturation;
  uniform float aoStrength;
  uniform bool useFXAA;
  uniform bool useAO;
  varying vec2 vUv;

  float viewDepth(float depth) {
    return (cameraNear * cameraFar) / (cameraFar - (cameraFar - cameraNear) * depth);
  }

  vec3 viewPosition(vec2 uv, float depth) {
    vec4 position = inverseProjection * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    return position.xyz / position.w;
  }

  float contactOcclusion(vec2 uv) {
    float depth = texture2D(tDepth, uv).x;
    vec3 position = viewPosition(uv, depth);
    // Derivatives must precede the depth-dependent exits so fragments at a
    // geometry/sky boundary do not use derivatives from divergent branches.
    vec3 dx = dFdx(position), dy = dFdy(position);
    float distance = viewDepth(depth);
    if (depth > 0.99999 || distance > 80.0) return 1.0;
    const float radius = 1.1;
    // A discontinuity is a silhouette, not a nearby contact surface. Avoid
    // the dark outlines produced by comparing unrelated foreground/background.
    if (max(length(dx), length(dy)) > radius * 0.65) return 1.0;
    vec3 crossNormal = cross(dx, dy);
    float normalLength = length(crossNormal);
    if (normalLength < 0.000001) return 1.0;
    vec3 normal = crossNormal / normalLength;
    if (dot(normal, -position) < 0.0) normal = -normal;
    float pixelRadius = clamp(radius * projectionScale / max(distance, 0.05) / texel.y, 2.0, 42.0);
    float occlusion = 0.0;
    for (int i = 0; i < 8; i++) {
      float fi = float(i);
      float angle = fi * 0.7853981634 + 0.3926990817;
      float ring = mod(fi, 2.0) < 0.5 ? 0.55 : 1.0;
      vec2 sampleUV = uv + vec2(cos(angle), sin(angle)) * texel * pixelRadius * ring;
      if (sampleUV.x < 0.0 || sampleUV.y < 0.0 || sampleUV.x > 1.0 || sampleUV.y > 1.0) continue;
      float sampleDepth = texture2D(tDepth, sampleUV).x;
      float linearDepth = viewDepth(sampleDepth);
      if (sampleDepth > 0.99999 || abs(linearDepth - distance) > radius) continue;
      vec3 delta = viewPosition(sampleUV, sampleDepth) - position;
      float separation = length(delta);
      if (separation < 0.035 || separation > radius) continue;
      float hemisphere = max(0.0, dot(normal, delta / separation) - 0.075);
      float falloff = 1.0 - smoothstep(radius * 0.25, radius, separation);
      occlusion += hemisphere * falloff;
    }
    float distanceFade = 1.0 - smoothstep(35.0, 80.0, distance);
    return 1.0 - min(0.30, occlusion * (aoStrength / 8.0) * distanceFade);
  }

  float edgeLuma(vec3 color) {
    float light = dot(color, vec3(0.299, 0.587, 0.114));
    return light / (1.0 + light);
  }

  vec3 antialias(vec2 uv) {
    vec3 middle = texture2D(tScene, uv).rgb;
    if (!useFXAA) return middle;
    vec3 northwest = texture2D(tScene, uv + vec2(-1.0, -1.0) * texel).rgb;
    vec3 northeast = texture2D(tScene, uv + vec2(1.0, -1.0) * texel).rgb;
    vec3 southwest = texture2D(tScene, uv + vec2(-1.0, 1.0) * texel).rgb;
    vec3 southeast = texture2D(tScene, uv + vec2(1.0, 1.0) * texel).rgb;
    float lumaM = edgeLuma(middle);
    float lumaNW = edgeLuma(northwest);
    float lumaNE = edgeLuma(northeast);
    float lumaSW = edgeLuma(southwest);
    float lumaSE = edgeLuma(southeast);
    float low = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
    float high = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
    // Flat surfaces need no extra directional reads.
    if (high - low < max(0.025, high * 0.09)) return middle;
    vec2 direction = vec2(-((lumaNW + lumaNE) - (lumaSW + lumaSE)),
      (lumaNW + lumaSW) - (lumaNE + lumaSE));
    float reduction = max((lumaNW + lumaNE + lumaSW + lumaSE) * 0.03125, 0.0078125);
    float reciprocal = 1.0 / (min(abs(direction.x), abs(direction.y)) + reduction);
    direction = clamp(direction * reciprocal, vec2(-8.0), vec2(8.0)) * texel;
    vec3 a = 0.5 * (texture2D(tScene, uv + direction * (-1.0 / 6.0)).rgb
      + texture2D(tScene, uv + direction * (1.0 / 6.0)).rgb);
    vec3 b = a * 0.5 + 0.25 * (texture2D(tScene, uv - direction * 0.5).rgb
      + texture2D(tScene, uv + direction * 0.5).rgb);
    float lumaB = edgeLuma(b);
    return (lumaB < low || lumaB > high) ? a : b;
  }

  vec3 filmic(vec3 color) {
    // Compact ACES fitted curve. The scene target is still linear HDR here.
    color = max(color * exposure, vec3(0.0));
    return clamp((color * (2.51 * color + 0.03)) /
      (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
  }

  void main() {
    vec3 color = antialias(vUv);
    if (useAO) color *= contactOcclusion(vUv);
    if (bloomStrength > 0.0) color += texture2D(tBloom, vUv).rgb * bloomStrength;
    color = filmic(color);
    float light = dot(color, vec3(0.2126, 0.7152, 0.0722));
    // A mild midtone S-curve deepens washed-out shadows. Its influence fades
    // before the highlight shoulder, leaving bright stone/sand detail intact.
    float shoulder = 1.0 - smoothstep(0.62, 0.96, light);
    float shapedLight = light + 0.20 * (light - 0.5) * light * (1.0 - light) * shoulder;
    color *= shapedLight / max(light, 0.0001);
    color = mix(vec3(light), color, saturation);
    // Restrained cool shadows / warm daylight; no coloured screen overlay.
    color *= mix(vec3(0.992, 1.0, 1.012), vec3(1.012, 1.002, 0.99), smoothstep(0.1, 0.85, light));
    vec2 distanceFromCenter = vUv - 0.5;
    color *= 1.0 - vignette * smoothstep(0.10, 0.5, dot(distanceFromCenter, distanceFromCenter));
    gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
    // Three selects the transfer function for the actual destination. This is
    // linear -> sRGB on the screen, and stays linear for another render target.
    #include <colorspace_fragment>
  }
`;

function shader(name, uniforms, fragmentShader) {
  const material = new THREE.ShaderMaterial({
    name, uniforms, vertexShader, fragmentShader,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    toneMapped: false,
  });
  return material;
}

/**
 * Bounded HDR pipeline for Enhanced mode only. High adds quarter-size bloom;
 * low retains a single output pass for filmic colour, FXAA and a mild vignette.
 * No history buffers, motion vectors, multisampled targets, or screen-space
 * ray tracing are allocated. All owned GPU resources have a matching dispose.
 */
export class EnhancedPostprocessing {
  constructor(renderer) {
    if (!renderer) throw new TypeError('EnhancedPostprocessing requires a renderer');
    this.renderer = renderer;
    this.quality = 'high';
    this.exposure = null; // null follows renderer.toneMappingExposure.
    this.bloomStrength = 0.12;
    this.vignette = 0.16;
    this.saturation = 1.045;
    this.fxaa = true;
    this.depthAO = true;
    this.aoStrength = 0.65;
    this.hdr = Boolean(renderer.extensions?.has?.('EXT_color_buffer_float'));
    this._type = this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this._disposed = false;
    this._requestedSize = [1, 1, 1];
    this._sceneTarget = this._target('enhanced-hdr-scene', true);
    this._depth = null;
    this._bloomA = null;
    this._bloomB = null;
    this._bright = shader('enhanced-bloom-extract', {
      tSource: { value: this._sceneTarget.texture }, texel: { value: new THREE.Vector2(1, 1) },
      threshold: { value: this.hdr ? 1.4 : 0.82 },
    }, brightShader);
    this._blur = shader('enhanced-bloom-blur', {
      tSource: { value: null }, direction: { value: new THREE.Vector2() },
    }, blurShader);
    this._composite = shader('enhanced-hdr-output', {
      tScene: { value: this._sceneTarget.texture }, tBloom: { value: null }, tDepth: { value: null },
      texel: { value: new THREE.Vector2(1, 1) }, exposure: { value: 1 },
      bloomStrength: { value: 0 }, vignette: { value: this.vignette },
      saturation: { value: this.saturation }, useFXAA: { value: this.fxaa },
      inverseProjection: { value: new THREE.Matrix4() }, projectionScale: { value: 0.5 },
      cameraNear: { value: 0.1 }, cameraFar: { value: 1000 },
      useAO: { value: false }, aoStrength: { value: this.aoStrength },
    }, compositeShader);
    this._geometry = new THREE.BufferGeometry();
    this._geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this._geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this._quad = new THREE.Mesh(this._geometry, this._composite);
    this._quad.frustumCulled = false;
    this._screenScene = new THREE.Scene();
    this._screenScene.add(this._quad);
    this._camera = new THREE.Camera();
    this._savedViewport = new THREE.Vector4();
    this._savedScissor = new THREE.Vector4();
    const size = renderer.getSize?.(new THREE.Vector2()) ?? new THREE.Vector2(1, 1);
    this.setSize(size.x, size.y, renderer.getPixelRatio?.() ?? 1);
  }

  _target(name, depthBuffer = false) {
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: this._type, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer, stencilBuffer: false, samples: 0,
      colorSpace: THREE.LinearSRGBColorSpace, generateMipmaps: false,
    });
    target.texture.name = name;
    return target;
  }

  get diagnostics() {
    const scenePixels = this._sceneTarget.width * this._sceneTarget.height;
    const bloomPixels = this._bloomA ? this._bloomA.width * this._bloomA.height : 0;
    return {
      quality: this.quality, hdr: this.hdr, depthAO: Boolean(this._depth && this.depthAO),
      passes: this.quality === 'high' ? 5 : 2,
      renderWidth: this._sceneTarget.width, renderHeight: this._sceneTarget.height,
      bloomWidth: this._bloomA?.width ?? 0, bloomHeight: this._bloomA?.height ?? 0,
      // Approximate colour + depth storage, excluding driver alignment.
      estimatedBytes: scenePixels * ((this.hdr ? 8 : 4) + 4) + bloomPixels * 2 * (this.hdr ? 8 : 4),
    };
  }

  setQuality(quality) {
    if (!Object.hasOwn(QUALITY, quality)) throw new RangeError(`Unknown postprocessing quality: ${quality}`);
    if (this._disposed) return this;
    if (quality === this.quality) return this;
    this.quality = quality;
    this.setSize(...this._requestedSize);
    return this;
  }

  setSize(width, height, pixelRatio = 1) {
    if (this._disposed) return this;
    width = Number.isFinite(width) && width > 0 ? width : 1;
    height = Number.isFinite(height) && height > 0 ? height : 1;
    pixelRatio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
    this._requestedSize = [width, height, pixelRatio];
    const maximumSize = this.renderer.capabilities?.maxTextureSize ?? 4096;
    const factor = Math.min(1, Math.sqrt(QUALITY[this.quality].maxPixels / (width * height * pixelRatio * pixelRatio)),
      maximumSize / (width * pixelRatio), maximumSize / (height * pixelRatio));
    const renderWidth = Math.max(1, Math.floor(width * pixelRatio * factor));
    const renderHeight = Math.max(1, Math.floor(height * pixelRatio * factor));
    const sizeChanged = renderWidth !== this._sceneTarget.width || renderHeight !== this._sceneTarget.height;
    const wantDepth = this.quality === 'high' && this.depthAO;
    let detachedDepth = false;
    if (this._depth && (!wantDepth || sizeChanged)) {
      // Detach before target disposal: Three also disposes an attached depth
      // texture, which would otherwise duplicate ownership on resize/toggle.
      this._sceneTarget.depthTexture = null;
      this._depth.dispose();
      this._depth = null;
      detachedDepth = true;
      if (!sizeChanged) this._sceneTarget.dispose();
    }
    this._sceneTarget.setSize(renderWidth, renderHeight);
    if (wantDepth && !this._depth) {
      if (!sizeChanged && !detachedDepth) this._sceneTarget.dispose();
      this._depth = new THREE.DepthTexture(renderWidth, renderHeight, THREE.UnsignedIntType);
      this._depth.name = 'enhanced-contact-depth';
      this._depth.minFilter = this._depth.magFilter = THREE.NearestFilter;
      this._depth.generateMipmaps = false;
      this._sceneTarget.depthTexture = this._depth;
    }
    this._composite.uniforms.tDepth.value = this._depth;
    this._bright.uniforms.texel.value.set(1 / renderWidth, 1 / renderHeight);
    this._composite.uniforms.texel.value.set(1 / renderWidth, 1 / renderHeight);
    if (QUALITY[this.quality].bloom) {
      this._bloomA ??= this._target('enhanced-bloom-a');
      this._bloomB ??= this._target('enhanced-bloom-b');
      this._bloomA.setSize(Math.max(1, Math.ceil(renderWidth / 4)), Math.max(1, Math.ceil(renderHeight / 4)));
      this._bloomB.setSize(this._bloomA.width, this._bloomA.height);
      this._composite.uniforms.tBloom.value = this._bloomA.texture;
    } else {
      this._bloomA?.dispose();
      this._bloomB?.dispose();
      this._bloomA = this._bloomB = null;
      this._composite.uniforms.tBloom.value = null;
    }
    return this;
  }

  _pass(material, destination) {
    this._quad.material = material;
    this.renderer.setRenderTarget(destination);
    this.renderer.render(this._screenScene, this._camera);
  }

  render(scene, camera) {
    if (this._disposed) throw new Error('EnhancedPostprocessing has been disposed');
    const renderer = this.renderer;
    const destination = renderer.getRenderTarget();
    const cubeFace = renderer.getActiveCubeFace?.() ?? 0;
    const mipmapLevel = renderer.getActiveMipmapLevel?.() ?? 0;
    const autoClear = renderer.autoClear;
    const toneMapping = renderer.toneMapping;
    const scissorTest = renderer.getScissorTest?.() ?? false;
    const infoAutoReset = renderer.info?.autoReset;
    renderer.getViewport?.(this._savedViewport);
    renderer.getScissor?.(this._savedScissor);
    const uniforms = this._composite.uniforms;
    uniforms.exposure.value = Math.max(0.01, Math.min(8, this.exposure ?? renderer.toneMappingExposure ?? 1));
    uniforms.bloomStrength.value = this._bloomA ? this.bloomStrength * (this.hdr ? 1 : 0.65) : 0;
    uniforms.vignette.value = this.vignette;
    uniforms.saturation.value = this.saturation;
    uniforms.useFXAA.value = Boolean(this.fxaa);
    uniforms.useAO.value = Boolean(this._depth && this.depthAO && camera.isPerspectiveCamera);
    uniforms.aoStrength.value = this.aoStrength;
    if (uniforms.useAO.value) {
      uniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);
      uniforms.projectionScale.value = camera.projectionMatrix.elements[5] * 0.5;
      uniforms.cameraNear.value = camera.near;
      uniforms.cameraFar.value = camera.far;
    }
    try {
      renderer.autoClear = false;
      // HDR radiance must reach the scene target without a first tone map.
      renderer.toneMapping = THREE.NoToneMapping;
      if (renderer.info) {
        if (infoAutoReset) renderer.info.reset();
        renderer.info.autoReset = false;
      }
      renderer.setRenderTarget(this._sceneTarget);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
      if (this._bloomA) {
        this._pass(this._bright, this._bloomA);
        this._blur.uniforms.tSource.value = this._bloomA.texture;
        this._blur.uniforms.direction.value.set(1 / this._bloomA.width, 0);
        this._pass(this._blur, this._bloomB);
        this._blur.uniforms.tSource.value = this._bloomB.texture;
        this._blur.uniforms.direction.value.set(0, 1 / this._bloomB.height);
        this._pass(this._blur, this._bloomA);
      }
      renderer.setRenderTarget(destination, cubeFace, mipmapLevel);
      if (destination === null) {
        renderer.setViewport?.(this._savedViewport);
        renderer.setScissor?.(this._savedScissor);
      }
      renderer.setScissorTest?.(scissorTest);
      this._quad.material = this._composite;
      renderer.render(this._screenScene, this._camera);
    } finally {
      renderer.setRenderTarget(destination, cubeFace, mipmapLevel);
      if (destination === null) {
        renderer.setViewport?.(this._savedViewport);
        renderer.setScissor?.(this._savedScissor);
      }
      renderer.setScissorTest?.(scissorTest);
      renderer.autoClear = autoClear;
      renderer.toneMapping = toneMapping;
      if (renderer.info) renderer.info.autoReset = infoAutoReset;
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._sceneTarget.depthTexture = null;
    this._depth?.dispose();
    this._depth = null;
    this._sceneTarget.dispose();
    this._bloomA?.dispose();
    this._bloomB?.dispose();
    this._bloomA = this._bloomB = null;
    this._bright.dispose();
    this._blur.dispose();
    this._composite.dispose();
    this._geometry.dispose();
    this._quad.removeFromParent();
  }
}
