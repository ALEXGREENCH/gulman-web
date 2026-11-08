# Enhanced asset sources

The original game pack is unchanged. The files listed here are separate,
optional resources loaded only by Enhanced mode.

## Scanned PBR materials

Downloaded on 2026-11-08 through the official [Poly Haven public API](https://api.polyhaven.com/).
All ten environment materials are [CC0 1.0](https://polyhaven.com/license), including permission
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

The shipped derivatives use 1024-pixel color and OpenGL normal maps, plus
512-pixel roughness maps. The original maps were downloaded as 1K JPEG; source
MD5 values were verified against the API. Color and normal maps are encoded as
WebP at quality 90 and 95; roughness is reduced with Lanczos and encoded lossless.
Color is sampled as sRGB; normal and roughness remain linear data. No normal or
roughness map is invented from the old game's diffuse texture.

`materials/manifest.json` records every direct source URL, author, real-world
tile size, source SHA-256, shipped SHA-256, dimensions and byte size. The total
texture download is approximately 7.63 MiB. `scripts/fetch_enhanced_assets.py`
rebuilds the pack using Python and Pillow.

The triplanar shader and wet-sand/slope blending are new project code, under the
project's code license. They preserve the original collision geometry. Facade
atlases, signs, paintings, menu art, character textures and foliage cards are
deliberately excluded from the material classifier.

The beach atlas is borrowed only as a broad mask distinguishing its original
sand and rock regions; its pixels are not used as the new detailed surface color.
Continuous coordinate warping reduces visible tiling without adding extra PBR
texture samples. The optional terrain subdivision creates a separate visual
mesh: every original triangle boundary is fixed, with displacement bounded to
8 mm on sand and 10 cm on steep rock. The original mesh remains the collider.

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
