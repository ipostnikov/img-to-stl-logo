import { createViewer } from "./viewer.js";
import { createEditor } from "./editor.js";

(() => {
  const $ = (id) => document.getElementById(id);

  const imageInput = $("image-input");
  const dropzone = $("dropzone");
  const centreBody = $("centre-body");
  const fileNameEl = $("file-name");
  const replaceBtn = $("replace-btn");
  const originalPreview = $("original-preview");
  const originalDims = $("original-dims");
  const maskPreview = $("mask-preview");
  const maskMeta = $("mask-meta");

  const rail = $("rail");
  const thresholdInput = $("threshold");
  const thresholdValue = $("threshold-value");
  const invertInput = $("invert");
  const simplifyInput = $("simplify");
  const simplifyValue = $("simplify-value");
  const minAreaInput = $("min-area");
  const minAreaValue = $("min-area-value");
  const advancedToggle = $("advanced-toggle");
  const advancedFields = $("advanced-fields");

  const sizesBody = $("sizes-body");
  const sizeCount = $("size-count");
  const addSizeBtn = $("add-size-btn");
  const presetButtons = document.querySelectorAll(".preset-btn");

  const mirrorHBtn = $("mirror-h");
  const mirrorVBtn = $("mirror-v");
  const rotateGroup = $("rotate");
  const layFlatInput = $("lay-flat");
  const trianglesInput = $("triangles");
  const trianglesValue = $("triangles-value");

  const viewerCanvas = $("viewer-canvas");
  const viewerEmpty = $("viewer-empty");
  const wireframeBtn = $("wireframe-btn");
  const refreshPreviewBtn = $("refresh-preview-btn");
  const resetViewBtn = $("reset-view-btn");
  const downloadPreviewBtn = $("download-preview-btn");
  const statsbar = $("statsbar");
  const statSizeLabel = $("stat-size-label");
  const statTris = $("stat-tris");
  const statDims = $("stat-dims");
  const statParts = $("stat-parts");
  const statWatertight = $("stat-watertight");
  const meshError = $("mesh-error");
  const meshErrorText = $("mesh-error-text");

  const editImageBtn = $("edit-image-btn");
  const editorBar = $("editor-bar");
  const editorStage = $("editor-stage");
  const editorCanvas = $("editor-canvas");
  const editorOverlay = $("editor-overlay");
  const editorUndo = $("editor-undo");
  const editorReset = $("editor-reset");
  const editorDone = $("editor-done");
  const brushField = $("brush-field");
  const brushSizeInput = $("brush-size");
  const brushSizeValue = $("brush-size-value");
  const zoomValue = $("zoom-value");
  const toolButtons = document.querySelectorAll("#tool-group .seg");

  const generateButtons = [$("generate-btn"), $("generate-btn-2")];
  const statusEl = $("status");

  let currentFile = null;
  let previewDebounce = null;
  let meshDebounce = null;
  // Triangle count of the undecimated mesh, learned from the most recent
  // full-detail preview; the budget slider is a percentage of it.
  let fullTriangleCount = 0;
  let meshRequestId = 0;
  let meshAbort = null;
  // The camera is only re-framed for a genuinely new model; tweaking the
  // triangle budget or orientation must leave the user's zoom exactly where
  // they put it so they can compare meshes at the same magnification.
  let needsViewReset = true;
  let lastMeshBlob = null;
  let lastMeshName = "preview.stl";
  // The size row the 3D viewport is currently showing.
  let previewedRow = null;

  // --- theme ---------------------------------------------------------------
  // One stylesheet, one [data-theme] attribute; the 3D viewport is the only
  // surface that stays put across the switch.
  function setTheme(name) {
    document.documentElement.dataset.theme = name;
    try {
      localStorage.setItem("theme", name);
    } catch { /* private mode: this session only */ }
    document
      .querySelectorAll("[data-theme-set]")
      .forEach((btn) => btn.classList.toggle("is-active", btn.dataset.themeSet === name));
  }
  document.querySelectorAll("[data-theme-set]").forEach((btn) => {
    btn.addEventListener("click", () => setTheme(btn.dataset.themeSet));
  });
  setTheme(document.documentElement.dataset.theme || "light");

  // Keep every slider's filled portion in step with its value.
  function paintRange(el) {
    const min = Number(el.min || 0);
    const max = Number(el.max || 100);
    const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
    el.style.setProperty("--fill", `${pct}%`);
  }
  document.querySelectorAll('input[type="range"]').forEach((el) => {
    paintRange(el);
    el.addEventListener("input", () => paintRange(el));
  });

  const viewer = createViewer(viewerCanvas);
  // Exposed for the browser test to inspect orbit state.
  window.__viewer = viewer;
  const editor = createEditor({
    canvas: editorCanvas,
    overlay: editorOverlay,
    onView: (scale) => {
      zoomValue.textContent = `${Math.round(scale * 100)}%`;
    },
    onChange: () => {
      // Edits invalidate the triangle baseline and change the silhouette.
      fullTriangleCount = 0;
      updateTriangleLabel();
      editorUndo.disabled = !editor.canUndo();
      schedulePreview();
    },
  });

  /** The bytes to upload: the edited image once the user has touched it,
   *  otherwise the pristine original (which keeps SVGs vector-sharp, since
   *  the server rasterizes them at a higher resolution than the editor). */
  async function uploadFile() {
    if (editor.isReady() && editor.isDirty()) return editor.toFile();
    return currentFile;
  }

  // Content hash of the image the server most recently accepted. Sending just
  // the id turns a slider drag into a few hundred bytes per request instead of
  // a full re-upload of the image.
  let cachedImageId = null;

  async function hashFile(file) {
    // crypto.subtle only exists in a secure context; over plain http on a LAN
    // address it is undefined, so fall back to always uploading the bytes.
    if (!window.crypto?.subtle) return null;
    try {
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      return null;
    }
  }

  /** POST `form`, attaching the image only when the server can already reuse it. */
  async function postWithImage(url, form, options = {}) {
    const file = await uploadFile();
    const id = await hashFile(file);
    if (id && id === cachedImageId) {
      form.append("image_id", id);
    } else {
      form.append("image", file);
    }

    let res = await fetch(url, { method: "POST", body: form, ...options });
    if (res.status === 409) {
      // The server dropped that image (restart, eviction, or the request
      // landed on the other worker): resend it in full, exactly once.
      const retry = new FormData();
      for (const [key, value] of form.entries()) {
        if (key !== "image_id") retry.append(key, value);
      }
      retry.append("image", file);
      res = await fetch(url, { method: "POST", body: retry, ...options });
    }
    if (res.ok && id) cachedImageId = id;
    return res;
  }

  // These logos go on earmoulds and hearing-aid shells, so the artwork is only
  // a few mm across: the hand-made reference logos span 4.7-10.2 mm in-plane.
  // Thickness is the depth of the prism that gets booleaned into the shell, not
  // the final emboss height, so it is deliberately generous - a 5 mm logo at
  // 10 mm deep is the size that has been used successfully in CAD.
  const PRESETS = {
    small: { label: "small", width_mm: 5, thickness_mm: 10 },
    medium: { label: "medium", width_mm: 7.5, thickness_mm: 10 },
    large: { label: "large", width_mm: 10, thickness_mm: 10 },
  };

  // --- size table ----------------------------------------------------------
  function addSizeRow(preset = {}) {
    const row = document.createElement("div");
    row.className = "size-row size-item";

    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.value = preset.label ?? `size-${sizesBody.children.length + 1}`;

    const widthInput = document.createElement("input");
    widthInput.type = "number";
    widthInput.className = "num";
    widthInput.min = "0.1";
    widthInput.step = "any";
    widthInput.value = (preset.width_mm ?? 5).toFixed(1);

    const thicknessInput = document.createElement("input");
    thicknessInput.type = "number";
    thicknessInput.className = "num";
    thicknessInput.min = "0.1";
    thicknessInput.step = "any";
    thicknessInput.value = (preset.thickness_mm ?? 10).toFixed(1);
    for (const input of [widthInput, thicknessInput]) {
      input.addEventListener("change", () => {
        const n = parseFloat(input.value);
        if (Number.isFinite(n)) input.value = n.toFixed(1);
      });
    }

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-row-btn";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove size";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasPreviewed = row === previewedRow;
      row.remove();
      if (wasPreviewed) {
        previewedRow = null;
        selectRow(sizesBody.firstElementChild);
      }
      updateSizeCount();
    });

    // Rows are click-to-preview: the 3D view follows the row you point at,
    // rather than always showing whichever size happens to be first.
    row.addEventListener("click", (e) => {
      if (e.target.tagName === "INPUT") return;
      selectRow(row);
    });

    row.append(labelInput, widthInput, thicknessInput, removeBtn);
    sizesBody.appendChild(row);
    updateSizeCount();
    if (!previewedRow) selectRow(row);
    return row;
  }

  function selectRow(row) {
    if (!row) {
      previewedRow = null;
      return;
    }
    if (previewedRow === row) return;
    previewedRow = row;
    for (const r of sizesBody.children) r.classList.toggle("is-previewed", r === row);
    scheduleMeshPreview();
  }

  function updateSizeCount() {
    const n = sizesBody.children.length;
    sizeCount.textContent = `${n} file${n === 1 ? "" : "s"}`;
  }

  function readRow(row) {
    const [labelInput, widthInput, thicknessInput] = row.querySelectorAll("input");
    const width_mm = parseFloat(widthInput.value);
    const thickness_mm = parseFloat(thicknessInput.value);
    if (!Number.isFinite(width_mm) || !Number.isFinite(thickness_mm)) return null;
    return { label: labelInput.value.trim() || "logo", width_mm, thickness_mm };
  }

  function collectSizes() {
    return [...sizesBody.children].map(readRow).filter(Boolean);
  }

  /** The size the 3D viewport is previewing. */
  function previewSize() {
    const row = previewedRow ?? sizesBody.firstElementChild;
    return row ? readRow(row) : null;
  }

  sizesBody.addEventListener("input", (e) => {
    // Editing a row's numbers implicitly makes it the one being judged.
    const row = e.target.closest(".size-item");
    if (row) selectRow(row);
    scheduleMeshPreview();
  });

  addSizeBtn.addEventListener("click", () => selectRow(addSizeRow()));
  presetButtons.forEach((btn) => {
    // Presets append rather than replace, so "all three" stays two clicks away.
    btn.addEventListener("click", () => addSizeRow(PRESETS[btn.dataset.preset]));
  });

  // Seed with the small/medium/large presets by default.
  addSizeRow(PRESETS.small);
  addSizeRow(PRESETS.medium);
  addSizeRow(PRESETS.large);

  // --- rail controls -------------------------------------------------------
  advancedToggle.addEventListener("click", () => {
    const open = advancedFields.hidden;
    advancedFields.hidden = !open;
    advancedToggle.textContent = open ? "Advanced ▾" : "Advanced ▸";
    advancedToggle.setAttribute("aria-expanded", String(open));
  });

  function bindRangeDisplay(input, display, digits = 0, suffix = "") {
    input.addEventListener("input", () => {
      display.textContent = Number(input.value).toFixed(digits) + suffix;
      schedulePreview();
    });
  }
  bindRangeDisplay(thresholdInput, thresholdValue, 0);
  bindRangeDisplay(simplifyInput, simplifyValue, 1);
  bindRangeDisplay(minAreaInput, minAreaValue, 2, "%");
  invertInput.addEventListener("change", schedulePreview);

  function bindToggleButton(btn) {
    btn.addEventListener("click", () => {
      btn.setAttribute("aria-pressed", btn.getAttribute("aria-pressed") === "true" ? "false" : "true");
      scheduleMeshPreview();
    });
  }
  bindToggleButton(mirrorHBtn);
  bindToggleButton(mirrorVBtn);
  const isPressed = (btn) => btn.getAttribute("aria-pressed") === "true";

  let rotateDeg = 0;
  rotateGroup.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg");
    if (!btn) return;
    rotateDeg = Number(btn.dataset.rotate);
    for (const b of rotateGroup.children) b.classList.toggle("is-active", b === btn);
    scheduleMeshPreview();
  });

  layFlatInput.addEventListener("change", scheduleMeshPreview);
  trianglesInput.addEventListener("input", () => {
    updateTriangleLabel();
    scheduleMeshPreview();
  });

  wireframeBtn.addEventListener("click", () => {
    const on = !isPressed(wireframeBtn);
    wireframeBtn.setAttribute("aria-pressed", String(on));
    viewer.setWireframe(on);
  });
  refreshPreviewBtn.addEventListener("click", runMeshPreview);
  resetViewBtn.addEventListener("click", () => viewer.resetView());
  downloadPreviewBtn.addEventListener("click", () => {
    if (lastMeshBlob) downloadBlob(lastMeshBlob, lastMeshName);
  });
  updateTriangleLabel();

  // --- image editor -------------------------------------------------------
  function setEditing(on) {
    editorBar.hidden = !on;
    editorStage.hidden = !on;
    centreBody.classList.toggle("is-editing", on);
    if (on) {
      // The stage has no size until it is actually laid out, so the view can
      // only be framed once the browser has done that.
      requestAnimationFrame(() => editor.refresh());
    }
  }
  editImageBtn.addEventListener("click", () => setEditing(true));
  editorDone.addEventListener("click", () => setEditing(false));

  toolButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      toolButtons.forEach((b) => b.classList.toggle("is-active", b === btn));
      editor.setTool(btn.dataset.tool);
      // Brush size only means anything while the brush is the active tool.
      brushField.hidden = btn.dataset.tool !== "erase-brush";
    });
  });
  brushSizeInput.addEventListener("input", () => {
    brushSizeValue.textContent = `${brushSizeInput.value}px`;
    editor.setBrushSize(Number(brushSizeInput.value));
  });
  brushSizeValue.textContent = `${brushSizeInput.value}px`;
  editor.setBrushSize(Number(brushSizeInput.value));
  $("zoom-in").addEventListener("click", () => editor.zoomIn());
  $("zoom-out").addEventListener("click", () => editor.zoomOut());
  $("zoom-actual").addEventListener("click", () => editor.zoomActual());
  $("zoom-fit").addEventListener("click", () => editor.zoomFit());

  // Keyboard zoom, but only while the editor is up and nothing is being typed.
  document.addEventListener("keydown", (e) => {
    if (editorBar.hidden || e.ctrlKey || e.metaKey || isEditableTarget(e.target)) return;
    if (e.key === "+" || e.key === "=") editor.zoomIn();
    else if (e.key === "-" || e.key === "_") editor.zoomOut();
    else if (e.key === "0") editor.zoomFit();
    else if (e.key === "1") editor.zoomActual();
    else return;
    e.preventDefault();
  });

  editorUndo.addEventListener("click", () => editor.undo());
  editorReset.addEventListener("click", () => editor.reset());

  // --- file intake ---------------------------------------------------------
  function setDropzoneFile(file) {
    const isSvg = /\.svg$/i.test(file?.name || "") || file?.type === "image/svg+xml";
    if (!file || (!file.type.startsWith("image/") && !isSvg)) {
      setStatus("Please choose a PNG, JPG, or SVG file.", true);
      return;
    }
    currentFile = file;
    // Triangle counts are per-artwork; forget the previous model's baseline.
    fullTriangleCount = 0;
    updateTriangleLabel();
    // A different logo deserves a freshly framed camera.
    needsViewReset = true;
    setEditing(false);

    fileNameEl.textContent = file.name;
    fileNameEl.classList.add("has-file");
    replaceBtn.hidden = false;
    editImageBtn.hidden = false;
    rail.classList.remove("is-idle");
    centreBody.classList.remove("is-empty");
    originalPreview.src = URL.createObjectURL(file);
    originalPreview.onload = () => {
      const dims = originalPreview.naturalWidth
        ? `${originalPreview.naturalWidth}×${originalPreview.naturalHeight}`
        : "";
      originalDims.textContent = dims;
      $("stage-note").textContent = dims ? `canvas stage · ${dims} source px` : "canvas stage";
    };
    generateButtons.forEach((b) => (b.disabled = false));
    editor
      .load(file)
      .then(() => {
        editorUndo.disabled = !editor.canUndo();
        schedulePreview();
      })
      .catch((err) => setStatus(`Could not open the image editor: ${err.message}`, true));
    schedulePreview();
  }

  imageInput.addEventListener("change", () => setDropzoneFile(imageInput.files[0]));
  replaceBtn.addEventListener("click", () => imageInput.click());

  // Once the previews are up the dropzone is gone, so the whole centre column
  // is the drop target.
  const dropTarget = $("centre");
  ["dragenter", "dragover"].forEach((evt) =>
    dropTarget.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropTarget.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    })
  );
  dropTarget.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) setDropzoneFile(file);
  });

  function isEditableTarget(el) {
    return (
      el &&
      (el.isContentEditable ||
        el.tagName === "TEXTAREA" ||
        (el.tagName === "INPUT" && !["range", "checkbox", "file"].includes(el.type)))
    );
  }

  // Clipboard images arrive as nameless blobs; give them a name so the header
  // label and the STL's Content-Disposition filename stay meaningful.
  function nameForPastedBlob(blob) {
    const ext = { "image/svg+xml": "svg", "image/jpeg": "jpg" }[blob.type] || "png";
    return `pasted-image.${ext}`;
  }

  document.addEventListener("paste", (e) => {
    const data = e.clipboardData;
    if (!data) return;

    const blob = Array.from(data.items || [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .find((f) => f && (f.type.startsWith("image/") || /\.svg$/i.test(f.name || "")));
    if (blob) {
      e.preventDefault();
      const named =
        blob.name && blob.name !== "image.png"
          ? blob
          : new File([blob], nameForPastedBlob(blob), { type: blob.type });
      setDropzoneFile(named);
      setStatus(`Pasted ${named.name}.`);
      return;
    }

    // Copying from a vector editor (or a text editor) often yields SVG markup
    // as plain text rather than a file.
    if (isEditableTarget(e.target)) return;
    const text = (data.getData("text/plain") || "").trim();
    if (!/^(<\?xml[\s\S]*?\?>\s*|<!DOCTYPE[\s\S]*?>\s*)*<svg[\s>]/i.test(text)) return;
    e.preventDefault();
    setDropzoneFile(new File([text], "pasted-image.svg", { type: "image/svg+xml" }));
    setStatus("Pasted SVG markup.");
  });

  // --- requests ------------------------------------------------------------
  function currentParams() {
    const form = new FormData();
    form.append("threshold", thresholdInput.value);
    form.append("invert", invertInput.checked ? "true" : "false");
    form.append("simplify", simplifyInput.value);
    form.append("min_area_pct", minAreaInput.value);
    form.append("mirror_h", isPressed(mirrorHBtn) ? "true" : "false");
    form.append("mirror_v", isPressed(mirrorVBtn) ? "true" : "false");
    form.append("rotate_deg", String(rotateDeg));
    form.append("lay_flat", layFlatInput.checked ? "true" : "false");
    form.append("target_faces", String(targetFaces()));
    return form;
  }

  /** 0 = no decimation; otherwise a percentage of the full-detail triangle count. */
  function targetFaces() {
    const pct = Number(trianglesInput.value);
    if (!pct || !fullTriangleCount) return 0;
    return Math.max(64, Math.round((pct / 100) * fullTriangleCount));
  }

  function updateTriangleLabel() {
    const pct = Number(trianglesInput.value);
    if (!pct) {
      trianglesValue.textContent = "auto";
    } else if (fullTriangleCount) {
      trianglesValue.textContent = `${pct}% · ${targetFaces().toLocaleString()}`;
    } else {
      trianglesValue.textContent = `${pct}%`;
    }
  }

  function schedulePreview() {
    if (!currentFile) return;
    clearTimeout(previewDebounce);
    previewDebounce = setTimeout(runPreview, 250);
    scheduleMeshPreview();
  }

  function scheduleMeshPreview() {
    if (!currentFile) return;
    clearTimeout(meshDebounce);
    meshDebounce = setTimeout(runMeshPreview, 450);
  }

  function showMeshError(msg) {
    meshErrorText.textContent = msg;
    meshError.hidden = !msg;
  }

  async function runMeshPreview() {
    if (!currentFile) return;
    const size = previewSize();
    if (!size) {
      setStatus("Add at least one size to preview.", true);
      return;
    }
    const form = currentParams();
    form.append("width_mm", String(size.width_mm));
    form.append("thickness_mm", String(size.thickness_mm));
    // What this particular request asked for; a 0 means the response is the
    // full-detail mesh and can therefore re-establish the budget baseline.
    const requestedFaces = targetFaces();

    const requestId = ++meshRequestId;
    // Drop any still-running preview: only the newest settings matter.
    meshAbort?.abort();
    meshAbort = new AbortController();
    const signal = meshAbort.signal;
    setStatus("Building 3D preview…");
    try {
      const res = await postWithImage("/api/mesh", form, { signal });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      const buffer = await res.arrayBuffer();
      // A slower earlier request must not overwrite a newer preview.
      if (requestId !== meshRequestId) return;

      const triangles = viewer.load(buffer, {
        showWireframe: isPressed(wireframeBtn),
        resetView: needsViewReset,
      });
      needsViewReset = false;
      viewerEmpty.hidden = true;
      lastMeshBlob = new Blob([buffer], { type: "model/stl" });
      lastMeshName = `${size.label || "logo"}_${size.width_mm}mm_x_${size.thickness_mm}mm.stl`;
      if (!requestedFaces) {
        const relearned = !fullTriangleCount;
        fullTriangleCount = triangles;
        updateTriangleLabel();
        // The baseline is cleared whenever the artwork changes. If the budget
        // slider is engaged, it had nothing to compute against a moment ago -
        // now that it does, re-render so the budget is actually applied.
        if (relearned && targetFaces()) {
          scheduleMeshPreview();
          return;
        }
      }

      const dims = res.headers.get("X-Size-Mm");
      const watertight = res.headers.get("X-Watertight") === "1";
      const bodies = Number(res.headers.get("X-Body-Count") || 1);

      statsbar.hidden = false;
      statSizeLabel.textContent =
        `${size.label} · ${size.width_mm.toFixed(1)} × ${size.thickness_mm.toFixed(1)} mm`;
      statTris.textContent = triangles.toLocaleString();
      // Always two decimals so the columns do not jitter under a dragging slider.
      statDims.textContent = dims
        ? `${dims.split(",").map((v) => Number(v).toFixed(2)).join(" × ")} mm`
        : "—";
      statParts.textContent = String(bodies);
      statWatertight.textContent = watertight ? "yes" : "NO";
      statWatertight.className = `stat-val ${watertight ? "ok" : "bad"}`;
      maskMeta.textContent = bodies > 1 ? `${bodies} parts` : "1 part";

      // A mesh that is not watertight will fail the boolean cut in CAD, so it
      // is called out on the canvas as well as in the status line, and the
      // download is withheld.
      showMeshError(
        watertight
          ? ""
          : "Not watertight — the mesh has open edges. This will fail the boolean cut in CAD."
      );
      downloadPreviewBtn.disabled = !watertight;
      setStatus(
        watertight
          ? `Ready · ${sizesBody.children.length} size${sizesBody.children.length === 1 ? "" : "s"} queued`
          : "Not watertight. Lower Triangle budget or raise Ignore specks, then retry.",
        !watertight
      );
    } catch (err) {
      if (err.name === "AbortError") return;
      if (requestId === meshRequestId) setStatus(`3D preview failed: ${err.message}`, true);
    }
  }

  async function runPreview() {
    if (!currentFile) return;
    const form = currentParams();
    try {
      const res = await postWithImage("/api/preview", form);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      maskPreview.src = URL.createObjectURL(blob);
    } catch (err) {
      setStatus(`Preview failed: ${err.message}`, true);
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function setStatus(msg, isError = false) {
    statusEl.textContent = msg;
    statusEl.classList.toggle("is-error", Boolean(msg) && isError);
  }

  generateButtons.forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!currentFile) return;
      const sizes = collectSizes();
      if (sizes.length === 0) {
        setStatus("Add at least one size first.", true);
        return;
      }

      const form = currentParams();
      form.append("sizes", JSON.stringify(sizes));

      generateButtons.forEach((b) => (b.disabled = true));
      setStatus("Generating STL…");
      try {
        const res = await postWithImage("/api/generate", form);
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `HTTP ${res.status}`);
        }
        const blob = await res.blob();
        const disposition = res.headers.get("Content-Disposition") || "";
        const match = disposition.match(/filename="?([^"]+)"?/);
        const filename = match ? match[1] : "logo.stl";

        downloadBlob(blob, filename);
        setStatus(`Done · ${sizes.length} file${sizes.length === 1 ? "" : "s"}.`);
      } catch (err) {
        setStatus(`Generation failed: ${err.message}`, true);
      } finally {
        generateButtons.forEach((b) => (b.disabled = false));
      }
    })
  );
})();
