# Enhanced asset sources

The original game pack is unchanged. The files listed here are separate,
optional resources loaded only by Enhanced mode.

## Scanned PBR materials

Downloaded on 2026-11-08–09 through the official [Poly Haven public API](https://api.polyhaven.com/).
All twelve environment materials are [CC0 1.0](https://polyhaven.com/license), including permission
to redistribute them in this application. The material authors are credited below.

| In-game material | Source | Authors |
| --- | --- | --- |
| Sand | [Sand 01](https://polyhaven.com/a/sand_01) | Rob Tuytel |
| Rock | [Rock Face](https://polyhaven.com/a/rock_face) | Greg Zaal (photography), Dario Barresi (processing) |
| Concrete | [Rough Concrete](https://polyhaven.com/a/rough_concrete) | Dimitrios Savva |
| Weathered wood | [Wood Planks Dirt](https://polyhaven.com/a/wood_planks_dirt) | Rob Tuytel |
| Brick | [Brick Wall 001](https://polyhaven.com/a/brick_wall_001) | Dimitrios Savva (photography), Rob Tuytel (processing) |
| Grass | [Grass Ground](https://polyhaven.com/a/grass_ground) | Charlotte Baglioni |
| Plaster | [Plastered Wall](https://polyhaven.com/a/plastered_wall) | Amal Kumar |
| Pale architectural stone (`limestone` material key) | [White Sandstone Blocks 02](https://polyhaven.com/a/white_sandstone_blocks_02) | Rob Tuytel |
| Marble | [Marble 01](https://polyhaven.com/a/marble_01) | Rob Tuytel |
| Terracotta roofing | [Clay Roof Tiles 02](https://polyhaven.com/a/clay_roof_tiles_02) | Amal Kumar |
| Fractured mountain rock (`cliff`) | [Rock Face 04](https://polyhaven.com/a/rock_face_04) | Dimitrios Savva |
| Cobblestone ground and embankments | [Cobblestone 01](https://polyhaven.com/a/cobblestone_01) | Rob Tuytel |

The shipped derivatives use 1024-pixel color and OpenGL normal maps, plus
512-pixel roughness maps. The original maps were downloaded as 1K JPEG; source
MD5 values were verified against the API. Color and normal maps are encoded as
WebP at quality 90 and 95; roughness is reduced with Lanczos and encoded lossless.
Color is sampled as sRGB; normal and roughness remain linear data. No normal or
roughness map is invented from the old game's diffuse texture.

`materials/manifest.json` records every direct source URL, author, real-world
tile size, source SHA-256, shipped SHA-256, dimensions and byte size. The total
texture download is approximately 9.27 MiB. `scripts/fetch_enhanced_assets.py`
rebuilds the pack using Python and Pillow.

The triplanar shader and wet-sand/slope blending are new project code, under the
project's code license. They preserve the original collision geometry. The
generic material classifier excludes atlas facades and mixed terrain. Separate
architecture and landscape layers select known source UV regions: blank walls,
roofs and ground receive scans, while historic inscriptions, paintings,
ornament artwork is retained; landscape stairs and platforms use separately clipped limestone. Terrain atlases locate grass, rock,
roads and paths; their blurry color pixels are not used as the new surface
detail. Menu artwork and the existing Enhanced character faces are unchanged.

The beach atlas is borrowed only as a broad mask distinguishing its original
sand and rock regions; its pixels are not used as the new detailed surface color.
Continuous coordinate warping reduces visible tiling without adding extra PBR
texture samples. `enhanced-landscape.js` creates separate terrain geometry on
all nine maps, bounded to 28,000 triangles in High and 7,000 in Low. Outer and
UV-clipped edges are pinned; subdivision and welded normals keep internal
edges continuous. Relief is bounded to 18 mm on level ground and 45 cm on
steep mountains; plazas remain undisplaced. The original mesh remains the
collider. The earlier beach-only helper remains available for independent use.
TX3 stair strips and its central archaeological floor island are UV-clipped
into a separate limestone surface; rocky slopes use the cliff scan. Their exact
source positions and collision geometry remain unchanged.

## Shared character material atlas

The new Enhanced character geometry uses one shared vertex-colored PBR material
with three 1024 × 512 atlases, totaling about 399 KiB. Original character atlases
are unchanged. The costume palette comes from each new mesh's vertex colors;
neutral surface detail comes from these CC0 scans:

| Cell | Source | Authors |
| --- | --- | --- |
| Cloth / denim | [Denim Fabric](https://polyhaven.com/a/denim_fabric) | Rob Tuytel |
| Brocade suit | [Quatrefoil Jacquard Fabric](https://polyhaven.com/a/quatrefoil_jacquard_fabric) | colormass (photography), Rico Cilliers (processing) |
| Leather | [Brown Leather](https://polyhaven.com/a/brown_leather) | Rob Tuytel |

The build script verifies source MD5s, reduces and normalizes albedo luminance
to preserve costume colors, scales the original tangent-space normal amplitude,
and packs measured roughness into ORM green. Skin pores, hair strands, eye gloss
and metal cells are simple code-authored microstructure; these are not scanned
human faces. Each 256-pixel cell has an eight-pixel repeated-edge gutter.

`characters/manifest.json` records source URLs/hashes, processing, UV rectangles
and output SHA-256s. `scripts/fetch_enhanced_character_materials.py` reproduces
the atlas. The optional runtime material library keeps one material identity
while its three textures load, and does not download anything in Original mode.

The faces use an additional shared material and a 2048 × 1024 albedo atlas
(`characters/face-color.webp`, 718 KiB). This image was reconstructed with the
built-in OpenAI ImageGen tool using the original seven character atlases as
identity references. It is generated artwork, not a CC0 human scan. The exact
prompt, processing and output checksum are in
[`characters/face-generation.json`](characters/face-generation.json). The new
anatomy, clothing, hair and architectural geometry are authored in the JS source.

The Taj Mahal garden retains its original UV layout as a broad grass/path mask.
Fine grass and limestone paving use the CC0 scans at physical scale, so the
paths remain in their original places without stretching the old painted ground.

## Imported human anatomy

The anatomical hand meshes come from the official MakeHuman Community
[hm08 base mesh](https://github.com/makehumancommunity/makehuman/blob/a8bc2d54ff0ac92e78ff71431b1023eda42bf482/makehuman/data/3dobjs/base.obj),
pinned to commit `a8bc2d54ff0ac92e78ff71431b1023eda42bf482`. The asset's own
header explicitly releases it under CC0. The project's
[asset license](https://github.com/makehumancommunity/makehuman/blob/a8bc2d54ff0ac92e78ff71431b1023eda42bf482/LICENSE.ASSETS.md)
covers the base mesh independently of the MakeHuman application's source code.
Credited authors: Data Collection AB, Joel Palmius, Jonas Hauquier and the
MakeHuman Community. No MakeHuman application code is bundled.

`scripts/fetch_human_anatomy.py` selects only the body mesh's two hands,
including 23.8 mm of wrist for an overlap beneath a costume cuff. Helper joint
meshes and all other body geometry are excluded. The five-finger topology and
UVs are retained, source normals are calculated, quads are triangulated, and
coordinates are transformed into wrist-local metres for a 1.8 m reference
person. The derivative contains 1,909 vertices and 3,328 triangles per hand;
the shared ES module is approximately 364 KiB.

`characters/human-anatomy-manifest.json` records the pinned URL, original and
derivative SHA-256s, processing and bounds. `characters/MAKEHUMAN-CC0.md` ships
the exact license. Anatomical hands attach beneath the original costume cuffs;
the approved generated character faces and the original game's character
texture files are preserved.

The anatomical head in `characters/human-head.js` comes from the same pinned
CC0 body topology. It retains ears, eyelids, nose and lips, while omitting all
helper meshes and cutting only 5.4 mm below the neck joint to avoid shoulder
fragments. The face surface is closed; its only open boundary is the neck.
The approved face atlas is projected onto this geometry using the source eye,
nose, lip and chin landmarks. The source character's costume is retained.

The head derivative contains 2,156 vertices / 4,000 triangles and is 209 KiB.
Offline meshoptimizer 1.3.0 simplification preserves normals and the neck
boundary; reported geometric error is 0.43 mm. No simplification library runs
in the browser. The pinned source and shipped SHA-256s, bounds and build steps
are recorded in `characters/human-head-manifest.json`; rebuild with
`scripts/fetch_human_anatomy.py --head-only` followed by
`scripts/optimize_human_head.mjs` with a local meshoptimizer module path.
