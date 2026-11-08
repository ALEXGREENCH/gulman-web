# Asset conversion

Run `python scripts/prepare_assets.py <path-to-Gulman_1_Full>` with Python 3 and Pillow.
The converter reads data only; no original EXE or DLL is executed or included.
It writes `assets/manifest.json`, converted images, mesh JSON and original audio.
Existing `assets/characters.json` is not overwritten (it has a separate converter).

## Manifest

- `models`: lower-case original relative path with forward slashes → model JSON URL.
- `images`: lower-case original image path → browser-compatible image URL.
- `imageInfo`: corresponding image width, height and meaningful alpha presence.
- `sounds`: lower-case original audio path → audio URL.
- `levels`: original numbered levels, with model key, entity array, story and briefing image URLs.
- `source`: public original download URL and archive SHA-256.
- `missingTextures`: original 3DS references that cannot be resolved in the archive.

All asset URLs start with `assets/` and are relative to the application root. The same
URLs can be resolved to ZIP entry blobs by the runtime. Stable ASCII filenames include
a SHA-1-derived suffix of the original relative path; they are not content hashes.
The manifest preserves the relationship to the original filenames.

## Mesh JSON

`coordinateSystem` is `y-up`; `units` is `original`.

Each `meshes` element contains `name`, flat `vertices` (XYZ), flat `uv` (UV),
triangle `indices` and contiguous `groups` of `{start,count,material}`. Group offsets
and lengths refer to the index buffer, and `material` names a key in `materials`.
Face assignments are reordered into contiguous groups using actual 3DS face IDs.
`smoothing`, when present, has one original smoothing mask per reordered triangle.
`originalMatrix` retains the optional raw 3DS local-frame metadata; do not apply it
again to the already baked model-space vertices.

Materials expose `color` (RGB, 0–1), optional `map` URL, `opacity` (0–1), `alphaTest`,
`uvScale`, `uvOffset`, `uvRotation` (radians) and optional `doubleSided`.
`originalMap` records the original texture name. TGA and BMP become PNG;
JPEG bytes and WAV bytes are preserved. Alpha cutouts use a threshold of 0.35.

## Coordinates

The original 3DS files are Z-up. Their points are converted by `(x,y,z) → (x,z,-y)`.
This is a rotation and does not reverse triangle winding. No scale is applied.
Scene/script coordinates agree with these Y-up vertices. Divide world positions and
world meshes by `manifest.unitsPerMeter` (100) in the runtime.

Characters use the original HSK hierarchy and require raw Z-up mesh geometry:
rotate the converted mesh vertices by `+π/2` around X before HSK assembly. Character
normalization belongs to the character loader; do not divide individual pieces by 100.

Most `GameStart` coordinates identify the character center about 100 original units
above the floor, not the feet. Ground-snap the player, or subtract 1 metre after scaling.
Level 6 contains two `GameStart` records; the last is the ground-level spawn.

## Entities

Each entity preserves `id,x,y,z,a,b,c,command,args,model` from the pipe-delimited
Windows-1251 `Levels.Script`. `model` is either a manifest model key or `null`.
The converter does not reinterpret undocumented numeric fields or repair game-script
typos. Empty placeholder commands occur in levels 5 and 6. Multiple keys, damage
zones and shops are retained, including objects that overlap in the original data.

## Known source issue

`models/weapons/weaponrifle2.3ds` refers to `GRANATE-.JPG`, which is absent from
the official archive. No speculative texture substitution is applied. The material's
original color remains available as the fallback. The other 134 models resolve all
referenced textures.
