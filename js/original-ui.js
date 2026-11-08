/** The original bitmap menus, displayed on their 1024 × 768 reference canvas.
 * Each transparent native button follows the corresponding Menu_Save region.
 * Extras are trusted application HTML or a DOM element, never archive text.
 */
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
    this._focusBefore = null;
    this.contentElement = null;
    this.extrasElement = null;
    this._resize = () => this._fit();
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
        const focusable = [...this.root.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')]
          .filter(element => !element.hidden && element.getClientRects().length);
        if (!focusable.length) { event.preventDefault(); return; }
        const first = focusable[0], last = focusable.at(-1);
        if (!this.root.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    this.root.addEventListener('click', this._click);
    document.addEventListener('keydown', this._keydown, true);
    window.addEventListener('resize', this._resize);
  }

  async init() {
    if (!this._initializing) {
      this._initializing = this.assets.json('assets/original-ui.json').then(data => {
        if (!data?.menus) throw new Error('В архиве отсутствует описание оригинальных меню');
        this.data = data;
        return this;
      });
    }
    return this._initializing;
  }

  get visible() { return this._visible && !this.root.hidden; }
  get currentMenu() { return this._currentMenu; }

  _fit() {
    const [width, height] = this._referenceSize;
    const availableWidth = this.root.clientWidth || window.innerWidth;
    const availableHeight = (this.root.clientHeight || window.innerHeight) - (this._comicMode ? 48 : 0);
    this.root.style.setProperty('--original-ui-scale', String(Math.min(availableWidth / width, availableHeight / height)));
  }

  _begin(menuId, referenceSize, label) {
    this._comicMode = false;
    this.root.classList.remove('has-comic');
    if (!this.visible) this._focusBefore = document.activeElement;
    this._currentMenu = menuId;
    this._visible = true;
    this._referenceSize = referenceSize ?? [1024, 768];
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
  }

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
    this.root.querySelector('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')?.focus({ preventScroll: true });
  }

  show(menuId, { extras, extrasRect, extrasClass = '', status, hotspotLabels = {}, disabledCommands = [] } = {}) {
    if (!this.data) throw new Error('Call await OriginalUI.init() before show()');
    const menu = this.data.menus[menuId];
    if (!menu) throw new Error(`Неизвестное оригинальное меню: ${menuId}`);
    this._begin(menuId, menu.referenceSize ?? this.data.referenceSize, menu.label || menu.title);
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
    if (status) {
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
    this._begin('frame', [1024, 768], title || 'Гульмэн');
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
    document.removeEventListener('keydown', this._keydown, true);
    window.removeEventListener('resize', this._resize);
    this.root.replaceChildren();
    this.root.classList.remove('original-ui');
  }
}
