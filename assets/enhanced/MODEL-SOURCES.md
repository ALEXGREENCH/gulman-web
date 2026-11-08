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
parasols, tables, crates, barrels, speedboat and water surfaces are project-authored code
geometry. They are covered by the project's MIT code license. They do not use
models or animation files from Call of Duty, Crysis or Cyberpunk.

GLTFLoader and BufferGeometryUtils are official Three.js 0.180.0 modules;
the Three.js MIT notice is retained under `vendor/`.
