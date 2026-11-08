# Original shooting and loot audit

Audited on **9 November 2026**, using the downloaded original game archive's
`Gulman_1_Full/Game.dll` and its original image/model resources. The executable
was inspected statically and was not run. It contains compiled Delphi/GLScene
code; no editable weapon source scripts were present in the archive.

The inspected DLL's SHA-256 is
`6e414dbc59229707f53398264f12d6144fa9dcb96eb34d064dc353ed0cfee05e`.
Addresses below are virtual addresses at image base `0x400000`. Original world
units are converted at 100 units per metre, matching the existing web level
conversion.

## Projectiles

The original uses a moving projectile pool, rather than an instant line hit.
Weapon initialization at `0x52AC84–0x52ACDA` supplies the firing intervals,
speed and base damage. Firing routines `0x52A0AC`, `0x52A1E4`, `0x52A318` and
`0x52A408` create the corresponding projectile resources and lifetime.

| Weapon | Travelling resource | Count per trigger | Speed | Lifetime/fuse | Original interval | Original base damage |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Pistol | Blue `Textures/3q.jpg` sprite | 1 | 50 m/s | 0.5 s | 0.4 s | 16 + Random(5) |
| Automatic rifle | Blue `Textures/3q.jpg` sprite | 1 | 40 m/s | 3 s | 0.17 s | 43 + Random(15) |
| Grenade | `Models/Weapons/Granate.3DS`, green grenade texture | 1 | 12 m/s | 1.5 s | 1 s | 72 |
| Biggun | Yellow `Textures/2q.jpg` sprite | 8 | 40 m/s | 1 s | 0.7 s | 218 per projectile |

The sprite constructor `0x52D430` sets width and height to 360/300/44 source
units for pistol/rifle/biggun respectively. These values include the black
border and broad additive glow surrounding the tiny luminous center. The
texture pixels are reused from the original converted assets, not painted
approximations. Muzzle flashes are warm, independently of the blue travelling
round. The original update at `0x52D57C` also bends projectile direction
downward and jitters Biggun rounds.

The explosion routine `0x52BEA0` uses a 600-unit grenade radius and a 400-unit
Biggun radius. Its original falloff multiplies base damage by
`(600-distance)/40` and `(400-distance)/320` respectively. Those extreme damage
values are documented as source evidence, not silently imposed on the existing
web enemy balance.

`js/original-combat.js` restores visible travel, blue/yellow source sprites,
the eight-round Biggun burst, an actual moving grenade model, muzzle flashes,
impact sparks, explosion radii and projectile lifetimes. It sweeps the travelled
segment against level triangles and live actor targets, so a round cannot
damage a character behind the first wall. Enemy rounds travel too and can be
dodged. The original collision mesh remains the only world collider.

## Death drops and pickup amounts

Death routine `0x5276C8–0x527971` creates these original models once per death:

| Drop | Original creation chance | Original model |
| --- | --- | --- |
| Money | Always | `Models/Инвентарь/баксы/баксы.3DS` |
| Ammunition | `Random(5) == 3`, or 20% | `Models/Инвентарь/патроны/shell_box.3DS` |
| Health | `Random(7) == 3`, or about 14.3% | `Models/Инвентарь/аптека/aptechka.3DS` |

Each drop scatters in X/Z by `Random(99) - Random(99)` units, or at most
0.98 m in either horizontal axis. Their source commands end in `>1>`, but
**that token is not a quantity**. The pickup parser at
`0x5254A5–0x5256E4` ignores it and rolls the following grants:

- Money: `20 + Random(20)` dollars, therefore 20–39.
- Health: `7 + Random(10)`, therefore 7–16; the source health cap is 120.
- Pistol ammunition: `5 + Random(5)`, therefore 5–9.
- Rifle ammunition: `15 + Random(10)`, therefore 15–24.
- Grenades: `1 + Random(2)` only when `Random(7) == 5`.
- Biggun ammunition: `2 + Random(3)` only when `Random(9) == 5`.

The original has separate ammunition pools and clamps each grant to its pool's
capacity. The new helper retains all four grants in `ammoByWeapon` and returns
their sum as `amount` for the web port's existing shared-ammunition interface.

## Deliberate browser adaptations

The web port retains its existing 100-health cap, shared ammunition pool,
weapon damage and fire/reload balance. Explicit `fire({damage})` means total
damage per trigger: Biggun divides that value across its eight rounds, avoiding
an accidental eightfold damage increase. Splash damage stays normalized by the
application rather than using the original extreme damage multiplier.

Projectile paths use short swept ballistic segments, with gravity approximating
the original direction changes. Contact impacts are resolved by the current
browser collision engine. Biggun's random path variation is represented by a
small initial spread. This is a restoration of the visible projectile and loot
mechanics, not a claim that the original native executable is emulated exactly.

Drops use the source chances, models and randomized grants, with placement
adjusted to the nearest reachable floor so an offset cannot put a pickup inside
a wall or across an inaccessible ledge. Money is collected from the dropped
object; killing an enemy does not silently award it to the HUD.

All projectile sprites/particles share a fixed geometry pool and one draw call.
The grenade reuses the original cached model. Disposal releases only resources
owned by the projectile system; original texture/model resources remain valid.

`tests/original-combat.test.mjs` checks delayed hits, swept wall occlusion,
eight-round damage conservation, grenade fuse/arc, enemy shots, 25/60/120 Hz
stability, pickup ranges and probabilities, bounded pools and asynchronous
resource ownership.
