import * as THREE from 'three';

const damp=(a,b,rate,dt)=>a+(b-a)*(1-Math.exp(-rate*dt));

/** Authored additive motion over the original HSK clips, not imported animation. */
export class MotionController {
  constructor(){this._poses=new WeakMap();this.reset();}
  reset(){this.slideTime=0;this.slideCooldown=0;this.phase=0;this.speed=0;this.crouched=false;this.sprinting=false;this.wasGrounded=true;this.landing=0;this.landingVelocity=0;this.bob=0;this.roll=0;this.lean=0;this.clock=0;}
  update(dt,{moving=false,sprinting=false,aiming=0,crouchPressed=false,crouchHeld=false,grounded=true,verticalSpeed=0,strafe=0}={}){
    dt=Math.min(.05,Math.max(0,dt));this.clock+=dt;this.slideCooldown=Math.max(0,this.slideCooldown-dt);
    if(crouchPressed&&grounded&&sprinting&&this.speed>5&&this.slideCooldown===0){this.slideTime=.72;this.slideCooldown=1.2;}
    this.slideTime=Math.max(0,this.slideTime-dt);this.crouched=crouchHeld||this.slideTime>0;
    this.sprinting=sprinting&&moving&&!this.crouched&&aiming<.15;
    const target=this.slideTime>0?7+5*this.slideTime/.72:!moving?0:this.crouched?2.2:this.sprinting?8.7:4.7-aiming*2;
    this.speed=damp(this.speed,target,this.slideTime>0?18:moving?12:15,dt);
    if(grounded&&!this.wasGrounded){this.landingVelocity=-Math.min(.9,Math.abs(verticalSpeed)*.055+.12);}
    this.wasGrounded=grounded;
    this.landingVelocity+=(-this.landing*100-this.landingVelocity*17)*dt;this.landing+=this.landingVelocity*dt;
    this.phase+=this.speed*dt*(this.sprinting?2.1:2.6);
    this.bob=damp(this.bob,grounded&&moving?Math.sin(this.phase*2)*(this.sprinting?.038:.019)*(1-aiming*.7):0,14,dt);
    this.roll=damp(this.roll,this.slideTime>0?-.055:strafe*-.013,11,dt);
    this.lean=damp(this.lean,strafe*-.07,10,dt);
    return this;
  }
  get sliding(){return this.slideTime>0;}
  /** Remove last frame's offsets before the original clip's slerp. */
  prepare(character){const prior=this._poses.get(character);if(prior)for(const [id,q] of prior)character.bones.get(id)?.quaternion.multiply(q.clone().invert());this._poses.delete(character);}
  apply(character,{aiming=0,reloading=false,reloadProgress=0,recoil=0,moving=false}={}){
    if(!character?.bones)return;
    const poses=new Map(),breath=Math.sin(this.clock*2)*.008;
    const add=(id,x,y,z)=>{const bone=character.bones.get(id);if(!bone)return;const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(x,y,z));bone.quaternion.multiply(q);poses.set(id,q);};
    const reload=reloading?Math.sin(Math.PI*reloadProgress):0;
    add(18,(this.sprinting?.075:0)+breath,this.lean*.25,this.lean+recoil*.25);
    add(2,-breath*.6,0,-this.lean*.4);
    add(10,-aiming*.12+reload*.32+recoil*.8,0,this.sprinting?-.09:0);
    add(11,-aiming*.1+reload*.6,0,-reload*.35);
    add(13,reload*.55,0,0);
    if(!moving)add(3,0,Math.sin(this.clock)*.004,0);
    this._poses.set(character,poses);
  }
}
