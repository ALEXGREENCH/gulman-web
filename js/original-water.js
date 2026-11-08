import * as THREE from 'three';
import { extractWaterSurfaces } from './enhanced-water.js?v=20261109-10';

// A visual reconstruction of the pale, sky-coloured sea in the original
// beach footage. Rendering WATER.JPG as an ordinary Lambert material produced
// an opaque olive surface. This is a reference-matched reconstruction, not
// a recovered GLScene shader. This is deliberately a flat,
// single-pass surface, independent of Enhanced's displaced/PBR ocean.
export class OriginalWater {
  constructor({ scene, world, modelData, sky, levelId }) {
    this.enabled = false;
    this.disposed = false;
    this.sources = new Map();
    this.parts = [];
    this.root = new THREE.Group();
    this.root.name = 'original-water';
    this.root.visible = false;
    this.root.userData.graphicsOwned = true;
    this.time = { value: 0 };
    // Only the first mission has been compared against original footage.
    if (Number(levelId) !== 1 || !sky?.isTexture) return;
    const surfaces = extractWaterSurfaces(modelData);
    world.updateWorldMatrix(true, true);
    for (const name of new Set(surfaces.map(surface => `world:${surface.material}`))) {
      const source = world.getObjectByName(name);
      if (!source?.isMesh || Array.isArray(source.material)) continue;
      const rippleMap = source.material.map;
      const material = new THREE.ShaderMaterial({
        name: 'Original / beach sky reflection',
        uniforms: { seaTime: this.time, seaSky: { value: sky }, seaRipple: { value: rippleMap } },
        vertexShader: /* glsl */`
          varying vec3 seaPosition;
          varying vec2 seaUv;
          void main() {
            vec4 world = modelMatrix * vec4(position, 1.0);
            seaPosition = world.xyz;
            seaUv = uv;
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: /* glsl */`
          uniform sampler2D seaSky;
          uniform sampler2D seaRipple;
          uniform float seaTime;
          varying vec3 seaPosition;
          varying vec2 seaUv;
          #include <common>
          void main() {
            vec3 eye = normalize(cameraPosition - seaPosition);
            // Slow, broad reflection bands, not geometric swells or foam.
            float roll = sin(seaPosition.z * 0.19 + seaTime * 0.28);
            float crossRoll = sin(seaPosition.x * 0.11 + seaPosition.z * 0.07 - seaTime * 0.19);
            float ripple = texture2D(seaRipple, seaUv + vec2(seaTime * 0.0007, 0.0)).r - 0.5;
            vec3 normal = normalize(vec3(crossRoll * 0.025, 1.0, roll * 0.045 + ripple * 0.012));
            vec3 reflected = reflect(-eye, normal);
            // The source is a cloud/horizon strip, not an HDR panorama.
            // Keep its white horizon and blue upper portion above the sea.
            vec2 skyUv = vec2(atan(reflected.z, reflected.x) / PI2 + 0.5,
              clamp(0.72 - asin(clamp(reflected.y, 0.0, 1.0)) / PI * 2.0, 0.28, 0.82));
            vec2 blur = vec2(0.055, 0.018);
            vec3 sky = texture2D(seaSky, skyUv).rgb * 0.5
              + (texture2D(seaSky, skyUv + blur).rgb + texture2D(seaSky, skyUv - blur).rgb) * 0.25;
            vec3 water = mix(vec3(0.43, 0.64, 0.76), sky, 0.82);
            float haze = 1.0 - smoothstep(0.0, 0.14, max(eye.y, 0.0));
            water = mix(water, vec3(0.87, 0.94, 0.97), haze * 0.55);
            gl_FragColor = vec4(water, 1.0);
            #include <colorspace_fragment>
          }
        `,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      material.userData.graphicsOwned = true;
      // Borrow the original geometry and its exact world transform. Nothing
      // changes in the collision tree, the shoreline, UVs or source assets.
      const mesh = new THREE.Mesh(source.geometry, material);
      mesh.name = `original-water:${name}`;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(source.matrixWorld);
      mesh.userData.graphicsOwned = true;
      mesh.userData.collision = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.parts.push({ mesh, source, material });
      this.root.add(mesh);
    }
    if (this.parts.length) scene.add(this.root);
  }

  get diagnostics() {
    return { enabled: this.enabled && this.parts.length > 0, surfaces: this.parts.length };
  }

  setEnabled(enabled) {
    if (this.disposed || this.enabled === Boolean(enabled)) return;
    this.enabled = Boolean(enabled);
    this.root.visible = this.enabled;
    if (this.enabled) {
      for (const { source, mesh } of this.parts) {
        this.sources.set(source, source.visible);
        mesh.visible = source.visible;
        source.visible = false;
      }
    } else {
      for (const [source, visible] of this.sources) source.visible = visible;
      this.sources.clear();
    }
  }

  update(dt) {
    if (this.enabled && !this.disposed && Number.isFinite(dt) && dt > 0) this.time.value += Math.min(dt, 0.1);
  }

  dispose() {
    if (this.disposed) return;
    this.setEnabled(false);
    this.root.removeFromParent();
    // Geometry and textures belong to Assets, not this layer.
    for (const { material } of this.parts) material.dispose();
    this.root.clear();
    this.parts.length = 0;
    this.disposed = true;
  }
}
