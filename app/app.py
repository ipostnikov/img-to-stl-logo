import hashlib
import io
import json
import zipfile
from collections import OrderedDict

from flask import Flask, abort, request, render_template, send_file

from logo_to_stl import (
    ConversionError,
    Orientation,
    build_mesh,
    build_polygons_from_image,
    mesh_to_stl_bytes,
    render_mask_preview,
)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # 20 MB uploads


@app.route("/")
def index():
    return render_template("index.html")


# Recently uploaded images, keyed by content hash. Tuning a slider fires a
# preview per change; without this every one of them would re-upload the full
# image. Clients send image_id alone and fall back to the bytes on a miss, so
# a cold cache (restart, or the other gunicorn worker) is merely slower.
_IMAGE_CACHE: "OrderedDict[str, bytes]" = OrderedDict()
_IMAGE_CACHE_MAX = 8


def _cache_image(image_bytes: bytes) -> str:
    image_id = hashlib.sha256(image_bytes).hexdigest()
    _IMAGE_CACHE[image_id] = image_bytes
    _IMAGE_CACHE.move_to_end(image_id)
    while len(_IMAGE_CACHE) > _IMAGE_CACHE_MAX:
        _IMAGE_CACHE.popitem(last=False)
    return image_id


def _resolve_image() -> bytes:
    """Take the uploaded bytes, or reuse a cached upload by its id."""
    if "image" in request.files:
        image_bytes = request.files["image"].read()
        if not image_bytes:
            abort(400, "Empty image upload")
        _cache_image(image_bytes)
        return image_bytes

    image_id = request.form.get("image_id", "")
    if not image_id:
        abort(400, "No image uploaded")
    cached = _IMAGE_CACHE.get(image_id)
    if cached is None:
        # 409 is the client's cue to retry with the full bytes attached.
        abort(409, "image-not-cached")
    _IMAGE_CACHE.move_to_end(image_id)
    return cached


def _read_image_and_params():
    image_bytes = _resolve_image()
    try:
        threshold = float(request.form.get("threshold", 30))
        min_area_pct = float(request.form.get("min_area_pct", 0.02))
        simplify = float(request.form.get("simplify", 1.5))
    except ValueError:
        abort(400, "Invalid numeric parameter")
    invert = request.form.get("invert", "false").lower() == "true"
    return image_bytes, threshold, invert, min_area_pct, simplify


def _flag(name: str) -> bool:
    return request.form.get(name, "false").lower() == "true"


def _read_orientation() -> Orientation:
    try:
        rotate_deg = float(request.form.get("rotate_deg", 0))
    except ValueError:
        abort(400, "Invalid rotation")
    return Orientation(
        mirror_h=_flag("mirror_h"),
        mirror_v=_flag("mirror_v"),
        rotate_deg=rotate_deg,
        lay_flat=_flag("lay_flat"),
    )


def _read_target_faces() -> int:
    try:
        target_faces = int(float(request.form.get("target_faces", 0)))
    except ValueError:
        abort(400, "Invalid triangle budget")
    return max(0, target_faces)


@app.route("/api/preview", methods=["POST"])
def preview():
    try:
        image_bytes, threshold, invert, min_area_pct, simplify = _read_image_and_params()
        png_bytes = render_mask_preview(image_bytes, threshold, invert, min_area_pct, simplify)
    except ConversionError as e:
        abort(400, str(e))
    return send_file(io.BytesIO(png_bytes), mimetype="image/png")


@app.route("/api/mesh", methods=["POST"])
def mesh_preview():
    """Return the finished mesh as binary STL so the browser can 3D-preview it.

    The bytes are produced by the exact same path as /api/generate, so what the
    user orbits on screen is what they download.
    """
    image_bytes, threshold, invert, min_area_pct, simplify = _read_image_and_params()
    orientation = _read_orientation()
    target_faces = _read_target_faces()
    try:
        width_mm = float(request.form.get("width_mm", 100))
        thickness_mm = float(request.form.get("thickness_mm", 35))
    except ValueError:
        abort(400, "Invalid size")
    if width_mm <= 0 or thickness_mm <= 0:
        abort(400, "Width and thickness must be positive")

    try:
        polygons, px_width, _px_height = build_polygons_from_image(
            image_bytes, threshold, invert, min_area_pct, simplify
        )
        if not polygons:
            abort(400, "No shape could be detected in the image. Try adjusting the threshold.")
        mesh = build_mesh(
            polygons, px_width, width_mm, thickness_mm, orientation, target_faces
        )
        stl_bytes = mesh_to_stl_bytes(mesh)
    except ConversionError as e:
        abort(400, str(e))

    resp = send_file(io.BytesIO(stl_bytes), mimetype="model/stl")
    resp.headers["X-Triangle-Count"] = str(len(mesh.faces))
    resp.headers["X-Watertight"] = "1" if mesh.is_watertight else "0"
    # One extruded solid per traced polygon. Counting connected components on
    # the mesh itself (mesh.body_count) would drag in scipy for no extra
    # accuracy, since that is exactly how the bodies were built.
    resp.headers["X-Body-Count"] = str(len(polygons))
    size = mesh.extents
    resp.headers["X-Size-Mm"] = ",".join(f"{v:.2f}" for v in size)
    resp.headers["Access-Control-Expose-Headers"] = (
        "X-Triangle-Count, X-Watertight, X-Size-Mm, X-Body-Count"
    )
    return resp


@app.route("/api/generate", methods=["POST"])
def generate():
    image_bytes, threshold, invert, min_area_pct, simplify = _read_image_and_params()
    orientation = _read_orientation()
    target_faces = _read_target_faces()

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

            stl_bytes = mesh_to_stl_bytes(
                build_mesh(
                    polygons, px_width, width_mm, thickness_mm, orientation, target_faces
                )
            )
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
