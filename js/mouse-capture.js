/** Pointer Lock is asynchronous: a late event from a menu transition must not
 * pause the next session or turn the click used to re-lock into a shot. */
export class MouseCapture {
  constructor(document, target, onChange) {
    this.document=document;this.target=target;this.onChange=onChange;
    this.active=false;this.releasing=false;this.state='idle';this.requestId=0;
    document.addEventListener('pointerlockchange',()=>this.changed());
    document.addEventListener('pointerlockerror',()=>this.fail(this.requestId));
  }
  get locked(){return this.document.pointerLockElement===this.target;}
  setState(state){if(state!==this.state){this.state=state;this.onChange(state);}}
  start(){
    this.active=true;
    if(this.releasing){this.setState('available');return;}
    this.request();
  }
  stop(){
    this.active=false;this.requestId++;clearTimeout(this.timer);this.setState('idle');
    if(this.locked&&!this.releasing){this.releasing=true;this.document.exitPointerLock();}
  }
  request(){
    if(!this.active||this.state==='requesting'||this.releasing)return;
    if(this.locked){this.setState('locked');return;}
    if(!this.target.requestPointerLock){this.setState('drag');return;}
    this.setState('requesting');const id=++this.requestId;
    this.timer=setTimeout(()=>this.fail(id),1200);
    try{this.target.requestPointerLock()?.catch(()=>this.fail(id));}catch{this.fail(id);}
  }
  fail(id){
    if(id!==this.requestId||this.state!=='requesting')return;
    clearTimeout(this.timer);this.setState('drag');
  }
  changed(){
    if(this.locked){
      clearTimeout(this.timer);
      if(!this.active){if(!this.releasing){this.releasing=true;this.document.exitPointerLock();}return;}
      if(!this.releasing)this.setState('locked');
      return;
    }
    this.releasing=false;
    if(this.active&&this.state==='locked')this.setState('available');
  }
}
