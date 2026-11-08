import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {fitShopLayout} from '../js/original-ui.js';

const app=await readFile(new URL('../js/app.js',import.meta.url),'utf8');
const shopFunctions=app.slice(app.indexOf('function shop('),app.indexOf('function briefings('));
function game({money=100,hp=60,ammo=10}={}){
  const screens=[],weapons=[],context=vm.createContext({money,hp,ammo,menuScreen:(id,options)=>screens.push({id,options}),changeWeapon:kind=>weapons.push(kind),saveProgress:()=>{},updateHUD:()=>{}});
  vm.runInContext(shopFunctions,context);return{context,screens,weapons};
}

test('shop purchases retain prices, ammo increments and health while updating the visible balance',()=>{
  const {context,screens,weapons}=game();
  vm.runInContext('buy(2)',context);assert.equal(context.money,75);assert.equal(context.ammo,30);assert.equal(weapons.at(-1),2);
  vm.runInContext('buy(-1)',context);assert.equal(context.money,45);assert.equal(context.hp,100);
  const stock=screens.at(-1).options.shop;assert.equal(stock.balance,45);assert.equal(stock.offers.length,3);
  assert.equal(stock.offers.find(o=>o.command==='BUY_HEALTH').disabled,true);
  assert.equal(stock.offers.find(o=>o.command==='ПАТРОНЫ>4>').price,50);
});

test('insufficient funds and full health do not spend money or append an unreadable extras paragraph',()=>{
  const low=game({money:10});vm.runInContext('buy(3)',low.context);
  assert.equal(low.context.money,10);assert.equal(low.context.ammo,10);assert.equal(low.screens.at(-1).options.status,'Не хватает денег');
  const full=game({money:100,hp:100});vm.runInContext('buy(-1)',full.context);
  assert.equal(full.context.money,100);assert.equal(full.context.hp,100);assert.equal(full.screens.at(-1).options.status,'Здоровье уже полное');
});

test('portrait shop places full illustration and readable controls in separate non-overlapping regions',()=>{
  for(const viewport of [[320,480],[360,640],[390,844],[600,900]]){
    const fit=fitShopLayout(viewport,[1024,768],[1168,878]);assert.equal(fit.stacked,true);
    assert.ok(fit.width*fit.scale<=viewport[0]);assert.ok(fit.artTop>=0);
    assert.ok(fit.panelTop>=fit.artTop+fit.height*fit.scale+9.99);
    assert.ok(fit.panelTop+fit.panelHeight<=viewport[1]+1e-8);
    assert.ok(Math.abs(fit.width/fit.height-1168/878)<1e-10);
  }
  for(const viewport of [[1280,720],[1920,1080],[844,390]])assert.equal(fitShopLayout(viewport).stacked,false);
});
