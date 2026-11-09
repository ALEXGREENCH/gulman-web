import { Box3, Triangle, Vector3 } from 'three';

// Game.dll at 0x51D852, 0x529B81, 0x529EFA, 0x52ADFD and 0x52B3E5.
// Distances and accelerations are converted from 100 source units per metre.
export const DCE = Object.freeze({
  radii: Object.freeze([.4, 1, .4]), gravity: 8, airFriction: .1, floorFriction: 10,
  runForce: 55, walkForce: 30, airControl: .01,
  jumpHeight: .44, jumpSpeed: 4, jumpNormal: .5, skin: .05, tick: 1/120,
});
const EPS = 1e-8;
const RADII = new Vector3(...DCE.radii);
const INVERSE = new Vector3(1/RADII.x, 1/RADII.y, 1/RADII.z);

function firstRoot(a,b,c,limit) {
  if(a<EPS)return Infinity;
  const d=b*b-a*c;
  if(d<0||b>=0)return Infinity;
  const t=(-b-Math.sqrt(d))/a;
  return t>=-EPS&&t<=limit?Math.max(0,t):Infinity;
}

/** A unit sphere in ellipsoid space. Check face, edges and vertices so a
 * narrow rail or triangle seam cannot be crossed between two updates. */
class EllipsoidSweep {
  constructor() {
    this.cache=new WeakMap();this.box=new Box3();this.candidates=new Set();
    this.center=new Vector3();this.motion=new Vector3();this.end=new Vector3();
    this.normal=new Vector3();this.face=new Vector3();this.point=new Vector3();
    this.relative=new Vector3();this.dv=new Vector3();this.rp=new Vector3();
    this.hitNormal=new Vector3();this.hitGroundY=0;
  }

  scaled(source) {
    let data=this.cache.get(source);
    if(!data){
      const tri=new Triangle(...[source.a,source.b,source.c].map(p=>p.clone().multiply(INVERSE)));
      const points=[tri.a,tri.b,tri.c];
      data={tri,normal:tri.getNormal(new Vector3()),bounds:new Box3().setFromPoints([source.a,source.b,source.c]),
        edges:points.map((p,i)=>({p,axis:points[(i+1)%3].clone().sub(p)})),points};
      this.cache.set(source,data);
    }
    return data;
  }

  gather(node) {
    if(!node.box||!this.box.intersectsBox(node.box))return;
    for(const triangle of node.triangles)this.candidates.add(triangle);
    for(const child of node.subTrees)this.gather(child);
  }

  earliest(tree, center, motion, actors = []) {
    // Query the world octree with the swept AABB, then solve in scaled space.
    this.end.copy(center).add(motion);
    this.box.min.copy(center).min(this.end).sub(RADII);
    this.box.max.copy(center).max(this.end).add(RADII);
    this.candidates.clear();this.gather(tree);
    const o=this.center.copy(center).multiply(INVERSE),v=this.motion.copy(motion).multiply(INVERSE);
    const vv=v.lengthSq();
    let best=1,found=false;
    const consider=(t,normal,face)=>{
      if(t>best||!Number.isFinite(t)||v.dot(normal)>=-EPS)return;
      best=t;found=true;this.hitNormal.copy(normal).normalize();this.hitGroundY=face.y;
    };
    for(const source of this.candidates){
      const {tri,normal,bounds,edges,points}=this.scaled(source);
      if(!this.box.intersectsBox(bounds))continue;
      // A few exported surfaces have reversed winding. Use their near side.
      const face=this.face.copy(normal);
      let d=face.dot(this.relative.copy(o).sub(tri.a));
      if(d<0){face.negate();d=-d;}
      const vn=face.dot(v);
      if(vn<-EPS){
        const t=Math.max(0,(1-d)/vn);
        if(t<=best&&tri.containsPoint(this.point.copy(o).addScaledVector(v,t).addScaledVector(face,-Math.min(1,d)))){
          consider(t,face,face);
        }
      }
      for(const point of points){
        const r=this.relative.copy(o).sub(point);
        const t=firstRoot(vv,r.dot(v),r.lengthSq()-1,best);
        if(Number.isFinite(t))consider(t,this.normal.copy(r).addScaledVector(v,t),face);
      }
      for(const {p,axis} of edges){
        const ee=axis.lengthSq();if(ee<EPS)continue;
        const r=this.relative.copy(o).sub(p),s=r.dot(axis)/ee,u=v.dot(axis)/ee;
        const rp=this.rp.copy(r).addScaledVector(axis,-s),dv=this.dv.copy(v).addScaledVector(axis,-u);
        const t=firstRoot(dv.lengthSq(),rp.dot(dv),rp.lengthSq()-1,best),at=s+t*u;
        if(Number.isFinite(t)&&at>0&&at<1)consider(t,this.normal.copy(rp).addScaledVector(dv,t),face);
      }
    }
    // Two identical DCE body ellipsoids have a radius-2 Minkowski sum in
    // scaled space. Each live bot is treated as stationary for this substep.
    for(const actor of actors){
      if(actor.dead||!actor.pos)continue;
      const r=this.relative.copy(center).sub(actor.pos);r.y-=RADII.y;r.multiply(INVERSE);
      if(r.lengthSq()>(2+Math.sqrt(vv))**2)continue;
      const c=r.lengthSq()-4,b=r.dot(v),t=c<0&&b<0?0:firstRoot(vv,b,c,best);
      if(!Number.isFinite(t))continue;
      const n=this.normal.copy(r).addScaledVector(v,t).normalize();
      consider(t,n,n);
    }
    return found?best:null;
  }

  slide(tree, center, displacement, actors, holdSlope = Infinity) {
    const remaining=displacement.clone();
    let normalY=0,blocked=false,hit=false;
    for(let i=0;i<6&&remaining.lengthSq()>EPS*EPS;i++){
      const time=this.earliest(tree,center,remaining,actors);
      if(time===null){center.add(remaining);break;}
      const n=this.hitNormal;
      // DCE uses the plane normal in ellipsoid space for ground and jump.
      normalY=Math.max(normalY,this.hitGroundY);hit=true;blocked||=this.hitGroundY<DCE.jumpNormal;
      const length=this.motion.length();
      // GLDCE world scale 10 times the ellipse solver's 0.005 separation.
      center.addScaledVector(remaining,Math.max(0,time-DCE.skin/length));
      if(Math.min(this.hitGroundY,n.y)>=holdSlope)return {normalY,blocked,hit,held:true};
      this.motion.multiplyScalar(1-time);
      this.motion.addScaledVector(n,-Math.min(0,this.motion.dot(n)));
      remaining.copy(this.motion).multiply(RADII);
    }
    return {normalY,blocked,hit};
  }
}

/** Independent port of the original DCE movement; position is at the feet.
 * The octree is only a triangle lookup, shared with the rest of the game. */
export class OriginalMovement {
  constructor(world) {
    this.world=world;this.sweep=new EllipsoidSweep();
    this.local=new Vector3();this.carry=new Vector3();this.drive=new Vector3();
    this.center=new Vector3();this.fall=new Vector3();this.reset();
  }
  reset() {
    this.local.set(0,0,0);this.carry.set(0,0,0);this.vertical=0;
    this.ascent=0;this.normalY=0;this.friction=DCE.airFriction;
    this.onGround=false;this.accumulator=0;this.queuedJump=false;
  }
  move(position, velocity, dt, {forward=0,strafe=0,yaw=0,sprint=false,jump=false,actors=[]}={}) {
    if(!(dt>0)||!Number.isFinite(dt))return {onGround:this.onGround,blocked:false};
    this.accumulator+=Math.min(dt,.1);
    this.queuedJump||=jump;
    let blocked=false;
    const strafeForce=sprint?DCE.runForce:DCE.walkForce;
    const forwardForce=forward>0?strafeForce:DCE.walkForce;
    const sin=Math.sin(yaw),cos=Math.cos(yaw);
    // The sweep reports normals in scaled ellipsoid coordinates.
    const slope=this.world.slopeCos;
    const holdSlope=forward||strafe?Infinity:slope/Math.hypot(slope,RADII.x*Math.sqrt(1-slope*slope));
    const localToWorld=(v,x,z)=>v.set(z*sin-x*cos,0,z*cos+x*sin);
    const h=DCE.tick;
    while(this.accumulator+EPS>=h){
      this.accumulator-=h;
      if((jump||this.queuedJump)&&this.onGround&&this.normalY>DCE.jumpNormal&&this.ascent<=0){
        this.carry.add(localToWorld(this.drive,this.local.x,this.local.z));this.local.set(0,0,0);
        this.ascent=DCE.jumpHeight;this.vertical=0;this.onGround=false;
      }
      this.queuedJump=false;
      const drag=Math.max(0,1-h*this.friction),control=this.onGround?1:DCE.airControl;
      this.local.x=this.local.x*drag+strafe*strafeForce*control*h;
      this.local.z=this.local.z*drag+forward*forwardForce*control*h;
      this.carry.multiplyScalar(drag);
      localToWorld(this.drive,this.local.x,this.local.z).add(this.carry).multiplyScalar(h);
      let falling=h;
      if(this.ascent>0){
        const rise=Math.min(this.ascent,DCE.jumpSpeed*h);
        this.drive.y=rise;this.ascent-=rise;falling=Math.max(0,h-rise/DCE.jumpSpeed);
        this.vertical=this.ascent>EPS?0:DCE.jumpSpeed;
      }
      this.center.copy(position);this.center.y+=RADII.y;
      const originY=this.center.y;
      const driveHit=this.sweep.slide(this.world.tree,this.center,this.drive,actors);
      if(this.drive.y>0&&this.center.y<originY+this.drive.y-.001){this.ascent=0;this.vertical=0;}
      blocked||=driveHit.blocked;
      let fallHit=null;
      if(falling>EPS){
        const gravity=DCE.gravity*(this.onGround?1-this.normalY:1);
        this.vertical=this.vertical*Math.max(0,1-DCE.airFriction*falling)-gravity*falling;
        this.fall.set(0,this.vertical*falling,0);
        fallHit=this.sweep.slide(this.world.tree,this.center,this.fall,actors,this.vertical<=0?holdSlope:Infinity);
        if(fallHit.held)this.vertical=0;
        blocked||=fallHit.blocked;
        // At rest, keep a short support probe without adding artificial fall speed.
        this.normalY=this.fall.y<0?fallHit.normalY:0;
        if(this.normalY===0&&this.vertical<=0&&this.onGround){
          const t=this.sweep.earliest(this.world.tree,this.center,this.fall.set(0,-.055,0),actors);
          if(t!==null)this.normalY=this.sweep.hitGroundY;
        }
        this.onGround=this.normalY>0;
      }
      this.friction=DCE.airFriction+(driveHit.hit||fallHit?.hit||this.onGround?DCE.floorFriction:0);
      position.copy(this.center);position.y-=RADII.y;
      localToWorld(velocity,this.local.x,this.local.z).add(this.carry);
      velocity.y=this.onGround?0:this.ascent>0?DCE.jumpSpeed:this.vertical;
    }
    return {onGround:this.onGround,blocked};
  }
}
