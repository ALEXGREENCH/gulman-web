/** The original bitmap menus, with their native aspect ratio preserved.
 * Each transparent native button follows the corresponding Menu_Save region.
 * Extras are trusted application HTML or a DOM element, never archive text.
 */
export function fitOriginalArtwork(viewportSize,referenceSize=[1024,768],imageSize=referenceSize){
  const width=referenceSize[0],height=width*imageSize[1]/imageSize[0];
  return {width,height,scale:Math.max(0,Math.min(viewportSize[0]/width,viewportSize[1]/height))};
}

export function cursorPlacement(x,y,hotspot,scale){return{x:x-hotspot[0]*scale,y:y-hotspot[1]*scale};}

export function fitShopLayout(viewportSize,referenceSize=[1024,768],imageSize=referenceSize){
  const [width,height]=viewportSize,stacked=width<700&&height>=480,panelHeight=270,gap=10;
  const fit=fitOriginalArtwork([width,stacked?Math.max(1,height-panelHeight-gap-24):height],referenceSize,imageSize);
  const artHeight=fit.height*fit.scale,artTop=stacked?Math.max(12,(height-artHeight-panelHeight-gap)/2):(height-artHeight)/2;
  return {...fit,stacked,artTop,panelTop:artTop+artHeight+gap,panelHeight};
}

export class OriginalUI {
  constructor({ root, assets, onCommand = () => {} }) {
    if (!root || !assets) throw new TypeError('OriginalUI requires root and assets');
    this.root = root;
    this.assets = assets;
    this.onCommand = onCommand;
    this.data = null;
    this._visible = false;
    this._currentMenu = null;
    this._referenceSize = [1024, 768];
    this._imageSize = this._referenceSize;
    this._focusBefore = null;
    this.contentElement = null;
    this.extrasElement = null;
    this._resize = () => this._fit();
    this._pointerMove = event => {
      if(event.pointerType==='touch'||event.pointerType==='pen'){this._hideCursor();return;}
      if(!this.visible||document.pointerLockElement||!this._cursorReady)return;
      if(window.matchMedia&&!window.matchMedia('(any-hover: hover) and (any-pointer: fine)').matches)return;
      this._lastPointer={x:event.clientX,y:event.clientY};
      this._positionCursor();
      this.cursor.hidden=false;this.root.classList.add('has-original-cursor');
      const target=event.target.closest?.('button, a, input, select, textarea, [data-command]');
      this.cursor.classList.toggle('is-action',!!target&&!target.disabled);
    };
    this._pointerLeave = () => this._hideCursor();
    this._pointerDown = event => {if(event.pointerType==='touch'||event.pointerType==='pen')this._hideCursor();else this.cursor?.classList.add('is-pressed');};
    this._pointerUp = () => this.cursor?.classList.remove('is-pressed');
    this._pointerLock = () => {if(document.pointerLockElement)this._hideCursor();};
    this._click = event => {
      const button = event.target.closest?.('[data-command]');
      if (!button || !this.root.contains(button) || button.disabled) return;
      this.onCommand(button.dataset.command, button._originalHotspot ?? null, event);
    };
    this._keydown = event => {
      if (!this.visible) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.onCommand('ESC', null, event);
      } else if (event.key === 'Tab') {
        this._hideCursor();
        const focusable = [...this.root.querySelectorAll('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')]
          .filter(element => !element.hidden && element.getClientRects().length);
        const fullscreen = document.getElementById('fullscreen');
        if (fullscreen && !fullscreen.hidden && fullscreen.getClientRects().length) focusable.push(fullscreen);
        if (!focusable.length) { event.preventDefault(); return; }
        const first = focusable[0], last = focusable.at(-1);
        if (!focusable.includes(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    this.root.addEventListener('click', this._click);
    this.root.addEventListener('pointermove',this._pointerMove);
    this.root.addEventListener('pointerleave',this._pointerLeave);
    this.root.addEventListener('pointerdown',this._pointerDown);
    window.addEventListener('pointerup',this._pointerUp);
    window.addEventListener('blur',this._pointerLeave);
    document.addEventListener('pointerlockchange',this._pointerLock);
    document.addEventListener('keydown', this._keydown, true);
    this._layoutObserver = new ResizeObserver(this._resize);
    this._layoutObserver.observe(this.root);
  }

  async init() {
    if (!this._initializing) {
      this._initializing = this.assets.json('assets/original-ui.json').then(data => {
        if (!data?.menus) throw new Error('В архиве отсутствует описание оригинальных меню');
        this.data = data;
        this._createCursor(data.cursor);
        return this;
      });
    }
    return this._initializing;
  }

  get visible() { return this._visible && !this.root.hidden; }
  get currentMenu() { return this._currentMenu; }

  refreshLayout() { this._fit(); }

  _fit() {
    let availableWidth = this.root.clientWidth || window.innerWidth;
    let availableHeight = this.root.clientHeight || window.innerHeight;
    const mobileComic = this._comicMode && document.documentElement.hasAttribute('data-touch');
    const sideRail = mobileComic && availableWidth >= 640 && availableWidth / availableHeight >= 1.65;
    this.root.classList.toggle('comic-side', sideRail);
    if (sideRail) availableWidth -= 164;
    else if (this._comicMode) {
      const nav = this.root.querySelector('.comic-controls');
      const bottom = mobileComic && nav ? parseFloat(getComputedStyle(nav).bottom) || 0 : 0;
      availableHeight -= mobileComic ? (nav?.offsetHeight ?? 48) + bottom + 6 : 48;
    }
    this.root.style.setProperty('--comic-bottom-space', `${(this.root.clientHeight || window.innerHeight) - availableHeight}px`);
    const fit=this.shopControls?fitShopLayout([availableWidth,availableHeight],this._referenceSize,this._imageSize):fitOriginalArtwork([availableWidth,availableHeight],this._referenceSize,this._imageSize);
    this.root.classList.toggle('original-shop-stacked',!!fit.stacked);
    if(this.shopControls){
      (fit.stacked?this.root:this.stage).append(this.shopControls);
      this.root.style.setProperty('--shop-art-top',`${fit.artTop}px`);
      this.root.style.setProperty('--shop-controls-top',`${fit.panelTop}px`);
    }
    this.root.style.setProperty('--original-ui-scale',String(fit.scale));
    if(this.stage){this.stage.style.width=`${fit.width}px`;this.stage.style.height=`${fit.height}px`;}
    this._cursorScale=(this.data?.cursor?.displayWidth??160)/(this.data?.cursor?.size?.[0]??172)*Math.max(.5,Math.min(1,availableHeight/768));
    this._positionCursor();
  }

  _begin(menuId, referenceSize, label, imageSize) {
    this._comicMode = false;
    this.root.classList.remove('has-comic');
    if (!this.visible) this._focusBefore = document.activeElement;
    this._currentMenu = menuId;
    this.shopControls=null;
    this._visible = true;
    this._referenceSize = referenceSize ?? [1024, 768];
    this._imageSize = imageSize ?? this._referenceSize;
    this.root.classList.add('original-ui');
    this.root.hidden = false;
    this.root.removeAttribute('aria-hidden');
    this.root.setAttribute('aria-label', label || 'Меню Гульмэн');
    this.root.replaceChildren();
    this.stage = document.createElement('div');
    this.stage.className = 'original-ui-stage';
    this.stage.style.width = `${this._referenceSize[0]}px`;
    this.stage.style.height = `${this._referenceSize[1]}px`;
    this.root.append(this.stage);
    if(this.cursor)this.root.append(this.cursor);
    this.contentElement = null;
    this.extrasElement = null;
    this._fit();
  }

  _background(path) {
    if (!path) return;
    const image = document.createElement('img');
    image.className = 'original-ui-background';
    image.src = this.assets.url(path);
    image.alt = '';
    image.draggable = false;
    image.setAttribute('aria-hidden', 'true');
    this.stage.append(image);
    // Extend the same original painting across a widescreen viewport. Only
    // this decorative backdrop is cropped/blurred; the central art is intact.
    this.ambient?.remove();this.ambient=document.createElement('div');
    this.ambient.className='original-ui-ambient';this.ambient.setAttribute('aria-hidden','true');
    this.ambient.style.backgroundImage=`url(${JSON.stringify(this.assets.url(path))})`;
    this.root.prepend(this.ambient);
  }

  _createCursor(spec){
    if(!spec?.image)return;
    this.cursor=document.createElement('div');this.cursor.className='original-menu-cursor';this.cursor.hidden=true;
    this.cursor.setAttribute('aria-hidden','true');
    this.cursor.style.width=`${spec.size[0]}px`;this.cursor.style.height=`${spec.size[1]}px`;
    this.cursorHand=document.createElement('img');this.cursorHand.className='original-menu-cursor-hand';
    this.cursorHand.alt='';this.cursorHand.draggable=false;
    this.cursorHand.onload=()=>{this._cursorReady=true;};
    this.cursorHand.onerror=()=>{this._cursorReady=false;this._hideCursor();};
    this.cursorHand.src=this.assets.url(spec.image);this.cursor.append(this.cursorHand);
    if(spec.glow){
      const glow=document.createElement('img');glow.className='original-menu-cursor-glow';glow.alt='';glow.draggable=false;
      glow.src=this.assets.url(spec.glow);glow.style.maskImage=`url("${glow.src}")`;const size=spec.glowSize??72;
      glow.style.width=`${size}px`;glow.style.height=`${size}px`;
      glow.style.left=`${spec.hotspot[0]-size/2}px`;glow.style.top=`${spec.hotspot[1]-size/2}px`;
      glow.onerror=()=>{glow.hidden=true;};this.cursor.append(glow);
    }
  }

  _positionCursor(){
    if(!this.cursor||!this._lastPointer)return;
    const scale=this._cursorScale||1,p=cursorPlacement(this._lastPointer.x,this._lastPointer.y,this.data.cursor.hotspot,scale);
    this.cursor.style.transform=`translate3d(${p.x}px,${p.y}px,0) scale(${scale})`;
  }

  _hideCursor(){this.root.classList.remove('has-original-cursor');if(this.cursor)this.cursor.hidden=true;}

  _rect(element, rect) {
    const [width, height] = this._referenceSize;
    const [x, y, w, h] = Array.isArray(rect) ? rect : [rect.x, rect.y, rect.width ?? rect.w, rect.height ?? rect.h];
    element.style.position = 'absolute';
    element.style.left = `${x / width * 100}%`;
    element.style.top = `${y / height * 100}%`;
    if (w !== undefined) element.style.width = `${w / width * 100}%`;
    if (h !== undefined) element.style.height = `${h / height * 100}%`;
  }

  /** Creates a command button. Omit rect for normal flow inside an extras form.
   * rect is [x,y,width,height] in reference pixels; hotspot hides its caption.
   */
  button(command, label, { rect, hotspot = false, disabled = false, className = '' } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${hotspot ? 'original-ui-hotspot' : 'original-ui-button'} ${className}`.trim();
    button.dataset.command = command;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.disabled = disabled;
    if (hotspot) {
      const text = document.createElement('span');
      text.className = 'original-ui-sr-only';
      text.textContent = label;
      button.append(text);
    } else button.textContent = label;
    if (rect) this._rect(button, rect);
    return button;
  }

  _appendContent(parent, content) {
    if (typeof content === 'string') parent.innerHTML = content;
    else if (content) parent.append(content);
  }

  _focusFirst() {
    this.root.querySelector('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled), [tabindex="0"]')?.focus({ preventScroll: true });
  }

  _shop(stock,status,disabled){
    const controls=document.createElement('div');controls.className='original-shop-controls';controls.setAttribute('aria-label','Покупки в Гульмаге');
    const balance=document.createElement('p');balance.className='original-shop-balance';
    const caption=document.createElement('span');caption.textContent='Баланс';const amount=document.createElement('strong');amount.textContent=`$${stock.balance??0}`;
    balance.append(caption,amount);this._rect(balance,[53,614,244,36]);controls.append(balance);
    const locations={'ПАТРОНЫ>4>':[22,258,290,66],'ПАТРОНЫ>3>':[24,478,247,66],BUY_HEALTH:[51,654,250,58]};
    for(const offer of stock.offers||[]){
      const button=this.button(offer.command,`${offer.label}, ${offer.detail}, $${offer.price}`,{rect:locations[offer.command],disabled:!!offer.disabled||disabled.has(offer.command),className:'original-shop-offer'});
      button.replaceChildren();button.dataset.shopItem=offer.command==='BUY_HEALTH'?'health':offer.command==='ПАТРОНЫ>3>'?'grenades':'biggun';
      const name=document.createElement('span');name.className='original-shop-name';name.textContent=offer.label;
      const detail=document.createElement('small');detail.className='original-shop-detail';detail.textContent=offer.detail;
      const price=document.createElement('strong');price.className='original-shop-price';price.textContent=`$${offer.price}`;
      button.append(name,detail,price);controls.append(button);
      // The painted object remains clickable. Its visible purchase button is
      // the single keyboard/screen-reader target for the same command.
      for(const hotspot of this.stage.querySelectorAll('.original-ui-hotspot'))if(hotspot.dataset.command===offer.command){hotspot.title=button.title;hotspot.disabled=button.disabled;hotspot.tabIndex=-1;hotspot.setAttribute('aria-hidden','true');}
    }
    const back=this.button('В=ИГРУ','В игру',{rect:[771,637,208,66],className:'original-shop-return',disabled:disabled.has('В=ИГРУ')});controls.append(back);
    for(const hotspot of this.stage.querySelectorAll('.original-ui-hotspot'))if(hotspot.dataset.command==='В=ИГРУ'){hotspot.tabIndex=-1;hotspot.setAttribute('aria-hidden','true');}
    const message=document.createElement('p');message.className='original-shop-message';message.setAttribute('role','status');message.setAttribute('aria-live','polite');message.textContent=status||'';this._rect(message,[22,550,300,52]);controls.append(message);
    this.shopControls=controls;this.extrasElement=controls;this.stage.append(controls);this._fit();
  }

  show(menuId, { extras, extrasRect, extrasClass = '', shop, status, hotspotLabels = {}, disabledCommands = [] } = {}) {
    if (!this.data) throw new Error('Call await OriginalUI.init() before show()');
    const menu = this.data.menus[menuId];
    if (!menu) throw new Error(`Неизвестное оригинальное меню: ${menuId}`);
    this._begin(menuId, menu.referenceSize ?? this.data.referenceSize, menu.label || menu.title, menu.imageSize);
    this._background(menu.image);
    const disabled = new Set(disabledCommands);
    for (const hotspot of menu.hotspots ?? []) {
      const label = hotspotLabels[hotspot.id] ?? hotspotLabels[hotspot.command] ?? hotspot.label ?? hotspot.command;
      // Menu_Save stores corner coordinates, unlike extrasRect's x/y/size.
      const [left, top, right, bottom] = hotspot.hitRect ?? hotspot.rect;
      const button = this.button(hotspot.command, label, {
        rect: [left, top, right - left, bottom - top],
        hotspot: true,
        disabled: disabled.has(hotspot.command),
      });
      button.dataset.hotspot = hotspot.id;
      button._originalHotspot = hotspot;
      if (hotspot.painted === false) {
        button.dataset.painted = 'false';
        const caption = button.firstElementChild;
        caption.className = 'original-ui-unpainted-label';
      }
      this.stage.append(button);
    }
    if (extras !== undefined && extras !== null) {
      this.extrasElement = document.createElement('div');
      this.extrasElement.className = `original-ui-extras ${extrasClass}`.trim();
      this._rect(this.extrasElement, extrasRect ?? menu.extrasRect ?? [350, 220, 420, 390]);
      this._appendContent(this.extrasElement, extras);
      this.stage.append(this.extrasElement);
    }
    // The settings artwork has no painted return command. This unobtrusive
    // addition occupies the empty lower paper roll rather than covering art.
    if (menuId === 'settings') {
      this.stage.append(this.button('MENU_BACK', 'Назад', {
        rect: [407, 636, 205, 35], className: 'original-ui-paper-back',
        disabled: disabled.has('MENU_BACK'),
      }));
    }
    if(menuId==='shop'&&shop)this._shop(shop,status,disabled);
    if (status&&!(menuId==='shop'&&shop)) {
      const output = document.createElement('p');
      output.className = 'original-ui-status';
      output.setAttribute('role', 'status');
      output.textContent = status;
      this.stage.append(output);
    }
    this._focusFirst();
    return this;
  }

  showFrame(html, { title, backCommand = 'MENU_BACK', backLabel = 'Назад' } = {}) {
    if (!this.data) throw new Error('Call await OriginalUI.init() before showFrame()');
    this._begin('frame', [1024, 768], title || 'Гульмэн', this.data.hud?.frame?.size);
    this.stage.classList.add('original-ui-framed');
    this._background(this.data.frames?.default ?? this.assets.manifest?.images?.['textures/рамка.jpg']);
    const content = document.createElement('div');
    content.className = 'original-ui-frame-content';
    this._rect(content, [90, 64, 844, 550]);
    if (title) {
      const heading = document.createElement('h2');
      heading.className = 'original-ui-frame-title';
      heading.textContent = title;
      content.append(heading);
    }
    const body = document.createElement('div');
    body.className = 'original-ui-frame-body';
    this._appendContent(body, html);
    content.append(body);
    this.stage.append(content);
    this.contentElement = body;
    if (backCommand) this.stage.append(this.button(backCommand, backLabel, { rect: [420, 688, 184, 42] }));
    this._focusFirst();
    return this;
  }

  hide() {
    this._hideCursor();this._lastPointer=null;
    this._visible = false;
    this.root.hidden = true;
    this.root.setAttribute('aria-hidden', 'true');
    if (this.root.contains(document.activeElement) && this._focusBefore?.isConnected) {
      this._focusBefore.focus({ preventScroll: true });
    }
    return this;
  }

  setComicMode() {
    this._comicMode = true;
    this.root.classList.add('has-comic');
    this._fit();
  }

  dispose() {
    this.hide();
    this.root.removeEventListener('click', this._click);
    this.root.removeEventListener('pointermove',this._pointerMove);
    this.root.removeEventListener('pointerleave',this._pointerLeave);
    this.root.removeEventListener('pointerdown',this._pointerDown);
    window.removeEventListener('pointerup',this._pointerUp);
    window.removeEventListener('blur',this._pointerLeave);
    document.removeEventListener('pointerlockchange',this._pointerLock);
    document.removeEventListener('keydown', this._keydown, true);
    this._layoutObserver.disconnect();
    this.root.replaceChildren();
    this.root.classList.remove('original-ui');
  }
}
