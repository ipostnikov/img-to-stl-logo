"""Convert a raster logo (PNG/JPG/etc.) into an extruded, correctly oriented STL mesh.

Pipeline:
  1. Build a binary silhouette mask from the image (alpha channel if present,
     otherwise by color distance from the auto-detected background color).
  2. Trace the mask into polygons (with holes) using OpenCV contours.
  3. Extrude each polygon along +Z so the model sits flat on the print bed
     (min Z == 0), with X/Y matching the image's footprint and Z the
     requested thickness.
"""
from __future__ import annotations

import io
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


@dataclass
class _RawShape:
    exterior: np.ndarray
    holes: list = field(default_factory=list)


def _load_mask(image_bytes: bytes, threshold: float, invert: bool) -> np.ndarray:
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

    mask_u8 = mask.astype(np.uint8) * 255
    kernel = np.ones((3, 3), np.uint8)
    mask_u8 = cv2.morphologyEx(mask_u8, cv2.MORPH_OPEN, kernel)
    mask_u8 = cv2.morphologyEx(mask_u8, cv2.MORPH_CLOSE, kernel)
    return mask_u8


def _mask_to_shapes(mask_u8: np.ndarray, min_area_pct: float, simplify: float) -> list[_RawShape]:
    h, w = mask_u8.shape
    min_area = max(4.0, min_area_pct / 100.0 * w * h)
    eps = max(simplify, 0.1)

    contours, hierarchy = cv2.findContours(mask_u8, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return []
    hierarchy = hierarchy[0]

    children = defaultdict(list)
    for idx, h_row in enumerate(hierarchy):
        parent = h_row[3]
        if parent != -1:
            children[parent].append(idx)

    def simplify_contour(cnt) -> np.ndarray:
        approx = cv2.approxPolyDP(cnt, eps, True)
        return approx.reshape(-1, 2).astype(np.float64)

    shapes = []
    for idx, h_row in enumerate(hierarchy):
        if h_row[3] != -1:
            continue  # only start from top-level (outer) contours
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


def polygons_to_stl_bytes(
    polygons: list[Polygon],
    content_width_px: float,
    width_mm: float,
    thickness_mm: float,
) -> bytes:
    if not polygons:
        raise ConversionError("No shapes to extrude.")
    scale = width_mm / content_width_px
    mesh = _extrude(polygons, scale, thickness_mm)
    # Sit flush at the origin: flat on the print bed (min Z == 0) and with
    # min X/Y == 0, regardless of extrude_polygon's internal placement.
    mesh.apply_translation(-mesh.bounds[0])
    buf = io.BytesIO()
    mesh.export(buf, file_type="stl")
    return buf.getvalue()


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
