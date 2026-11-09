/** Manage browser Pointer Lock independently of the running game. */
export class MouseCapture {
  constructor(document, target, onChange) {
    this.document=document;this.target=target;this.onChange=onChange;
    this.active=false;this.releasing=false;this.state='idle';this.reason=null;this.requestId=0;
    this.legacyRequest=null;this.prefersDrag=false;
    document.addEventListener('pointerlockchange',()=>this.changed());
    // Promise browsers also emit this untagged event, before the rejection.
    // Use it only for the older API, where there is no rejection to handle.
    document.addEventListener('pointerlockerror',()=>{
      if(this.legacyRequest!==null)this.fail(this.legacyRequest);
    });
  }
  get locked(){return this.document.pointerLockElement===this.target;}
  setState(state,reason=null){
    if(state===this.state&&reason===this.reason)return;
    this.state=state;this.reason=reason;this.onChange(state,reason);
  }
  start(){
    this.active=true;
    if(this.prefersDrag&&!this.locked){this.setState('drag','chosen');return;}
    if(this.releasing){this.setState('available');return;}
    if(!this.locked&&this.document.defaultView?.navigator?.userActivation?.isActive===false){
      this.setState('available','activation');return;
    }
    this.request();
  }
  stop(){
    this.active=false;this.requestId++;this.legacyRequest=null;clearTimeout(this.timer);this.setState('idle');
    if(this.locked&&!this.releasing){this.releasing=true;this.document.exitPointerLock();}
  }
  useDrag(){
    if(!this.active||this.locked)return;
    this.prefersDrag=true;this.requestId++;this.legacyRequest=null;clearTimeout(this.timer);this.setState('drag','chosen');
  }
  request(){
    if(this.releasing&&!this.locked)this.releasing=false;
    if(!this.active||this.state==='requesting'||this.releasing)return;
    if(this.locked){this.setState('locked');return;}
    this.prefersDrag=false;
    if(!this.target.requestPointerLock){this.setState('drag','unsupported');return;}
    this.setState('requesting');const id=++this.requestId;
    this.legacyRequest=null;
    this.timer=setTimeout(()=>this.fail(id,null,'timeout'),2500);
    try{
      const result=this.target.requestPointerLock();
      if(typeof result?.then==='function'){
        result.then(()=>{if(id===this.requestId&&this.locked)this.changed();},error=>this.fail(id,error));
      }else if(this.state==='requesting')this.legacyRequest=id;
    }catch(error){this.fail(id,error);}
  }
  fail(id,error,reason='denied'){
    if(id!==this.requestId||this.state!=='requesting')return;
    this.legacyRequest=null;clearTimeout(this.timer);
    // A delayed error must not override the browser's actual lock state.
    if(this.locked){this.changed();return;}
    if(error?.name==='SecurityError'){
      // Chromium uses SecurityError for its short post-Esc cooldown too.
      if(/exited the lock/i.test(error.message??'')){this.setState('drag','released');return;}
      this.setState('drag','blocked');return;
    }
    if(error?.name==='InUseAttributeError'){this.setState('drag','busy');return;}
    if(error?.name==='WrongDocumentError'||error?.name==='InvalidStateError'){
      this.setState('drag','focus');return;
    }
    if(error?.name==='NotAllowedError'){
      this.setState('drag','activation');return;
    }
    this.setState('drag',error?.name==='NotSupportedError'?'unsupported':reason);
  }
  changed(){
    if(this.locked){
      clearTimeout(this.timer);this.legacyRequest=null;
      if(!this.active||this.prefersDrag){if(!this.releasing){this.releasing=true;this.document.exitPointerLock();}return;}
      if(!this.releasing)this.setState('locked');
      return;
    }
    this.releasing=false;
    if(this.active&&this.state==='locked')this.setState('available','released');
  }
}
