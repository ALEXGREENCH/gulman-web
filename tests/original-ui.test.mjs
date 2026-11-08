import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const readJSON = async path => JSON.parse(await fs.readFile(new URL(path, root), 'utf8'));
const ui = await readJSON('assets/original-ui.json');
const manifest = await readJSON('assets/manifest.json');
const characters = await readJSON('assets/characters.json');
const exists = async path => { assert.ok(path.startsWith('assets/')); await fs.access(new URL(path, root)); };

test('all original menus retain valid artwork and corrected reference-canvas targets', async () => {
  assert.equal(ui.rectFormat, 'left-top-right-bottom');
  assert.deepEqual(Object.keys(ui.menus).sort(), ['main','levels','settings','graphics','audio','controls','credits','shop','gameOver','exit','test'].sort());
  let targets = 0;
  for (const menu of Object.values(ui.menus)) {
    assert.equal(menu.image, manifest.images[menu.backgroundKey]);
    await exists(menu.image);
    const [width,height] = menu.referenceSize;
    assert.deepEqual([width,height],[1024,768]);
    const ids = new Set();
    for (const hotspot of menu.hotspots) {
      assert.ok(!ids.has(hotspot.id)); ids.add(hotspot.id);
      assert.ok(hotspot.command && hotspot.label);
      assert.deepEqual(hotspot.rect,hotspot.rawRect);
      const [left,top,right,bottom] = hotspot.hitRect;
      assert.ok([left,top,right,bottom].every(Number.isFinite));
      assert.ok(0<=left && left<right && right<=width && 0<=top && top<bottom && bottom<=height, `${menu.source}: ${hotspot.command}`);
      targets++;
    }
  }
  assert.equal(targets,29);
  assert.equal(ui.menus.levels.hotspots.filter(h=>/^EVEL\d$/.test(h.command)).length,8);
});

test('shop targets preserve original grenade, BigGun and return ordering', () => {
  const center = command => {
    const [l,t,r,b] = ui.menus.shop.hotspots.find(h=>h.command===command).hitRect;
    return [(l+r)/2,(t+b)/2];
  };
  const grenade=center('ПАТРОНЫ>3>'), bigGun=center('ПАТРОНЫ>4>'), back=center('В=ИГРУ');
  assert.ok(grenade[0]<350 && grenade[1]>300 && grenade[1]<500);
  assert.ok(bigGun[0]<350 && bigGun[1]<300);
  assert.ok(back[0]>700 && back[1]>550);
});

test('25 comic pages pair each original illustration with its transparent text panel', async () => {
  let count=0, terminals=0;
  for (let level=1;level<=9;level++) {
    const pages=ui.comics[String(level)];
    assert.equal(pages.length,level===1?8:level===9?3:2);
    for (const [index,page] of pages.entries()) {
      assert.equal(page.index,index+1);
      assert.equal(page.imageKey,`levels/${level}/0/${index+1}вид.jpg`);
      assert.equal(page.textKey,`levels/${level}/0/т${index+1}.jpg`);
      assert.equal(page.image,manifest.images[page.imageKey]);
      await exists(page.image); await exists(page.text);
      assert.deepEqual(page.referenceSize,[1024,768]);
      const [l,t,r,b]=page.textRect,[width,height]=page.textSize;
      assert.ok(0<=l && l<r && r<=width && height*.6<t && t<b && b<=height);
      const png=await fs.readFile(new URL(page.text,root));
      assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
      assert.equal(png.readUInt32BE(16),width); assert.equal(png.readUInt32BE(20),height);
      assert.equal(png[25],6,'Comic text must retain an RGBA alpha channel');
      if(page.terminal){terminals++;assert.equal(level,9);assert.equal(index,pages.length-1);}
      count++;
    }
  }
  assert.equal(count,25); assert.equal(terminals,1);
});

test('character selection has both original playable rigs and HUD uses existing artwork', async () => {
  assert.equal(ui.comics['1'][0].characterSelection,true);
  for (const key of ['gulman','dama']) {
    const rig=characters.characters[key]; assert.ok(rig?.bones.length>=18);
    const models=rig.bones.map(b=>b.model).filter(Boolean);
    assert.ok(models.length>=10);
    for(const model of models) assert.ok(manifest.models[model],`${key}: ${model}`);
  }
  for(const name of ['health','ammo','money','pistol','rifle','grenade','bigGun','crosshair','frame']) {
    const sprite=ui.hud[name]; assert.ok(sprite); await exists(sprite.image);
    assert.ok(manifest.images[sprite.originalKey]);
    if(sprite.colorKey) assert.ok(sprite.transparentPixels>0 && sprite.transparentPixels<sprite.size[0]*sprite.size[1]);
  }
  assert.equal(ui.frames.default,ui.hud.frame.image);
});

test('HUD HTML retains unique gameplay hooks and original UI stylesheets', async () => {
  const html=await fs.readFile(new URL('index.html',root),'utf8');
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(new Set(ids).size,ids.length);
  for(const id of ['menu','resource-error','status','import-panel','asset-file','health-value','health-bar','ammo-value','credits','weapon-name','weapon-slots','objective','level-label','objective-distance','prompt','toast','hitmarker','damage','minimap','briefing-open','pause-button','touch-fire','health-icon','money-icon','ammo-icon','weapon-icon','crosshair','hero-name','hero-switch','loading','loading-title','loading-status','sound-unlock']) assert.ok(ids.includes(id),id);
  for(const id of ['crosshair','health-icon','money-icon','ammo-icon','weapon-icon']) assert.match(html,new RegExp(`<img\\s+id="${id}"`));
  assert.match(html,/<main id="menu"[^>]*><\/main>/);
  assert.match(html,/href="\.\/original-ui\.css(?:\?[^\"]*)?"/);
  assert.match(html,/href="\.\/enhanced\.css(?:\?[^\"]*)?"/);
  assert.ok(!ids.includes('dialog-overlay'));
});
