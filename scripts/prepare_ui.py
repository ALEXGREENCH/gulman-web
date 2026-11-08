"""Extract original Menu_Save definitions, HUD color keys and paired comic overlays.

Usage: python scripts/prepare_ui.py /path/to/Gulman_1_Full
Requires Pillow and assets/manifest.json from prepare_assets.py.
Does not modify the original artwork or execute the original game.
"""
from pathlib import Path
import argparse
import json
import re
import struct
import hashlib
from PIL import Image

MENU_IDS = {
    'Menu_ГЛАВНОЕ МЕНЮ.Menu_Save':'main', 'Menu_ЗАГРУЗКА.Menu_Save':'levels',
    'Menu_НАСТРОЙКИ.Menu_Save':'settings', 'Menu_ГРАФИКА.Menu_Save':'graphics',
    'Menu_ЗВУКИ.Menu_Save':'audio', 'Menu_УПРАВЛЕНИЕ.Menu_Save':'controls',
    'Menu_Авторы.Menu_Save':'credits', 'Menu_BY.Menu_Save':'shop',
    'GameOver.Menu_Save':'gameOver', 'Menu_ВЫХОД.Menu_Save':'exit',
    'Menu_test.Menu_Save':'test',
}
LABELS = {
    'main':['Играть','Загрузка','Настройки','Авторы','Выход'],
    'levels':['Жаркий пляж','Вендетта','В Греции всё есть…','Летучий голландец','Золотая антилопа','Увидеть Париж и…','Зов предков','Калинка малинка','Главное меню'],
    'settings':['Графика','Звуки','Управление'],
    'shop':['В игру','Граната','БигГан'],
    'exit':['Да, завершить игру','Нет, в главное меню'],
    'test':['Выход','Главное меню'],
    'gameOver':['Начать заново'],
}
# Measured on the actual JPEGs, in each image's native pixels. Raw Menu_Save
# rectangles are preserved separately; their vertical offsets miss several labels.
PAINTED_RECTS = {
    'main': [[145,218,410,302],[158,301,440,387],[158,388,479,477],[189,488,433,574],[171,576,425,664]],
    'levels': [[105,158,400,216],[110,218,424,273],[102,275,456,331],[98,332,469,391],[109,392,468,446],[104,447,457,501],[135,502,426,557],[76,558,442,630],[900,16,1128,98]],
    'settings': [[530,625,790,698],[530,702,755,773],[525,776,885,849]],
    'shop': [[885,664,1162,875],[37,356,230,543],[18,75,365,290]],
    'exit': [[40,580,355,845],[890,575,1195,845]],
    'test': [[40,580,355,845],[890,575,1195,845]],
    'graphics': [[22,920,411,1046]], 'audio': [[22,920,411,1046]], 'controls': [[22,920,411,1046]],
}
HUD_SOURCES = {
    'health': ('textures/интерфейс/здоровье.bmp', [0,0,0]),
    'ammo': ('textures/интерфейс/патроны.bmp', [0,0,0]),
    'money': ('textures/интерфейс/баксы.bmp', [0,0,0]),
    'pistol': ('textures/интерфейс/пистолет-1.bmp', [0,0,0]),
    'rifle': ('textures/интерфейс/автомат-1.bmp', [0,0,0]),
    'grenade': ('textures/интерфейс/granate-1.bmp', [0,0,0]),
    'bigGun': ('textures/интерфейс/granate-2.bmp', [0,0,0]),
    'crosshair': ('textures/chross_x.bmp', [255,255,255]),
    'crosshairBlue': ('textures/x1.bmp', [0,0,0]),
    'crosshairRed': ('textures/x2.bmp', [0,0,0]),
    'pointerBlue': ('textures/x3.bmp', [0,0,0]),
}


def norm(path): return str(path).replace('\\','/').lower()


def original_bmp_alpha(path):
    """Pillow drops the fourth byte of BI_RGB BMPs, but Gulman's hand uses it."""
    data=path.read_bytes(); offset=struct.unpack_from('<I',data,10)[0]
    width,height=struct.unpack_from('<ii',data,18)
    bits=struct.unpack_from('<H',data,28)[0]; compression=struct.unpack_from('<I',data,30)[0]
    if data[:2]!=b'BM' or bits!=32 or compression!=0:
        raise ValueError('Expected original 32-bit uncompressed BGRA hand cursor')
    image=Image.frombytes('RGBA',(width,abs(height)),data[offset:],'raw','BGRA',0,-1 if height>0 else 1)
    if image.getchannel('A').getextrema()!=(0,255):
        raise ValueError('Original hand cursor alpha channel is missing')
    return image,hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path)
    args = parser.parse_args()
    source = args.source.resolve()
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root/'assets/manifest.json').read_text('utf8'))
    source_files = {norm(p.relative_to(source)):p for p in source.rglob('*') if p.is_file()}
    output = root/'assets/ui'; output.mkdir(parents=True,exist_ok=True)
    menus = {}
    for filename, menu_id in MENU_IDS.items():
        path = source/filename
        lines = path.read_text('cp1251').splitlines()
        background_key = norm(lines[0]); background = manifest['images'][background_key]
        reference = [int(n) for n in lines[1].split('|') if n]
        with Image.open(source_files[background_key]) as im: image_size = list(im.size)
        hotspots = []
        for line in lines[2:]:
            fields = line.split('|')
            if len(fields)<6: continue
            hot_id = int(fields[0]); rect = [int(x) for x in fields[2:6]]
            painted = PAINTED_RECTS.get(menu_id)
            if painted:
                hit_rect = [round(painted[hot_id][i]*reference[i%2]/image_size[i%2],2) for i in range(4)]
            else:
                hit_rect = [max(0,min(rect[i],reference[i%2])) for i in range(4)]
            labels = LABELS.get(menu_id,['Главное меню'])
            hotspots.append(dict(id=hot_id,command=fields[1],rect=rect,rawRect=rect,hitRect=hit_rect,label=labels[hot_id],painted=menu_id not in ('credits','gameOver')))
        menus[menu_id] = dict(source=filename,backgroundKey=background_key,image=background,background=background,referenceSize=reference,imageSize=image_size,hotspots=hotspots)
    hud = {}
    for name,(key,color) in HUD_SOURCES.items():
        with Image.open(source_files[key]) as original:
            image = original.convert('RGBA'); pixels = list(image.getdata())
            rgba = [(*pixel[:3],0 if list(pixel[:3])==color else 255) for pixel in pixels]
            image.putdata(rgba); image.save(output/(name+'.png'),optimize=True)
            url = 'assets/ui/'+name+'.png'
            hud[name] = dict(originalKey=key,image=url,url=url,size=list(image.size),colorKey=color,transparentPixels=sum(p[3]==0 for p in rgba))
    def original_image(key):
        key = norm(key)
        info = manifest['imageInfo'][key]
        return dict(originalKey=key,image=manifest['images'][key],url=manifest['images'][key],size=[info['width'],info['height']])
    hud['frame'] = original_image('textures/рамка.jpg')
    hud['handCursor'] = original_image('textures/hud/рука4!.bmp')
    hand,hand_hash=original_bmp_alpha(source_files['textures/hud/рука4!.bmp'])
    hand.save(output/'hand-cursor.png',optimize=True)
    alpha=hand.getchannel('A').tobytes()
    hud['handCursor'].update(originalImage=hud['handCursor']['image'],image='assets/ui/hand-cursor.png',url='assets/ui/hand-cursor.png',
        alphaMode='original-bmp-bgra',sourceSha256=hand_hash,alphaSha256=hashlib.sha256(alpha).hexdigest(),
        transparentPixels=alpha.count(0),translucentPixels=sum(0<a<255 for a in alpha))
    cursor=dict(image=hud['handCursor']['image'],size=list(hand.size),hotspot=[17,10],displayWidth=160,
        glow=original_image('textures/hud/light.jpg')['image'],glowSize=72,
        source='Textures/Hud/рука4!.BMP + Textures/Hud/Light.JPG',
        sourceRenderSize=[160,160],glowSourceRenderSize=[222,222],
        animation='CSS pulse of original light sprite; no source animation frames exist',
        hotspotSource='Visible index-finger tip in the original bitmap')
    extras = {
        'copyrightSplash':original_image('textures/menus/1заставка.jpg'),
        'finalCredits':original_image('textures/menus/участие конец2.jpg'),
        'legacyLicenseLoading':original_image('textures/заставка.jpg'),
    }
    comics = {}
    for level in range(1,10):
        folder = source/'Levels'/str(level)/'0'
        pictures = {}; overlays = {}
        for path in folder.iterdir():
            match = re.match(r'^(\d+)вид$',path.stem,re.I)
            if match: pictures[int(match[1])] = path
            match = re.match(r'^т(\d+)$',path.stem,re.I)
            if match: overlays[int(match[1])] = path
        pages = []
        for number,picture in sorted(pictures.items()):
            text_path = overlays.get(number)
            page = dict(index=number,image=manifest['images'][norm(picture.relative_to(source))],imageKey=norm(picture.relative_to(source)),referenceSize=[1024,768])
            with Image.open(picture) as im: page['imageSize']=list(im.size)
            if text_path:
                with Image.open(text_path) as original:
                    image=original.convert('RGB'); width,height=image.size; pixels=image.load()
                    # The source text layer is a white full-frame canvas with one
                    # black bottom text panel. Keep that panel's exact pixels,
                    # including text antialiasing; make its surroundings transparent.
                    rows = [y for y in range(height) if sum(max(pixels[x,y])<48 for x in range(width))>width*.3]
                    if not rows: raise ValueError(f'No black text panel: {text_path}')
                    top,bottom=min(rows),max(rows)+1
                    columns = [x for x in range(width) if sum(max(pixels[x,y])<48 for y in range(top,bottom))>(bottom-top)*.1]
                    left,right=min(columns),max(columns)+1
                    rect=[left,top,right,bottom]
                    rgba=Image.new('RGBA',image.size,(0,0,0,0)); rgba.paste(image.crop(tuple(rect)),(left,top))
                    file=f'comic-{level}-{number}-text.png'; rgba.save(output/file,optimize=True)
                    page.update(text='assets/ui/'+file,textKey=norm(text_path.relative_to(source)),textSize=list(image.size),textRect=rect,textAlphaMode='opaque-original-panel-transparent-surroundings')
            else: page['text']=None
            if level==1 and number==1: page['characterSelection']=True
            if level==9 and number==max(pictures): page['terminal']=True
            pages.append(page)
        if set(pictures)!=set(overlays): raise ValueError(f'Unpaired comics in level {level}')
        comics[str(level)] = pages
    diagnostics = [
        'Menu_Save uses 1024x768 coordinates; native image sizes differ. Scale artwork and hotspots together.',
        'Raw main/levels/settings rectangles miss painted captions vertically. hitRect is measured on artwork; rawRect preserves source values.',
        'Graphics/audio/controls artwork contains an empty parchment. Slider coordinates are not present in Menu_Save.',
        'Settings has no back hotspot; credits back and GameOver restart have no corresponding painted captions.',
        'Level selector contains EVEL1 through EVEL8 only; the ninth level is reached through gameplay.',
        'GameOver raw rectangle extends to y=800; hitRect is clipped to y=768.',
        'Shop command ПАТРОНЫ>3> points to the grenade; ПАТРОНЫ>4> points to the BigGun.',
        'Hand cursor preserves its original 32-bit BMP alpha channel, including its translucent shadow; no color-key mask is inferred.',
        'legacyLicenseLoading is an original license-check illustration, not a status claim of the web runtime.',
        'Comic text images are overlays, not standalone story frames. Pair each nвид image with тn and composite full-frame.',
    ]
    result=dict(version=1,referenceSize=[1024,768],rectFormat='left-top-right-bottom',menus=menus,hud=hud,cursor=cursor,frames={'default':hud['frame']['image']},extras=extras,comics=comics,diagnostics=diagnostics)
    (root/'assets/original-ui.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf8')
    print(json.dumps(dict(menus=len(menus),hotspots=sum(len(m['hotspots']) for m in menus.values()),hud=len(hud),comicPairs=sum(len(v) for v in comics.values()),output='assets/original-ui.json'),ensure_ascii=False))


if __name__=='__main__': main()
