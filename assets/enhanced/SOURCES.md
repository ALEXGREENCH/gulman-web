# Enhanced asset sources

The original game pack is unchanged. The files listed here are separate,
optional resources loaded only by Enhanced mode.

## Scanned PBR materials

Downloaded on 2026-11-08 through the official [Poly Haven public API](https://api.polyhaven.com/).
All seven materials are [CC0 1.0](https://polyhaven.com/license), including permission
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

The shipped derivatives use 1024-pixel color and OpenGL normal maps, plus
512-pixel roughness maps. The original maps were downloaded as 1K JPEG; source
MD5 values were verified against the API. Color and normal maps are encoded as
WebP at quality 90 and 95; roughness is reduced with Lanczos and encoded lossless.
Color is sampled as sRGB; normal and roughness remain linear data. No normal or
roughness map is invented from the old game's diffuse texture.

`materials/manifest.json` records every direct source URL, author, real-world
tile size, source SHA-256, shipped SHA-256, dimensions and byte size. The total
texture download is approximately 5.87 MiB. `scripts/fetch_enhanced_assets.py`
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
