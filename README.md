# Logo → STL

Turn a logo (PNG, JPG, SVG, etc.) into an extruded STL, oriented to match
the hand-made reference STLs in this repo (`0.stl`/`1.stl`/`2.stl`) — meant
for embossing/pressing the design into another surface, not just printing a
thin flat badge. Generate as many sizes as you want, at once.

## How it works

1. Upload an image. **SVG input** is rasterized at 2000 px on its longest side
   first, then follows the same path as raster input. If it has a transparent
   background, that's used directly;
   otherwise the background color is auto-detected from the image corners and
   subtracted.
2. The resulting silhouette is traced into polygons, honoring arbitrary
   nesting (e.g. a shield with a maple-leaf-shaped hole, which itself has a
   solid figure sitting inside it — a hole-within-a-hole "island" comes back
   as its own raised detail, not a flat void).
3. Each polygon is extruded into a solid, then reoriented to match the
   project's reference STLs exactly: **Y is the thickness/extrusion axis**,
   **Z is vertical** (up in the artwork), and **X is mirrored** relative to
   the source image. The model sits flush at the origin (min X/Y/Z = 0).
4. Optional orientation tweaks (mirror horizontally/vertically, rotate the
   artwork in its own plane, or lay the model flat so its thickness runs off
   the print bed) are applied on top of that reference transform. Mirroring
   keeps face winding correct, so the result stays a valid watertight solid.
5. Optionally the mesh is decimated toward a triangle budget (quadric
   simplification via `fast_simplification`). Reduction is approximate —
   boundary edges constrain how far a thin-walled logo can collapse.
6. You specify one or more (width in mm, thickness in mm) pairs and get one
   STL per size (aspect ratio is preserved automatically from the image).
   Thickness defaults to a substantial fraction of the width (not a thin
   veneer), matching the reference examples.

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
3. Set orientation (mirror / rotate / lay flat) and, if you want a lighter
   file, drag the "Triangle budget" slider.
4. Check the **3D preview** — drag to orbit, scroll to zoom. It renders the
   exact bytes `/api/generate` would hand you, at the first size in the list.
   Tick "Show mesh triangles" to overlay the wireframe and see how the
   triangle budget is reshaping the mesh. The readout reports the triangle
   count, the model's mm dimensions, and whether it is watertight.
5. Add/edit size rows (label, width in mm, thickness in mm) — presets for
   small/medium/large are provided as a starting point.
6. Click "Generate STL". One size downloads as a single `.stl`; multiple
   sizes download as a `.zip` containing one `.stl` each.

## Notes

- Disconnected parts of the logo (e.g. separate silhouettes side by side)
  become separate solids in the same STL file, matching how the source
  `logo-png.png` / manually-made `*.stl` files in this repo were built.
- The 3D preview uses a vendored copy of three.js
  (`app/static/vendor/three.module.min.js`) with a hand-rolled orbit control,
  so the tool works fully offline — nothing is fetched from a CDN.
- SVG detection is alpha-based: a white shape painted on top of a black shape
  in an SVG is *opaque*, so it stays part of the silhouette rather than
  becoming a hole. Use a real cut-out (e.g. `fill-rule="evenodd"`) for holes.
- Everything runs inside the container; no image data leaves it.
