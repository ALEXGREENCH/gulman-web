"""Fetch the optional Enhanced CC0 material pack from Poly Haven's public API.

Requires Pillow. Source files are cached under the workspace's work/ directory;
the game only contains the bounded WebP derivatives plus source/checksum records.
No original game resources are replaced. Re-run from any working directory.
"""
from __future__ import annotations

import hashlib
import io
import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT.parents[1] / "work" / "polyhaven-materials"
OUT = ROOT / "assets" / "enhanced" / "materials"
HEADERS = {"User-Agent": "GulmanEnhancedAssetBuilder/1.0 (CC0 material redistribution)"}
PACK = {
    "sand": "sand_01",
    "rock": "rock_face",
    "concrete": "rough_concrete",
    "wood": "wood_planks_dirt",
    "brick": "brick_wall_001",
    "grass": "grass_ground",
    "plaster": "plastered_wall",
}
MAPS = {"color": ("Diffuse", 1024), "normal": ("nor_gl", 1024), "roughness": ("Rough", 512)}


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=60) as response:
        return response.read()


def checksum(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def material(item: tuple[str, str], catalog: dict) -> tuple[str, dict]:
    kind, asset = item
    api_url = f"https://api.polyhaven.com/files/{asset}"
    files = json.loads(fetch(api_url))
    info = catalog[asset]
    result = {
        "asset": asset,
        "source": f"https://polyhaven.com/a/{asset}",
        "api": api_url,
        "license": "CC0-1.0",
        "authors": info.get("authors", {}),
        "tileMeters": round(info.get("dimensions", [2000])[0] / 1000, 3),
        "maps": {},
    }
    for name, (channel, size) in MAPS.items():
        entry = files[channel]["1k"]["jpg"]
        raw_path = CACHE / f"{asset}_{name}.jpg"
        raw = raw_path.read_bytes() if raw_path.exists() else fetch(entry["url"])
        if entry.get("md5") and hashlib.md5(raw).hexdigest() != entry["md5"]:
            raise ValueError(f"Source checksum mismatch: {asset}/{name}")
        raw_path.write_bytes(raw)
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        image.thumbnail((size, size), Image.Resampling.LANCZOS)
        path = OUT / f"{kind}-{name}.webp"
        # Normals remain linear data. Only the shader interprets color as sRGB.
        if name == "roughness":
            image = image.convert("L")
            image.save(path, "WEBP", lossless=True, method=6)
        else:
            image.save(path, "WEBP", quality=95 if name == "normal" else 90, method=6)
        result["maps"][name] = {
            "path": path.relative_to(ROOT).as_posix(),
            "size": list(image.size),
            "bytes": path.stat().st_size,
            "sha256": checksum(path.read_bytes()),
            "sourceUrl": entry["url"],
            "sourceSha256": checksum(raw),
        }
    print(f"{kind}: {asset}, {sum(v['bytes'] for v in result['maps'].values()) / 1024:.0f} KiB", flush=True)
    return kind, result


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    catalog = json.loads(fetch("https://api.polyhaven.com/assets?t=textures"))
    with ThreadPoolExecutor(max_workers=4) as executor:
        materials = dict(executor.map(lambda item: material(item, catalog), PACK.items()))
    manifest = {
        "version": 1,
        "license": "https://polyhaven.com/license",
        "retrieved": "2026-11-08",
        "materials": materials,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf8")
    print(f"Total: {sum(p.stat().st_size for p in OUT.glob('*.webp')) / 1024 / 1024:.2f} MiB")


if __name__ == "__main__":
    main()
