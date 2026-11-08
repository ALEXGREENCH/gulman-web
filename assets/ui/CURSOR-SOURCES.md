# Original menu cursor

`hand-cursor.png` is a lossless decode of the **existing fourth BGRA byte** in
`Textures/Hud/рука4!.BMP` from the original game archive. The BMP is 172×165,
32-bit BI_RGB, pixel offset54. Ordinary Pillow BMP loading silently discards
this alpha byte. It contains the author's transparent outline, antialiasing
and soft shadow; white/black exterior RGB pixels are not a transparency key.
The source and decoded-alpha SHA-256 values are in `assets/original-ui.json`.

The light sprite is the original `Textures/Hud/Light.JPG` (128×128). No cursor
animation strip, `.cur` or `.ani` is present in the archive. The web version
places that sprite over the visible fingertip and gives it a small CSS pulse;
this is a web adaptation and respects reduced-motion preferences.

Static inspection of the original `Game.dll` (no execution) confirms both
textures belong to its menu controller:

- At VA `0x51df90`, hand HUD sprite `0x539ec4` is initialized to160×160 and loads
  the hand texture referenced at`0x51e538`.
- At VA `0x51e028`, light HUD sprite `0x539ed4` is initialized to222×222 and loads
  the light texture referenced at`0x51e558`.
- At VA `0x51e773`–`0x51e784`, both sprites are passed to the menu controller
  constructor at`0x526908`. It stores them at offsets`+0x10` and`+0x14`.
- The original highlight routine at`0x526f84` uses `Menu_Save` rectangles,
  resizes the light sprite to the hovered region and changes its visibility.
  Thus the source confirms a separate hand and glow, not an animated hand file.

The browser hotspot is native pixel[17,10], the visible index-finger tip.
Positioning subtracts this hotspot after display scaling; the overlay has
`pointer-events:none`. Mouse-only menu rendering, pointer lock, touch input,
focus loss and failed image loading all retain or restore the standard cursor.

Menu artwork now uses each image's native aspect ratio. The unchanged
`Menu_Save` 1024×768 coordinates and corrected painted-caption rectangles are
mapped by percentages onto that intact image. A blurred copy of the same art
fills wide-screen margins; it does not crop or stretch the usable illustration.

Rebuild: `python scripts/prepare_ui.py /path/to/Gulman_1_Full`.
