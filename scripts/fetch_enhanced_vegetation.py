"""Fetch verified official CC0 sources and build compact self-hosted vegetation.

Python 3 + Pillow; Node. Source cache lives in work/, never in the published pack.
Meshoptimizer 1.3.0 (MIT) performs offline geometric LOD reduction only.
"""
import concurrent.futures
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import struct
import tarfile
from urllib.request import Request, urlopen
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT.parents[1] / 'work'
CACHE = WORK / 'vegetation-source'
OUTPUT = ROOT / 'assets/enhanced/vegetation'
HEADERS = {'User-Agent': 'GulmanWeb CC0 vegetation importer (github.com/ALEXGREENCH/gulman-web)'}
SOURCES = {'broadleaf': ('island_tree_02', 0, 'leaves_alpha'), 'conifer': ('fir_tree_01', 0, 'twig_alpha'), 'shrub': ('shrub_02', 0, 'Alpha'), 'flower': ('shrub_sorrel_01', 0, 'Alpha')}


def fetch(url):
    with urlopen(Request(url, headers=HEADERS), timeout=120) as response:
        return response.read()


def verified(path, spec):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or hashlib.md5(path.read_bytes()).hexdigest() != spec['md5']:
        with urlopen(Request(spec['url'], headers=HEADERS), timeout=180) as response, path.open('wb') as stream:
            while data := response.read(1024 * 1024):
                stream.write(data)
    data = path.read_bytes()
    if hashlib.md5(data).hexdigest() != spec['md5']:
        raise ValueError('Source checksum mismatch: ' + spec['url'])
    return {'source': spec['url'], 'md5': spec['md5'], 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}


def source(kind, settings):
    name, selected, alpha_key = settings
    metadata = json.loads(fetch('https://api.polyhaven.com/files/' + name))
    record = metadata['gltf']['1k']['gltf']
    folder = CACHE / name
    files = [verified(folder / (name + '.gltf'), record)]
    with concurrent.futures.ThreadPoolExecutor(4) as pool:
        jobs = [pool.submit(verified, folder / relative, spec) for relative, spec in record['include'].items()]
        files.extend(job.result() for job in jobs)
    files.append(verified(folder / 'alpha.png', metadata[alpha_key]['1k']['png']))
    print(name, 'source verified', sum(f['bytes'] for f in files), flush=True)
    return kind, name, selected, folder, files


def palm(package):
    import py7zr
    folder = CACHE / 'palm'
    folder.mkdir(exist_ok=True)
    archive = folder / 'palm_tree_v2.7z'
    url = 'https://opengameart.org/sites/default/files/palm_tree_v2.7z'
    if not archive.exists(): archive.write_bytes(fetch(url))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != '9c0b77935498cf51a9166cee91807fea71bdae1a9ad4b79f3ffa740b8c7cac69':
        raise ValueError('Pinned Yughues source archive has changed')
    with py7zr.SevenZipFile(archive) as packed: packed.extractall(folder / 'source')
    vertices, normals, uv, positions, packed_normals, packed_uv, indices, unique = [], [], [], [], [], [], [], {}
    for line in (folder / 'source/palm_tree.obj').read_text().splitlines():
        parts = line.split()
        if not parts: continue
        if parts[0] == 'v': vertices.append([float(v) * .01 for v in parts[1:4]])
        elif parts[0] == 'vn': normals.append([float(v) for v in parts[1:4]])
        elif parts[0] == 'vt': uv.append([float(parts[1]), 1 - float(parts[2])])
        elif parts[0] == 'f':
            face = []
            for token in parts[1:]:
                if token not in unique:
                    ids = [int(v) - 1 for v in token.split('/')]
                    unique[token] = len(positions) // 3; positions.extend(vertices[ids[0]]); packed_uv.extend(uv[ids[1]]); packed_normals.extend(normals[ids[2]])
                face.append(unique[token])
            for i in range(1, len(face) - 1): indices.extend([face[0], face[i], face[i + 1]])
    data = bytearray(); views = []; accessors = []
    for values, width, component, fmt, target in [(positions, 3, 5126, 'f', 34962), (packed_normals, 3, 5126, 'f', 34962), (packed_uv, 2, 5126, 'f', 34962), (indices, 1, 5125, 'I', 34963)]:
        chunk = struct.pack('<' + fmt * len(values), *values); views.append({'buffer': 0, 'byteOffset': len(data), 'byteLength': len(chunk), 'target': target}); data.extend(chunk)
        accessor = {'bufferView': len(views) - 1, 'componentType': component, 'count': len(values) // width, 'type': {1: 'SCALAR', 2: 'VEC2', 3: 'VEC3'}[width]}
        if width == 3: accessor.update(min=[min(values[i::3]) for i in range(3)], max=[max(values[i::3]) for i in range(3)])
        accessors.append(accessor)
    gltf = {'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0}], 'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'NORMAL': 1, 'TEXCOORD_0': 2}, 'indices': 3, 'material': 0}]}], 'materials': [{'name': 'Yughues_palm_tree_v2', 'doubleSided': True, 'alphaMode': 'MASK', 'alphaCutoff': .42, 'normalTexture': {'index': 1}, 'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}, 'metallicFactor': 0, 'roughnessFactor': .86}}], 'images': [{'uri': 'color.webp'}, {'uri': 'normal.webp'}], 'textures': [{'source': 0}, {'source': 1}], 'buffers': [{'uri': 'mesh.bin', 'byteLength': len(data)}], 'bufferViews': views, 'accessors': accessors}
    (folder / 'mesh.bin').write_bytes(data); (folder / 'model.gltf').write_text(json.dumps(gltf), encoding='utf8')
    target = OUTPUT / 'palm'
    subprocess.run(['node', str(ROOT / 'scripts/optimize_vegetation.mjs'), str(folder / 'model.gltf'), str(target), str(package / 'meshopt_simplifier.js'), '0'], check=True)
    for filename, targetname in [('diffus.tga', 'color.webp'), ('normal.tga', 'normal.webp')]:
        image = Image.open(folder / 'source' / filename)
        image.convert('RGBA' if filename == 'diffus.tga' else 'RGB').save(target / targetname, 'WEBP', quality=94, method=6)
    files = [{'path': f.relative_to(ROOT).as_posix(), 'sha256': hashlib.sha256(f.read_bytes()).hexdigest(), 'bytes': f.stat().st_size} for f in sorted(target.rglob('*')) if f.is_file()]
    return {'kind': 'palm', 'asset': 'Palm tree v2', 'author': 'Yughues / Nobiax', 'source': 'https://opengameart.org/content/palm-tree-v2', 'license': 'CC0-1.0', 'licenseUrl': 'https://creativecommons.org/publicdomain/zero/1.0/', 'sourceFiles': [{'source': url, 'sha256': digest, 'bytes': archive.stat().st_size}], 'files': files}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kind',choices=[*SOURCES,'palm'],help='Rebuild only one species, retaining other provenance records')
    args=parser.parse_args()
    package = WORK / 'vendor/meshoptimizer/package'
    if not (package / 'meshopt_simplifier.js').exists():
        metadata = json.loads(fetch('https://registry.npmjs.org/meshoptimizer/1.3.0'))
        archive = fetch(metadata['dist']['tarball'])
        tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz').extractall(package.parent, filter='data')
    records = json.loads((OUTPUT/'sources.json').read_text()) if args.kind and (OUTPUT/'sources.json').exists() else []
    records = [record for record in records if record['kind']!=args.kind]
    with concurrent.futures.ThreadPoolExecutor(3) as pool:
        results = [pool.submit(source, kind, spec) for kind, spec in SOURCES.items() if not args.kind or args.kind==kind]
        for job in results:
            kind, name, selected, folder, source_files = job.result()
            target = OUTPUT / kind
            subprocess.run(['node', str(ROOT / 'scripts/optimize_vegetation.mjs'), str(folder / (name + '.gltf')), str(target), str(package / 'meshopt_simplifier.js'), str(selected)], check=True)
            gltf = json.loads((target / 'model.gltf').read_text(encoding='utf8'))
            alpha = Image.open(folder / 'alpha.png').convert('L')
            for image in gltf['images']:
                original = image['uri']
                value = Image.open(folder / original).convert('RGB')
                is_leaf_color = ('diff' in original and ('leaves' in original or 'twig' in original or name.startswith('shrub')))
                if is_leaf_color:
                    value = value.convert('RGBA')
                    value.putalpha(alpha.resize(value.size, Image.Resampling.LANCZOS))
                relative = 'textures/' + Path(original).stem + '.webp'
                path = target / relative
                path.parent.mkdir(exist_ok=True)
                value.save(path, 'WEBP', quality=93 if 'nor_' in original else 90, method=6)
                image.update(uri=relative, mimeType='image/webp')
            (target / 'model.gltf').write_text(json.dumps(gltf, separators=(',', ':')), encoding='utf8')
            output_files = [{'path': f.relative_to(ROOT).as_posix(), 'sha256': hashlib.sha256(f.read_bytes()).hexdigest(), 'bytes': f.stat().st_size} for f in sorted(target.rglob('*')) if f.is_file()]
            records.append({'kind': kind, 'asset': name, 'selectedMesh': selected, 'source': 'https://polyhaven.com/a/' + name, 'license': 'CC0-1.0', 'licenseUrl': 'https://polyhaven.com/license', 'sourceFiles': source_files, 'files': output_files})
            print(kind, 'published', sum(f['bytes'] for f in output_files), flush=True)
    if not args.kind or args.kind=='palm': records.append(palm(package))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / 'sources.json').write_text(json.dumps(records, indent=2) + '\n', encoding='utf8')


if __name__ == '__main__':
    main()
