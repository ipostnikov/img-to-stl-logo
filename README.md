# img-to-stl-logo

Turns a logo image into an extruded STL I can boolean into an earmould or
hearing aid shell in CAD.

Drop in a PNG/JPG/SVG, tweak the threshold until the silhouette preview looks
right, pick your sizes, download. Output is centred on the origin, with Y as
the extrusion axis.

## Run

```bash
docker compose up --build
```

http://localhost:8080

## Notes

- Sizes are small: presets are 5/7.5/10 mm wide. Thickness is the depth of the
  prism you cut into the shell, not the final emboss height, so 10 mm is
  deliberately more than you need.
- There's a built-in image editor (brush, rectangle erase, crop) for stripping
  the text off a logo before tracing.
- The triangle budget slider decimates the mesh. Push it too far and the model
  stops being watertight — the preview readout tells you.
- Nothing leaves the container. three.js is vendored, so no CDN either.
