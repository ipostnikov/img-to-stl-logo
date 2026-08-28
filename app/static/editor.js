// Lightweight raster editor for the input image: crop, erase-rectangle and
// erase-brush, with undo. Everything happens client-side; the edited PNG is
// what gets uploaded, so the silhouette pipeline never has to know about it.

// Working resolution cap. Bounds undo-history memory (each step is a full
// RGBA snapshot) while staying far above what the contour tracer needs.
const MAX_DIM = 1600;
const MAX_HISTORY = 10;

// Zoom limits. The floor keeps a large image from vanishing; the ceiling is
// well past one work-pixel-per-screen-pixel, which is what erasing a speck a
// few pixels across actually needs.
const MIN_SCALE = 0.05;
const MAX_SCALE = 32;
// Fitting stops here, so a tiny favicon-sized logo opens big but not absurd.
const MAX_FIT_SCALE = 4;
const FIT_MARGIN = 24;

function isSvgFile(file) {
  return /\.svg$/i.test(file?.name || "") || file?.type === "image/svg+xml";
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode that image"));
    };
    img.src = url;
  });
}

/** Median of the four corner pixels — the same background heuristic the
 *  Python side uses, so erasing on an opaque image blends into the
 *  background it will later be keyed out against. */
function cornerBackground(ctx, w, h) {
  const pick = (x, y) => ctx.getImageData(x, y, 1, 1).data;
  const corners = [pick(0, 0), pick(w - 1, 0), pick(0, h - 1), pick(w - 1, h - 1)];
  const channel = (i) => {
    const vals = corners.map((c) => c[i]).sort((a, b) => a - b);
    return Math.round((vals[1] + vals[2]) / 2);
  };
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

function hasTransparency(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true;
  }
  return false;
}

export function createEditor({ canvas, overlay, onChange, onView }) {
  // work: full-resolution pixels. The canvases cover the whole stage and show
  // that image through `view`, so zooming is a change of transform rather than
  // a change of canvas size.
  const work = document.createElement("canvas");
  let wctx = null;
  let history = [];
  let tool = "erase-brush";
  let brushSize = 40;
  let eraseStyle = "transparent";
  let drag = null;
  let painting = false;
  let panning = null;
  let spaceHeld = false;
  let originalFile = null;
  let dirty = false;
  // Where the pointer is, in CSS pixels, so the brush outline can be drawn at
  // the size the stroke will actually have at this zoom.
  let cursor = null;

  // work -> CSS pixels of the stage: x_css = x_work * scale + tx.
  const view = { scale: 1, tx: 0, ty: 0 };

  const ctx = canvas.getContext("2d");
  const octx = overlay.getContext("2d");

  function stage() {
    // Measure the stage, not the immediate parent: the canvases are absolutely
    // positioned inside it, so anything sized *by* them would be circular.
    return canvas.closest(".editor-stage") || canvas.parentElement;
  }

  function viewportSize() {
    const host = stage();
    return { w: Math.max(1, host.clientWidth), h: Math.max(1, host.clientHeight) };
  }

  /** Size the canvases to the stage, in device pixels for a crisp zoom. */
  function resizeCanvas() {
    const { w, h } = viewportSize();
    const dpr = window.devicePixelRatio || 1;
    for (const c of [canvas, overlay]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
  }

  function clampScale(s) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  }

  /** Frame the whole image in the stage. */
  function fitView() {
    const { w, h } = viewportSize();
    const scale = clampScale(
      Math.min(
        (w - FIT_MARGIN * 2) / work.width,
        (h - FIT_MARGIN * 2) / work.height,
        MAX_FIT_SCALE
      )
    );
    view.scale = scale;
    view.tx = (w - work.width * scale) / 2;
    view.ty = (h - work.height * scale) / 2;
    redraw();
  }

  /** Keep at least a corner of the image on screen, so it can't be lost. */
  function clampPan() {
    const { w, h } = viewportSize();
    const iw = work.width * view.scale;
    const ih = work.height * view.scale;
    const keep = 40;
    view.tx = Math.min(w - keep, Math.max(keep - iw, view.tx));
    view.ty = Math.min(h - keep, Math.max(keep - ih, view.ty));
  }

  /** Zoom about a point in CSS pixels, so whatever is under the pointer
   *  stays under the pointer. */
  function zoomAt(cssX, cssY, factor) {
    const next = clampScale(view.scale * factor);
    if (next === view.scale) return;
    const wx = (cssX - view.tx) / view.scale;
    const wy = (cssY - view.ty) / view.scale;
    view.scale = next;
    view.tx = cssX - wx * next;
    view.ty = cssY - wy * next;
    clampPan();
    redraw();
  }

  function zoomCentre(factor) {
    const { w, h } = viewportSize();
    zoomAt(w / 2, h / 2, factor);
  }

  function redraw() {
    if (!wctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = viewportSize();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Cleared rather than filled: the stage's own checkerboard shows through,
    // which is how a transparent logo reads as transparent.
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.tx, dpr * view.ty);
    // Past 1:1 the point of zooming is to see individual pixels, so stop the
    // browser smoothing them back together.
    ctx.imageSmoothingEnabled = view.scale < 1.5;
    ctx.drawImage(work, 0, 0);
    ctx.restore();

    // The image edge, so the artwork is distinguishable from the stage around it.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = "rgba(128,128,128,.5)";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      view.tx - 0.5,
      view.ty - 0.5,
      work.width * view.scale + 1,
      work.height * view.scale + 1
    );

    drawOverlay();
    onView?.(view.scale);
  }

  function drawOverlay() {
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = viewportSize();
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, w, h);

    if (drag) {
      const { x0, y0, x1, y1 } = drag;
      const rx = Math.min(x0, x1);
      const ry = Math.min(y0, y1);
      const rw = Math.abs(x1 - x0);
      const rh = Math.abs(y1 - y0);
      octx.setLineDash([6, 4]);
      octx.strokeStyle = "#ffb03b";
      octx.lineWidth = 1.5;
      octx.strokeRect(rx, ry, rw, rh);
      if (tool === "crop") {
        // Dim everything that the crop would discard.
        octx.setLineDash([]);
        octx.fillStyle = "rgba(0,0,0,0.45)";
        octx.beginPath();
        octx.rect(0, 0, w, h);
        octx.rect(rx, ry, rw, rh);
        octx.fill("evenodd");
      }
      return;
    }

    // The brush outline is drawn at its on-screen size, which is the only way
    // to judge a stroke once the view is zoomed.
    if (tool === "erase-brush" && cursor && !panning) {
      octx.setLineDash([]);
      octx.strokeStyle = "#ffb03b";
      octx.lineWidth = 1.5;
      octx.beginPath();
      octx.arc(cursor.x, cursor.y, Math.max(1.5, (brushSize / 2) * view.scale), 0, Math.PI * 2);
      octx.stroke();
    }
  }

  /** Event -> CSS pixels within the stage. */
  function toCss(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** Event -> work-space point, through the current view. */
  function toWork(e) {
    const { x, y } = toCss(e);
    return { x: (x - view.tx) / view.scale, y: (y - view.ty) / view.scale };
  }

  function pushHistory() {
    history.push(wctx.getImageData(0, 0, work.width, work.height));
    if (history.length > MAX_HISTORY) history.shift();
  }

  function eraseAt(pt, radius) {
    if (eraseStyle === "transparent") {
      wctx.save();
      wctx.globalCompositeOperation = "destination-out";
      wctx.fillStyle = "#000";
    } else {
      wctx.save();
      wctx.fillStyle = eraseStyle;
    }
    wctx.beginPath();
    wctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    wctx.fill();
    wctx.restore();
  }

  function eraseRect(x, y, w, h) {
    if (eraseStyle === "transparent") {
      wctx.clearRect(x, y, w, h);
    } else {
      wctx.fillStyle = eraseStyle;
      wctx.fillRect(x, y, w, h);
    }
  }

  function applyCrop(x, y, w, h) {
    const snapshot = document.createElement("canvas");
    snapshot.width = Math.max(1, Math.round(w));
    snapshot.height = Math.max(1, Math.round(h));
    snapshot
      .getContext("2d")
      .drawImage(work, x, y, w, h, 0, 0, snapshot.width, snapshot.height);
    work.width = snapshot.width;
    work.height = snapshot.height;
    wctx = work.getContext("2d", { willReadFrequently: true });
    wctx.clearRect(0, 0, work.width, work.height);
    wctx.drawImage(snapshot, 0, 0);
    // A crop changes the canvas size, so earlier snapshots no longer fit.
    history = [];
    fitView();
  }

  // --- pointer handling ---------------------------------------------------
  /** Middle button, space, or alt pans, whichever tool is selected — the
   *  alternative is a pan tool the user has to keep switching back out of. */
  function wantsPan(e) {
    return e.button === 1 || spaceHeld || e.altKey;
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (!wctx) return;
    canvas.setPointerCapture(e.pointerId);
    cursor = toCss(e);

    if (wantsPan(e)) {
      e.preventDefault();
      panning = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
      canvas.classList.add("is-panning");
      return;
    }

    const pt = toWork(e);
    if (tool === "erase-brush") {
      pushHistory();
      dirty = true;
      painting = true;
      eraseAt(pt, brushSize / 2);
      redraw();
    } else {
      const css = toCss(e);
      drag = { x0: css.x, y0: css.y, x1: css.x, y1: css.y, wx0: pt.x, wy0: pt.y, wx1: pt.x, wy1: pt.y };
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!wctx) return;
    cursor = toCss(e);

    if (panning) {
      view.tx = panning.tx + (e.clientX - panning.x);
      view.ty = panning.ty + (e.clientY - panning.y);
      clampPan();
      redraw();
      return;
    }
    if (painting) {
      eraseAt(toWork(e), brushSize / 2);
      redraw();
      return;
    }
    if (drag) {
      drag.x1 = cursor.x;
      drag.y1 = cursor.y;
      const pt = toWork(e);
      drag.wx1 = pt.x;
      drag.wy1 = pt.y;
    }
    drawOverlay();
  });

  canvas.addEventListener("pointerleave", () => {
    cursor = null;
    if (wctx) drawOverlay();
  });

  // Scroll to zoom about the pointer, the same gesture the 3D preview uses.
  // Trackpad pinch arrives as a ctrl-wheel and lands here too.
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!wctx) return;
      e.preventDefault();
      const { x, y } = toCss(e);
      zoomAt(x, y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    },
    { passive: false }
  );

  function finishDrag() {
    if (panning) {
      panning = null;
      canvas.classList.remove("is-panning");
      drawOverlay();
      return;
    }
    if (painting) {
      painting = false;
      onChange?.();
      return;
    }
    if (!drag) return;
    const x = Math.min(drag.wx0, drag.wx1);
    const y = Math.min(drag.wy0, drag.wy1);
    const w = Math.abs(drag.wx1 - drag.wx0);
    const h = Math.abs(drag.wy1 - drag.wy0);
    drag = null;
    // Ignore stray clicks that didn't actually sweep out an area.
    if (w < 3 || h < 3) {
      drawOverlay();
      return;
    }
    dirty = true;
    if (tool === "crop") {
      applyCrop(x, y, w, h);
    } else {
      pushHistory();
      eraseRect(x, y, w, h);
      redraw();
    }
    onChange?.();
  }

  canvas.addEventListener("pointerup", (e) => {
    canvas.releasePointerCapture(e.pointerId);
    finishDrag();
  });
  canvas.addEventListener("pointercancel", finishDrag);
  // Middle-click pastes on X11 and opens autoscroll on Windows; neither is
  // wanted on a canvas being panned.
  canvas.addEventListener("auxclick", (e) => {
    if (e.button === 1) e.preventDefault();
  });

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !spaceHeld) {
      spaceHeld = true;
      canvas.classList.add("can-pan");
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      spaceHeld = false;
      canvas.classList.remove("can-pan");
    }
  });
  window.addEventListener("blur", () => {
    spaceHeld = false;
    canvas.classList.remove("can-pan");
  });

  window.addEventListener("resize", () => {
    if (!wctx) return;
    resizeCanvas();
    clampPan();
    redraw();
  });

  return {
    async load(file) {
      originalFile = file;
      const img = await loadImageElement(file);
      // SVGs have no intrinsic pixel size worth trusting; render them large
      // so the traced outline stays crisp.
      let w = img.naturalWidth || MAX_DIM;
      let h = img.naturalHeight || MAX_DIM;
      if (isSvgFile(file)) {
        const ratio = w / h;
        if (ratio >= 1) {
          w = MAX_DIM;
          h = Math.round(MAX_DIM / ratio);
        } else {
          h = MAX_DIM;
          w = Math.round(MAX_DIM * ratio);
        }
      } else {
        const scale = Math.min(1, MAX_DIM / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
      }
      work.width = w;
      work.height = h;
      wctx = work.getContext("2d", { willReadFrequently: true });
      wctx.clearRect(0, 0, w, h);
      wctx.drawImage(img, 0, 0, w, h);
      history = [];
      // Erasing an already-transparent image should punch holes; erasing an
      // opaque one should paint the background color, or the Python side
      // would switch from color-keying to alpha-keying and select everything.
      eraseStyle = hasTransparency(wctx, w, h) ? "transparent" : cornerBackground(wctx, w, h);
      resizeCanvas();
      fitView();
    },
    /** The edited image as a PNG File, ready to upload. */
    toFile() {
      return new Promise((resolve) => {
        work.toBlob((blob) => {
          const name = (originalFile?.name || "logo").replace(/\.[^.]+$/, "") + "-edited.png";
          resolve(new File([blob], name, { type: "image/png" }));
        }, "image/png");
      });
    },
    setTool(next) {
      tool = next;
      drag = null;
      drawOverlay();
    },
    setBrushSize(px) {
      brushSize = px;
      drawOverlay();
    },
    /** Re-measure after the stage has been laid out (it has no size while the
     *  editor is closed). */
    refresh() {
      if (!wctx) return;
      resizeCanvas();
      fitView();
    },
    zoomIn() {
      zoomCentre(1.25);
    },
    zoomOut() {
      zoomCentre(1 / 1.25);
    },
    zoomFit() {
      fitView();
    },
    /** 1 = one work pixel per CSS pixel. */
    zoomActual() {
      const { w, h } = viewportSize();
      const cx = w / 2;
      const cy = h / 2;
      zoomAt(cx, cy, 1 / view.scale);
    },
    getZoom() {
      return view.scale;
    },
    undo() {
      const prev = history.pop();
      if (!prev) return false;
      const resized = prev.width !== work.width || prev.height !== work.height;
      work.width = prev.width;
      work.height = prev.height;
      wctx = work.getContext("2d", { willReadFrequently: true });
      wctx.putImageData(prev, 0, 0);
      // Undoing a plain erase must not throw away the zoom the user is working
      // at; only a change of image size forces a re-frame.
      if (resized) fitView();
      else redraw();
      onChange?.();
      return true;
    },
    async reset() {
      if (!originalFile) return;
      await this.load(originalFile);
      onChange?.();
    },
    canUndo() {
      return history.length > 0;
    },
    /** False until the user actually alters the image - callers can then keep
     *  uploading the pristine original (notably an SVG, which the server
     *  rasterizes at a higher resolution than this editor works at). */
    isDirty() {
      return dirty;
    },
    /** True once the user has actually altered the image. */
    isReady() {
      return wctx !== null;
    },
  };
}
