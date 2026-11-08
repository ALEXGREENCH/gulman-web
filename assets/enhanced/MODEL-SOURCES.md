# Enhanced models and sky

The optional Enhanced pack includes these self-hosted assets, downloaded from
the official Poly Haven API on 2026-11-08. They are redistributable under
[CC0 1.0](https://polyhaven.com/license).

| Asset | Use |
| --- | --- |
| [Fern 02](https://polyhaven.com/a/fern_02) | Replaces original crossed bush cards with volumetric fronds |
| [Grass Bermuda 01](https://polyhaven.com/a/grass_bermuda_01) | Wind-animated grass around the original planting locations |
| [Rock 07](https://polyhaven.com/a/rock_07) | Photoscanned rocks along the sides of the beach |
| [Kloofendal 48d Partly Cloudy Pure Sky](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) | Real 2K HDR sky and environmental illumination |

The glTF geometry, 1K material maps, separate original alpha masks and HDR sky
are original downloads, without AI-generated substitutes. `models/sources.json`
records exact file URLs, SHA-256 hashes and sizes. Rebuild with
`python scripts/fetch_enhanced_models.py`. Powered by [Poly Haven](https://polyhaven.com/).

Runtime changes: selected plant variants are normalized and instanced at the
original plant positions, grass gets distance culling, leaves get shader wind,
and the standalone alpha masks are attached to the opaque/cutout glTF materials.
Only Enhanced loads this pack. Original collision geometry is retained.

The new weapon meshes, articulated magazines/actions, gloves, beach loungers,
parasols, fallback tables/crates/barrels, speedboat and water surfaces are project-authored code
geometry. They are covered by the project's MIT code license. They do not use
models or animation files from Call of Duty, Crysis or Cyberpunk.

GLTFLoader and BufferGeometryUtils are official Three.js 0.180.0 modules;
the Three.js MIT notice is retained under `vendor/`.

## Imported environment props

The following four original Poly Haven models were downloaded from its official
API on 2026-11-09 and are self-hosted under `props/`. Poly Haven explicitly allows
modification and redistribution under [CC0 1.0](https://polyhaven.com/license).
No third-party game models, character faces, or generated replacement images
are included in this pack.

| Model | Placement | Close / distant triangles |
| --- | --- | ---: |
| [Wooden Crate 01](https://polyhaven.com/a/wooden_crate_01) | Existing small wooden cargo boxes; source latch, handles, joints and wear retained | 6,576 / 808 |
| [Barrel 03](https://polyhaven.com/a/barrel_03) | Existing steel drums; blue painted metal with dents, rings and bung | 1,473 / 175 |
| [Round Wooden Table 01](https://polyhaven.com/a/round_wooden_table_01) | Existing round café/dining tables; turned pedestal and splayed feet | 8,640 / 1,050 |
| [Plastic Monobloc Chair 01](https://polyhaven.com/a/plastic_monobloc_chair_01) | Existing small beach/café chairs sharing the old lounger atlas | 3,356 / 402 |

The complete pack is 2,170,580 bytes (about 2.07 MiB), excluding its small manifest
and provenance JSON. Source geometry is unchanged at close range. The original
1K color, normal and packed roughness/metallic maps are converted to WebP; no
visual details are invented. A second index-only mesh LOD is built offline with
[meshoptimizer 1.3.0](https://github.com/zeux/meshoptimizer), preserving source
positions, UVs and normals. Geometry and PBR materials are shared by instanced
copies. A bounded number of nearby copies use the close LOD; all other copies
remain visible with the distance LOD. Original and Potato never require this
pack.

`props/sources.json` records upstream URLs and MD5/SHA-256 checksums plus hashes
and byte sizes of every shipped derivative. Rebuild with
`python scripts/fetch_enhanced_props.py` (Python, Pillow and Node.js).

Selection checks both original texture identity and source-mesh shape: the
large platforms, beams and towers also painted with `BOX.JPG` remain their
original geometry. Chairs are not converted into loungers. Replacement visual
bounds fit inside the source footprint and height; original collisions and
objective routes remain untouched. Individual failed imports leave their
source chunks available to the fallback renderer. The existing authored
motorboat remains in use: a sailing ship or another unrelated type would not
be an appropriate replacement.
