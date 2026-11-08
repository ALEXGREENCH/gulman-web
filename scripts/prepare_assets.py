"""Convert the freely downloadable original Gulman 1 data for the browser runtime.

Usage: python scripts/prepare_assets.py /path/to/Gulman_1_Full
Requires Pillow. Does not run or redistribute the original executables.
3DS vertices are baked into Y-up (x,z,-y), preserving original game units.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import shutil
import struct
from collections import Counter
from pathlib import Path
from PIL import Image


def norm(s):
    return str(s).replace('\\', '/').lower()


def dump(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':'), allow_nan=False), 'utf8')


def natural(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r'(\d+)', str(s))]


class TDS:
    def __init__(self, source, image_lookup):
        self.source = source
        self.data = source.read_bytes()
        self.image_lookup = image_lookup
        self.materials = {}
        self.meshes = []
        self.missing = []

    def chunks(self, start, end):
        while start + 6 <= end:
            kind, size = struct.unpack_from('<HI', self.data, start)
            stop = start + size
            if size < 6 or stop > end:
                raise ValueError(f'Invalid chunk {kind:x} at {start}: {self.source}')
            yield kind, start + 6, stop
            start = stop

    def string(self, p):
        z = self.data.index(b'\0', p)
        return self.data[p:z].decode('cp1251'), z + 1

    def color(self, start, end):
        result = [1, 1, 1]
        for kind, p, e in self.chunks(start, end):
            if kind in (0x0011, 0x0012):
                result = [round(v/255, 6) for v in self.data[p:p+3]]
            elif kind in (0x0010, 0x0013):
                result = list(struct.unpack_from('<3f', self.data, p))
        return result

    def percent(self, start, end):
        for kind, p, e in self.chunks(start, end):
            if kind == 0x0030:
                return struct.unpack_from('<H', self.data, p)[0] / 100
            if kind == 0x0031:
                return struct.unpack_from('<f', self.data, p)[0]
        return 0

    def material(self, start, end):
        name = ''
        m = dict(color=[1, 1, 1], opacity=1, alphaTest=0, uvScale=[1, 1], uvOffset=[0, 0], uvRotation=0)
        for kind, p, e in self.chunks(start, end):
            if kind == 0xa000:
                name, _ = self.string(p)
            elif kind == 0xa020:
                m['color'] = self.color(p, e)
            elif kind == 0xa050:
                m['opacity'] = round(1 - self.percent(p, e), 6)
            elif kind == 0xa081:
                m['doubleSided'] = True
            elif kind == 0xa200:
                for sub, q, stop in self.chunks(p, e):
                    if sub == 0xa300:
                        filename, _ = self.string(q)
                        m['originalMap'] = filename
                        image = self.image_lookup(self.source.parent, filename)
                        if image:
                            m['map'] = image['url']
                            if image.get('alpha'):
                                m['alphaTest'] = 0.35
                        else:
                            self.missing.append(filename)
                    elif sub in (0xa354, 0xa356, 0xa358, 0xa35a, 0xa35c):
                        v = struct.unpack_from('<f', self.data, q)[0]
                        field, ix = {0xa354:('uvScale',0), 0xa356:('uvScale',1), 0xa358:('uvOffset',0), 0xa35a:('uvOffset',1), 0xa35c:('uvRotation',None)}[sub]
                        if ix is None: m[field] = v
                        else: m[field][ix] = v
        self.materials[name] = m

    def mesh(self, name, start, end):
        m = dict(name=name, vertices=[], uv=[], indices=[], groups=[])
        faces = []
        assignments = []
        face_order = []
        for kind, p, e in self.chunks(start, end):
            if kind == 0x4110:
                n = struct.unpack_from('<H', self.data, p)[0]
                for x, y, z in struct.iter_unpack('<fff', self.data[p+2:p+2+n*12]):
                    m['vertices'].extend([round(x,5), round(z,5), round(-y,5)])
            elif kind == 0x4140:
                n = struct.unpack_from('<H', self.data, p)[0]
                m['uv'] = [round(v,7) for v in struct.unpack_from('<'+'f'*n*2, self.data, p+2)]
            elif kind == 0x4160:
                # 3DS stores vertices in world/model space. The optional local
                # frame is useful for animation but must not be applied twice.
                m['originalMatrix'] = list(struct.unpack_from('<12f', self.data, p))
            elif kind == 0x4120:
                n = struct.unpack_from('<H', self.data, p)[0]
                faces = [list(t[:3]) for t in struct.iter_unpack('<HHHH', self.data[p+2:p+2+n*8])]
                for sub, q, stop in self.chunks(p+2+n*8, e):
                    if sub == 0x4130:
                        mat, q = self.string(q)
                        count = struct.unpack_from('<H', self.data, q)[0]
                        ids = struct.unpack_from('<'+'H'*count, self.data, q+2)
                        assignments.append((mat, ids))
                    elif sub == 0x4150:
                        m['smoothing'] = list(struct.unpack_from('<'+'I'*n, self.data, q))
        seen = set()
        for mat, ids in assignments:
            start = len(m['indices'])
            for i in ids:
                if i >= len(faces): raise ValueError('Invalid face material index')
                if i in seen: continue
                m['indices'].extend(faces[i]); seen.add(i)
                face_order.append(i)
            count = len(m['indices']) - start
            if count: m['groups'].append(dict(start=start, count=count, material=mat))
        rest = [i for i in range(len(faces)) if i not in seen]
        if rest:
            start = len(m['indices'])
            for i in rest:
                m['indices'].extend(faces[i])
                face_order.append(i)
            m['groups'].append(dict(start=start, count=len(rest)*3, material=''))
        if 'smoothing' in m:
            m['smoothing'] = [m['smoothing'][i] for i in face_order]
        if m['vertices'] and m['indices']:
            if max(m['indices']) >= len(m['vertices'])//3: raise ValueError('Invalid vertex index')
            self.meshes.append(m)

    def walk(self, start, end):
        for kind, p, e in self.chunks(start, end):
            if kind in (0x4d4d, 0x3d3d): self.walk(p, e)
            elif kind == 0xafff: self.material(p, e)
            elif kind == 0x4000:
                name, q = self.string(p)
                for sub, a, b in self.chunks(q, e):
                    if sub == 0x4100: self.mesh(name, a, b)

    def parse(self):
        self.walk(0, len(self.data))
        return dict(coordinateSystem='y-up', originalCoordinateSystem='z-up', units='original', meshes=self.meshes, materials=self.materials)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1]/'assets')
    args = parser.parse_args()
    src = args.source.resolve(); out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    def original(p): return norm(p.relative_to(src))
    def destination(p, folder, extension):
        digest = hashlib.sha1(original(p).encode('utf8')).hexdigest()[:12]
        safe = re.sub(r'[^a-z0-9_-]', '-', p.stem.lower()).strip('-')[:35] or 'asset'
        url = f'assets/{folder}/{safe}-{digest}{extension}'
        path = out / folder / f'{safe}-{digest}{extension}'
        path.parent.mkdir(parents=True, exist_ok=True)
        return url, path
    images = {}; sounds = {}; models = {}; missing = []
    for p in sorted(src.rglob('*')):
        if not p.is_file(): continue
        ext = p.suffix.lower()
        if ext in ('.jpg','.jpeg','.png','.tga','.bmp'):
            url, dest = destination(p, 'images', '.png' if ext in ('.tga','.bmp') else ext)
            with Image.open(p) as im:
                alpha = False
                if 'A' in im.getbands():
                    lo, hi = im.getchannel('A').getextrema()
                    alpha = lo < 255 and hi > 0
                if ext in ('.tga','.bmp'):
                    im.convert('RGBA' if alpha else 'RGB').save(dest, optimize=True)
                else: shutil.copyfile(p, dest)
                images[original(p)] = dict(url=url, width=im.width, height=im.height, alpha=alpha)
        elif ext in ('.wav','.mp3','.ogg'):
            url, dest = destination(p, 'sounds', ext)
            shutil.copyfile(p, dest)
            sounds[original(p)] = url
    basename_index = {}
    for key, val in images.items(): basename_index.setdefault(key.rsplit('/',1)[-1], []).append(val)
    def lookup(parent, name):
        filename = norm(name).rsplit('/',1)[-1]
        result = images.get(norm(parent.relative_to(src))+'/'+filename)
        if result: return result
        # Some exports retain an old BMP extension after JPEG conversion.
        stem = filename.rsplit('.',1)[0]
        for ext in ('.jpg','.png','.tga','.bmp'):
            result = images.get(norm(parent.relative_to(src))+'/'+stem+ext)
            if result: return result
        candidates = basename_index.get(filename, [])
        if len(candidates) == 1: return candidates[0]
        return None
    for p in sorted(src.rglob('*')):
        if p.suffix.lower() != '.3ds': continue
        loader = TDS(p, lookup); data = loader.parse()
        url, dest = destination(p, 'models', '.json')
        data['source'] = original(p)
        dump(dest, data); models[original(p)] = url
        for name in loader.missing: missing.append(dict(model=original(p), texture=name))
    levels = []
    for folder in sorted((src/'Levels').iterdir(), key=lambda p:natural(p.name)):
        if not folder.is_dir(): continue
        entities = []
        for line in (folder/'Levels.Script').read_text('cp1251').splitlines():
            cols = line.split('|')
            if len(cols) < 9: continue
            command = cols[7].split('>')
            entities.append(dict(id=int(cols[0]), x=float(cols[1].replace(',','.')), y=float(cols[2].replace(',','.')), z=float(cols[3].replace(',','.')), a=float(cols[4].replace(',','.')), b=float(cols[5].replace(',','.')), c=float(cols[6].replace(',','.')), command=command[0], args=command[1:], model=norm(cols[8]) if cols[8] else None))
        comic_files = sorted([p for p in (folder/'0').glob('*') if original(p) in images], key=lambda p:natural(p.name))
        comics = [images[original(p)]['url'] for p in comic_files]
        story = [images[original(p)]['url'] for p in comic_files if p.stem.lower().startswith('п')]
        briefing = [images[original(p)]['url'] for p in comic_files if not p.stem.lower().startswith('п')]
        levels.append(dict(id=int(folder.name), model=original(folder/'Level.3DS'), entities=entities, comics=comics, story=story, briefing=briefing))
    manifest = dict(version=1, source=dict(url='https://www.gulman.ru/supergulman007.rar', page='https://www.gulman.ru/gul1.html', label='Gulman_1_Full, original 2009 release', archiveSha256=''), coordinateSystem='y-up', unitsPerMeter=100, models=models, images={k:v['url'] for k,v in images.items()}, imageInfo=images, sounds=sounds, levels=levels, missingTextures=missing)
    archive = src.parents[1]/'supergulman007.rar'
    if archive.exists(): manifest['source']['archiveSha256'] = hashlib.sha256(archive.read_bytes()).hexdigest()
    dump(out/'manifest.json', manifest)
    summary = dict(models=len(models), images=len(images), sounds=len(sounds), levels=len(levels), entities=sum(len(l['entities']) for l in levels), missingTextures=missing, totalBytes=sum(p.stat().st_size for p in out.rglob('*') if p.is_file()))
    dump(out/'conversion-report.json', summary)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__': main()
