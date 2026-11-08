"""Rebuild the optional CC0 prop pack from Poly Haven's official API.

Requires Python 3, Pillow and Node.js. Geometry is preserved for the close LOD;
meshoptimizer 1.3.0 makes a second index-only distance LOD. Textures are encoded
as 1K WebP. The source checksum and every shipped file hash are recorded.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
from urllib.request import Request, urlopen
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
WORK = Path(os.environ.get('GULMAN_ASSET_CACHE', str(ROOT.parents[1] / 'work' if ROOT.parent.name == 'outputs' else ROOT / '.cache'))) / 'enhanced-props-import'
DEST = ROOT / 'assets/enhanced/props'
HEADERS = {'User-Agent': 'GulmanWeb-CC0-props-import/1.0 (github.com/ALEXGREENCH/gulman-web)'}
ASSETS = {'crate': 'wooden_crate_01', 'barrel': 'barrel_03',
          'table': 'round_wooden_table_01', 'chair': 'plastic_monobloc_chair_01'}

LOD_SCRIPT = r"""
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
const [filename,library]=process.argv.slice(2),{MeshoptSimplifier}=await import(pathToFileURL(library));await MeshoptSimplifier.ready;
const doc=JSON.parse(fs.readFileSync(filename)),folder=path.dirname(filename),buffers=doc.buffers.map(b=>fs.readFileSync(path.join(folder,b.uri)));
function attribute(id){const a=doc.accessors[id],v=doc.bufferViews[a.bufferView],buffer=buffers[v.buffer],size={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type],C={5126:Float32Array,5123:Uint16Array,5125:Uint32Array}[a.componentType];if(!C||v.byteStride)throw Error('Unsupported source accessor');const offset=buffer.byteOffset+(v.byteOffset||0)+(a.byteOffset||0);return new C(buffer.buffer,offset,a.count*size).slice();}
const blocks=[],oldMeshCount=doc.meshes.length,oldNodeCount=doc.nodes.length,bufferIndex=doc.buffers.length;let length=0,highTriangles=0,lowTriangles=0;
for(const mesh of doc.meshes.slice()){
 const low=structuredClone(mesh);low.name=(mesh.name||'prop')+'_lod';
 for(const primitive of low.primitives){const position=attribute(primitive.attributes.POSITION),indices=new Uint32Array(attribute(primitive.indices)),normal=attribute(primitive.attributes.NORMAL),uv=attribute(primitive.attributes.TEXCOORD_0),attrs=new Float32Array(position.length/3*5);
  for(let i=0;i<position.length/3;i++)attrs.set([normal[i*3],normal[i*3+1],normal[i*3+2],uv[i*2],uv[i*2+1]],i*5);
  const goal=Math.max(24,Math.floor(indices.length*.12/3)*3),[result]=MeshoptSimplifier.simplifyWithAttributes(indices,position,3,attrs,5,[.1,.1,.1,1,1],null,goal,.045,['Permissive']);
  const block=Buffer.from(result.buffer,result.byteOffset,result.byteLength),view=doc.bufferViews.length,accessor=doc.accessors.length;blocks.push(block);doc.bufferViews.push({buffer:bufferIndex,byteOffset:length,byteLength:block.length,target:34963});length+=block.length;
  doc.accessors.push({bufferView:view,componentType:5125,count:result.length,type:'SCALAR'});primitive.indices=accessor;highTriangles+=indices.length/3;lowTriangles+=result.length/3;
 }doc.meshes.push(low);
}
for(const source of doc.nodes.slice()){const node=structuredClone(source);node.name=(source.name||'prop')+'_lod';if(node.mesh!==undefined)node.mesh+=oldMeshCount;if(node.children)node.children=node.children.map(i=>i+oldNodeCount);doc.nodes.push(node);}
doc.scenes.push({name:'Distance LOD',nodes:doc.scenes[doc.scene||0].nodes.map(i=>i+oldNodeCount)});doc.buffers.push({uri:'distance-lod.bin',byteLength:length});doc.extras={...(doc.extras||{}),gulmanLOD:{highTriangles,lowTriangles,method:'meshoptimizer 1.3.0, attributes preserved, target 12%, error 0.045'}};
fs.writeFileSync(path.join(folder,'distance-lod.bin'),Buffer.concat(blocks));fs.writeFileSync(filename,JSON.stringify(doc));console.log(JSON.stringify({highTriangles,lowTriangles}));
"""


def fetch(url):
    with urlopen(Request(url, headers=HEADERS), timeout=90) as response:
        return response.read()


def source_file(path, entry):
    data = path.read_bytes() if path.exists() else b''
    if hashlib.md5(data).hexdigest() != entry['md5']:
        data = fetch(entry['url'])
    if hashlib.md5(data).hexdigest() != entry['md5']:
        raise ValueError('Source checksum mismatch: ' + entry['url'])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data, {'url': entry['url'], 'md5': entry['md5'],
                  'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}


def file_record(path):
    data = path.read_bytes()
    return {'path': path.relative_to(ROOT).as_posix(), 'bytes': len(data),
            'sha256': hashlib.sha256(data).hexdigest()}


def simplifier():
    folder = WORK / 'meshoptimizer-1.3.0'
    module = folder / 'meshopt_simplifier.mjs'
    if not module.exists():
        archive = fetch('https://registry.npmjs.org/meshoptimizer/-/meshoptimizer-1.3.0.tgz')
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
            folder.mkdir(parents=True, exist_ok=True)
            module.write_bytes(package.extractfile('package/meshopt_simplifier.js').read())
            (folder / 'LICENSE.md').write_bytes(package.extractfile('package/LICENSE.md').read())
    return module


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)
    optimizer = WORK / 'make-lod.mjs'
    optimizer.write_text(LOD_SCRIPT, encoding='utf8')
    library = simplifier()
    records, models = [], {}
    for kind, name in ASSETS.items():
        metadata = json.loads(fetch('https://api.polyhaven.com/files/' + name))
        entry = metadata['gltf']['1k']['gltf']
        cache, folder = WORK / name, DEST / name
        raw, record = source_file(cache / (name + '.gltf'), entry)
        gltf = json.loads(raw)
        sources = [record]
        folder.mkdir(parents=True, exist_ok=True)
        uri_map = {}
        for relative, info in entry['include'].items():
            data, record = source_file(cache / relative, info)
            sources.append(record)
            target = folder / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.suffix.lower() in ('.png', '.jpg', '.jpeg'):
                target = target.with_suffix('.webp')
                image = Image.open(io.BytesIO(data))
                image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
                image.save(target, 'WEBP', quality=94 if 'nor_' in relative else 88, method=6)
                uri_map[relative] = target.relative_to(folder).as_posix()
            else:
                target.write_bytes(data)
        for image in gltf.get('images', []):
            image['uri'] = uri_map.get(image.get('uri'), image.get('uri'))
            if image['uri'].endswith('.webp'):
                image['mimeType'] = 'image/webp'
        # Chromium/Firefox/Safari support WebP natively; GLTFLoader needs no
        # decoder, compressed geometry extension, or runtime external request.
        path = folder / (name + '.gltf')
        path.write_text(json.dumps(gltf, separators=(',', ':')), encoding='utf8')
        subprocess.run(['node', str(optimizer), str(path), str(library)], check=True)
        gltf = json.loads(path.read_text(encoding='utf8'))
        print(name, 'nodes:', [n.get('name') for n in gltf.get('nodes', [])], flush=True)
        records.append({'asset': name, 'kind': kind, 'source': 'https://polyhaven.com/a/' + name,
                        'license': 'CC0-1.0', 'licenseUrl': 'https://polyhaven.com/license',
                        'sourceFiles': sources, 'files': [file_record(p) for p in sorted(folder.rglob('*')) if p.is_file()]})
        models[kind] = {'asset': name, 'path': path.relative_to(ROOT).as_posix(),
                        'lodScene': 1, **gltf['extras']['gulmanLOD']}
    (DEST / 'manifest.json').write_text(json.dumps({'version': 1, 'models': models}, indent=2) + '\n', encoding='utf8')
    (DEST / 'sources.json').write_text(json.dumps(records, indent=2) + '\n', encoding='utf8')
    print('Verified shipped bytes:', sum(f['bytes'] for r in records for f in r['files']))


if __name__ == '__main__':
    main()
