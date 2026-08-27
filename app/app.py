import io
import json
import zipfile

from flask import Flask, abort, request, render_template, send_file

from logo_to_stl import (
    ConversionError,
    build_polygons_from_image,
    polygons_to_stl_bytes,
    render_mask_preview,
)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # 20 MB uploads


@app.route("/")
def index():
    return render_template("index.html")


def _read_image_and_params():
    if "image" not in request.files:
        abort(400, "No image uploaded")
    image_bytes = request.files["image"].read()
    if not image_bytes:
        abort(400, "Empty image upload")
    try:
        threshold = float(request.form.get("threshold", 30))
        min_area_pct = float(request.form.get("min_area_pct", 0.02))
        simplify = float(request.form.get("simplify", 1.5))
    except ValueError:
        abort(400, "Invalid numeric parameter")
    invert = request.form.get("invert", "false").lower() == "true"
    return image_bytes, threshold, invert, min_area_pct, simplify


@app.route("/api/preview", methods=["POST"])
def preview():
    try:
        image_bytes, threshold, invert, min_area_pct, simplify = _read_image_and_params()
        png_bytes = render_mask_preview(image_bytes, threshold, invert, min_area_pct, simplify)
    except ConversionError as e:
        abort(400, str(e))
    return send_file(io.BytesIO(png_bytes), mimetype="image/png")


@app.route("/api/generate", methods=["POST"])
def generate():
    image_bytes, threshold, invert, min_area_pct, simplify = _read_image_and_params()

    sizes_json = request.form.get("sizes")
    if not sizes_json:
        abort(400, "No sizes provided")
    try:
        sizes = json.loads(sizes_json)
    except json.JSONDecodeError:
        abort(400, "Malformed sizes payload")
    if not isinstance(sizes, list) or not sizes:
        abort(400, "No sizes provided")

    try:
        polygons, px_width, _px_height = build_polygons_from_image(
            image_bytes, threshold, invert, min_area_pct, simplify
        )
        if not polygons:
            abort(400, "No shape could be detected in the image. Try adjusting the threshold.")

        files = []
        for size in sizes:
            label = str(size.get("label") or "logo").strip() or "logo"
            try:
                width_mm = float(size["width_mm"])
                thickness_mm = float(size["thickness_mm"])
            except (KeyError, TypeError, ValueError):
                abort(400, "Each size needs a numeric width_mm and thickness_mm")
            if width_mm <= 0 or thickness_mm <= 0:
                abort(400, "Width and thickness must be positive")

            stl_bytes = polygons_to_stl_bytes(polygons, px_width, width_mm, thickness_mm)
            safe_label = "".join(c if c.isalnum() or c in "-_" else "_" for c in label)
            filename = f"{safe_label}_{width_mm:g}mm_x_{thickness_mm:g}mm.stl"
            files.append((filename, stl_bytes))
    except ConversionError as e:
        abort(400, str(e))

    if len(files) == 1:
        filename, data = files[0]
        return send_file(
            io.BytesIO(data),
            mimetype="model/stl",
            as_attachment=True,
            download_name=filename,
        )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for filename, data in files:
            zf.writestr(filename, data)
    buf.seek(0)
    return send_file(
        buf,
        mimetype="application/zip",
        as_attachment=True,
        download_name="logo_stls.zip",
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=False)
