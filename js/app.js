import * as THREE from 'three';
import {Assets} from './assets.js?v=20261109-10';
import {createCharacter} from './characters.js?v=20261109-16';
import {OriginalMovement} from './original-physics.js?v=20261109-16';
import {WorldCollision} from './collision.js?v=20261109-15';
import {CrowdRenderer} from './crowd.js?v=20261109-10';
import {OriginalProjectiles,rollOriginalLoot,rollOriginalPickup,safeProjectileOrigin} from './original-combat.js?v=20261109-12';
import {OriginalUI} from './original-ui.js?v=20261109-10';
import {AudioManager} from './audio.js?v=20261109-10';
import {createPlayerChoice,heroForKey} from './player-choice.js?v=20261109-12';
import {GraphicsManager} from './graphics.js?v=20261109-15';
import {CombatController} from './combat.js?v=20261109-10';
import {ProceduralViewmodel} from './viewmodel.js?v=20261109-10';
import {MotionController} from './motion.js?v=20261109-10';
import {CombatFX} from './combat-fx.js?v=20261109-10';
import {MouseCapture} from './mouse-capture.js?v=20261109-13';
import {ropeSupport} from './rope-support.js?v=20261109-15';
import {OriginalWater} from './original-water.js?v=20261109-11';
import {EnhancedWorld} from './enhanced-world.js?v=20261109-15';
import {EnhancedCharacterLayer} from './enhanced-character-layer.js?v=20261109-10';
import {selectInteraction,maxSlopeForLevel,jumpSpeedForLevel} from './progression.js?v=20261109-10';

const $=id=>document.getElementById(id);
const assets=new Assets(), keys=new Set();
const locations=['Италия · Пляж','Италия · Отель','Греция · Акрополь','Голландия','Индия · Тадж-Махал','Франция','Мексика · Чичен-Ица','Россия · Красная площадь','Финальная схватка'];
const tasks=['Найди письмо связиста','Обезвредь бомбу','Найди статую Венеры','Найди картину','Найди древнюю книгу','Найди Мону Лизу','Найди реликвию майя','Собери две реликвии','Собери четыре артефакта'];
const weapons=[{name:'ПИСТОЛЕТ',damage:34,rate:.3,cost:1,sound:'sounds/weapons/pistol-01.wav'},{name:'АВТОМАТ',damage:24,rate:.1,cost:1,sound:'sounds/weapons/aug-1.wav'},{name:'ГРАНАТА',damage:120,rate:1,cost:5,splash:5,sound:'sounds/weapons/gl_explodesmoke.wav'},{name:'БИГГАН',damage:85,rate:.65,cost:3,splash:2,sound:'sounds/weapons/sg_mediumexplode.wav'}];
let renderer,scene,camera,world,worldMesh,player,level,actors=[],items=[],hazards=[],effects=[],crowd,combatFX,projectiles,viewmodel,enhancedWorld,enhancedCharacters,originalWater,originalMovement;
let running=false,loaded=false,busy=false,thirdPerson=true,shooting=false,grounded=false;
let ropes;
let pendingGrenade=null,weaponReady=true;
let yaw=0,pitch=-.08,hp=100,ammo=120,money=0,weapon=0,collected=0,totalKeys=0,kills=0,shotTimer=0,toastTimer=0,damageTimer=0,hitTimer=0,saveTimer=0;
const position=new THREE.Vector3(),velocity=new THREE.Vector3(),spawn=new THREE.Vector3();
const forward=new THREE.Vector3(),right=new THREE.Vector3(),tmp=new THREE.Vector3();
let lastFrame=performance.now(),frameCount=0,fpsTime=0,frameCPUTime=0;
let drag=null,comicIndex=0,mapBounds,firePointer=null,aimHeld=false,crouchPressed=false,lookX=0,lookY=0;
const combat=new CombatController(),motion=new MotionController();
let cameraPreference=null;try{cameraPreference=localStorage.getItem('gulman-camera');}catch{}
let saved=null;try{saved=JSON.parse(localStorage.getItem('gulman-web-save-v1'));}catch{}

let toastHandle;
function toast(text){clearTimeout(toastHandle);toastHandle=setTimeout(()=>{$('toast').style.opacity=0;},3000);$('toast').textContent=text;toastTimer=3;$('toast').style.opacity=1;}

const menuMusic='music/gulman1_sg3.wav',gameMusic='music/t3.wav';
let sensitivity=1,invertMouse=false,classicPhysics=true,voiceTimer=25,comicEnding=false;
try{const settings=JSON.parse(localStorage.getItem('gulman-controls')||'{}');sensitivity=settings.sensitivity||1;invertMouse=!!settings.invertMouse;classicPhysics=settings.classicPhysics!==false;}catch{}
const audio=new AudioManager(path=>assets.sound(path),{onError:message=>toast(message),onStateChange:updateSoundStatus});
const ui=new OriginalUI({root:$('menu'),assets,onCommand:menuCommand});
const graphics=new GraphicsManager({onChange:syncGraphics});
graphics.applyAssets(assets);
thirdPerson=cameraPreference?cameraPreference==='third':graphics.mode!=='enhanced';
let lastGraphicsMode=graphics.mode;
const hero=createPlayerChoice({assets,getPlayer:()=>player,setPlayer:value=>{cancelGrenadeThrow();player=value;weaponReady=true;},getScene:()=>loaded?scene:null,getPosition:()=>position,getYaw:()=>yaw,getWeapon:()=>weapon,onChange:name=>{updateHeroName(name);if(loaded){if(isEnhanced())void ensureEnhancedCharacters();graphics.applyScene(scene,player);heroVoice();}},onError:message=>toast(message)});

function isEnhanced(){return graphics.mode==='enhanced';}
function usesOriginalPhysics(){return graphics.mode==='original'&&classicPhysics;}
function resetMovement(){originalMovement?.reset();velocity.set(0,0,0);grounded=false;}
function syncViewmodel(){
  if(isEnhanced()||weapon===2)void viewmodel?.setWeapon(weapon,{original:!isEnhanced()});
  viewmodel?.setVisible(!thirdPerson&&(isEnhanced()||weapon===2));
}
function cancelGrenadeThrow(){
  if(pendingGrenade){ammo=pendingGrenade.modern?combat.returnGrenade(ammo):ammo+weapons[2].cost;pendingGrenade=null;if(loaded)updateHUD();}
  player?.cancelGrenadeThrow?.();
}
function rebuildCrowd(){if(!loaded)return;crowd?.dispose();crowd=new CrowdRenderer(scene,actors);crowd.update(isEnhanced()?camera:camera.position);graphics.applyScene(scene,player);}
async function ensureEnhancedCharacters(){
  if(!loaded||!isEnhanced())return;
  if(!enhancedCharacters){const layer=new EnhancedCharacterLayer({assets,onChange:()=>{if(layer===enhancedCharacters&&isEnhanced())rebuildCrowd();}});enhancedCharacters=layer;}
  const layer=enhancedCharacters,types=['Box','Bugay','Ded','BruceLee','Dama','BoSS'];
  try{layer.setCharacters([[player,hero.value],...actors.map(actor=>[actor.char,types[actor.type]||'Box'])]);await layer.load();if(layer===enhancedCharacters)$('game').dataset.enhancedCharacters=String(layer.diagnostics.count);}
  catch(error){if(layer!==enhancedCharacters)return;console.error('Enhanced characters:',error);crowd?.dispose();layer.dispose();enhancedCharacters=null;rebuildCrowd();toast('Не удалось загрузить новые модели персонажей. Проверь соединение.');}
}
async function ensureEnhancedWorld(){
  const layer=enhancedWorld;if(!layer||!isEnhanced())return;
  layer.setEnabled(true);$('game').dataset.enhancedAssets=layer.ready?'ready':'loading';
  try{await layer.load();if(layer===enhancedWorld){layer.setEnabled(isEnhanced());$('game').dataset.enhancedAssets='ready';}}
  catch(error){if(layer.disposed&&layer!==enhancedWorld)return;console.error('Enhanced assets:',error);layer.dispose();if(layer===enhancedWorld){$('game').dataset.enhancedAssets='fallback';toast('Не удалось загрузить новые ресурсы Enhanced. Проверь соединение и перезагрузи уровень.');}}
}
function syncGraphics(){
  // Restore the shared source before either water layer claims its visibility.
  originalWater?.setEnabled(false);
  combatFX?.setEnabled(isEnhanced());
  if(!isEnhanced()&&enhancedCharacters){crowd?.dispose();enhancedCharacters.dispose();enhancedCharacters=null;$('game').dataset.enhancedCharacters='0';rebuildCrowd();}
  if(loaded&&isEnhanced())void ensureEnhancedCharacters();
  if(!isEnhanced()&&enhancedWorld?.promise){const old=enhancedWorld;old.dispose();enhancedWorld=new EnhancedWorld({assets,scene,world:worldMesh,modelData:old.modelData,levelId:level.id,groundSample:(x,y,z)=>world.ground(x,y,z,35),quality:graphics.diagnostics.effectiveQuality});$('game').dataset.enhancedAssets='unloaded';}
  enhancedWorld?.setEnabled(isEnhanced());originalWater?.setEnabled(!isEnhanced());if(loaded&&isEnhanced())void ensureEnhancedWorld();
  if(lastGraphicsMode!==graphics.mode){resetMovement();cancelGrenadeThrow();combat.reset({ammo,weapon});motion.prepare(player);motion.reset();world&&(world.height=1.65);if(!cameraPreference)thirdPerson=!isEnhanced();}
  lastGraphicsMode=graphics.mode;
  syncViewmodel();
  $('enhanced-controls').hidden=!isEnhanced();
  $('game').dataset.renderMode=graphics.mode;if(loaded)updateHUD();
}
function updateCameraButton(){const button=$('camera-switch');button.textContent=thirdPerson?'От 1-го лица':'От 3-го лица';button.title=(thirdPerson?'Переключить на вид от первого лица':'Переключить на вид от третьего лица')+' (C)';button.setAttribute('aria-label',button.title);}
function setCamera(third){thirdPerson=third;cameraPreference=third?'third':'first';try{localStorage.setItem('gulman-camera',cameraPreference);}catch{}syncViewmodel();updateCameraButton();}
function reloadWeapon(){if(!running||!isEnhanced()||player?.grenadeThrow?.active)return;if(combat.reload(ammo)){void audio.play('sounds/weapons/ricstone01.wav',.15,{duration:.12});updateCombatHUD();}}
function updateCombatHUD(){
  const modern=isEnhanced();$('enhanced-controls').hidden=!modern;$('reload-meter').hidden=!modern||!combat.reloading;
  $('reload-progress').style.width=(combat.reloadProgress*100)+'%';
  if(modern){const cost=weapons[weapon].cost;$('ammo-value').textContent=`${Math.floor(combat.magazine/cost)} / ${Math.floor(combat.reserve(ammo)/cost)}`;$('combat-state').textContent=combat.reloading?'ПЕРЕЗАРЯДКА':motion.sliding?'ПОДКАТ':ammo<cost?'НЕТ ПАТРОНОВ':combat.magazine<cost?'R — ПЕРЕЗАРЯДИТЬ':'';$('crosshair').style.opacity=String(1-combat.ads*.3);}
  else{$('combat-state').textContent='';$('crosshair').style.opacity='1';}
  $('game').dataset.magazine=String(combat.magazine);$('game').dataset.reloading=String(combat.reloading);$('game').dataset.ads=combat.ads.toFixed(2);
}
function updateHeroName(name=hero.value){const label=name==='Dama'?'ГУЛЬМОНИКА':'ГУЛЬМЭН';$('hero-name').textContent=label;$('game').dataset.hero=name;$('hero-gulman').setAttribute('aria-pressed',String(name==='Gulman'));$('hero-switch').setAttribute('aria-pressed',String(name==='Dama'));}
function updateSoundStatus(){const state=audio.diagnostics;$('game').dataset.audio=state.state;$('game').dataset.music=state.musicPlaying?'playing':'paused';const output=$('audio-status');if(output)output.textContent=state.lastError||state.stateLabel+(state.musicPlaying?' · музыка играет':'');$('sound-unlock').hidden=state.unlocked||state.muted;$('sound-unlock').textContent=state.lastError?'Повторить включение звука':'Включить звук';}
function playSound(path,volume=.8){void audio.play(path,volume);}
function setMusic(path){void audio.setMusic(path);}
function heroVoice(){const n=hero.value==='Dama'?2+Math.floor(Math.random()*3):1+Math.floor(Math.random()*5);void audio.play(hero.value==='Dama'?`sounds/гульмоника/${n}.wav`:`sounds/гульмен/г${n}.wav`,.9,{voice:true});voiceTimer=30+Math.random()*30;}
function showDialog(html){pause(false);$('hud').hidden=true;ui.showFrame(html);setMusic(menuMusic);}
function closeDialog(){ui.hide();}
const mouse=new MouseCapture(document,$('game'),(state,reason)=>{
  $('capture-mouse').hidden=state!=='drag'||mouse.waiting;
  $('mouse-recovery').hidden=!mouse.waiting;
  $('mouse-retry').disabled=state==='requesting';
  $('mouse-retry').hidden=reason==='blocked'||reason==='unsupported';
  $('mouse-recovery-status').textContent=state==='requesting'?'Запрашиваю захват мыши…':
    reason==='blocked'||reason==='unsupported'?'Здесь браузер не разрешает захват мыши. Открой игру в обычном браузере или продолжи с обзором перетаскиванием.':
    reason==='focus'?'Браузер не передал игре фокус. Кликни по игре для повтора. Если во встроенном окне это не помогает, открой игру в обычном браузере.':
    reason==='denied'||reason==='timeout'?'Браузер не подтвердил захват. Можно повторить или продолжить без него.':
    'Кликни по игре, чтобы захватить мышь. Игра на паузе.';
  $('game').dataset.mouseCapture=state;
  $('game').dataset.mouseCaptureReason=reason??'';
  if(mouse.waiting){shooting=false;aimHeld=false;drag=null;firePointer=null;keys.clear();}
});
function requestMouse(){if(running){if(!document.hasFocus())window.focus();$('game').focus({preventScroll:true});mouse.request();}}
function playWithoutMouseCapture(){if(!running)return;keys.clear();mouse.useDrag();$('game').focus({preventScroll:true});toast('Для обзора зажми ПКМ и двигай мышь. Можно также использовать стрелки.');}
function pause(show=true){running=false;shooting=false;aimHeld=false;drag=null;firePointer=null;keys.clear();mouse.stop();if(show&&loaded)pauseMenu();}
function resume(){if(!loaded)return;if(hp<=0){deathMenu();return;}closeDialog();$('hud').hidden=false;running=true;keys.clear();lastFrame=performance.now();$('game').focus({preventScroll:true});setMusic(gameMusic);if(matchMedia('(any-pointer:fine)').matches)mouse.start();}
function menuScreen(id,options={}){pause(false);$('hud').hidden=true;ui.show(id,options);setMusic(menuMusic);}
function pauseMenu(){if(hp<=0){deathMenu();return;}mainMenu();}
function recoverPlayer(){if(!loaded||hp<=0||busy)return;cancelGrenadeThrow();position.copy(spawn);resetMovement();shooting=false;aimHeld=false;motion.prepare(player);motion.reset();world.height=1.65;keys.clear();updateCamera(true);resume();toast('Ты у начала уровня. Собранные предметы и припасы сохранены.');}
function mainMenu(){menuScreen('main',{hotspotLabels:{EVEL1:loaded&&hp>0?'Продолжить игру':'Играть'},extras:(saved||loaded)?'<button data-command="CONTINUE">Продолжить</button>'+(loaded&&hp>0?'<button data-command="RECOVER" title="Вернуться к началу уровня, сохранив собранные предметы">Застрял? К началу уровня</button>':''):'',extrasRect:[165,655,700,48],extrasClass:'original-toolbar recovery-toolbar'});}
function chooseLevel(){menuScreen('levels',{extras:'<button data-command="EVEL9">9. Финальная схватка</button>',extrasRect:[190,588,390,48],extrasClass:'original-toolbar'});}
function about(){showDialog('<h2>Гульмэн 3D — веб-версия</h2><p>Ресурсы Enhanced: <a href="https://polyhaven.com/" target="_blank" rel="noopener">Powered by Poly Haven</a> (CC0).</p><p>Святослав Гуляев и команда оригинальной игры. Оригинальные уровни, модели, анимации, меню, иллюстрации и звук.</p><p>Движение и игровая логика восстановлены для браузера. Настройки и дополнительные кнопки адаптированы для веб-версии.</p><p><a href="https://www.gulman.ru/gul1.html" target="_blank" rel="noopener">Сайт автора</a></p>');}
function saveControls(){try{localStorage.setItem('gulman-controls',JSON.stringify({sensitivity,invertMouse,classicPhysics}));}catch{}}
function help(){menuScreen('controls',{extras:`<div class="control-table"><b>W A S D</b><span>Движение</span><b>Мышь / ← →</b><span>Обзор</span><b>Shift / Space</b><span>Бег / прыжок</span><b>ЛКМ / E</b><span>Стрелять / подобрать</span><b>ПКМ / R</b><span>Прицел / перезарядка (Enhanced)</span><b>Ctrl</b><span>Присесть; на бегу — подкат</span><b>1 · 2 · 3 · 4</b><span>Оружие</span><b>5 / 6</b><span>Гульмэн / Гульмоника</span><b>C / M / Esc</b><span>Камера / карта / меню</span></div><label>Камера<select id="camera-choice"><option value="first">От первого лица</option><option value="third">От третьего лица</option></select></label><label>Герой<select id="hero-choice"><option value="Gulman">Гульмэн — 5</option><option value="Dama">Гульмоника — 6</option></select></label><label>Чувствительность мыши <input id="sensitivity" type="range" min="0.3" max="2.5" step="0.1" value="${sensitivity}"></label><label><input id="classic-physics" type="checkbox" ${classicPhysics?'checked':''}>Физика оригинала в режиме «Оригинал»</label><p>Если застрял на прыжке, отключи для адаптированного движения.</p><label><input id="invert-mouse" type="checkbox" ${invertMouse?'checked':''}>Инверсия мыши</label>`,extrasRect:[350,200,430,450]});$('camera-choice').value=thirdPerson?'third':'first';$('camera-choice').onchange=e=>setCamera(e.target.value==='third');$('hero-choice').value=hero.value;$('hero-choice').onchange=e=>hero.select(e.target.value);$('sensitivity').oninput=e=>{sensitivity=+e.target.value;saveControls();};$('invert-mouse').onchange=e=>{invertMouse=e.target.checked;saveControls();};$('classic-physics').onchange=e=>{classicPhysics=e.target.checked;cancelGrenadeThrow();resetMovement();saveControls();};}
function soundMenu(){menuScreen('audio',{extras:`<label><input type="checkbox" id="sound-enabled" ${audio.muted?'':'checked'}>Включить звук</label><label>Музыка <output id="music-volume-value">${Math.round(audio.musicVolume*100)}%</output><input id="music-volume" aria-label="Громкость музыки" type="range" min="0" max="100" value="${audio.musicVolume*100}"></label><label>Эффекты и голоса <output id="effects-volume-value">${Math.round(audio.effectsVolume*100)}%</output><input id="effects-volume" aria-label="Громкость эффектов" type="range" min="0" max="100" value="${audio.effectsVolume*100}"></label><button data-command="TEST_SOUND">Проверить звук</button><p id="audio-status" role="status"></p>`});$('sound-enabled').onchange=e=>{audio.muted=!e.target.checked;audio.unlock();};for(const name of ['music','effects'])$(name+'-volume').oninput=e=>{audio[name+'Volume']=+e.target.value/100;$(name+'-volume-value').textContent=e.target.value+'%';};updateSoundStatus();}
function graphicsMenu(){
  menuScreen('graphics',{extras:`<label>Режим<select id="graphics-mode"><option value="potato">Калькулятор</option><option value="original">Оригинал</option><option value="enhanced">Enhanced — современный рендер</option></select></label><label>Качество Enhanced<select id="graphics-quality"><option value="auto">Авто — по производительности</option><option value="high">Высокое</option><option value="low">Лёгкое</option></select></label><label><input id="light-effects" type="checkbox" ${graphics.lighting?'checked':''}>Объёмный свет и тени</label><p>Новые модели, PBR-текстуры, живая вода, растительность и HDR-свет. Ресурсы Enhanced загружаются отдельно.</p><output id="graphics-status" role="status"></output>`,extrasRect:[350,210,420,435]});
  $('graphics-mode').value=graphics.mode;$('graphics-quality').value=graphics.quality;
  const state=()=>{$('graphics-status').textContent=graphics.mode==='enhanced'?'Enhanced включён':'Исходная графика';};
  $('light-effects').onchange=e=>{graphics.setLighting(e.target.checked,{renderer,scene,player});state();};
  $('graphics-mode').onchange=e=>{graphics.setMode(e.target.value,{renderer,scene,player});state();};
  $('graphics-quality').onchange=e=>{graphics.setQuality(e.target.value,{renderer,scene,player});state();};
}
function shop(status=''){menuScreen('shop',{shop:{balance:money,offers:[{command:'ПАТРОНЫ>4>',label:'БигГан',detail:'60 патронов',price:50},{command:'ПАТРОНЫ>3>',label:'Гранаты',detail:'20 патронов',price:25},{command:'BUY_HEALTH',label:'Здоровье',detail:hp>=100?'Уже полное':'Восстановить до 100%',price:30,disabled:hp>=100}]},status});}
function buy(kind){const cost=kind===2?25:kind===3?50:30;if(kind===-1&&hp>=100){shop('Здоровье уже полное');return;}if(money<cost){shop('Не хватает денег');return;}money-=cost;if(kind===-1)hp=100;else{ammo+=kind===2?20:60;changeWeapon(kind);}saveProgress();updateHUD();shop(kind===-1?'Здоровье восстановлено':kind===2?'Куплено 20 патронов для гранат':'Куплено 60 патронов БигГана');}
function briefings(ending=false){if(ending)comicEnding=true;const pages=(ui.data.comics[String(level.id)]||[]).filter(p=>comicEnding?p.terminal:!p.terminal);if(!pages.length){resume();return;}comicIndex=Math.min(comicIndex,pages.length-1);const page=pages[comicIndex];pause(false);$('hud').hidden=true;ui.showFrame('',{backCommand:null});ui.stage.classList.add('comic-stage');ui.setComicMode();ui.stage.replaceChildren();const art=document.createElement('img');art.className='comic-art';art.src=assets.url(page.image);art.alt='Оригинальный комикс: миссия '+level.id+', кадр '+(comicIndex+1);ui.stage.append(art);if(page.text){const text=document.createElement('img');text.className='comic-text';text.src=assets.url(page.text);text.alt='Текст оригинального комикса';ui.stage.append(text);}const nav=document.createElement('div');nav.className='comic-controls';nav.innerHTML=`<button data-command="COMIC_PREV" ${comicIndex?'':'disabled'}>←</button><span>${comicIndex+1} / ${pages.length}</span><button data-command="COMIC_NEXT">${comicIndex<pages.length-1?'Далее →':comicEnding?'В меню':'В игру →'}</button>${comicEnding?'':'<button data-command="RESUME">Пропустить</button>'}${page.characterSelection?'<button data-command="HERO_GULMAN">5 — Гульмэн</button><button data-command="HERO_DAMA">6 — Гульмоника</button>':''}`;ui.root.append(nav);nav.querySelector('button:not(:disabled)')?.focus();setMusic(menuMusic);}
function menuCommand(command){audio.unlock();if(command==='ESC'||command==='MENU_BACK'){if(['audio','graphics','controls'].includes(ui.currentMenu))menuScreen('settings');else if(ui.currentMenu==='main'&&loaded&&hp>0)resume();else mainMenu();return;}if(command==='EVEL1'&&ui.currentMenu==='main'){if(loaded&&hp>0)resume();else loadLevel(1);return;}if(/^EVEL[1-9]$/.test(command)){loadLevel(+command.slice(4));return;}const commands={CONTINUE:()=>loaded&&hp>0?resume():loadLevel(saved?.level||1,true),'ЗАГРУЗКА':chooseLevel,'НАСТРОЙКИ':()=>menuScreen('settings'),'АВТОРЫ':()=>menuScreen('credits',{extras:'<button data-command="ABOUT">О веб-версии</button>',extrasRect:[680,700,290,48],extrasClass:'original-toolbar'}),'ВЫХОД':()=>menuScreen('exit'),'ГРАФИКА':graphicsMenu,'ЗВУКИ':soundMenu,'УПРАВЛЕНИЕ':help,'ГЛАВНОЕ МЕНЮ':()=>['audio','graphics','controls'].includes(ui.currentMenu)?menuScreen('settings'):mainMenu(),'ВЫХОД=ДА':()=>{pause(false);showDialog('<h2>Игра завершена</h2><p>Прогресс сохранён. Эту вкладку можно закрыть.</p><button data-command="MAIN">В главное меню</button>');audio.pauseMusic();},'В=ИГРУ':resume,ReStart:()=>loadLevel(level?.id||1),MAIN:mainMenu,ABOUT:about,RESUME:resume,RECOVER:recoverPlayer,TEST_SOUND:()=>audio.unlock().then(ok=>{if(ok)heroVoice();}),HERO_GULMAN:()=>hero.select('Gulman'),HERO_DAMA:()=>hero.select('Dama'),'ПАТРОНЫ>3>':()=>buy(2),'ПАТРОНЫ>4>':()=>buy(3),BUY_HEALTH:()=>buy(-1),COMIC_PREV:()=>{comicIndex--;briefings();},COMIC_NEXT:()=>{const pages=(ui.data.comics[String(level.id)]||[]).filter(p=>comicEnding?p.terminal:!p.terminal);if(comicIndex<pages.length-1){comicIndex++;briefings();}else if(comicEnding){comicEnding=false;mainMenu();}else{resume();heroVoice();}}};commands[command]?.();}

function initRenderer(){if(renderer)return;renderer=new THREE.WebGLRenderer({canvas:$('game'),antialias:false,powerPreference:'high-performance'});graphics.applyRenderer(renderer);renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.setClearColor(0x9caeaa);camera=new THREE.PerspectiveCamera(67,innerWidth/innerHeight,.08,1000);world=new WorldCollision({radius:.28,height:1.65,stepHeight:.45});originalMovement=new OriginalMovement(world);viewmodel=new ProceduralViewmodel({assets,onError:message=>toast(String(message))});camera.add(viewmodel.group);window.addEventListener('resize',()=>{graphics.applyRenderer(renderer);renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();graphics.resize(innerWidth,innerHeight);projectiles?.setViewportHeight(renderer.domElement.height);});$('game').addEventListener('webglcontextlost',e=>{e.preventDefault();pause(false);showDialog('<h2>Графический контекст потерян</h2><p>Обнови страницу. Сохранение текущего уровня останется на устройстве.</p>');});requestAnimationFrame(frame);}
async function loadLevel(id,restore=false){if(busy||!assets.manifest)return;busy=true;pause(false);closeDialog();$('loading').hidden=false;$('loading-title').textContent=locations[id-1];$('loading-status').textContent='Оригинальная геометрия и текстуры…';$('menu').hidden=true;
  try{
    initRenderer();cancelGrenadeThrow();hero.cancel();loaded=false;originalWater?.dispose();originalWater=null;enhancedWorld?.dispose();enhancedWorld=null;graphics.releaseScene?.(scene);combatFX?.dispose();projectiles?.dispose();crowd?.dispose();enhancedCharacters?.dispose();enhancedCharacters=null;for(const actor of actors)actor.char.dispose();player?.dispose();player=null;actors=[];items=[];hazards=[];effects=[];
    level=assets.manifest.levels.find(l=>l.id===id);world.slopeCos=Math.cos(maxSlopeForLevel(id)*Math.PI/180);scene=new THREE.Scene();scene.add(camera);scene.background=new THREE.Color(id===9?0x6c7d81:0xacc5cc);scene.fog=new THREE.Fog(scene.background,180,650);scene.add(new THREE.HemisphereLight(0xf1f1df,0x626d55,2.1));const sun=new THREE.DirectionalLight(0xfff0cf,1.5);sun.position.set(80,180,50);scene.add(sun);
    const skyPath=assets.manifest.images['textures/!!!!!!sky_jpg__0.jpg'];if(skyPath){const sky=await assets.texture({map:skyPath});sky.mapping=THREE.EquirectangularReflectionMapping;scene.background=sky;}
    worldMesh=await assets.model(level.model);scene.add(worldMesh);worldMesh.updateMatrixWorld(true);$('loading-status').textContent='Столкновения и персонажи…';await new Promise(r=>setTimeout(r,20));const modelData=await assets.json(assets.manifest.models[level.model.toLowerCase()]);ropes=ropeSupport(id,modelData);world.setWorld(worldMesh,ropes);
    enhancedWorld=new EnhancedWorld({assets,scene,world:worldMesh,modelData,levelId:id,groundSample:(x,y,z)=>world.ground(x,y,z,35),quality:graphics.diagnostics.effectiveQuality});
    originalWater=new OriginalWater({scene,world:worldMesh,modelData:enhancedWorld.modelData,sky:scene.background,levelId:id});
    mapBounds=new THREE.Box3().setFromObject(worldMesh);
    const start=level.entities.filter(e=>e.command==='GameStart').at(-1);if(!start)throw new Error('Нет точки старта');position.set(start.x/100,start.y/100,start.z/100);const floor=world.ground(position.x,position.y+.2,position.z,50);position.y=(floor??position.y-1)+.03;spawn.copy(position);resetMovement();
    const keyEntity=level.entities.find(e=>e.command==='GameKey');yaw=keyEntity?Math.atan2(keyEntity.x/100-position.x,keyEntity.z/100-position.z):0;pitch=-.07;
    hp=100;ammo=restore?Math.max(60,saved?.ammo||120):120;money=restore?saved?.money||0:0;weapon=0;weaponReady=true;collected=0;totalKeys=level.entities.filter(e=>e.command==='GameKey').length;kills=0;comicIndex=0;comicEnding=false;combat.reset({ammo,weapon});motion.reset();world.height=1.65;
    toastTimer=0;damageTimer=0;hitTimer=0;shotTimer=0;$('toast').style.opacity=0;$('damage').style.borderColor='transparent';$('hitmarker').style.opacity=0;$('prompt').style.display='none';$('objective-distance').textContent='';$('minimap').hidden=true;
    player=await createCharacter(hero.value,assets.model.bind(assets),assets.json.bind(assets));scene.add(player.group);player.characterName=hero.value;updateHeroName();
    const weaponModel=await assets.model('models/weapons/weaponpistol.3ds',true);if(player.attachWeapon)player.attachWeapon(weaponModel);
    const types=['Box','Bugay','Ded','BruceLee','Dama','BoSS'];
    const enemyEntries=level.entities.filter(e=>e.command==='БОТ');let done=0;
    // Build models in small batches so loading remains responsive on modest devices.
    for(const e of enemyEntries){const type=+e.args[0]||0;const ch=await createCharacter(types[type]||'Box',assets.model.bind(assets),assets.json.bind(assets));const p=new THREE.Vector3(e.x/100,e.y/100,e.z/100);p.y=world.ground(p.x,p.y+.3,p.z,12)??p.y-1;ch.group.position.copy(p);scene.add(ch.group);actors.push({char:ch,pos:p,home:p.clone(),hp:type===5?200:75,timer:Math.random()*2,dead:false,type});done++;if(done%10===0){$('loading-status').textContent=`Персонажи: ${done} / ${enemyEntries.length}`;await new Promise(r=>setTimeout(r,0));}}
    const pickupEntries=level.entities.filter(e=>!['БОТ','GameStart',''].includes(e.command));
    await Promise.all(pickupEntries.map(e=>{
      const p=new THREE.Vector3(e.x/100,e.y/100,e.z/100);if(e.command==='#Uron'){hazards.push({pos:p,radius:Math.max(1,e.a/10)});return;}
      return createPickup(e,p,scene);
    }));
    projectiles=new OriginalProjectiles({scene,world,assets,onImpact:projectileImpact});await projectiles.load();projectiles.setViewportHeight(renderer.domElement.height);
    crowd=new CrowdRenderer(scene,actors);combatFX=new CombatFX(scene);graphics.applyScene(scene,player);loaded=true;syncGraphics();if(isEnhanced()){$('loading-status').textContent='Материалы и модели Enhanced…';await Promise.all([viewmodel.setWeapon(weapon),ensureEnhancedWorld(),ensureEnhancedCharacters(),graphics.prepareEnvironment(assets)]);}$('hud').hidden=false;$('level-label').textContent=`МИССИЯ ${String(id).padStart(2,'0')} / 09 · ${locations[id-1]}`;updateHUD();updateCamera(true);crowd.update(isEnhanced()?camera:camera.position);graphics.render(renderer,scene,camera,0);setMusic('music/t3.wav');saveProgress();
    briefings();
  }catch(err){console.error(err);loaded=false;$('hud').hidden=true;$('menu').hidden=false;$('status').textContent='Не удалось загрузить уровень: '+err.message;showDialog(`<h2>Уровень не загрузился</h2><p id="load-error"></p><button id="back-to-menu">Вернуться в меню</button>`);$('load-error').textContent=err.message;$('back-to-menu').onclick=mainMenu;
  }finally{busy=false;$('loading').hidden=true;}
}
async function createPickup(entry,p,targetScene){
  const holder=new THREE.Group();holder.position.copy(p);let model;
  if(entry.model){
    model=await assets.model(entry.model);if(scene!==targetScene)return;
    const b=new THREE.Box3().setFromObject(model),size=b.getSize(new THREE.Vector3()),desired=entry.command==='GameEnd'?1.25:entry.command==='GameKey'?.7:entry.command==='БАКСЫ'?.42:.35;
    model.scale.multiplyScalar(desired/Math.max(size.x,size.y,size.z,.001));b.setFromObject(model);model.position.sub(b.getCenter(new THREE.Vector3()));holder.add(model);
  }else holder.add(new THREE.Mesh(new THREE.OctahedronGeometry(.35),new THREE.MeshBasicMaterial({color:0xa5e7cb,wireframe:true})));
  if(scene!==targetScene)return;
  const color=entry.command==='GameEnd'?0xb9ea91:entry.command==='GameKey'?0xffd477:0x9bb28c;
  if(['GameEnd','GameKey','МАГАЗИН'].includes(entry.command)){const ring=new THREE.Mesh(new THREE.TorusGeometry(.52,.025,6,32),new THREE.MeshBasicMaterial({color,depthTest:false}));ring.rotation.x=Math.PI/2;ring.position.y=-.2;holder.add(ring);}
  targetScene.add(holder);const item={entry,pos:p.clone(),object:holder,collected:false,baseY:p.y};items.push(item);
  if(entry.dropped){holder.userData.droppedLoot=true;graphics.applyScene(scene,player);$('game').dataset.lootDrops=String(items.filter(i=>i.entry.dropped&&!i.collected).length);}
  return item;
}
function hurtActor(actor,value){
  if(actor.dead)return;actor.hp-=value;
  if(actor.hp>0)return;actor.dead=true;kills++;
  void audio.play('sounds/боты/в'+(1+Math.floor(Math.random()*4))+'.wav',.5,{voice:true});
  const targetScene=scene;
  for(const drop of rollOriginalLoot(actor.pos,{world})){
    const entry={id:10000+items.length+Math.floor(Math.random()*1000),command:drop.command,args:[String(drop.amount)],model:drop.model,dropped:true,pickupAmount:drop.amount};
    void createPickup(entry,drop.position.clone().add(new THREE.Vector3(0,.24,0)),targetScene).catch(error=>console.warn('Dropped pickup:',error));
  }
}
function projectileImpact(hit){
  if(!loaded)return;
  const {position:point,normal,actor,damage:power,owner}=hit,splash=hit.splash||0;
  if(owner==='player'&&actor&&!actor.dead){hurtActor(actor,power);hitTimer=.15;$('hitmarker').style.opacity=1;}
  else if(owner==='enemy'&&actor)damage(power);
  if(splash){
    playSound(hit.weapon===2?'sounds/weapons/gl_explodesmoke.wav':'sounds/weapons/sg_mediumexplode.wav',Math.min(.7,14/Math.max(14,point.distanceTo(position))));
    const start=point.clone();if(normal)start.addScaledVector(normal,.06);
    for(const target of actors){if(target.dead||target===actor)continue;const to=target.pos.clone().add(new THREE.Vector3(0,.8,0)).sub(start),distance=to.length();if(distance<splash&&!world.ray(start,to,Math.max(0,distance-.3)))hurtActor(target,power*(1-distance/splash));}
    const to=position.clone().add(new THREE.Vector3(0,.8,0)).sub(start),distance=to.length();if(actor!=='player'&&distance<splash&&!world.ray(start,to,Math.max(0,distance-.3)))damage(power*(1-distance/splash)*.35);
  }
  if(isEnhanced())combatFX?.shot({origin:point,end:point,normal,hit:!!actor,explosionRadius:splash});
  updateHUD();
}
function saveProgress(){if(!level)return;saved={version:1,level:level.id,money,ammo:ammo+(pendingGrenade?weapons[2].cost:0),date:Date.now()};try{localStorage.setItem('gulman-web-save-v1',JSON.stringify(saved));}catch{}}
function updateHUD(){ $('health-value').textContent=Math.max(0,Math.ceil(hp));$('health-bar').style.width=Math.max(0,hp)+'%';$('ammo-value').textContent=ammo;$('credits').textContent='$ '+money;$('weapon-name').textContent=weapons[weapon].name;$('weapon-icon').src=assets.url(ui.data.hud[['pistol','rifle','grenade','bigGun'][weapon]].image);$('weapon-slots').textContent=[1,2,3,4].map(n=>n===weapon+1?'['+n+']':n).join(' · ');$('objective').textContent=collected>=totalKeys?'Артефакты собраны. Найди выход.':tasks[level.id-1]+(totalKeys>1?` (${collected}/${totalKeys})`:'');combat.setAmmo(ammo);updateCombatHUD(); }
async function changeWeapon(index){cancelGrenadeThrow();weaponReady=false;weapon=index;combat.setWeapon(index);syncViewmodel();updateHUD();const currentPlayer=player;const paths=['weaponpistol','weaponrifle','granate','weaponrifle2'];try{const model=await assets.model('models/weapons/'+paths[index]+'.3ds',true);if(player===currentPlayer&&weapon===index){player.attachWeapon(model,{length:index===2?.2:index===0?.42:.7});weaponReady=true;}}catch(error){console.warn('Weapon model:',error);}}
function deathMenu(){menuScreen('gameOver',{extras:'<button data-command="MAIN">Главное меню</button>',extrasRect:[380,680,300,45],extrasClass:'original-toolbar'});}
function damage(amount){if(!running||hp<=0)return;hp=Math.max(0,hp-amount);damageTimer=.3;$('damage').style.borderColor='#ad202080';if(hp<=0){cancelGrenadeThrow();saveProgress();deathMenu();}updateHUD();}
function tracer(a,b,color=0xffdb8b){const g=new THREE.BufferGeometry().setFromPoints([a,b]);const mat=new THREE.LineBasicMaterial({color,transparent:true,opacity:.8});const line=new THREE.Line(g,mat);scene.add(line);effects.push({mesh:line,ttl:.09});}

function shoot(){
  if(!running||mouse.waiting||!weaponReady||pendingGrenade||player?.grenadeThrow?.active)return;
  const w=weapons[weapon],modern=isEnhanced();let spread=0;
  if(modern){const shot=combat.tryFire(ammo);if(!shot.fired){if(shot.reason==='reload')reloadWeapon();else if(shot.reason==='empty'&&toastTimer<=0)toast('Нет патронов. Ищи припасы или магазин.');return;}ammo=shot.ammo;spread=shot.spread||0;if(weapon!==2)viewmodel?.flash();}
  else{if(shotTimer>0)return;if(ammo<w.cost){toast('Нет патронов. Ищи ящики или магазин.');shotTimer=.5;return;}shotTimer=w.rate;ammo-=w.cost;}
  if(weapon===2){
    if(usesOriginalPhysics()){
      const aim=new THREE.Vector3(Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch));
      const eye=position.clone().add(new THREE.Vector3(0,1.4,0));
      const anchor=position.clone().add(new THREE.Vector3(-.22*Math.cos(yaw)-.01*Math.sin(yaw),2.15,.22*Math.sin(yaw)-.01*Math.cos(yaw)));
      const origin=safeProjectileOrigin(eye,anchor,world);
      projectiles?.fire({weapon:2,origin,direction:aim,owner:'player',damage:w.damage,classicGrenade:true});
      player.beginGrenadeThrow({immediate:true});updateHUD();return;
    }
    pendingGrenade={player,scene,modern};
    if(!player.beginGrenadeThrow())cancelGrenadeThrow();
    updateHUD();return;
  }
  if(weapon!==2)playSound(w.sound,.55);camera.getWorldDirection(tmp);const dir=tmp.clone(),origin=camera.position.clone();
  if(spread){dir.applyAxisAngle(camera.up,(Math.random()-.5)*spread);dir.y+=(Math.random()-.5)*spread;dir.normalize();}
  const wall=world.ray(origin,dir,180);let distance=wall?.distance??180,target=null;
  const ray=new THREE.Ray(origin,dir),point=new THREE.Vector3();
  for(const actor of actors){if(actor.dead)continue;const center=actor.pos.clone().add(new THREE.Vector3(0,.95,0));if(ray.intersectSphere(new THREE.Sphere(center,.7),point)){const d=point.distanceTo(origin);if(d<distance){distance=d;target=actor;}}}
  const end=origin.clone().addScaledVector(dir,distance),muzzle=position.clone().add(new THREE.Vector3(0,1.2,0));
  if(thirdPerson)player.weaponMuzzlePosition?.(muzzle);else if(modern)viewmodel.muzzleWorldPosition(muzzle);else muzzle.copy(camera.position).addScaledVector(dir,.35);
  // A barrel can visually overlap a wall; its projectile must start before it.
  const eye=position.clone().add(new THREE.Vector3(0,modern?motion.eyeHeight:1.4,0));
  muzzle.copy(safeProjectileOrigin(eye,muzzle,world));
  const muzzleDirection=end.clone().sub(muzzle).normalize();
  projectiles?.fire({weapon,origin:muzzle,direction:muzzleDirection,owner:'player',damage:w.damage});

  updateHUD();
}
function releaseGrenade(){
  if(!pendingGrenade)return;
  if(pendingGrenade.player!==player||pendingGrenade.scene!==scene){cancelGrenadeThrow();return;}
  const hand=player.consumeGrenadeRelease(new THREE.Vector3());if(!hand)return;
  if(!thirdPerson&&viewmodel.weapon===2)viewmodel.grenadeReleaseWorldPosition(hand);
  camera.getWorldDirection(tmp);
  // The hand travels with the throw; a wall overlapping that hand still blocks
  // the grenade. A modest lob offsets gravity without changing the camera aim.
  const eye=position.clone().add(new THREE.Vector3(0,isEnhanced()?motion.eyeHeight:1.4,0));
  const origin=safeProjectileOrigin(eye,hand,world),direction=tmp.clone();
  direction.y+=.18;direction.normalize();
  pendingGrenade=null;
  projectiles?.fire({weapon:2,origin,direction,owner:'player',damage:weapons[2].damage});
  updateHUD();
}
function interact(item){const e=item.entry,n=e.pickupAmount??rollOriginalPickup(e.command).amount??0;
  if(e.command==='GameEnd'){if(collected<totalKeys){toast('Сначала найди все предметы задания.');return;}saveProgress();if(level.id<9){showDialog(`<div class="eyebrow">МИССИЯ ВЫПОЛНЕНА</div><h2>Артефакт спасён</h2><p>Следующая остановка: ${locations[level.id]}.</p><div class="dialog-actions"><button class="primary" id="next-level">Продолжить →</button><button id="end-menu">Главное меню</button></div>`);$('next-level').onclick=()=>loadLevel(level.id+1,true);$('end-menu').onclick=mainMenu;}else{comicIndex=0;briefings(true);}return;}
  if(e.command==='МАГАЗИН'){shop();return;}
  if(e.command==='АПТЕЧКА'){if(hp>=100){toast('Здоровье уже полное.');return;}hp=Math.min(100,hp+(n||15));toast('Здоровье +'+(n||15));}
  else if(e.command==='ПАТРОНЫ'){ammo+=n||10;toast('Патроны +'+(n||10));}
  else if(e.command==='БАКСЫ'){money+=n||37;toast('$ +'+(n||37));}
  else if(e.command==='GameKey'){collected++;void audio.play('music/трек артефакт.wav',.5,{duration:6});toast(collected>=totalKeys?'Артефакты собраны. Теперь к выходу!':`Артефакт ${collected} / ${totalKeys}`);}
  else return;
  item.collected=true;item.object.visible=false;$('game').dataset.lootDrops=String(items.filter(i=>i.entry.dropped&&!i.collected).length);updateHUD();saveProgress();
}
function updateItems(dt,time){const near=selectInteraction(items,position,world,{health:hp,collected,totalKeys});for(const item of items){if(item.collected)continue;const important=['GameKey','GameEnd','МАГАЗИН'].includes(item.entry.command);item.object.rotation.y=time*(important?.45:.25);item.object.position.y=item.baseY+Math.sin(time*2+item.entry.id)*.08;}
  $('prompt').style.display=near?'block':'none';if(near){const names={'АПТЕЧКА':'Аптечка','ПАТРОНЫ':'Патроны','БАКСЫ':'Деньги','GameKey':'Предмет задания','GameEnd':'Выход','МАГАЗИН':'Магазин'};$('prompt').textContent='E — '+(names[near.entry.command]||'Подобрать');if(keys.has('KeyE')){keys.delete('KeyE');interact(near);}}
  const targets=items.filter(i=>!i.collected&&i.entry.command===(collected>=totalKeys?'GameEnd':'GameKey'));const min=targets.length?Math.min(...targets.map(t=>position.distanceTo(t.pos))):0;$('objective-distance').textContent=min?`${Math.round(min)} м до ${collected>=totalKeys?'выхода':'цели'} · M — карта`:'';
}
function updateEnemies(dt,modern){const playerEye=position.clone().add(new THREE.Vector3(0,1.1,0));for(const actor of actors){const dist=actor.pos.distanceTo(position);actor.char.group.visible=dist<100;if(actor.dead){actor.char.update(dt,false,true);continue;}if(dist>75)continue;actor.timer-=dt;const to=playerEye.clone().sub(actor.pos.clone().add(new THREE.Vector3(0,1.2,0)));const canSee=dist<38&&!world.ray(actor.pos.clone().add(new THREE.Vector3(0,1.2,0)),to,to.length()-.6);let moving=false;
    if(canSee){actor.char.group.rotation.y=Math.atan2(to.x,to.z);if(dist>8){const direction=new THREE.Vector3(to.x,0,to.z).normalize();const step=direction.clone().multiplyScalar(dt*2.2);const body=actor.pos.clone().add(new THREE.Vector3(0,.8,0));if(!world.ray(body,direction,.6+step.length())){const next=actor.pos.clone().add(step);const floor=world.ground(next.x,next.y+.65,next.z,1.8);if(floor!==undefined&&Math.abs(floor-next.y)<.7){actor.pos.set(next.x,floor,next.z);moving=true;}}}if(actor.timer<=0&&dist<30){actor.timer=1.2+Math.random()*1.4;const from=actor.pos.clone().add(new THREE.Vector3(0,1.2,0));const aim=playerEye.clone().sub(from).normalize();aim.x+=(Math.random()-.5)*.08;aim.y+=(Math.random()-.5)*.06;projectiles?.fire({weapon:actor.type===5?3:0,origin:from,direction:aim.normalize(),owner:'enemy',damage:actor.type===5?10:4});}}
    actor.char.group.position.copy(actor.pos);actor.char.update(dt,{moving,running:false,enhanced:modern});
  }
}

function updateCamera(instant=false,dt=.016){
  const modern=isEnhanced(),ads=modern?combat.ads:0;
  const head=position.clone().add(new THREE.Vector3(0,modern?motion.eyeHeight:1.4,0));
  if(modern)head.y+=motion.landing+(!thirdPerson?motion.bob:0);
  const viewYaw=yaw+(modern?combat.recoil.yaw:0),viewPitch=pitch+(modern?combat.recoil.pitch:0);
  const direction=new THREE.Vector3(Math.sin(viewYaw)*Math.cos(viewPitch),Math.sin(viewPitch),Math.cos(viewYaw)*Math.cos(viewPitch));let desired;
  if(thirdPerson){desired=head.clone().addScaledVector(direction,-(4-ads*1.9)).add(new THREE.Vector3(Math.cos(yaw)*.55,.5,-Math.sin(yaw)*.55));const v=desired.clone().sub(head),hit=world.ray(head,v,v.length());if(hit)desired.copy(head).addScaledVector(v.normalize(),Math.max(.2,hit.distance-.2));}else desired=head;
  camera.position.copy(desired);camera.lookAt(head.clone().addScaledVector(direction,40));
  if(modern)camera.rotateZ(motion.roll);
  const fov=modern?(75-ads*25+(motion.sprinting?7:motion.sliding?5:0)):67;
  camera.fov=instant?fov:THREE.MathUtils.lerp(camera.fov,fov,1-Math.exp(-dt*12));camera.updateProjectionMatrix();
  player.group.position.copy(position);player.group.rotation.y=yaw;player.group.visible=thirdPerson&&camera.position.distanceTo(head)>.8;
  viewmodel?.setVisible(!thirdPerson&&(modern||weapon===2));updateCameraButton();
}
function updateMap(){if($('minimap').hidden)return;const ctx=$('minimap').getContext('2d'),w=220;ctx.clearRect(0,0,w,w);ctx.fillStyle='#101a13e0';ctx.fillRect(0,0,w,w);const sx=mapBounds.max.x-mapBounds.min.x,sz=mapBounds.max.z-mapBounds.min.z,scale=190/Math.max(sx,sz);const map=p=>[110+(p.x-(mapBounds.min.x+mapBounds.max.x)/2)*scale,110+(p.z-(mapBounds.min.z+mapBounds.max.z)/2)*scale];ctx.strokeStyle='#75865e60';ctx.strokeRect(110-sx*scale/2,110-sz*scale/2,sx*scale,sz*scale);const dot=(p,c,r)=>{const [x,z]=map(p);ctx.fillStyle=c;ctx.beginPath();ctx.arc(x,z,r,0,Math.PI*2);ctx.fill();};for(const a of actors)if(!a.dead)dot(a.pos,'#d47560',2);for(const i of items)if(!i.collected&&['GameKey','GameEnd'].includes(i.entry.command))dot(i.pos,i.entry.command==='GameKey'?'#f6cf71':'#a2e47e',4);dot(position,'white',4);const [x,z]=map(position);ctx.strokeStyle='white';ctx.beginPath();ctx.moveTo(x,z);ctx.lineTo(x+Math.sin(yaw)*10,z+Math.cos(yaw)*10);ctx.stroke();ctx.fillStyle='#c6d2b0';ctx.font='10px Arial';ctx.fillText('N',105,12);}

function frame(now){
  requestAnimationFrame(frame);const elapsed=Math.min(.25,(now-lastFrame)/1000),dt=Math.min(.04,elapsed);lastFrame=now;
  if(!loaded||!scene||(!running&&ui.visible)||mouse.waiting)return;const cpuStart=performance.now();
  if(running){
    const modern=isEnhanced(),classic=usesOriginalPhysics();voiceTimer-=dt;if(voiceTimer<=0)heroVoice();shotTimer-=dt;saveTimer+=dt;
    if(saveTimer>10){saveTimer=0;saveProgress();}if(keys.has('ArrowLeft'))yaw+=dt*1.8;if(keys.has('ArrowRight'))yaw-=dt*1.8;if(keys.has('ArrowUp'))pitch=Math.min(.9,pitch+dt);if(keys.has('ArrowDown'))pitch=Math.max(-1.1,pitch-dt);
    const f=(keys.has('KeyW')?1:0)-(keys.has('KeyS')?1:0),s=(keys.has('KeyD')?1:0)-(keys.has('KeyA')?1:0),moving=!!(f||s);
    const shiftHeld=keys.has('ShiftLeft')||keys.has('ShiftRight');
    const sprint=shiftHeld&&moving&&(classic||(!aimHeld&&!shooting&&!player.grenadeThrow?.active));
    const crouchHeld=keys.has('ControlLeft')||keys.has('ControlRight');
    if(modern){motion.update(dt,{moving,sprinting:sprint,aiming:combat.ads,crouchPressed,crouchHeld,grounded,verticalSpeed:velocity.y,strafe:s});combat.setAmmo(ammo);combat.update(dt,{aiming:aimHeld,sprinting:motion.sprinting,moving,grounded});}
    crouchPressed=false;
    const jump=keys.has('Space');
    const moveYaw=grounded&&!jump&&!motion.sliding?(ropes?.heading(position,yaw,f,s)??yaw):yaw;
    forward.set(Math.sin(moveYaw),0,Math.cos(moveYaw));right.set(-Math.cos(moveYaw),0,Math.sin(moveYaw));tmp.copy(forward).multiplyScalar(f).addScaledVector(right,s);if(tmp.lengthSq())tmp.normalize();
    if(modern&&motion.sliding)tmp.copy(forward);tmp.multiplyScalar(modern?motion.speed:sprint?8:4.3);velocity.x=tmp.x;velocity.z=tmp.z;
    if(modern){if(motion.crouched)world.height=1.12;else if(world.height<1.65){const ceiling=world.ray(position.clone().add(new THREE.Vector3(0,.4,0)),new THREE.Vector3(0,1,0),1.25);if(!ceiling)world.height=1.65;else motion.crouched=true;}}else world.height=1.65;
    if(!classic&&jump&&grounded&&world.height>1.5){velocity.y=jumpSpeedForLevel(level.id);grounded=false;keys.delete('Space');}
    const fallSpeed=velocity.y,result=classic?originalMovement.move(position,velocity,elapsed,{forward:f,strafe:s,yaw:moveYaw,sprint,jump,actors}):world.move(position,velocity,dt,grounded);if(result.onGround&&!grounded&&modern){motion.landingVelocity=-Math.min(.85,Math.abs(fallSpeed)*.055);}grounded=result.onGround;
    if(position.y<mapBounds.min.y-20){position.copy(spawn);resetMovement();damage(15);toast('Возвращение на безопасную точку.');}
    motion.prepare(player);player.update(dt,{moving,running:modern?motion.sprinting:sprint,airborne:!grounded,crouching:modern&&motion.crouched,direction:f<0?'back':s<0?'left':s>0?'right':'forward',enhanced:modern});
    if(modern&&!player.grenadeThrow?.active)motion.apply(player,{moving,aiming:combat.ads,reloading:combat.reloading,reloadProgress:combat.reloadProgress,recoil:combat.recoil.pitch});
    updateCamera(false,dt);
    if(modern||weapon===2)viewmodel.update(dt,{speed:modern?motion.speed:moving?4.3:0,sprinting:modern&&motion.sprinting,aiming:modern?combat.ads:0,reloading:modern&&combat.reloading,reloadProgress:combat.reloadProgress,recoil:modern?combat.recoil:{},movementX:lookX,movementY:lookY,grounded,landing:modern?motion.landing:0,grenadeThrow:player.grenadeThrow});
    releaseGrenade();if(modern)updateCombatHUD();
    lookX=lookY=0;if(shooting)shoot();updateEnemies(dt,modern);if(running)updateItems(dt,now/1000);for(const h of hazards)if(position.distanceTo(h.pos)<h.radius)damage(dt*10);updateMap();projectiles?.update(dt,{actors,playerPosition:position});combatFX?.update(dt);
  }
  for(let i=effects.length-1;i>=0;i--){const e=effects[i];e.ttl-=dt;if(e.ttl<=0){e.mesh.removeFromParent();e.mesh.geometry.dispose();e.mesh.material.dispose();effects.splice(i,1);}}
  if(toastTimer>0&&(toastTimer-=dt)<=0)$('toast').style.opacity=0;if(damageTimer>0&&(damageTimer-=dt)<=0)$('damage').style.borderColor='transparent';if(hitTimer>0&&(hitTimer-=dt)<=0)$('hitmarker').style.opacity=0;
  originalWater?.update(running?dt:0);graphics.update(position,{grounded,dt,time:now/1000,camera});enhancedWorld?.update(now/1000,camera,graphics.diagnostics.effectiveQuality);if(crowd){crowd.maxDistance=isEnhanced()?(graphics.diagnostics.effectiveQuality==='low'?40:65):75;crowd.update(isEnhanced()?camera:camera.position);}graphics.render(renderer,scene,camera,elapsed);
  frameCount++;fpsTime+=elapsed;frameCPUTime+=performance.now()-cpuStart;
  if(fpsTime>1){Object.assign($('game').dataset,{fps:String(Math.round(frameCount/fpsTime)),cpuMs:(frameCPUTime/frameCount).toFixed(2),triangles:String(renderer.info.render.triangles),drawCalls:String(renderer.info.render.calls),level:String(level.id),position:position.toArray().map(n=>n.toFixed(2)).join(','),renderMode:graphics.mode,quality:graphics.quality,effectiveQuality:graphics.diagnostics.effectiveQuality,renderScale:String(graphics.diagnostics.renderScale),renderPasses:String(graphics.diagnostics.postprocessing?.passes||1),enhancedModels:String(enhancedWorld?.diagnostics.props||0),enhancedArchitecture:String(enhancedWorld?.diagnostics.architecture?.instances||0),enhancedCharacters:String(enhancedCharacters?.diagnostics.count||0),visibleCharacters:String(crowd?.stats.visibleActors||0),enhancedSurfaces:String((enhancedWorld?.diagnostics.surfaces||0)+(enhancedWorld?.diagnostics.landscape?.surfaces||0)),activeProjectiles:String(projectiles?.activeCount||0),grenadeThrow:player?.grenadeThrow?.active?(player.grenadeThrow.released?'recovery':'windup'):'idle',lootDrops:String(items.filter(i=>i.entry.dropped&&!i.collected).length),enhancedVegetation:String(enhancedWorld?.diagnostics.vegetation?.replacements||0),enhancedImportedProps:String(enhancedWorld?.diagnostics.importedProps?.replacements||0),sky:graphics.diagnostics.sky,originalWater:String(originalWater?.diagnostics.enabled||false),physics:usesOriginalPhysics()?'dce':'adapted'});frameCount=0;fpsTime=0;frameCPUTime=0;}
}

document.addEventListener('pointerdown',e=>{if(!audio.unlocked)audio.unlock();if(running&&e.pointerType==='touch'&&mouse.waiting)mouse.useDrag();},true);
document.addEventListener('keydown',e=>{
  if(!audio.unlocked)audio.unlock();
  if(e.target.isContentEditable||e.target.closest?.('input,select,textarea,[contenteditable="true"],[role="textbox"]'))return;
  const selectedHero=heroForKey(e);if(selectedHero){e.preventDefault();if(!busy)hero.select(selectedHero);return;}
  if(e.metaKey||e.altKey||(e.ctrlKey&&(!running||!['ControlLeft','ControlRight','KeyW','KeyA','KeyS','KeyD','Space','ShiftLeft','ShiftRight'].includes(e.code))))return;
  if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)||(running&&e.ctrlKey))e.preventDefault();
  if(e.code==='Escape'){if(running)pause();return;}if(!running)return;keys.add(e.code);if(e.repeat)return;
  if(e.code==='KeyC')setCamera(!thirdPerson);if(e.code==='KeyM')$('minimap').hidden=!$('minimap').hidden;if(e.code==='KeyR')reloadWeapon();
  if(e.code==='ControlLeft'||e.code==='ControlRight')crouchPressed=true;
  if(/^Digit[1-4]$/.test(e.code))changeWeapon(+e.code.at(-1)-1);
});
document.addEventListener('keyup',e=>keys.delete(e.code));window.addEventListener('blur',()=>{keys.clear();if(running)pause();});document.addEventListener('visibilitychange',()=>{if(document.hidden){if(running)pause();audio.pauseMusic();}else audio.resumeMusic();});
$('game').addEventListener('pointerdown',e=>{
  if(!running)return;
  if(mouse.waiting)return;
  if(!mouse.locked){drag={id:e.pointerId,x:e.clientX,y:e.clientY};$('game').setPointerCapture?.(e.pointerId);}
  if(e.pointerType!=='touch'&&e.button===0){shooting=true;firePointer=e.pointerId;shoot();}
  if(e.button===2)aimHeld=true;
});
// Click follows the browser's normal pointer focus handling. The preceding
// pointerdown was consumed while waiting, so re-capture cannot fire a round.
$('game').addEventListener('click',()=>{
  if(mouse.waiting&&mouse.reason!=='blocked'&&mouse.reason!=='unsupported')requestMouse();
});
document.addEventListener('mouseup',e=>{if(e.button===0){shooting=false;firePointer=null;}if(e.button===2)aimHeld=false;});
function releasePointer(e){if(e.button===2)aimHeld=false;if(e.pointerId===firePointer&&e.button!==2){shooting=false;firePointer=null;}if(e.pointerId===drag?.id&&(!e.buttons||e.type!=='pointerup'))drag=null;}
document.addEventListener('pointerup',releasePointer);document.addEventListener('pointercancel',releasePointer);$('game').addEventListener('lostpointercapture',releasePointer);
$('game').addEventListener('contextmenu',e=>e.preventDefault());
document.addEventListener('pointermove',e=>{if(!running)return;lookX=e.movementX||0;lookY=e.movementY||0;if(mouse.locked){yaw-=e.movementX*.0025*sensitivity;pitch=Math.max(-1.1,Math.min(.9,pitch-e.movementY*.0025*sensitivity*(invertMouse?-1:1)));}else if(drag?.id===e.pointerId){yaw-=(e.clientX-drag.x)*.004*sensitivity;pitch=Math.max(-1.1,Math.min(.9,pitch-(e.clientY-drag.y)*.004*sensitivity*(invertMouse?-1:1)));drag.x=e.clientX;drag.y=e.clientY;}});
document.querySelectorAll('[data-key]').forEach(button=>{button.onpointerdown=e=>{e.preventDefault();keys.add(button.dataset.key);button.setPointerCapture(e.pointerId);};button.onpointerup=button.onpointercancel=()=>keys.delete(button.dataset.key);});$('touch-fire').onpointerdown=e=>{e.preventDefault();shooting=true;firePointer=e.pointerId;e.target.setPointerCapture(e.pointerId);shoot();};$('touch-fire').onpointerup=$('touch-fire').onpointercancel=releasePointer;

$('capture-mouse').onclick=$('mouse-retry').onclick=requestMouse;$('mouse-drag').onclick=playWithoutMouseCapture;$('camera-switch').onclick=()=>setCamera(!thirdPerson);$('touch-reload').onclick=reloadWeapon;$('touch-aim').onclick=()=>{aimHeld=!aimHeld;$('touch-aim').setAttribute('aria-pressed',String(aimHeld));};$('pause-button').onclick=()=>pause();$('briefing-open').onclick=()=>{comicEnding=false;comicIndex=0;briefings();};$('hero-gulman').onclick=()=>hero.select('Gulman');$('hero-switch').onclick=()=>hero.select('Dama');$('sound-unlock').onclick=()=>{audio.muted=false;audio.unlock();};
async function ready(){await ui.init();$('resource-error').hidden=true;for(const name of ['health','ammo','money'])$(name+'-icon').src=assets.url(ui.data.hud[name].image);$('crosshair').src=assets.url(ui.data.hud.crosshairRed.image);$('loading').style.setProperty('--loading-frame',`url("${assets.url(ui.data.frames.default)}")`);updateHeroName();mainMenu();updateSoundStatus();}
$('asset-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;$('status').textContent='Распаковка ресурсов…';try{await assets.importZip(file);await ready();}catch(error){$('status').textContent='Ошибка импорта: '+error.message;}};
try{await assets.init();await ready();}catch(error){$('resource-error').hidden=false;$('status').textContent='Ресурсы не загрузились: '+error.message;$('import-panel').hidden=false;console.warn(error);}
