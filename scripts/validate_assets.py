"""Validate converted geometry, references and original spawn/floor alignment."""
from pathlib import Path
from collections import Counter
import json
import math


ROOT = Path(__file__).resolve().parents[1]


def ground_intersections(model, x, z):
    hits = set()
    for mesh in model['meshes']:
        points, indices = mesh['vertices'], mesh['indices']
        for n in range(0, len(indices), 3):
            a, b, c = [points[i*3:i*3+3] for i in indices[n:n+3]]
            den = (b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2])
            if abs(den) < 1e-8: continue
            u = ((b[2]-c[2])*(x-c[0])+(c[0]-b[0])*(z-c[2])) / den
            v = ((c[2]-a[2])*(x-c[0])+(a[0]-c[0])*(z-c[2])) / den
            w = 1-u-v
            if min(u, v, w) >= -1e-5:
                hits.add(round(u*a[1]+v*b[1]+w*c[1], 3))
    return sorted(hits)


def main():
    manifest = json.loads((ROOT/'assets/manifest.json').read_text('utf8'))
    errors = []
    models = {}
    for section in ('models','images','sounds'):
        for key, url in manifest[section].items():
            if not (ROOT/url).is_file(): errors.append(f'Missing {section} URL: {url}')
    mesh_count = triangle_count = 0
    for key, url in manifest['models'].items():
        data = json.loads((ROOT/url).read_text('utf8')); models[key] = data
        for mesh in data['meshes']:
            mesh_count += 1
            vertices, indices, uv = mesh['vertices'], mesh['indices'], mesh['uv']
            triangle_count += len(indices)//3
            label = key + ' / ' + mesh['name']
            if len(vertices)%3 or len(indices)%3: errors.append('Bad stride: '+label)
            if not all(math.isfinite(v) for v in vertices+uv): errors.append('Nonfinite geometry: '+label)
            if indices and (min(indices)<0 or max(indices)>=len(vertices)//3): errors.append('Out of bounds index: '+label)
            if uv and len(uv)//2 != len(vertices)//3: errors.append('UV count mismatch: '+label)
            cursor = 0
            for group in mesh['groups']:
                if group['start'] != cursor or group['count']%3: errors.append('Invalid material group: '+label)
                cursor += group['count']
            if cursor != len(indices): errors.append('Unassigned faces: '+label)
        for material in data['materials'].values():
            if material.get('map') and not (ROOT/material['map']).is_file(): errors.append('Missing texture URL: '+key)
    levels = []
    for level in manifest['levels']:
        for entity in level['entities']:
            if entity['model'] and entity['model'] not in manifest['models']:
                errors.append(f"Unresolved entity model level {level['id']}: {entity['model']}")
        model = models[level['model']]
        spawns = []
        starts = [e for e in level['entities'] if e['command']=='GameStart']
        for spawn in starts:
            heights = ground_intersections(model, spawn['x'], spawn['z'])
            below = [y for y in heights if y <= spawn['y']]
            floor = max(below) if below else None
            spawns.append(dict(entityId=spawn['id'], position=[spawn['x'],spawn['y'],spawn['z']], groundY=heights, floorBelow=floor, centerAboveFloor=None if floor is None else round(spawn['y']-floor,3), selected=spawn is starts[-1]))
        levels.append(dict(id=level['id'], meshes=len(model['meshes']), triangles=sum(len(m['indices'])//3 for m in model['meshes']), entities=len(level['entities']), commands=dict(Counter(e['command'] for e in level['entities'])), spawns=spawns))
    report = dict(passed=not errors, errors=errors, counts=dict(models=len(models),meshes=mesh_count,triangles=triangle_count,images=len(manifest['images']),sounds=len(manifest['sounds']),levels=len(levels),entities=sum(l['entities'] for l in levels)), warnings=manifest['missingTextures'], levels=levels)
    (ROOT/'assets/asset-validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf8')
    print(json.dumps({k:v for k,v in report.items() if k != 'levels'},ensure_ascii=False))
    raise SystemExit(0 if not errors else 1)


if __name__ == '__main__': main()
