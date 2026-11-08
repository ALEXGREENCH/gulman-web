"""Build one small character PBR atlas from verified CC0 scan channels.

Python 3 + Pillow. This is deterministic asset packing/channel processing;
skin, hair, eye and metal cells contain code-authored microstructure, not faces.
The original character atlases are never read or changed.
"""
import hashlib
import io
import json
import math
import urllib.request
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets/enhanced/characters'
CACHE = ROOT.parents[1] / 'work/polyhaven-character-materials'
HEADERS = {'User-Agent': 'GulmanEnhancedAssetBuilder/1.0 (CC0 material redistribution)'}
SIZE, GUTTER = 256, 8
INNER = SIZE - 2 * GUTTER
KINDS = ['skin', 'cloth', 'suit', 'leather', 'hair', 'metal', 'eye', 'denim']
SOURCES = {'cloth': 'denim_fabric', 'suit': 'quatrefoil_jacquard_fabric', 'leather': 'brown_leather'}


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=60) as response:
        return response.read()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def source_maps(kind, name, catalog):
    files = json.loads(fetch('https://api.polyhaven.com/files/' + name))
    maps, record = {}, {'asset': name, 'source': 'https://polyhaven.com/a/' + name,
                        'license': 'CC0-1.0', 'authors': catalog[name]['authors'], 'maps': {}}
    for channel, api_name in [('color', 'Diffuse'), ('normal', 'nor_gl'), ('roughness', 'Rough')]:
        entry = files[api_name]['1k']['jpg']
        cached = CACHE / f'{name}_{channel}.jpg'
        data = cached.read_bytes() if cached.exists() else fetch(entry['url'])
        if hashlib.md5(data).hexdigest() != entry['md5']:
            raise ValueError('Source checksum mismatch: ' + entry['url'])
        cached.write_bytes(data)
        maps[channel] = Image.open(io.BytesIO(data)).convert('RGB').resize((INNER, INNER), Image.Resampling.LANCZOS)
        record['maps'][channel] = {'sourceUrl': entry['url'], 'sourceSha256': sha(data)}
    return maps, record


def noise(x, y):
    return (((x * 73856093) ^ (y * 19349663) ^ 83492791) & 65535) / 65535


def normal_pixel(r, g, b, strength):
    x, y, z = (r / 127.5 - 1) * strength, (g / 127.5 - 1) * strength, b / 127.5 - 1
    inverse = 1 / max(0.001, math.sqrt(x*x + y*y + z*z))
    return tuple(round((q * inverse * 0.5 + 0.5) * 255) for q in (x, y, z))


def tile(kind, maps=None):
    color = Image.new('RGB', (INNER, INNER), 'white')
    normal = Image.new('RGB', (INNER, INNER), (128, 128, 255))
    orm = Image.new('RGB', (INNER, INNER), (255, 200, 0))
    c, n, o = color.load(), normal.load(), orm.load()
    if maps:
        luminance = ImageOps.grayscale(maps['color'])
        low, high = luminance.getextrema()
        source_color, source_normal, source_rough = luminance.load(), maps['normal'].load(), maps['roughness'].load()
    for y in range(INNER):
        for x in range(INNER):
            q = noise(x, y)
            if maps:
                value = (source_color[x, y] - low) / max(1, high-low)
                shade = round(222 + value * 33) if kind != 'suit' else round(211 + value * 44)
                c[x, y] = (shade, shade, shade)
                strength = {'cloth': 0.32, 'denim': 0.4, 'suit': 0.45, 'leather': 0.3}[kind]
                n[x, y] = normal_pixel(*source_normal[x, y], strength)
                rough = source_rough[x, y][1]
                if kind in ['cloth', 'denim']: rough = max(180, rough)
                elif kind == 'suit': rough = min(230, max(140, rough))
                else: rough = min(195, max(90, rough))
                o[x, y] = (255, rough, 0)
            elif kind == 'skin':
                shade = round(249 + q * 6); c[x, y] = (shade, shade, shade)
                n[x, y] = (round(128+(q-.5)*4), round(128+(noise(y,x)-.5)*4), 255)
                o[x, y] = (255, round(145+q*12), 0)
            elif kind == 'hair':
                strand = math.sin(x*2.1 + math.sin(y*.06)*.5)
                shade = round(224+strand*15+q*10); c[x, y] = (shade, shade, shade)
                n[x, y] = (round(128+math.cos(x*2.1)*9), 128, 255)
                o[x, y] = (255, round(143+q*20), 0)
            elif kind == 'metal':
                shade = round(244+q*11); c[x, y] = (shade, shade, shade)
                n[x, y] = (round(128+(q-.5)*3),128,255)
                o[x, y] = (255, round(60+q*18), 255)
            elif kind == 'eye': o[x, y] = (255, 32, 0)
    return color, normal, orm


def pad(image):
    result = Image.new('RGB', (SIZE, SIZE))
    result.paste(image, (GUTTER, GUTTER))
    result.paste(image.crop((0,0,1,INNER)).resize((GUTTER,INNER)),(0,GUTTER))
    result.paste(image.crop((INNER-1,0,INNER,INNER)).resize((GUTTER,INNER)),(SIZE-GUTTER,GUTTER))
    result.paste(result.crop((0,GUTTER,SIZE,GUTTER+1)).resize((SIZE,GUTTER)),(0,0))
    result.paste(result.crop((0,SIZE-GUTTER-1,SIZE,SIZE-GUTTER)).resize((SIZE,GUTTER)),(0,SIZE-GUTTER))
    return result


def main():
    OUT.mkdir(parents=True, exist_ok=True); CACHE.mkdir(parents=True, exist_ok=True)
    catalog = json.loads(fetch('https://api.polyhaven.com/assets?t=textures'))
    maps, sources = {}, []
    for kind, name in SOURCES.items():
        maps[kind], record = source_maps(kind, name, catalog); sources.append(record)
    atlas = [Image.new('RGB', (SIZE*4, SIZE*2)) for _ in range(3)]
    rects = {}
    for index, kind in enumerate(KINDS):
        x, y = index % 4 * SIZE, index // 4 * SIZE
        images = tile(kind, maps.get('cloth' if kind == 'denim' else kind))
        for full, image in zip(atlas, images): full.paste(pad(image), (x,y))
        rects[kind] = {'x': (x+GUTTER)/(SIZE*4), 'y': 1-(y+SIZE-GUTTER)/(SIZE*2), 'width': INNER/(SIZE*4), 'height': INNER/(SIZE*2)}
    outputs = {}
    for name, image in zip(['color', 'normal', 'orm'], atlas):
        path = OUT / f'character-{name}.webp'
        image.save(path, 'WEBP', lossless=True, method=6)
        data = path.read_bytes();outputs[name] = {'path': path.relative_to(ROOT).as_posix(), 'size': list(image.size), 'bytes': len(data), 'sha256': sha(data)}
    manifest = {'version':1, 'size':[SIZE*4,SIZE*2], 'gutterPixels':GUTTER, 'rects':rects, 'maps':outputs, 'sources':sources,
                'processing':'Grayscale neutral albedo preserves vertex palettes; original OpenGL normals are normalized after amplitude reduction; roughness comes from the scans; metalness packed into ORM blue. Skin, hair, eyes, metal are code-authored cells.'}
    (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf8')
    print(f"Character atlas: {sum(v['bytes'] for v in outputs.values()):,} bytes, 3 maps, {SIZE*4}x{SIZE*2}")


if __name__ == '__main__': main()
