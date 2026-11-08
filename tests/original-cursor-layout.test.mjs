import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {fitOriginalArtwork,cursorPlacement} from '../js/original-ui.js';

const root=new URL('../',import.meta.url),ui=JSON.parse(await readFile(new URL('assets/original-ui.json',root),'utf8'));

test('native menu proportions and every painted button fit narrow, wide and ultrawide screens',()=>{
  for(const viewport of [[360,800],[1280,720],[1920,1080],[3440,1440]])for(const menu of Object.values(ui.menus)){
    const fit=fitOriginalArtwork(viewport,menu.referenceSize,menu.imageSize);
    assert.ok(fit.width*fit.scale<=viewport[0]+1e-8);assert.ok(fit.height*fit.scale<=viewport[1]+1e-8);
    assert.ok(Math.abs(fit.width/fit.height-menu.imageSize[0]/menu.imageSize[1])<1e-10);
    const left=(viewport[0]-fit.width*fit.scale)/2,top=(viewport[1]-fit.height*fit.scale)/2;
    for(const button of menu.hotspots){
      const [l,t,r,b]=button.hitRect,[w,h]=menu.referenceSize;
      assert.ok(left+l/w*fit.width*fit.scale>=0&&left+r/w*fit.width*fit.scale<=viewport[0]+1e-6);
      assert.ok(top+t/h*fit.height*fit.scale>=0&&top+b/h*fit.height*fit.scale<=viewport[1]+1e-6);
    }
  }
});

test('cursor fingertip stays at the actual pointer at every supported display scale',()=>{
  for(const scale of [.45,.6,1,1.2])for(const[x,y]of[[0,0],[1920,1080],[321,456]]){
    const p=cursorPlacement(x,y,ui.cursor.hotspot,scale);
    assert.equal(p.x+ui.cursor.hotspot[0]*scale,x);assert.equal(p.y+ui.cursor.hotspot[1]*scale,y);
  }
});

function decodeRGBA(png){
  assert.equal(png[24],8);assert.equal(png[25],6);
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20),chunks=[];
  for(let offset=8;offset<png.length;){const length=png.readUInt32BE(offset),type=png.toString('ascii',offset+4,offset+8);if(type==='IDAT')chunks.push(png.subarray(offset+8,offset+8+length));offset+=12+length;}
  const raw=inflateSync(Buffer.concat(chunks)),stride=width*4,rgba=Buffer.alloc(height*stride);let p=0;
  const paeth=(a,b,c)=>{const q=a+b-c,da=Math.abs(q-a),db=Math.abs(q-b),dc=Math.abs(q-c);return da<=db&&da<=dc?a:db<=dc?b:c;};
  for(let y=0;y<height;y++){const filter=raw[p++];for(let x=0;x<stride;x++){
    const i=y*stride+x,a=x>=4?rgba[i-4]:0,b=y?rgba[i-stride]:0,c=y&&x>=4?rgba[i-stride-4]:0;
    const prediction=[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter];assert.ok(prediction!==undefined);rgba[i]=(raw[p++]+prediction)&255;
  }}return{width,height,rgba};
}

test('decoded cursor alpha exactly retains the original BMP alpha, including its soft shadow',async()=>{
  const info=ui.hud.handCursor,png=await readFile(new URL(info.image,root)),decoded=decodeRGBA(png),alpha=Buffer.alloc(decoded.width*decoded.height);
  decoded.rgba.forEach((value,i)=>{if(i%4===3)alpha[(i-3)/4]=value;});
  assert.deepEqual([decoded.width,decoded.height],[172,165]);assert.equal(info.alphaMode,'original-bmp-bgra');
  assert.equal(createHash('sha256').update(alpha).digest('hex'),info.alphaSha256);
  assert.equal(alpha.filter(v=>v===0).length,14945);assert.equal(alpha.filter(v=>v>0&&v<255).length,info.translucentPixels);
  assert.ok(info.translucentPixels>5000);assert.equal(alpha[0],0);assert.equal(alpha.at(-1),0);
  assert.equal(ui.cursor.image,info.image);await readFile(new URL(ui.cursor.glow,root));
});
