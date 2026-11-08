# Enhanced vegetation sources

Enhanced uses downloaded, artist-authored models below. All geometry and maps
are self-hosted; the running game does not request third-party asset servers.
Original mode, original resource files, character faces and collision geometry
are unchanged.

| Replacement | Downloaded model | License | Detailed / distant triangles |
| --- | --- | --- | --- |
| `TREE.TGA` | [Island Tree 02 — Poly Haven](https://polyhaven.com/a/island_tree_02) | [CC0](https://polyhaven.com/license) | 33,275 / 4,910 |
| `TUIA.TGA`, `TUIA.JPG`, `TUIA1.JPG`, `TUIA2.JPG` | [Fir Tree 01 — Poly Haven](https://polyhaven.com/a/fir_tree_01), dense original variant A | [CC0](https://polyhaven.com/license) | 35,827 / 8,053 |
| `BUSH.TGA` | [Shrub 02 — Poly Haven](https://polyhaven.com/a/shrub_02), original variant A | [CC0](https://polyhaven.com/license) | 7,590 / 1,793 |
| `FLOWERS.TGA` | [Shrub Sorrel 01 — Poly Haven](https://polyhaven.com/a/shrub_sorrel_01) | [CC0](https://polyhaven.com/license) | 148 / 148 |
| `PALMA.TGA` | [Palm tree v2 — Yughues / Nobiax](https://opengameart.org/content/palm-tree-v2), published November 2011 | [CC0 dedication on the source page](https://creativecommons.org/publicdomain/zero/1.0/) | 1,032 / 1,032 |

Poly Haven explicitly permits redistribution and modification of its CC0 models
and textures. Yughues's source archive also includes its author's permission to
use or modify the model in personal and commercial works. The source-page CC0
dedication is the redistribution license. These are existing published assets,
not newly generated replacement trees.

`assets/enhanced/vegetation/sources.json` records source download URLs, official
Poly Haven MD5 values, source SHA256 values and SHA256 values for every published
file. The five published species together occupy 10.82 MiB. Source archives
remain in the build workspace, outside the game.

## Processing

- `scripts/fetch_enhanced_vegetation.py` verifies official source checksums and
  invokes `scripts/optimize_vegetation.mjs`. Rebuilding needs Python 3, Pillow,
  py7zr and Node. It downloads meshoptimizer 1.3.0 from the official npm registry
  if the workspace cache is absent; meshoptimizer is MIT-licensed and used only
  as an offline build tool.
- One original tree/shrub variant is selected from each multi-variant source.
  Trunks and branches use meshoptimizer LODs; source object
  transforms are preserved. Island Tree's disconnected leaves use a separate
  coverage-preserving reduction: each retained leaf is reconstructed as two
  triangles from its original positions and UVs, with the source alpha map
  preserving its silhouette. Both LODs retain leaves in all 709 occupied crown
  cells. This avoids the nearly bare crown caused by pruning leaf islands.
  The detailed and distant models retain 15,081 and 2,234 complete leaves,
  respectively; modest per-cell leaf scaling compensates for the reduced count.
- Fir uses the dense A variant, selected against the author's orthographic
  preview. Its sub-pixel individual needles are represented by complete twig
  clusters using the original photographed alpha atlas at the source twig axes.
  The detailed mesh retains all 7,817 twig axes; the distant mesh retains 1,856,
  covering all 651 occupied crown cells. Each cluster uses two small crossing
  surfaces, not a whole-tree billboard. Browser QA confirmed a dense crown at
  both distances; the sparse C variant is not shipped.
- Shrub keeps all 7,590 source triangles nearby. Its distant reduction disables
  island pruning and retains 94.8% of the source surface area. The already compact
  palm and sorrel retain their complete original geometry at both distances.
- Poly Haven's separate leaf alpha maps are merged into the corresponding
  base-color map. Published maps use WebP at 1K. Yughues's OBJ is converted to
  glTF with its authored UVs, normals and TGA diffuse/normal maps.
- Source models are fitted to the original vegetation's height and horizontal
  footprint, with pivots at the original ground minimum. Three crossed bush
  cards become one volume. Original plant materials are hidden only after every
  required import succeeds; unconsumed material groups are returned intact.
- Instanced material batches, two distance LODs, frustum/distance culling and
  gentle shader wind bound the runtime cost. Low quality shortens detailed-LOD
  distances and disables vegetation shadows; it retains nearby plant positions.

## Scope audit

All nine original model/material tables were inspected. Dedicated `TREE`,
`TUIA`, `PALMA`, `BUSH` and `FLOWERS` materials are covered. `TX3.JPG` is a stone
atlas; `GRASS4.JPG` is used by large terrain surfaces in level 9. Neither is
consumed by the vegetation layer. They belong to the separate landscape layer.

`tests/enhanced-vegetation.test.mjs` checks all nine inventories, source immutability,
partial-group retention, hashes and glTF geometry validity, leaf coverage and
winding, twig coverage, shrub surface area, complete palm/sorrel geometry, LOD
budgets, culling, and asynchronous disposal. Browser visual QA
confirmed a full crown at both distances after the leaf reduction fix.
