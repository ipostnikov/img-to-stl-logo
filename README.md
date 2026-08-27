# Logo → STL

Turn a raster logo (PNG, JPG, etc.) into an extruded, correctly-oriented STL
file, ready to 3D print — in as many sizes as you want, at once.

## How it works

1. Upload an image. If it has a transparent background, that's used directly;
   otherwise the background color is auto-detected from the image corners and
   subtracted.
2. The resulting silhouette (including any holes/cutouts, e.g. a maple leaf
   cut out of a shield) is traced into polygons.
3. Each polygon is extruded upward into a solid with a flat bottom sitting at
   Z = 0 — the model always comes out lying flat and print-ready, no manual
   rotation needed.
4. You specify one or more (width in mm, thickness in mm) pairs and get one
   STL per size (aspect ratio is preserved automatically from the image).

## Run it

```bash
docker compose up --build
```

Then open http://localhost:8080

Or without compose:

```bash
docker build -t logo-to-stl .
docker run --rm -p 8080:8080 logo-to-stl
```

## Usage

1. Drop in an image.
2. If it doesn't have transparency, use the "Background sensitivity" slider
   and watch the "Detected shape" preview until it matches your logo. Use
   "Invert selection" if the tool picked the background instead of the logo.
3. Add/edit size rows (label, width in mm, thickness in mm) — presets for
   small/medium/large are provided as a starting point.
4. Click "Generate STL". One size downloads as a single `.stl`; multiple
   sizes download as a `.zip` containing one `.stl` each.

## Notes

- Disconnected parts of the logo (e.g. separate silhouettes side by side)
  become separate solids in the same STL file, matching how the source
  `logo-png.png` / manually-made `*.stl` files in this repo were built.
- Everything runs inside the container; no image data leaves it.
