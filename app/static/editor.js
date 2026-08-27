// Lightweight raster editor for the input image: crop, erase-rectangle and
// erase-brush, with undo. Everything happens client-side; the edited PNG is
// what gets uploaded, so the silhouette pipeline never has to know about it.

// Working resolution cap. Bounds undo-history memory (each step is a full
// RGBA snapshot) while staying far above what the contour tracer needs.
const MAX_DIM = 1600;
const MAX_HISTORY = 10;

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

export function createEditor({ canvas, overlay, onChange }) {
  // work: full-resolution pixels. canvas: what the user sees/interacts with.
  const work = document.createElement("canvas");
  let wctx = null;
  let history = [];
  let tool = "erase-brush";
  let brushSize = 40;
  let eraseStyle = "transparent";
  let drag = null;
  let painting = false;
  let originalFile = null;
  let dirty = false;

  const ctx = canvas.getContext("2d");
  const octx = overlay.getContext("2d");

  // Tallest the editor is allowed to get on screen, so a portrait logo can't
  // push the rest of the form off the page.
  const MAX_DISPLAY_H = 420;

  function fitDisplay() {
    // Measure the <details>, not the immediate parent: the stage is an
    // inline-block sized *by* the canvas, so measuring it would be circular
    // and collapse the editor to a sliver.
    const host = canvas.closest("details") || canvas.parentElement;
    const avail = Math.max(120, host.clientWidth - 24);
    const scale = Math.min(avail / work.width, MAX_DISPLAY_H / work.height, 1);
    const w = Math.max(1, Math.round(work.width * scale));
    const h = Math.max(1, Math.round(work.height * scale));
    for (const c of [canvas, overlay]) {
      c.width = w;
      c.height = h;
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    redraw();
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(work, 0, 0, canvas.width, canvas.height);
    drawOverlay();
  }

  function drawOverlay() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (!drag) return;
    const { x0, y0, x1, y1 } = drag;
    octx.setLineDash([6, 4]);
    octx.strokeStyle = "#ffb03b";
    octx.lineWidth = 1.5;
    octx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    if (tool === "crop") {
      // Dim everything that the crop would discard.
      octx.fillStyle = "rgba(0,0,0,0.45)";
      octx.beginPath();
      octx.rect(0, 0, overlay.width, overlay.height);
      octx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      octx.fill("evenodd");
    }
  }

  /** Display-space point -> work-space point. */
  function toWork(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = work.width / rect.width;
    const sy = work.height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
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
    fitDisplay();
  }

  // --- pointer handling ---------------------------------------------------
  canvas.addEventListener("pointerdown", (e) => {
    if (!wctx) return;
    canvas.setPointerCapture(e.pointerId);
    const pt = toWork(e);
    if (tool === "erase-brush") {
      pushHistory();
      dirty = true;
      painting = true;
      eraseAt(pt, brushSize / 2);
      redraw();
    } else {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      drag = { x0: x, y0: y, x1: x, y1: y, wx0: pt.x, wy0: pt.y, wx1: pt.x, wy1: pt.y };
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!wctx) return;
    if (painting) {
      eraseAt(toWork(e), brushSize / 2);
      redraw();
      return;
    }
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    drag.x1 = e.clientX - rect.left;
    drag.y1 = e.clientY - rect.top;
    const pt = toWork(e);
    drag.wx1 = pt.x;
    drag.wy1 = pt.y;
    drawOverlay();
  });

  function finishDrag() {
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
  window.addEventListener("resize", () => {
    if (wctx) fitDisplay();
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
      fitDisplay();
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
    },
    undo() {
      const prev = history.pop();
      if (!prev) return false;
      work.width = prev.width;
      work.height = prev.height;
      wctx = work.getContext("2d", { willReadFrequently: true });
      wctx.putImageData(prev, 0, 0);
      fitDisplay();
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
