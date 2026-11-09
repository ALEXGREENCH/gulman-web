import * as THREE from 'three';
import { humanAnatomy } from '../assets/enhanced/characters/human-anatomy.js?v=20261109-10';
import { poseAnatomicalHandPoint } from './human-hand-pose.js?v=20261109-10';

async function loadEnhancedWeapon(index) {
  const { createEnhancedWeapon } = await import('./enhanced-weapons.js?v=20261109-10');
  return createEnhancedWeapon(index);
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const smooth = (value, target, rate, dt) => value + (target - value) * (1 - Math.exp(-rate * dt));
const UP = new THREE.Vector3(0, 1, 0);
const ADS_CLEARANCE = 0.035;
function throwTransform(time) {
  const poses = [[0,0,0,0,0,0,0],[.16,-.07,.06,0,-.2,.1,.1],[.34,0,.18,.02,-.65,.12,.20],
    [.46,-.05,.12,-.22,.35,-.2,-.25],[.64,-.13,-.08,-.23,.6,-.15,-.3],[1.05,0,0,0,0,0,0]];
  let i=0;while(i<poses.length-2&&time>poses[i+1][0])i++;
  let t=clamp((time-poses[i][0])/(poses[i+1][0]-poses[i][0]),0,1);t=t*t*(3-2*t);
  return poses[i].slice(1).map((value,j)=>THREE.MathUtils.lerp(value,poses[i+1][j+1],t));
}

function flashTexture() {
  const size = 64, pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x + 0.5 - size / 2) / (size / 2), dy = (y + 0.5 - size / 2) / (size / 2);
    const radius = Math.hypot(dx, dy), angle = Math.atan2(dy, dx);
    const star = Math.pow(Math.max(0, 1 - radius / (0.38 + 0.42 * Math.pow(Math.abs(Math.cos(angle * 3)), 10))), 1.4);
    const glow = Math.max(0, 1 - radius) ** 4, alpha = Math.min(1, star + glow * 0.6);
    const offset = (y * size + x) * 4;
    pixels[offset] = 255; pixels[offset + 1] = 150 + Math.round(glow * 105); pixels[offset + 2] = 35 + Math.round(glow * 200); pixels[offset + 3] = Math.round(alpha * 255);
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function gloveTexture() {
  const size = 64, pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const offset = (y * size + x) * 4;
    const threadX = Math.sin(x * Math.PI / 2), threadY = Math.sin(y * Math.PI / 2);
    const crossing = ((x >> 2) + (y >> 2)) % 2 ? 1 : 0.4;
    pixels.set([128 + Math.round(threadX * 13 * crossing), 128 + Math.round(threadY * 13 * (1.4 - crossing)), 253, 255], offset);
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(8, 8); texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter;
  texture.userData.graphicsOwned = true; texture.needsUpdate = true;
  return texture;
}

/** Enhanced-only authored weapons, textured gloves and secondary motion.
 * Camera space uses -Z forward. Add group to the camera and camera to scene.
 * Original-mode models and asset caches are never read or modified here. */
export class ProceduralViewmodel {
  constructor({ assets, onError = () => {}, weaponFactory = loadEnhancedWeapon } = {}) {
    this.assets = assets;
    this.onError = onError;
    this._weaponFactory = weaponFactory;
    this.group = new THREE.Group();
    this.group.name = 'first-person-weapons';
    this.group.userData.graphicsOwned = true;
    this.group.visible = false;
    this.mount = new THREE.Group();
    this.group.add(this.mount);
    this.weapon = 0;
    this._generation = 0;
    this._disposed = false;
    this._visible = true;
    this._model = null;
    this._weaponRecord = null;
    this._ownedGeometry = new Set();
    this._ownedMaterials = new Set();
    this._muzzle = new THREE.Vector3(0, 0, -0.3);
    this._hip = new THREE.Vector3(0.21, -0.205, -0.38);
    this._aim = new THREE.Vector3(0, -0.07, -0.38);
    this._position = this._hip.clone();
    this._rotation = new THREE.Vector3();
    this._aimAmount = 0;
    this._sprintAmount = 0;
    this._bob = 0;
    this._phase = 0;
    this._swayX = this._swayY = this._landing = 0;
    this._lastGrounded = true;
    this._clock = 0;
    this._equip = 0;
    this._support = new THREE.Vector3(-0.045, -0.05, -0.015);
    this._clearanceCorner = new THREE.Vector3();
    this._gloveTexture = gloveTexture();
    this._makeHands();
    this._flashTexture = flashTexture();
    this._flashTexture.userData.graphicsOwned = true;
    this._flashes = Array.from({ length: 3 }, () => {
      const material = new THREE.SpriteMaterial({ map: this._flashTexture, color: 0xffe2ad, transparent: true,
        blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
      const sprite = new THREE.Sprite(material);
      sprite.userData.graphicsOwned = true;
      sprite.renderOrder = 10030;
      sprite.visible = false;
      this.mount.add(sprite);
      return { sprite, life: 0 };
    });
    this._flashCursor = 0;
    this.update(0, {});
  }

  _material(color, roughness = 0.82) {
    const material = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.04, emissive: 0x070909,
      normalMap: this._gloveTexture, normalScale: new THREE.Vector2(0.22, 0.22),
      transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
    this._ownedMaterials.add(material);
    return material;
  }

  _makeHands() {
    const rubber = this._material(0x171b1d), fabric = this._material(0x282d2b), cuff = this._material(0x3b4138);
    const hand = side => {
      const root = new THREE.Group(); root.name = side > 0 ? 'right-gloved-hand' : 'left-gloved-hand'; this.mount.add(root);
      const source = humanAnatomy.parts[side > 0 ? 'rightHand' : 'leftHand'];
      const anatomy = open => {
        const values = [];
        for (let i=0;i<source.positions.length;i+=3) {
          const p = open ? source.positions.slice(i,i+3) : poseAnatomicalHandPoint(source,...source.positions.slice(i,i+3),side>0);
          values.push(.025*side + p[2]*side*.86, -p[0]*side*.86, .075-p[1]*.86);
        }
        const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(values,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(source.uv,2));geometry.setIndex(source.indices);geometry.computeVertexNormals();this._ownedGeometry.add(geometry);return geometry;
      };
      const closed=anatomy(false),open=anatomy(true);
      const palm=new THREE.Mesh(closed,rubber);palm.name='MakeHuman anatomical glove';palm.userData.anatomicalSource='MakeHuman hm08 CC0';root.add(palm);
      root.userData.closedGeometry=closed;root.userData.openGeometry=open;root.userData.palm=palm;
      // A continuous cloth sleeve and flat wrist strap, with no spherical joints.
      const sleeve=new THREE.CylinderGeometry(.035,.047,.31,12,3,true);
      const direction=new THREE.Vector3(.13*side,-.23,.24),rotation=new THREE.Quaternion().setFromUnitVectors(UP,direction.clone().normalize());
      sleeve.applyQuaternion(rotation);sleeve.translate(.065*side,-.115,.195);this._ownedGeometry.add(sleeve);
      const sleeveMesh=new THREE.Mesh(sleeve,fabric);sleeveMesh.name='glove-sleeve';root.add(sleeveMesh);
      root.userData.sleeve=sleeveMesh;
      const throwGeometry=new THREE.BufferGeometry(),segments=8,radial=12,indices=[];
      throwGeometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(((segments+1)*(radial+1)+2)*3),3));
      const uv=[];for(let ring=0;ring<=segments;ring++)for(let side=0;side<=radial;side++)uv.push(side/radial,ring/segments);uv.push(.5,0,.5,1);throwGeometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
      for(let ring=0;ring<segments;ring++)for(let side=0;side<radial;side++){const a=ring*(radial+1)+side,b=a+radial+1;indices.push(a,b,a+1,a+1,b,b+1);}
      const cap=(segments+1)*(radial+1);for(let side=0;side<radial;side++){indices.push(cap,side,side+1);const end=segments*(radial+1)+side;indices.push(cap+1,end+1,end);}
      throwGeometry.setIndex(indices);this._ownedGeometry.add(throwGeometry);
      const throwSleeve=new THREE.Mesh(throwGeometry,fabric);throwSleeve.name='camera-anchored-throw-sleeve';throwSleeve.userData.graphicsOwned=true;throwSleeve.visible=false;throwSleeve.frustumCulled=false;throwSleeve.renderOrder=10009;this.group.add(throwSleeve);
      root.userData.throwSleeve=throwSleeve;root.userData.side=side;
      const strap=new THREE.BoxGeometry(.071,.026,.033);strap.translate(.025*side,-.017,.070);this._ownedGeometry.add(strap);root.add(new THREE.Mesh(strap,cuff));
      root.traverse(object=>{if(object.isMesh){object.userData.graphicsOwned=true;object.renderOrder=10010;object.frustumCulled=false;}});
      return root;
    };
    this.rightHand=hand(1);this.leftHand=hand(-1);
    this.rightHand.position.set(.004,-.034,.012);this.rightHand.rotation.set(-.15,0,-.1);
    this.leftHand.position.set(-.045,-.05,-.015);this.leftHand.rotation.set(-.15,-.3,.3);
  }

  _releaseModel() {
    this._weaponRecord?.dispose();
    this._weaponRecord = null;
    this._model = null;
  }

  _updateThrowSleeves(throwing) {
    this.group.updateWorldMatrix(true,true);
    for(const hand of [this.rightHand,this.leftHand]){
      const sleeve=hand.userData.throwSleeve,side=hand.userData.side;
      hand.userData.sleeve.visible=!throwing;sleeve.visible=throwing&&hand.visible;
      if(!sleeve.visible)continue;
      // Wrist follows the animated hand; elbow and upper sleeve remain tied
      // to the off-screen body in camera space. No cut end can float in frame.
      const start=this.group.worldToLocal(hand.localToWorld(new THREE.Vector3(.025*side,0,.075)));
      const elbow=new THREE.Vector3(.46*side,-.38,-.40),end=new THREE.Vector3(.62*side,-.65,-.28);
      const positions=sleeve.geometry.attributes.position,segments=8,radial=12;
      for(let ring=0;ring<=segments;ring++){
        const t=ring/segments,one=1-t,center=start.clone().multiplyScalar(one*one).addScaledVector(elbow,2*one*t).addScaledVector(end,t*t);
        const axis=elbow.clone().sub(start).multiplyScalar(one).addScaledVector(end.clone().sub(elbow),t).normalize();
        const width=new THREE.Vector3().crossVectors(axis,new THREE.Vector3(0,0,1)).normalize(),depth=new THREE.Vector3().crossVectors(width,axis).normalize();
        const radius=THREE.MathUtils.lerp(.034,.057,t);
        for(let side=0;side<=radial;side++){const angle=side/radial*Math.PI*2,p=center.clone().addScaledVector(width,Math.cos(angle)*radius).addScaledVector(depth,Math.sin(angle)*radius);positions.setXYZ(ring*(radial+1)+side,p.x,p.y,p.z);}
      }
      const cap=(segments+1)*(radial+1);positions.setXYZ(cap,start.x,start.y,start.z);positions.setXYZ(cap+1,end.x,end.y,end.z);positions.needsUpdate=true;sleeve.geometry.computeVertexNormals();sleeve.geometry.computeBoundingBox();
    }
  }

  async _originalGrenade() {
    if (!this.assets?.model) throw new Error('Original grenade asset loader missing');
    const model = await this.assets.model('models/weapons/granate.3ds', true), materials = new Set();
    model.rotation.x = -Math.PI / 2; model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const scale = .13 / Math.max(size.x,size.y,size.z,.001);
    model.position.sub(center).multiplyScalar(scale); model.scale.multiplyScalar(scale);
    model.traverse(object=>{if(!object.isMesh)return;object.userData.graphicsOwned=true;object.castShadow=object.receiveShadow=false;object.renderOrder=10005;object.frustumCulled=false;
      const copy=material=>{const own=material.clone();Object.assign(own,{transparent:true,depthTest:false,depthWrite:false,fog:false,toneMapped:false});own.userData.graphicsOwned=true;materials.add(own);return own;};
      object.material=Array.isArray(object.material)?object.material.map(copy):copy(object.material);
    });
    const group=new THREE.Group();group.name='original-viewmodel-grenade';group.add(model);group.updateMatrixWorld(true);
    const bounds=new THREE.Box3().setFromObject(group);
    return {group,bounds,muzzle:bounds.getCenter(new THREE.Vector3()),support:new THREE.Vector3(),update(){},shot(){},dispose(){group.removeFromParent();for(const material of materials)material.dispose();materials.clear();}};
  }

  async setWeapon(index, {original = false} = {}) {
    if (this._disposed) return false;
    const selected = Number.isInteger(index) && index >= 0 && index < 4 ? index : 0;
    const originalGrenade=Boolean(original&&selected===2);
    const token = ++this._generation;
    if (!this._disposed && this._weaponRecord && this.weapon === selected && this._originalGrenadeMode===originalGrenade) return true;
    let candidate;
    try {
      candidate = originalGrenade ? await this._originalGrenade() : await this._weaponFactory(selected);
      if (this._disposed || token !== this._generation) { candidate?.dispose(); return false; }
      if (!candidate?.group || !candidate.muzzle || !candidate.bounds) throw new Error('Пустая модель оружия');
      this._releaseModel();
      this._weaponRecord = candidate;
      this._model = candidate.group;
      this.mount.add(candidate.group);
      this.weapon = selected;
      this._originalGrenadeMode=originalGrenade;
      this._muzzle.copy(candidate.muzzle);
      this._aim.set(-this._muzzle.x, -candidate.bounds.max.y - ADS_CLEARANCE, -0.38);
      this._hip.set(selected === 2 ? 0.20 : 0.21, Math.min(selected === 2 ? -0.18 : -0.205, -candidate.bounds.max.y - 0.055), selected === 2 ? -0.58 : -0.38);
      this._support.copy(candidate.support);
      this.leftHand.visible = selected !== 2;
      this.leftHand.position.copy(this._support);
      this.group.visible = this._visible;
      this._position.copy(this._hip);
      this._equip = 1;
      return true;
    } catch (error) {
      if (candidate && candidate !== this._weaponRecord) candidate.dispose();
      if (!this._disposed && token === this._generation) this.onError('Не удалось загрузить оружие от первого лица: ' + error.message, error);
      return false;
    }
  }

  setVisible(visible) { this._visible = Boolean(visible); this.group.visible = this._visible && Boolean(this._model) && !this._disposed; return this; }

  update(dt, { speed = 0, sprinting = false, aiming = 0, reloadProgress = 0, reloading = false,
    recoil = {}, movementX = 0, movementY = 0, grounded = true, landing = 0, grenadeThrow = null } = {}) {
    if (this._disposed) return this;
    const seconds = clamp(finite(dt), 0, 0.25), aimTarget = clamp(Number(aiming) || 0, 0, 1);
    const throwing=this.weapon===2&&Boolean(grenadeThrow?.active), thrown=throwing&&Boolean(grenadeThrow.released);
    if(throwing){aiming=0;sprinting=false;reloading=false;}
    this._clock += seconds;
    this._equip *= Math.exp(-seconds * 13);
    this._weaponRecord?.update(seconds, { reloading, reloadProgress });
    this._aimAmount = smooth(this._aimAmount, sprinting || reloading || throwing ? 0 : aimTarget, 18, seconds);
    if(throwing)this._aimAmount=0;
    this._sprintAmount = smooth(this._sprintAmount, sprinting ? 1 : 0, 13, seconds);
    const walk = clamp(Math.abs(finite(speed)) / 4.3, 0, 1.8) * (grounded ? 1 : 0);
    this._bob = smooth(this._bob, walk, 10, seconds);
    this._phase += seconds * (sprinting ? 13 : 9) * Math.max(0.25, walk);
    const lookX = clamp(finite(movementX) * 0.0018, -0.07, 0.07), lookY = clamp(finite(movementY) * 0.0018, -0.05, 0.05);
    this._swayX = smooth(this._swayX, lookX, 15, seconds);
    this._swayY = smooth(this._swayY, lookY, 15, seconds);
    if ((!this._lastGrounded && grounded) || landing) this._landing = Math.max(this._landing, clamp(finite(landing) || 0.7, 0, 1.5));
    this._lastGrounded = Boolean(grounded);
    this._landing *= Math.exp(-seconds * 10);
    const aim = this._aimAmount, sprint = this._sprintAmount, bob = this._bob * (1 - aim * 0.94);
    const reload = reloading ? Math.sin(Math.PI * clamp(finite(reloadProgress), 0, 1)) : 0;
    const recoilPitch = clamp(finite(recoil.pitch), -0.1, 0.2), recoilYaw = clamp(finite(recoil.yaw), -0.1, 0.1);
    const breathing = (Math.sin(this._clock * 1.7) + Math.sin(this._clock * 2.31) * 0.25) * 0.0007 * (1 - aim * 0.8);
    const x = this._hip.x * (1 - aim) + this._aim.x * aim + Math.sin(this._phase) * 0.006 * bob - this._swayX * 0.13 * (1 - aim * 0.8) - sprint * 0.08;
    const y = this._hip.y * (1 - aim) + this._aim.y * aim + Math.cos(this._phase * 2) * 0.005 * bob + breathing - this._landing * 0.022 - sprint * 0.11 - reload * 0.13 - this._equip * 0.11;
    const z = this._hip.z * (1 - aim) + this._aim.z * aim + recoilPitch * 1.2 + sprint * 0.075 + reload * 0.10 + this._equip * 0.045;
    this._position.set(smooth(this._position.x, x, 22, seconds), smooth(this._position.y, y, 22, seconds), smooth(this._position.z, z, 28, seconds));
    this.mount.position.copy(this._position);
    this._rotation.set(recoilPitch * 1.5 - this._swayY * (1 - aim * 0.85) - sprint * 0.30 - reload * 0.7 - this._equip * 0.25,
      recoilYaw - this._swayX * (1 - aim * 0.85) + sprint * 0.35 + reload * 0.3,
      Math.sin(this._phase) * 0.014 * bob - sprint * 0.45 - reload * 0.55);
    this.mount.rotation.set(this._rotation.x, this._rotation.y, this._rotation.z);
    // Keep recoil/sway from sweeping the rear sight or an optic over the
    // reticle. The cached neutral bound makes this eight cheap corner checks,
    // independent of model detail and without per-frame geometry traversal.
    if (aim > 0.55 && !reloading && this._weaponRecord) {
      const bounds = this._weaponRecord.bounds;
      let top = -Infinity;
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        top = Math.max(top, this._clearanceCorner.set(x, y, z).applyQuaternion(this.mount.quaternion).y);
      }
      this.mount.position.y = Math.min(this.mount.position.y, -0.025 - top);
    }
    // Support hand leaves the fore-end during the middle of the reload.
    this.leftHand.position.copy(this._support);
    this.leftHand.position.y -= reload * 0.13;
    this.leftHand.position.z += reload * 0.09;
    this.leftHand.rotation.set(-0.15 + reload * 1.1,-.3,.3);
    this.leftHand.visible=this.weapon!==2;
    this.rightHand.userData.palm.geometry=thrown?this.rightHand.userData.openGeometry:this.rightHand.userData.closedGeometry;
    if(this._model)this._model.visible=!thrown;
    if(throwing){
      const [tx,ty,tz,rx,ry,rz]=throwTransform(grenadeThrow.time);
      this.mount.position.add(new THREE.Vector3(tx,ty,tz));this.mount.rotation.x+=rx;this.mount.rotation.y+=ry;this.mount.rotation.z+=rz;
      const pull=clamp(grenadeThrow.time/.30,0,1);
      this.leftHand.visible=grenadeThrow.time<.28-1e-6;
      this.leftHand.position.set(-.035-pull*.16,.035-pull*.07,-.035+pull*.04);
      this.leftHand.rotation.set(-.4,-.5,.5);
    }
    this._updateThrowSleeves(throwing);
    for (const flash of this._flashes) {
      flash.life = Math.max(0, flash.life - seconds);
      flash.sprite.visible = flash.life > 0;
      flash.sprite.material.opacity = clamp(flash.life / 0.045, 0, 1);
    }
    return this;
  }

  flash() {
    if (this._disposed || !this._model) return false;
    this._weaponRecord?.shot();
    if (this.weapon === 2) return false;
    const flash = this._flashes[this._flashCursor++ % this._flashes.length];
    flash.life = 0.045;
    flash.sprite.position.copy(this._muzzle); flash.sprite.position.z -= 0.012;
    flash.sprite.scale.setScalar(this.weapon === 3 ? 0.24 : this.weapon === 1 ? 0.17 : 0.13);
    flash.sprite.material.rotation = (this._flashCursor * 2.39996) % (Math.PI * 2);
    flash.sprite.material.opacity = 1; flash.sprite.visible = true;
    return true;
  }

  muzzleWorldPosition(target = new THREE.Vector3()) {
    this.group.updateWorldMatrix(true, true);
    return this.mount.localToWorld(target.copy(this._muzzle));
  }

  grenadeReleaseWorldPosition(target = new THREE.Vector3()) {
    if(this.weapon!==2||!this._weaponRecord)return null;
    this.group.updateWorldMatrix(true,true);
    this._weaponRecord.bounds.getCenter(target);
    return this.mount.localToWorld(target);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true; this._generation++;
    this.group.removeFromParent(); this.group.visible = false;
    this._releaseModel();
    for (const geometry of this._ownedGeometry) geometry.dispose();
    for (const material of this._ownedMaterials) material.dispose();
    for (const { sprite } of this._flashes) sprite.material.dispose();
    this._flashTexture.dispose();
    this._gloveTexture.dispose();
    this._ownedGeometry.clear(); this._ownedMaterials.clear();
  }
}
