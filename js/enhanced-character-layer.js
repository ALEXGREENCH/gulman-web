import {createEnhancedCharacterMaterials} from './enhanced-character-materials.js?v=20261109-9';

/** Owns one level's optional skins. The original actor remains the animation
 * source, and can be replaced while the shared textures are still loading. */
export class EnhancedCharacterLayer {
  constructor({assets,onChange=()=>{},materials,skinFactory}={}) {
    this.materials=materials||createEnhancedCharacterMaterials({assets});
    this.skinFactory=skinFactory;this.onChange=onChange;
    this.characters=new Map();this.skins=new Map();this.ready=false;this.disposed=false;
  }
  setCharacters(entries) {
    if(this.disposed)return;
    this.characters=new Map(entries.filter(([actor])=>actor));
    let changed=false;
    for(const actor of this.skins.keys())if(!this.characters.has(actor)){this._release(actor);changed=true;}
    if(this.ready)changed=this._attach()||changed;
    if(changed)this.onChange();
  }
  load() {
    if(!this.promise)this.promise=Promise.all([Promise.resolve().then(()=>this.materials.load()),this.skinFactory?null:import('./enhanced-characters.js?v=20261109-9').then(module=>{this.skinFactory=module.createEnhancedCharacterSkin;})]).then(([success])=>{
      if(this.disposed){this.materials.dispose();return this;}
      if(success===false)throw new Error('Не загрузились материалы персонажей');
      this.ready=true;if(this._attach())this.onChange();return this;
    }).catch(error=>{this.dispose();throw error;});
    return this.promise;
  }
  _attach() {
    let changed=false;
    for(const [actor,name] of this.characters){
      if(this.skins.has(actor))continue;
      const skin=this.skinFactory(actor,name,{materials:this.materials,enabled:true});
      const dispose=actor.dispose;
      const wrapped=()=>{this.characters.delete(actor);this._release(actor);dispose?.call(actor);};
      this.skins.set(actor,{skin,dispose,wrapped});actor.dispose=wrapped;
      actor.enhancedSkin=skin;changed=true;
    }
    return changed;
  }
  _release(actor) {
    const record=this.skins.get(actor);if(!record)return;
    this.skins.delete(actor);record.skin.dispose();
    if(actor.dispose===record.wrapped)actor.dispose=record.dispose;
    if(actor.enhancedSkin===record.skin)delete actor.enhancedSkin;
  }
  get diagnostics() {
    let triangles=0;
    for(const {skin} of this.skins.values())triangles+=skin.stats?.triangles||0;
    return {ready:this.ready,count:this.skins.size,triangles};
  }
  dispose() {
    if(this.disposed)return;this.disposed=true;
    for(const actor of this.skins.keys())this._release(actor);
    this.characters.clear();this.materials.dispose();
  }
}
