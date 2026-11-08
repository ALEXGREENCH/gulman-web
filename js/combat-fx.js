import * as THREE from 'three';

function particlePool(count,additive){
  const geometry=new THREE.BufferGeometry();
  for(const [key,size] of [['position',3],['color',3],['size',1],['alpha',1]])geometry.setAttribute(key,new THREE.BufferAttribute(new Float32Array(count*size),size).setUsage(THREE.DynamicDrawUsage));
  const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:additive?THREE.AdditiveBlending:THREE.NormalBlending,
    vertexShader:`attribute float size;attribute float alpha;varying vec3 vColor;varying float vAlpha;void main(){vColor=color;vAlpha=alpha;vec4 p=modelViewMatrix*vec4(position,1.);gl_PointSize=clamp(size*420./max(.2,-p.z),1.,100.);gl_Position=projectionMatrix*p;}`,
    fragmentShader:`varying vec3 vColor;varying float vAlpha;void main(){float d=length(gl_PointCoord-.5)*2.;if(d>1.)discard;gl_FragColor=vec4(vColor,pow(1.-d,1.6)*vAlpha);}`,vertexColors:true,toneMapped:false});
  const mesh=new THREE.Points(geometry,material);mesh.frustumCulled=false;mesh.userData.graphicsOwned=true;
  return {mesh,geometry,material,slots:Array.from({length:count},()=>({ttl:0,life:1,pos:new THREE.Vector3(),velocity:new THREE.Vector3(),size:1,color:new THREE.Color()})),cursor:0};
}

/** Fixed-size pools bound GPU memory and draw calls even under automatic fire. */
export class CombatFX {
  constructor(scene){
    this.scene=scene;this.enabled=false;this.spark=particlePool(128,true);this.dust=particlePool(64,false);
    this.root=new THREE.Group();this.root.name='combat-effects';this.root.userData.graphicsOwned=true;scene.add(this.root);this.root.add(this.spark.mesh,this.dust.mesh);
    this.light=new THREE.PointLight(0xffb76b,0,9,2);this.light.userData.graphicsOwned=true;this.root.add(this.light);this.lightTime=0;
    this.traces=Array.from({length:12},()=>({ttl:0,a:new THREE.Vector3(),b:new THREE.Vector3()}));this.traceIndex=0;
    this.traceGeometry=new THREE.BufferGeometry();this.traceGeometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(12*6),3).setUsage(THREE.DynamicDrawUsage));
    this.traceMaterial=new THREE.LineBasicMaterial({color:new THREE.Color(3.5,1.7,.5),transparent:true,opacity:.8,depthWrite:false,toneMapped:false,blending:THREE.AdditiveBlending});this.traceMesh=new THREE.LineSegments(this.traceGeometry,this.traceMaterial);this.traceMesh.frustumCulled=false;this.traceMesh.userData.graphicsOwned=true;this.root.add(this.traceMesh);
    this.decalGeometry=new THREE.PlaneGeometry(.1,.1);this.decalMaterial=new THREE.MeshBasicMaterial({color:0x17110a,transparent:true,opacity:.7,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2});
    this.decals=Array.from({length:24},()=>{const mesh=new THREE.Mesh(this.decalGeometry,this.decalMaterial);mesh.userData.graphicsOwned=true;mesh.visible=false;this.root.add(mesh);return mesh;});this.decalIndex=0;
  }
  setEnabled(value){this.enabled=!!value;this.root.visible=this.enabled;if(!value){this.light.intensity=0;for(const pool of [this.spark,this.dust])for(const p of pool.slots)p.ttl=0;}}
  _emit(pool,point,count,{color=0xffc075,speed=2,size=.1,life=.3,up=0}={}){for(let i=0;i<count;i++){const p=pool.slots[pool.cursor++%pool.slots.length];p.pos.copy(point);p.velocity.set((Math.random()-.5)*speed,(Math.random()-.25)*speed+up,(Math.random()-.5)*speed);p.life=p.ttl=life*(.6+Math.random()*.8);p.size=size*(.6+Math.random()*.8);p.color.set(color);if(pool===this.spark)p.color.multiplyScalar(2.8);}}
  shot({origin,end,normal=null,hit=false,explosionRadius=0}){
    if(!this.enabled)return;
    const t=this.traces[this.traceIndex++%this.traces.length];t.a.copy(origin);t.b.copy(end);t.ttl=.055;
    this.light.position.copy(origin);this.light.intensity=22;this.lightTime=.045;
    this._emit(this.spark,origin,3,{size:.13,speed:.5,life:.045,color:0xffd9a0});
    if(normal||hit){this._emit(this.spark,end,hit?4:9,{size:.045,speed:3.4,life:.22,color:hit?0xff8e43:0xffe0a0});this._emit(this.dust,end,6,{size:.4,speed:.7,life:.55,color:hit?0x714541:0x817462,up:.3});}
    if(normal&&!hit){const mark=this.decals[this.decalIndex++%this.decals.length];mark.position.copy(end).addScaledVector(normal,.008);mark.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),normal);mark.rotateZ(Math.random()*Math.PI);mark.visible=true;}
    if(explosionRadius){this.light.position.copy(end);this.light.intensity=100;this.light.distance=explosionRadius*3;this.lightTime=.18;this._emit(this.spark,end,38,{size:.24,speed:8,life:.6,color:0xffa43d,up:2});this._emit(this.dust,end,18,{size:2.4,speed:2.8,life:1.4,color:0x4a4440,up:1.2});}
  }
  update(dt){
    if(!this.enabled)return;
    this.lightTime-=dt;if(this.lightTime<=0){this.light.intensity=0;this.light.distance=9;}else this.light.intensity*=Math.exp(-dt*13);
    for(const pool of [this.spark,this.dust]){const a=pool.geometry.attributes;for(let i=0;i<pool.slots.length;i++){const p=pool.slots[i];p.ttl=Math.max(0,p.ttl-dt);if(p.ttl){p.velocity.y-=dt*(pool===this.spark?5:.1);p.pos.addScaledVector(p.velocity,dt);}a.position.setXYZ(i,p.pos.x,p.pos.y,p.pos.z);a.color.setXYZ(i,p.color.r,p.color.g,p.color.b);a.size.setX(i,p.size*(pool===this.dust?1+(1-p.ttl/p.life)*1.5:1));a.alpha.setX(i,p.ttl/p.life);}for(const attribute of Object.values(a))attribute.needsUpdate=true;}
    const positions=this.traceGeometry.attributes.position;for(let i=0;i<this.traces.length;i++){const t=this.traces[i];t.ttl-=dt;positions.setXYZ(i*2,t.a.x,t.a.y,t.a.z);const b=t.ttl>0?t.b:t.a;positions.setXYZ(i*2+1,b.x,b.y,b.z);}positions.needsUpdate=true;
  }
  dispose(){this.root.removeFromParent();for(const pool of [this.spark,this.dust]){pool.geometry.dispose();pool.material.dispose();}this.traceGeometry.dispose();this.traceMaterial.dispose();this.decalGeometry.dispose();this.decalMaterial.dispose();this.light.dispose();}
}
