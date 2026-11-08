"""Prepare CC0 MakeHuman anatomical hands, without bundling application code.

Downloads pinned official asset data, excludes helpers, clips a short wrist
margin, preserves the real human finger topology/UVs and emits an ES module.
The source OBJ is cached in work/; only the two compact hands ship to players.
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT.parents[1] / "work" / "makehuman-source"
OUT = ROOT / "assets" / "enhanced" / "characters"
COMMIT = "a8bc2d54ff0ac92e78ff71431b1023eda42bf482"
REPO = "https://github.com/makehumancommunity/makehuman"
RAW = f"https://raw.githubusercontent.com/makehumancommunity/makehuman/{COMMIT}/"


def sub(a, b): return [x-y for x, y in zip(a, b)]
def add(a, b): return [x+y for x, y in zip(a, b)]
def mul(a, s): return [x*s for x in a]
def dot(a, b): return sum(x*y for x, y in zip(a, b))
def cross(a, b): return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
def normalize(a): return mul(a, 1/max(math.sqrt(dot(a, a)), 1e-12))
def checksum(data): return hashlib.sha256(data).hexdigest()


def fetch(path, name):
    target = CACHE / name
    if not target.exists():
        request = urllib.request.Request(RAW + path, headers={"User-Agent": "GulmanWeb-CC0-asset-builder"})
        target.write_bytes(urllib.request.urlopen(request, timeout=60).read())
    return target.read_bytes()


def parse_obj(text):
    vertices, uv, groups = [], [], defaultdict(list)
    group = "none"
    for line in text.splitlines():
        p = line.split()
        if not p: continue
        if p[0] == "v": vertices.append(list(map(float, p[1:4])))
        elif p[0] == "vt": uv.append(list(map(float, p[1:3])))
        elif p[0] == "g": group = p[1]
        elif p[0] == "f":
            groups[group].append([(int(s.split('/')[0])-1, int(s.split('/')[1])-1) for s in p[1:]])
    return vertices, uv, groups


def clipped_polygon(polygon, wrist, axis):
    # 0.22 source units = 23.8 mm of hidden wrist/forearm beneath the cuff.
    def distance(vertex): return dot(sub(vertex["p"], wrist), axis) + .22
    result = []
    for i, a in enumerate(polygon):
        b = polygon[(i+1) % len(polygon)]
        da, db = distance(a), distance(b)
        if da >= 0: result.append(a)
        if (da >= 0) != (db >= 0):
            t = da/(da-db)
            result.append({key: add(a[key], mul(sub(b[key], a[key]), t)) for key in ["p", "uv", "n"]})
    return result


def convert(vertices, uv, groups):
    body = groups["body"]
    body_indices = sorted({index for face in body for index, _ in face})
    bottom = min(vertices[i][1] for i in body_indices)
    height = max(vertices[i][1] for i in body_indices) - bottom
    scale = 1.8 / height
    normals = [[0., 0., 0.] for _ in vertices]
    for face in body:
        points = [vertices[i] for i, _ in face]
        normal = cross(sub(points[1], points[0]), sub(points[2], points[0]))
        for index, _ in face: normals[index] = add(normals[index], normal)
    normals = list(map(normalize, normals))
    joints = {}
    for name, faces in groups.items():
        if not name.startswith("joint-"): continue
        indices = {i for face in faces for i, _ in face}
        joints[name] = [sum(vertices[i][a] for i in indices)/len(indices) for a in range(3)]
    result = {}
    for side, name in [("l", "leftHand"), ("r", "rightHand")]:
        wrist = joints[f"joint-{side}-hand"]
        tip = joints[f"joint-{side}-finger-3-4"]
        axis = normalize(sub(tip, wrist))
        across = sub(joints[f"joint-{side}-finger-5-1"], joints[f"joint-{side}-finger-2-1"])
        across = normalize(sub(across, mul(axis, dot(across, axis))))
        dorsal = normalize(cross(across, axis))
        # Both are right-handed frames; preserve source winding and normals.
        frame = [across, axis, dorsal]
        def local(p): return [round(dot(sub(p, wrist), a)*scale, 6) for a in frame]
        def local_normal(n): return [round(dot(normalize(n), a), 6) for a in frame]
        positions, out_uv, out_normals, indices, lookup = [], [], [], [], {}
        source_faces = 0
        for face in body:
            center = mul([sum(vertices[index][a] for index, _ in face) for a in range(3)], 1/len(face))
            if dot(sub(center, wrist), sub(center, wrist)) > 3.2**2: continue
            polygon = clipped_polygon([{"p": vertices[i], "uv": uv[t], "n": normals[i]} for i, t in face], wrist, axis)
            if len(polygon) < 3: continue
            source_faces += 1
            refs = []
            for vertex in polygon:
                p, n, t = local(vertex["p"]), local_normal(vertex["n"]), [round(x, 6) for x in vertex["uv"]]
                key = tuple(p+t)
                if key not in lookup:
                    lookup[key] = len(positions)//3
                    positions.extend(p);out_normals.extend(n);out_uv.extend(t)
                refs.append(lookup[key])
            for i in range(1, len(refs)-1): indices.extend([refs[0], refs[i], refs[i+1]])
        bounds = {"min": [min(positions[a::3]) for a in range(3)], "max": [max(positions[a::3]) for a in range(3)]}
        landmarks = {key.removeprefix(f"joint-{side}-"):local(p) for key, p in joints.items() if key.startswith(f"joint-{side}-finger") or key.startswith(f"joint-{side}-hand")}
        result[name] = {"positions": positions, "normals": out_normals, "uv": out_uv, "indices": indices,
                        "wrist": [0, 0, 0], "middleTip": local(tip), "fingerDirection": [0, 1, 0],
                        "dorsalAxis": [0, 0, -1 if side == "l" else 1], "palmAxis": [0, 0, 1 if side == "l" else -1],
                        "acrossAxis": [1, 0, 0], "bounds": bounds,
                        "landmarks": landmarks, "sourceFrame": {"wrist": wrist, "axes": frame, "scale": scale},
                        "sourcePolygons": source_faces, "triangles": len(indices)//3}
    return {"version": 1, "license": "CC0-1.0", "source": REPO+f"/blob/{COMMIT}/makehuman/data/3dobjs/base.obj",
            "units": "metres", "referenceHumanHeight": 1.8,
            "coordinateSpace": "wrist-local; +Y wrist to middle fingertip; +X index to little-finger side; +Z cross(X,Y)",
            "parts": result}


def head_geometry(vertices, uv, groups):
    body = groups["body"]
    ids = {i for face in body for i, _ in face}
    scale = 1.8/(max(vertices[i][1] for i in ids)-min(vertices[i][1] for i in ids))
    joints = {}
    for name, faces in groups.items():
        if not name.startswith("joint-"): continue
        refs = {i for face in faces for i, _ in face}
        joints[name] = [sum(vertices[i][a] for i in refs)/len(refs) for a in range(3)]
    neck = joints["joint-neck"]
    normals = [[0., 0., 0.] for _ in vertices]
    for face in body:
        points = [vertices[i] for i, _ in face]
        normal = cross(sub(points[1], points[0]), sub(points[2], points[0]))
        for index, _ in face: normals[index] = add(normals[index], normal)
    normals = list(map(normalize, normals))
    def local(point): return [round(v*scale, 6) for v in sub(point, neck)]
    positions, out_normals, out_uv, indices, lookup = [], [], [], [], {}
    for face in body:
        if max(vertices[i][1] for i, _ in face)<neck[1]-.05: continue
        # The generic clipping function adds .22; move its origin accordingly.
        plane = [neck[0], neck[1]+.17, neck[2]]
        polygon = clipped_polygon([{"p":vertices[i],"uv":uv[t],"n":normals[i]} for i,t in face], plane, [0,1,0])
        if len(polygon)<3: continue
        refs=[]
        for vertex in polygon:
            p, n, t = local(vertex['p']), [round(x,6) for x in normalize(vertex['n'])], [round(x,6) for x in vertex['uv']]
            key=tuple(p+t)
            if key not in lookup:
                lookup[key]=len(positions)//3;positions.extend(p);out_normals.extend(n);out_uv.extend(t)
            refs.append(lookup[key])
        for i in range(1,len(refs)-1): indices.extend([refs[0],refs[i],refs[i+1]])
    nose = max((vertices[i] for i in ids if vertices[i][1]>6.5 and abs(vertices[i][0])<.25),key=lambda p:p[2])
    chin = min((vertices[i] for i in ids if 6.<vertices[i][1]<6.7 and abs(vertices[i][0])<.25 and vertices[i][2]>.8),key=lambda p:p[1])
    # Mouth surface center from the official lip loop region; the joint-mouth
    # helper sits inside the oral cavity and is not a lip-surface UV landmark.
    mouth = min((vertices[i] for i in ids if abs(vertices[i][0])<.0001 and 6.63<vertices[i][1]<6.67 and vertices[i][2]>1.4),key=lambda p:p[2])
    return {"version":1,"license":"CC0-1.0","source":REPO+f"/blob/{COMMIT}/makehuman/data/3dobjs/base.obj",
            "units":"metres","coordinateSpace":"neck-local; +Y up, +Z face forward","referenceHumanHeight":1.8,
            "positions":positions,"normals":out_normals,"uv":out_uv,"indices":indices,
            "neck":[0,0,0],"headCenter":local(joints['joint-head']),"eyesY":local(joints['joint-l-eye'])[1],
            "eyes":{"left":local(joints['joint-l-eye']),"right":local(joints['joint-r-eye'])},
            "noseTip":local(nose),"chin":local(chin),"chinY":local(chin)[1],"mouthY":local(mouth)[1],
            "sourceFrame":{"neck":neck,"scale":scale},"sourceTriangles":len(indices)//3}


def main():
    CACHE.mkdir(parents=True, exist_ok=True); OUT.mkdir(parents=True, exist_ok=True)
    raw = fetch("makehuman/data/3dobjs/base.obj", "base.obj")
    license_bytes = fetch("LICENSE.ASSETS.md", "LICENSE.ASSETS.md")
    assert b"explicitly released as CC0" in raw[:1000]
    if "--head-only" in sys.argv:
        head = head_geometry(*parse_obj(raw.decode("utf8")))
        (CACHE / "human-head-source.json").write_text(json.dumps(head,separators=(",",":")),encoding="utf8")
        print(json.dumps({"headVertices":len(head['positions'])//3,"triangles":head['sourceTriangles'],"eyesY":head['eyesY'],"chinY":head['chinY'],"mouthY":head['mouthY'],"noseTip":head['noseTip']}))
        return
    data = convert(*parse_obj(raw.decode("utf8")))
    output = OUT / "human-anatomy.js"
    output.write_text("// MakeHuman hm08 anatomical hands, CC0-1.0. See human-anatomy-manifest.json.\nexport const humanAnatomy = "+json.dumps(data, separators=(",", ":"))+";\n", encoding="utf8")
    (OUT / "MAKEHUMAN-CC0.md").write_bytes(license_bytes)
    manifest = {"version": 1, "asset": "MakeHuman hm08 anatomical hands", "license": "CC0-1.0", "retrieved": "2026-11-09",
                "source": data["source"], "sourceUrl": RAW+"makehuman/data/3dobjs/base.obj", "sourceCommit": COMMIT,
                "sourceSha256": checksum(raw), "licenseUrl": RAW+"LICENSE.ASSETS.md",
                "authors": ["Data Collection AB", "Joel Palmius", "Jonas Hauquier", "MakeHuman Community"],
                "derivative": {"path": output.relative_to(ROOT).as_posix(), "bytes": output.stat().st_size, "sha256": checksum(output.read_bytes()), "parts": {name: {"vertices": len(part['positions'])//3, "triangles": part['triangles'], "bounds": part['bounds']} for name, part in data['parts'].items()}},
                "processing": ["Keep official body faces; omit all helper geometry", "Crop each wrist with 23.8 mm cuff overlap", "Convert to 1.8 m reference human and right-handed wrist-local axes", "Preserve source finger topology and UVs, compute smooth source normals", "Triangulate quads; deduplicate matching position/UV corners; round to micrometre coordinates"],
                "usage": "Anatomical hands fit beneath the original costume cuffs; approved character faces and original garments remain unchanged."}
    (OUT / "human-anatomy-manifest.json").write_text(json.dumps(manifest, indent=2)+"\n", encoding="utf8")
    print(json.dumps(manifest['derivative'], indent=2))


if __name__ == "__main__": main()
