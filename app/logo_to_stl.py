"""Convert a logo (PNG/JPG/SVG/etc.) into an extruded, correctly oriented STL mesh.

Pipeline:
  1. If the input is SVG, rasterize it at high resolution first.
  2. Build a binary silhouette mask from the image (alpha channel if present,
     otherwise by color distance from the auto-detected background color).
  3. Trace the mask into polygons (with holes) using OpenCV contours.
  4. Extrude each polygon along +Z so the model sits flat on the print bed
     (min Z == 0), with X/Y matching the image's footprint and Z the
     requested thickness.
  5. Reorient (reference convention + user mirror/rotate/lay-flat) and
     optionally decimate to a target triangle budget.
"""
from __future__ import annotations

import io
import re
from collections import defaultdict
from dataclasses import dataclass, field

import cv2
import numpy as np
import trimesh
from PIL import Image
from shapely.affinity import scale as shapely_scale
from shapely.geometry import Polygon
from shapely.geometry.polygon import orient


class ConversionError(Exception):
    """Raised when the image cannot be converted to a usable silhouette/mesh."""


# --------------------------------------------------------------------------
# SVG input
# --------------------------------------------------------------------------

# Rasterizing at a high fixed resolution keeps SVG edges crisp enough that the
# contour tracer reproduces vector-quality curves, while letting SVG reuse the
# exact same mask -> contour -> extrude pipeline as raster input (including
# transparency handling, which SVGs almost always have).
SVG_RASTER_PX = 2000


def is_svg(data: bytes) -> bool:
    head = data[:1024].lstrip()
    if head[:5].lower() == b"<?xml" or head[:4].lower() == b"<svg":
        return True
    return bool(re.search(rb"<svg[\s>]", data[:4096], re.IGNORECASE))


def rasterize_svg(data: bytes, target_px: int = SVG_RASTER_PX) -> bytes:
    """Render an SVG to PNG bytes, scaled so its longest side is target_px."""
    try:
        import cairosvg
    except Exception as exc:  # noqa: BLE001
        raise ConversionError(f"SVG support unavailable: {exc}") from exc

    try:
        # Two passes: the first learns the SVG's intrinsic aspect ratio so the
        # second can scale the longest side (not just width) to target_px.
        probe = cairosvg.svg2png(bytestring=data, output_width=512)
        with Image.open(io.BytesIO(probe)) as im:
            pw, ph = im.size
        if pw >= ph:
            png = cairosvg.svg2png(bytestring=data, output_width=target_px)
        else:
            png = cairosvg.svg2png(bytestring=data, output_height=target_px)
    except ConversionError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ConversionError(f"Could not render SVG: {exc}") from exc
    if not png:
        raise ConversionError("SVG rendered to an empty image.")
    return png


def normalize_input(data: bytes) -> bytes:
    """Return raster bytes for any supported input (SVG is rasterized)."""
    return rasterize_svg(data) if is_svg(data) else data


@dataclass
class _RawShape:
    exterior: np.ndarray
    holes: list = field(default_factory=list)


def _load_mask(image_bytes: bytes, threshold: float, invert: bool) -> np.ndarray:
    image_bytes = normalize_input(image_bytes)
    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    except Exception as exc:  # noqa: BLE001 - want a friendly message for any decode failure
        raise ConversionError(f"Could not read image: {exc}") from exc

    arr = np.array(img)
    rgb = arr[:, :, :3].astype(np.int16)
    alpha = arr[:, :, 3]

    if alpha.min() < 250:
        # Real transparency present: trust it.
        mask = alpha > 127
    else:
        # Opaque image: infer the background color from the four corners
        # and treat everything far enough from it as foreground.
        h, w = rgb.shape[:2]
        corner_px = np.stack([rgb[0, 0], rgb[0, w - 1], rgb[h - 1, 0], rgb[h - 1, w - 1]])
        bg = np.median(corner_px, axis=0)
        dist = np.sqrt(((rgb - bg) ** 2).sum(axis=2))
        mask = dist > threshold

    if invert:
        mask = ~mask

    # No morphological open/close here: even a 3x3 kernel severs thin
    # single-pixel line art (e.g. a rifle outline) that clean vector-style
    # logos rely on. Small speckle noise is filtered later by min_area_pct
    # in _mask_to_shapes instead, which doesn't erode real thin detail.
    return mask.astype(np.uint8) * 255


def _mask_to_shapes(mask_u8: np.ndarray, min_area_pct: float, simplify: float) -> list[_RawShape]:
    """Trace the mask into shapes, honoring arbitrary nesting depth.

    Artwork can nest more than one level deep - e.g. a solid shield with a
    cut-out maple leaf that itself contains a solid figure "island" sitting
    inside that cut-out. RETR_TREE gives the full parent/child hierarchy;
    contours at even depth are solid fills, odd depth are holes cut into
    their parent, and any children of a hole become independent solid
    shapes of their own (recursively).
    """
    h, w = mask_u8.shape
    min_area = max(4.0, min_area_pct / 100.0 * w * h)
    eps = max(simplify, 0.1)

    contours, hierarchy = cv2.findContours(mask_u8, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return []
    hierarchy = hierarchy[0]

    children = defaultdict(list)
    for idx, h_row in enumerate(hierarchy):
        parent = h_row[3]
        if parent != -1:
            children[parent].append(idx)

    depth_of: dict[int, int] = {}

    def depth(i: int) -> int:
        if i not in depth_of:
            parent = hierarchy[i][3]
            depth_of[i] = 0 if parent == -1 else depth(parent) + 1
        return depth_of[i]

    def simplify_contour(cnt) -> np.ndarray:
        approx = cv2.approxPolyDP(cnt, eps, True)
        return approx.reshape(-1, 2).astype(np.float64)

    shapes = []
    # Ascending depth order matters for the raster preview: a shield's solid
    # fill must be drawn (and its hole cut) before an island nested inside
    # that hole draws its own fill back on top.
    solid_indices = sorted((i for i in range(len(contours)) if depth(i) % 2 == 0), key=depth)
    for idx in solid_indices:
        if cv2.contourArea(contours[idx]) < min_area:
            continue
        ext = simplify_contour(contours[idx])
        if len(ext) < 3:
            continue
        holes = []
        for cidx in children.get(idx, []):
            if cv2.contourArea(contours[cidx]) < min_area:
                continue
            hole = simplify_contour(contours[cidx])
            if len(hole) >= 3:
                holes.append(hole)
        shapes.append(_RawShape(exterior=ext, holes=holes))
    return shapes


def _shapes_to_polygons(shapes: list[_RawShape], img_height: int) -> list[Polygon]:
    def to_model_space(pts: np.ndarray) -> np.ndarray:
        # Flip Y: image row 0 is the top, model +Y should be "up".
        out = pts.copy()
        out[:, 1] = img_height - out[:, 1]
        return out

    polygons: list[Polygon] = []
    for shape in shapes:
        ext = to_model_space(shape.exterior)
        holes = [to_model_space(hole) for hole in shape.holes]
        try:
            poly = Polygon(ext, holes)
            if not poly.is_valid:
                poly = poly.buffer(0)
        except Exception:  # noqa: BLE001 - skip malformed geometry rather than fail the whole image
            continue
        if poly.is_empty:
            continue
        if poly.geom_type == "MultiPolygon":
            polygons.extend(orient(p, sign=1.0) for p in poly.geoms if p.area > 0)
        elif poly.geom_type == "Polygon" and poly.area > 0:
            polygons.append(orient(poly, sign=1.0))
    return polygons


def build_polygons_from_image(
    image_bytes: bytes,
    threshold: float,
    invert: bool,
    min_area_pct: float,
    simplify: float,
) -> tuple[list[Polygon], float, float]:
    """Extract the logo silhouette as a list of shapely polygons.

    Returns (polygons, content_width, content_height) in pixel units, where
    content_width/height are the bounding box of the *detected artwork*
    (not the full canvas) so a requested output size maps to the visible
    logo rather than to any surrounding whitespace in the source image.
    """
    mask = _load_mask(image_bytes, threshold, invert)
    h, w = mask.shape
    shapes = _mask_to_shapes(mask, min_area_pct, simplify)
    polygons = _shapes_to_polygons(shapes, h)
    if not polygons:
        return polygons, float(w), float(h)
    min_x = min(p.bounds[0] for p in polygons)
    min_y = min(p.bounds[1] for p in polygons)
    max_x = max(p.bounds[2] for p in polygons)
    max_y = max(p.bounds[3] for p in polygons)
    return polygons, max_x - min_x, max_y - min_y


# extrude_polygon lays the shape out as (X, Y=footprint, Z=thickness). The
# reference STLs shipped with this project (0.stl/1.stl/2.stl) instead use
# Y as the thickness/extrusion axis, Z as "up" (vertical in the artwork),
# and have X mirrored relative to the source image. This matrix reproduces
# that exact convention: new_x=-x, new_y=z(thickness), new_z=y(vertical).
# Its determinant is +1 (a rotation, not a reflection), so face winding /
# normals stay correct without any extra flipping.
_REFERENCE_ORIENTATION = np.array(
    [
        [-1, 0, 0, 0],
        [0, 0, 1, 0],
        [0, 1, 0, 0],
        [0, 0, 0, 1],
    ],
    dtype=float,
)


def _extrude(polygons: list[Polygon], scale: float, thickness_mm: float) -> trimesh.Trimesh:
    meshes = []
    for poly in polygons:
        scaled_poly = shapely_scale(poly, xfact=scale, yfact=scale, origin=(0, 0))
        try:
            mesh = trimesh.creation.extrude_polygon(scaled_poly, height=thickness_mm)
        except Exception:  # noqa: BLE001 - skip shapes that fail to triangulate
            continue
        meshes.append(mesh)
    if not meshes:
        raise ConversionError("Failed to build a 3D mesh from the detected shapes.")
    return trimesh.util.concatenate(meshes)


@dataclass
class Orientation:
    """User-facing orientation tweaks, applied after the reference transform.

    In reference space the artwork lies in the X/Z plane (X = horizontal,
    Z = vertical) and Y is the extrusion/thickness axis, so:
      - mirror_h  flips the artwork left/right  -> negate X
      - mirror_v  flips the artwork up/down     -> negate Z
      - rotate    spins the artwork in its own plane -> rotate about Y
      - lay_flat  drops the model onto the bed so thickness runs along Z
    """

    mirror_h: bool = False
    mirror_v: bool = False
    rotate_deg: float = 0.0
    lay_flat: bool = False

    def matrix(self) -> np.ndarray:
        m = np.eye(4)
        if self.mirror_h:
            m = np.diag([-1.0, 1.0, 1.0, 1.0]) @ m
        if self.mirror_v:
            m = np.diag([1.0, 1.0, -1.0, 1.0]) @ m
        if self.rotate_deg:
            m = trimesh.transformations.rotation_matrix(
                np.radians(self.rotate_deg), [0, 1, 0]
            ) @ m
        if self.lay_flat:
            m = trimesh.transformations.rotation_matrix(np.radians(-90), [1, 0, 0]) @ m
        return m


DEFAULT_ORIENTATION = Orientation()


def _decimate(mesh: trimesh.Trimesh, target_faces: int) -> trimesh.Trimesh:
    """Reduce the mesh toward target_faces, leaving it alone if already smaller.

    fast_simplification is called directly rather than through
    trimesh.simplify_quadric_decimation, whose backend varies by trimesh
    version (4.x routes through open3d, which we don't ship).
    """
    if target_faces <= 0 or len(mesh.faces) <= target_faces:
        return mesh
    try:
        import fast_simplification
    except Exception as exc:  # noqa: BLE001
        raise ConversionError(f"Mesh decimation unavailable: {exc}") from exc

    # Extruded shapes are concatenated per-polygon, so coincident vertices must
    # be welded before the decimator can collapse edges across them.
    welded = mesh.copy()
    welded.merge_vertices()
    try:
        verts, faces = fast_simplification.simplify(
            np.asarray(welded.vertices, dtype=np.float32),
            np.asarray(welded.faces, dtype=np.int32),
            target_count=int(target_faces),
        )
    except Exception as exc:  # noqa: BLE001
        raise ConversionError(f"Could not reduce the mesh: {exc}") from exc

    # A decimator can collapse a thin-walled logo into nothing; keep the
    # original rather than hand back a degenerate model.
    if faces is None or len(faces) < 4:
        return mesh
    return trimesh.Trimesh(vertices=verts, faces=faces, process=False)


def build_mesh(
    polygons: list[Polygon],
    content_width_px: float,
    width_mm: float,
    thickness_mm: float,
    orientation: Orientation | None = None,
    target_faces: int = 0,
) -> trimesh.Trimesh:
    if not polygons:
        raise ConversionError("No shapes to extrude.")
    scale = width_mm / content_width_px
    mesh = _extrude(polygons, scale, thickness_mm)
    if target_faces:
        mesh = _decimate(mesh, target_faces)
    mesh.apply_transform(_REFERENCE_ORIENTATION)
    mesh.apply_transform((orientation or DEFAULT_ORIENTATION).matrix())
    # Centre the bounding box on the origin, regardless of extrude_polygon's
    # internal placement or the reorientation above. CAD tools mate the logo to
    # another body by its centre, so a min-corner-at-origin placement forces a
    # manual translate on every import.
    mesh.apply_translation(-mesh.bounds.mean(axis=0))
    return mesh


def mesh_to_stl_bytes(mesh: trimesh.Trimesh) -> bytes:
    buf = io.BytesIO()
    mesh.export(buf, file_type="stl")
    return buf.getvalue()


def polygons_to_stl_bytes(
    polygons: list[Polygon],
    content_width_px: float,
    width_mm: float,
    thickness_mm: float,
    orientation: Orientation | None = None,
    target_faces: int = 0,
) -> bytes:
    return mesh_to_stl_bytes(
        build_mesh(
            polygons, content_width_px, width_mm, thickness_mm, orientation, target_faces
        )
    )


def render_mask_preview(
    image_bytes: bytes,
    threshold: float,
    invert: bool,
    min_area_pct: float,
    simplify: float,
) -> bytes:
    """Render the extracted silhouette as a PNG for UI preview/tuning."""
    mask = _load_mask(image_bytes, threshold, invert)
    h, w = mask.shape
    shapes = _mask_to_shapes(mask, min_area_pct, simplify)

    fill = np.zeros((h, w), dtype=np.uint8)
    for shape in shapes:
        cv2.fillPoly(fill, [shape.exterior.astype(np.int32)], 255)
        if shape.holes:
            cv2.fillPoly(fill, [hole.astype(np.int32) for hole in shape.holes], 0)

    preview = np.full((h, w, 3), (24, 24, 26), dtype=np.uint8)
    preview[fill > 0] = (255, 176, 59)

    ok, buf = cv2.imencode(".png", cv2.cvtColor(preview, cv2.COLOR_RGB2BGR))
    if not ok:
        raise ConversionError("Failed to render preview image.")
    return buf.tobytes()
