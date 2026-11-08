import * as THREE from 'three';

/** Recovered from the original Game.dll weapon table at VA 0x52AC84–0x52ACDA
 * and firing routines 0x52A0AC/0x52A1E4/0x52A318/0x52A408. World units / 100.
 * Damage is the original base value; pistol/rifle add Random(5)/Random(15).
 * Browser balancing can override damage without turning these into hitscan.
 */
export const ORIGINAL_PROJECTILE_WEAPONS=Object.freeze([
  Object.freeze({speed:50,life:.5,size:3.6,damage:16,damageRandom:5,interval:.4,count:1,color:'blue',splash:0,gravity:5}),
  Object.freeze({speed:40,life:3,size:3,damage:43,damageRandom:15,interval:.17,count:1,color:'blue',splash:0,gravity:4}),
  Object.freeze({speed:12,life:1.5,size:.14,damage:72,damageRandom:0,interval:1,count:1,color:'grenade',splash:6,gravity:10.8}),
  Object.freeze({speed:40,life:1,size:.44,damage:218,damageRandom:0,interval:.7,count:8,color:'yellow',splash:4,gravity:0}),
]);
const BLUE='textures/3q.jpg',YELLOW='textures/2q.jpg';
const LOOT_MODELS=Object.freeze({
  'БАКСЫ':'models/инвентарь/баксы/баксы.3ds',
  'ПАТРОНЫ':'models/инвентарь/патроны/shell_box.3ds',
  'АПТЕЧКА':'models/инвентарь/аптека/aptechka.3ds',
});
const finiteRandom=random=>Math.max(0,Math.min(.999999999,Number(random())||0));
const integer=(random,max)=>Math.floor(finiteRandom(random)*max);

/** Keep a gun whose rendered barrel overlaps a thin wall from firing behind it. */
export function safeProjectileOrigin(eye,muzzle,world){
  const direction=muzzle.clone().sub(eye),distance=direction.length();
  if(distance<.001)return muzzle.clone();
  direction.divideScalar(distance);
  const hit=world?.ray?.(eye,direction,distance);
  return hit?hit.position.clone().addScaledVector(direction,-.04):muzzle.clone();
}

/** Pickup parser VA 0x5254A5–0x5256E4 ignores the command's numeric token.
 * The web game's shared ammunition pool receives the sum of the four grants;
 * ammoByWeapon retains the original distribution for a future separate pool.
 */
export function rollOriginalPickup(command,{random=Math.random}={}){
  if(command==='БАКСЫ')return {amount:20+integer(random,20)};
  if(command==='АПТЕЧКА')return {amount:7+integer(random,10),maxHealth:120};
  if(command==='ПАТРОНЫ'){
    const ammoByWeapon=[5+integer(random,5),15+integer(random,10),0,0];
    if(integer(random,7)===5)ammoByWeapon[2]=1+integer(random,2);
    if(integer(random,9)===5)ammoByWeapon[3]=2+integer(random,3);
    return {amount:ammoByWeapon.reduce((sum,n)=>sum+n,0),ammoByWeapon};
  }
  return {amount:0};
}

/** Original death routine 0x5276C8: money always, ammo Random(5)==3,
 * health Random(7)==3. The >1> command token is not a quantity: see pickup
 * parser above. Offsets are Random(99)-Random(99).
 * Only placement is adapted: supplies stay on reachable ground, outside walls.
 */
export function rollOriginalLoot(position,{random=Math.random,world=null}={}){
  const drops=[];
  for(const [command,chance]of [['БАКСЫ',0],['ПАТРОНЫ',5],['АПТЕЧКА',7]]){
    const point=position.clone();point.x+=(integer(random,99)-integer(random,99))*.01;point.z+=(integer(random,99)-integer(random,99))*.01;
    if(chance&&integer(random,chance)!==3)continue;
    if(world){
      const from=position.clone().add(new THREE.Vector3(0,.35,0)),to=point.clone().add(new THREE.Vector3(0,.35,0)).sub(from);
      if(to.lengthSq()>1e-8&&world.ray?.(from,to,to.length()+.08))point.copy(position);
      const floor=world.ground?.(point.x,position.y+1.2,point.z,3);
      if(floor===undefined||Math.abs(floor-position.y)>1.1)point.copy(position);else point.y=floor;
    }
    drops.push({command,...rollOriginalPickup(command,{random}),model:LOOT_MODELS[command],position:point});
  }
  return drops;
}

const owned=o=>{o.userData.graphicsOwned=true;o.userData.collision=false;return o;};
function centeredGrenade(prototype){
  // Assets.model(false) is already converted from the source's Z-up into
  // Y-up metres. Keep those axes and transform only an owned Object3D clone;
  // even the bounding-box query must not populate shared geometry bounds.
  const model=prototype.clone(true),holder=owned(new THREE.Group());
  holder.name='Centred original grenade';holder.add(model);
  const bounds=new THREE.Box3().setFromObject(model,true),size=bounds.getSize(new THREE.Vector3());
  const longest=Math.max(size.x,size.y,size.z);
  if(bounds.isEmpty()||!Number.isFinite(longest)||longest<=1e-8)return null;
  model.position.sub(bounds.getCenter(new THREE.Vector3()));model.updateMatrix();
  holder.scale.setScalar(.18/longest);holder.traverse(owned);
  return holder;
}
function glowGeometry(count){
  const geometry=new THREE.BufferGeometry();
  for(const[name,size]of [['position',3],['size',1],['alpha',1],['kind',1]])geometry.setAttribute(name,new THREE.BufferAttribute(new Float32Array(count*size),size).setUsage(THREE.DynamicDrawUsage));
  return geometry;
}

/** Bounded, genuinely moving original sprites. Swept world/actor collision
 * occurs during update, never at fire time. One pooled Points draw handles
 * every blue/yellow projectile, muzzle flash and impact spark. Original maps
 * and grenade models belong to Assets and are borrowed, never disposed here.
 */
export class OriginalProjectiles {
  constructor({scene,world,assets=null,onImpact=()=>{},capacity=128,random=Math.random}={}){
    Object.assign(this,{scene,world,assets,onImpact,random});this.disposed=false;this.capacity=Math.max(8,Math.min(224,Math.floor(capacity)));this.cursor=0;this.effectCursor=0;
    this.root=owned(new THREE.Group());this.root.name='Original moving projectiles';scene?.add(this.root);
    this.projectiles=Array.from({length:this.capacity},()=>({active:false,position:new THREE.Vector3(),velocity:new THREE.Vector3(),age:0,weapon:0,owner:'player',damage:0,mesh:null}));
    this.effects=Array.from({length:256},()=>({ttl:0,life:1,position:new THREE.Vector3(),velocity:new THREE.Vector3(),size:1,kind:0}));
    this.geometry=glowGeometry(this.capacity+this.effects.length);
    this.fallback=new THREE.DataTexture(new Uint8Array([255,255,255,255]),1,1);this.fallback.needsUpdate=true;
    this.material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false,uniforms:{blue:{value:this.fallback},yellow:{value:this.fallback},hasMaps:{value:0},viewportHeight:{value:720}},
      vertexShader:`attribute float size;attribute float alpha;attribute float kind;uniform float viewportHeight;varying float vAlpha;varying float vKind;void main(){vAlpha=alpha;vKind=kind;vec4 p=modelViewMatrix*vec4(position,1.);gl_PointSize=clamp(size*projectionMatrix[1][1]*viewportHeight*.5/max(.1,-p.z),1.,180.);gl_Position=projectionMatrix*p;}`,
      fragmentShader:`uniform sampler2D blue;uniform sampler2D yellow;uniform float hasMaps;varying float vAlpha;varying float vKind;void main(){if(vAlpha<=0.)discard;vec3 color;if(hasMaps>.5){color=vKind<.5?texture2D(blue,gl_PointCoord).rgb:texture2D(yellow,gl_PointCoord).rgb;}else{float radius=length(gl_PointCoord-.5)*2.;color=(vKind<.5?vec3(.17,.6,1.):vec3(1.,.65,.2))*pow(max(0.,1.-radius),3.);}gl_FragColor=vec4(color*vAlpha,1.);}`});
    this.points=owned(new THREE.Points(this.geometry,this.material));this.points.frustumCulled=false;this.root.add(this.points);
    this.grenadeGeometry=new THREE.IcosahedronGeometry(.075,1);this.grenadeMaterial=new THREE.MeshLambertMaterial({color:0x4e6238});this.grenadePrototype=null;
    this._ray=new THREE.Ray();this._point=new THREE.Vector3();this._center=new THREE.Vector3();this._sphere=new THREE.Sphere();
  }
  load(){
    if(this._promise)return this._promise;
    this._promise=(async()=>{
      if(!this.assets)return this;
      const images=this.assets.manifest?.images||{};
      const maps=await Promise.allSettled([BLUE,YELLOW].map(name=>images[name]?this.assets.texture({map:images[name]}):null));
      if(this.disposed)return this;
      if(maps.every(r=>r.status==='fulfilled'&&r.value?.isTexture)){this.material.uniforms.blue.value=maps[0].value;this.material.uniforms.yellow.value=maps[1].value;this.material.uniforms.hasMaps.value=1;}
      try{const prototype=await this.assets.model('models/weapons/granate.3ds',false);if(!this.disposed)this.grenadePrototype=centeredGrenade(prototype);}catch{/* The finite grenade fallback still flies and collides. */}
      return this;
    })();return this._promise;
  }
  get activeCount(){return this.projectiles.reduce((sum,p)=>sum+(p.active?1:0),0);}
  setViewportHeight(height){if(Number.isFinite(height)&&height>0)this.material.uniforms.viewportHeight.value=height;}
  _glow(position,{count=1,kind=0,size=.35,life=.16,speed=0}={}){
    for(let i=0;i<count;i++){const effect=this.effects[this.effectCursor++%this.effects.length];effect.position.copy(position);effect.velocity.set((finiteRandom(this.random)-.5)*speed,(finiteRandom(this.random)-.3)*speed,(finiteRandom(this.random)-.5)*speed);effect.size=size;effect.kind=kind;effect.ttl=effect.life=life;}
  }
  fire({weapon=0,origin,direction,owner='player',damage,spread=0,classicGrenade=false}={}){
    if(this.disposed||!origin?.isVector3||!direction?.isVector3||direction.lengthSq()<1e-10)return 0;
    weapon=Math.max(0,Math.min(3,Math.floor(weapon)));const spec=ORIGINAL_PROJECTILE_WEAPONS[weapon];
    // A hand-thrown grenade has no firearm muzzle flash.
    if(weapon!==2)this._glow(origin,{kind:1,size:weapon===1?.65:.45,life:.065});
    for(let i=0;i<spec.count;i++){
      const p=this.projectiles[this.cursor++%this.capacity];if(p.mesh)p.mesh.visible=false;
      p.active=true;p.position.copy(origin);p.velocity.copy(direction).normalize();p.classicGrenade=weapon===2&&classicGrenade;p.classicSpeed=spec.speed;
      const jitter=spread+(weapon===3?.026:0);if(jitter)p.velocity.add(new THREE.Vector3(finiteRandom(this.random)-.5,finiteRandom(this.random)-.5,finiteRandom(this.random)-.5).multiplyScalar(jitter)).normalize();
      // Explicit damage is total per trigger, so a balanced big-gun blast is
      // not accidentally multiplied by its original eight projectile count.
      p.velocity.multiplyScalar(spec.speed);p.age=0;p.weapon=weapon;p.owner=owner;p.damage=Number.isFinite(damage)?Math.max(0,damage)/spec.count:spec.damage+integer(this.random,spec.damageRandom||1);p.trail=0;
      if(weapon===2){
        if(!p.mesh){p.mesh=owned(new THREE.Group());p.mesh.name='Original thrown grenade';this.root.add(p.mesh);}
        // A grenade thrown before load() completed uses the finite fallback.
        // Upgrade its pooled holder on the next throw, without disposing any
        // cached model geometry or the shared fallback resources.
        if(p.grenadeSource!==this.grenadePrototype){p.mesh.clear();p.mesh.add(this.grenadePrototype?this.grenadePrototype.clone(true):new THREE.Mesh(this.grenadeGeometry,this.grenadeMaterial));p.mesh.traverse(owned);p.grenadeSource=this.grenadePrototype;}
        p.mesh.visible=true;p.mesh.position.copy(origin);p.mesh.rotation.set(0,0,0);
      }
    }
    this._upload();return spec.count;
  }
  _impact(p,hit,expired=false){
    const spec=ORIGINAL_PROJECTILE_WEAPONS[p.weapon];p.active=false;if(p.mesh)p.mesh.visible=false;
    if(!expired||p.weapon===2||p.weapon===3){
      this._glow(p.position,{count:p.weapon===2?22:9,kind:spec.color==='blue'?0:1,size:p.weapon===2?1.1:.38,life:p.weapon===2?.55:.23,speed:p.weapon===2?5:2.5});
      const position=p.position.clone();this.onImpact({position,point:position,normal:hit?.normal?.clone()||null,actor:hit?.actor||null,weapon:p.weapon,damage:p.damage,splash:spec.splash,owner:p.owner,expired});
    }
  }
  update(dt,{actors=[],playerPosition=null}={}){
    if(this.disposed||!Number.isFinite(dt)||dt<=0)return;
    // The app caps frames, but bounded substeps also support deterministic tests
    // and a tab's occasional long frame without tunnelling through thin walls.
    let remaining=Math.min(dt,5);
    while(remaining>1e-8){const step=Math.min(remaining,1/60);remaining-=step;
      for(const p of this.projectiles){if(!p.active)continue;const spec=ORIGINAL_PROJECTILE_WEAPONS[p.weapon],seconds=Math.min(step,spec.life-p.age);
        // Original Move uses scalar speed × direction and subtracts .9 per
        // second from direction.y. A bounce reduces both speed and drop rate.
        const gravity=p.classicGrenade?p.classicSpeed*.9:spec.gravity;
        const displacement=p.velocity.clone().multiplyScalar(seconds);displacement.y-=gravity*seconds*seconds*.5;const distance=displacement.length();
        let hit=null;if(distance>1e-9){const direction=displacement.clone().divideScalar(distance),wall=this.world?.ray?.(p.position,direction,distance);if(wall)hit={distance:wall.distance,position:wall.position,normal:wall.normal};
          this._ray.set(p.position,direction);
          const targets=p.owner==='player'?actors:(playerPosition?[{pos:playerPosition,player:true}]:[]);
          for(const actor of targets){if(actor.dead)continue;this._center.copy(actor.pos).add(new THREE.Vector3(0,.95,0));this._sphere.center.copy(this._center);this._sphere.radius=actor.radius||.7;
            if(this._ray.intersectSphere(this._sphere,this._point)){const d=this._point.distanceTo(p.position);if(d<=distance&&(!hit||d<hit.distance)){hit={actor:actor.player?'player':actor,distance:d,position:this._point.clone(),normal:this._point.clone().sub(this._center).normalize()};}}
          }
        }
        p.age+=seconds;p.velocity.y-=gravity*seconds;
        if(hit){
          p.position.copy(hit.position);
          if(p.classicGrenade&&!hit.actor&&hit.normal?.lengthSq()>0){
            // Game.dll 0x52C880 and 0x52CA7E, then the 100-unit/s
            // detonation threshold in 0x52BEA0. Keep a tiny gap instead
            // of restarting the next sweep exactly on the same triangle.
            const speed=p.classicSpeed*.22*.66;
            p.classicSpeed=speed;
            if(speed>1&&p.age+1e-8<spec.life){
              p.velocity.normalize().reflect(hit.normal).multiplyScalar(speed);
              p.position.addScaledVector(hit.normal,.015);
              p.mesh?.position.copy(p.position);
              continue;
            }
          }
          this._impact(p,hit);continue;
        }
        p.position.add(displacement);if(p.mesh&&p.weapon===2){p.mesh.position.copy(p.position);p.mesh.rotation.x+=seconds*7;p.mesh.rotation.z+=seconds*4;}
        p.trail+=seconds;if(p.trail>=.04&&p.weapon!==2){p.trail=0;this._glow(p.position,{kind:spec.color==='blue'?0:1,size:spec.size*.3,life:.1});}
        if(p.age+1e-8>=spec.life)this._impact(p,null,true);
      }
      for(const effect of this.effects)if(effect.ttl>0){effect.ttl=Math.max(0,effect.ttl-step);effect.position.addScaledVector(effect.velocity,step);effect.velocity.y-=step*2;}
    }
    this._upload();
  }
  _upload(){
    const a=this.geometry.attributes;
    for(let i=0;i<this.projectiles.length;i++){const p=this.projectiles[i],spec=ORIGINAL_PROJECTILE_WEAPONS[p.weapon];a.position.setXYZ(i,p.position.x,p.position.y,p.position.z);a.size.setX(i,spec.size);a.alpha.setX(i,p.active&&p.weapon!==2?1:0);a.kind.setX(i,spec.color==='blue'?0:1);}
    for(let i=0;i<this.effects.length;i++){const e=this.effects[i],j=i+this.capacity;a.position.setXYZ(j,e.position.x,e.position.y,e.position.z);a.size.setX(j,e.size);a.alpha.setX(j,e.ttl/e.life);a.kind.setX(j,e.kind);}
    for(const value of Object.values(a))value.needsUpdate=true;
  }
  clear(){for(const p of this.projectiles){p.active=false;if(p.mesh)p.mesh.visible=false;}for(const effect of this.effects)effect.ttl=0;this._upload();}
  dispose(){if(this.disposed)return;this.disposed=true;this.clear();this.root.removeFromParent();this.root.clear();for(const p of this.projectiles){p.mesh?.clear();p.mesh=null;p.grenadeSource=null;}this.geometry.dispose();this.material.dispose();this.fallback.dispose();this.grenadeGeometry.dispose();this.grenadeMaterial.dispose();this.grenadePrototype=null;}
}
