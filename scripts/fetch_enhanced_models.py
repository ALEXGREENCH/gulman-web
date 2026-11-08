"""Download the optional CC0 glTF models, verifying the official source checksums.

Requires Python 3 only. Nothing is downloaded by the game at runtime from Poly
Haven: all files are self-hosted alongside the static GitHub Pages application.
Powered by Poly Haven's public API: https://polyhaven.com/
"""
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
HEADERS = {'User-Agent': 'GulmanWeb-enhanced-asset-import/1.0 (github.com/ALEXGREENCH/gulman-web)'}


def fetch(url):
    with urlopen(Request(url, headers=HEADERS), timeout=60) as response:
        return response.read()


def install(path, entry):
    data = path.read_bytes() if path.exists() else b''
    if hashlib.md5(data).hexdigest() != entry['md5']:
        data = fetch(entry['url'])
    if hashlib.md5(data).hexdigest() != entry['md5']:
        raise ValueError('Source checksum mismatch: ' + entry['url'])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {'path': path.relative_to(ROOT).as_posix(), 'source': entry['url'],
            'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}


def main():
    records = []
    for name in ['fern_02', 'grass_bermuda_01', 'rock_07']:
        data = json.loads(fetch('https://api.polyhaven.com/files/' + name))
        source = data['gltf']['1k']['gltf']
        folder = ROOT / 'assets/enhanced/models' / name
        files = [install(folder / (name + '.gltf'), source)]
        for relative, entry in source['include'].items():
            files.append(install(folder / relative, entry))
        if name != 'rock_07':
            files.append(install(folder / 'alpha.png', data['Alpha']['1k']['png']))
        records.append({'asset': name, 'source': 'https://polyhaven.com/a/' + name,
                        'license': 'CC0-1.0', 'files': files})
    sky = 'kloofendal_48d_partly_cloudy_puresky'
    sky_data = json.loads(fetch('https://api.polyhaven.com/files/' + sky))
    sky_file = install(ROOT / 'assets/enhanced/sky' / (sky + '.hdr'), sky_data['hdri']['2k']['hdr'])
    records.append({'asset': sky, 'source': 'https://polyhaven.com/a/' + sky,
                    'license': 'CC0-1.0', 'files': [sky_file]})
    target = ROOT / 'assets/enhanced/models/sources.json'
    target.write_text(json.dumps(records, indent=2) + '\n', encoding='utf8')
    print(f'{len(records)} CC0 assets; {sum(f["bytes"] for r in records for f in r["files"]):,} bytes verified')


if __name__ == '__main__':
    main()
