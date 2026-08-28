import { createViewer } from "./viewer.js";
import { createEditor } from "./editor.js";

(() => {
  const imageInput = document.getElementById("image-input");
  const dropzone = document.getElementById("dropzone");
  const dropzoneText = document.getElementById("dropzone-text");
  const originalPreview = document.getElementById("original-preview");
  const maskPreview = document.getElementById("mask-preview");

  const thresholdInput = document.getElementById("threshold");
  const thresholdValue = document.getElementById("threshold-value");
  const invertInput = document.getElementById("invert");
  const simplifyInput = document.getElementById("simplify");
  const simplifyValue = document.getElementById("simplify-value");
  const minAreaInput = document.getElementById("min-area");
  const minAreaValue = document.getElementById("min-area-value");
  const advancedToggle = document.getElementById("advanced-toggle");
  const advancedFields = document.getElementById("advanced-fields");
  const advancedFields2 = document.getElementById("advanced-fields-2");

  const sizesBody = document.getElementById("sizes-body");
  const addSizeBtn = document.getElementById("add-size-btn");
  const presetButtons = document.querySelectorAll(".preset-btn");

  const mirrorHInput = document.getElementById("mirror-h");
  const mirrorVInput = document.getElementById("mirror-v");
  const rotateInput = document.getElementById("rotate");
  const layFlatInput = document.getElementById("lay-flat");
  const trianglesInput = document.getElementById("triangles");
  const trianglesValue = document.getElementById("triangles-value");

  const viewerCanvas = document.getElementById("viewer-canvas");
  const viewerEmpty = document.getElementById("viewer-empty");
  const wireframeInput = document.getElementById("wireframe");
  const refreshPreviewBtn = document.getElementById("refresh-preview-btn");
  const resetViewBtn = document.getElementById("reset-view-btn");
  const downloadPreviewBtn = document.getElementById("download-preview-btn");
  const meshStats = document.getElementById("mesh-stats");

  const editorDetails = document.getElementById("editor-details");
  const editorCanvas = document.getElementById("editor-canvas");
  const editorOverlay = document.getElementById("editor-overlay");
  const editorUndo = document.getElementById("editor-undo");
  const editorReset = document.getElementById("editor-reset");
  const brushSizeInput = document.getElementById("brush-size");
  const brushSizeValue = document.getElementById("brush-size-value");
  const toolButtons = document.querySelectorAll(".tool-btn");

  const generateBtn = document.getElementById("generate-btn");
  const statusEl = document.getElementById("status");

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

  const viewer = createViewer(viewerCanvas);
  // Exposed for the browser test to inspect orbit state.
  window.__viewer = viewer;
  const editor = createEditor({
    canvas: editorCanvas,
    overlay: editorOverlay,
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

  function addSizeRow(preset = {}) {
    const row = document.createElement("tr");

    const labelTd = document.createElement("td");
    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.value = preset.label ?? `size-${sizesBody.children.length + 1}`;
    labelTd.appendChild(labelInput);

    const widthTd = document.createElement("td");
    const widthInput = document.createElement("input");
    widthInput.type = "number";
    widthInput.min = "0.1";
    widthInput.step = "any";
    widthInput.value = preset.width_mm ?? 5;
    widthTd.appendChild(widthInput);

    const thicknessTd = document.createElement("td");
    const thicknessInput = document.createElement("input");
    thicknessInput.type = "number";
    thicknessInput.min = "0.1";
    thicknessInput.step = "any";
    thicknessInput.value = preset.thickness_mm ?? 10;
    thicknessTd.appendChild(thicknessInput);

    const removeTd = document.createElement("td");
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-row-btn";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove size";
    removeBtn.addEventListener("click", () => row.remove());
    removeTd.appendChild(removeBtn);

    row.append(labelTd, widthTd, thicknessTd, removeTd);
    sizesBody.appendChild(row);
  }

  function collectSizes() {
    const sizes = [];
    for (const row of sizesBody.children) {
      const [labelInput, widthInput, thicknessInput] = row.querySelectorAll("input");
      const width_mm = parseFloat(widthInput.value);
      const thickness_mm = parseFloat(thicknessInput.value);
      if (!Number.isFinite(width_mm) || !Number.isFinite(thickness_mm)) continue;
      sizes.push({
        label: labelInput.value.trim() || "logo",
        width_mm,
        thickness_mm,
      });
    }
    return sizes;
  }

  // The 3D preview is rendered at the first size in the table.
  sizesBody.addEventListener("input", scheduleMeshPreview);

  addSizeBtn.addEventListener("click", () => addSizeRow());
  presetButtons.forEach((btn) => {
    btn.addEventListener("click", () => addSizeRow(PRESETS[btn.dataset.preset]));
  });

  // Seed with the small/medium/large presets by default.
  addSizeRow(PRESETS.small);
  addSizeRow(PRESETS.medium);
  addSizeRow(PRESETS.large);

  advancedToggle.addEventListener("change", () => {
    advancedFields.hidden = !advancedToggle.checked;
    advancedFields2.hidden = !advancedToggle.checked;
  });

  function bindRangeDisplay(input, display, digits = 0) {
    input.addEventListener("input", () => {
      display.textContent = Number(input.value).toFixed(digits);
      schedulePreview();
    });
  }
  bindRangeDisplay(thresholdInput, thresholdValue, 0);
  bindRangeDisplay(simplifyInput, simplifyValue, 1);
  bindRangeDisplay(minAreaInput, minAreaValue, 2);
  invertInput.addEventListener("change", schedulePreview);

  [mirrorHInput, mirrorVInput, layFlatInput].forEach((el) =>
    el.addEventListener("change", scheduleMeshPreview)
  );
  rotateInput.addEventListener("change", scheduleMeshPreview);
  trianglesInput.addEventListener("input", () => {
    updateTriangleLabel();
    scheduleMeshPreview();
  });
  wireframeInput.addEventListener("change", () => viewer.setWireframe(wireframeInput.checked));
  refreshPreviewBtn.addEventListener("click", runMeshPreview);
  resetViewBtn.addEventListener("click", () => viewer.resetView());
  downloadPreviewBtn.addEventListener("click", () => {
    if (lastMeshBlob) downloadBlob(lastMeshBlob, lastMeshName);
  });
  updateTriangleLabel();

  // --- image editor -------------------------------------------------------
  toolButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      toolButtons.forEach((b) => b.classList.toggle("is-active", b === btn));
      editor.setTool(btn.dataset.tool);
      editorCanvas.classList.toggle("crop-cursor", btn.dataset.tool !== "erase-brush");
    });
  });
  brushSizeInput.addEventListener("input", () => {
    brushSizeValue.textContent = brushSizeInput.value;
    editor.setBrushSize(Number(brushSizeInput.value));
  });
  editor.setBrushSize(Number(brushSizeInput.value));
  editorUndo.addEventListener("click", () => editor.undo());
  editorReset.addEventListener("click", () => editor.reset());
  // The canvas is sized from its container, which has no width until the
  // <details> is actually open.
  editorDetails.addEventListener("toggle", () => {
    if (editorDetails.open) window.dispatchEvent(new Event("resize"));
  });

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
    dropzoneText.textContent = file.name;
    originalPreview.src = URL.createObjectURL(file);
    generateBtn.disabled = false;
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

  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    })
  );
  dropzone.addEventListener("drop", (e) => {
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

  // Clipboard images arrive as nameless blobs; give them a name so the dropzone
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

  function currentParams() {
    const form = new FormData();
    form.append("threshold", thresholdInput.value);
    form.append("invert", invertInput.checked ? "true" : "false");
    form.append("simplify", simplifyInput.value);
    form.append("min_area_pct", minAreaInput.value);
    form.append("mirror_h", mirrorHInput.checked ? "true" : "false");
    form.append("mirror_v", mirrorVInput.checked ? "true" : "false");
    form.append("rotate_deg", rotateInput.value);
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
      trianglesValue.textContent = `${pct}% (~${targetFaces().toLocaleString()})`;
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

  async function runMeshPreview() {
    if (!currentFile) return;
    const size = collectSizes()[0];
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
        showWireframe: wireframeInput.checked,
        resetView: needsViewReset,
      });
      needsViewReset = false;
      viewerEmpty.hidden = true;
      lastMeshBlob = new Blob([buffer], { type: "model/stl" });
      lastMeshName = `${size.label || "logo"}_${size.width_mm}mm_x_${size.thickness_mm}mm.stl`;
      downloadPreviewBtn.disabled = false;
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
      meshStats.textContent =
        `${triangles.toLocaleString()} triangles` +
        (dims ? ` · ${dims.split(",").map((v) => Number(v).toFixed(1)).join(" × ")} mm` : "") +
        (bodies > 1 ? ` · ${bodies} separate parts` : "") +
        (watertight ? " · watertight" : " · NOT watertight");
      meshStats.classList.toggle("warn", !watertight);
      setStatus("");
    } catch (err) {
      if (err.name === "AbortError") return;
      if (requestId === meshRequestId) setStatus(`3D preview failed: ${err.message}`, true);
    }
  }

  async function runPreview() {
    if (!currentFile) return;
    const form = currentParams();
    setStatus("Updating preview…");
    try {
      const res = await postWithImage("/api/preview", form);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      maskPreview.src = URL.createObjectURL(blob);
      setStatus("");
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
    statusEl.style.color = isError ? "#c0392b" : "";
  }

  generateBtn.addEventListener("click", async () => {
    if (!currentFile) return;
    const sizes = collectSizes();
    if (sizes.length === 0) {
      setStatus("Add at least one size first.", true);
      return;
    }

    const form = currentParams();
    form.append("sizes", JSON.stringify(sizes));

    generateBtn.disabled = true;
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
      setStatus("Done.");
    } catch (err) {
      setStatus(`Generation failed: ${err.message}`, true);
    } finally {
      generateBtn.disabled = false;
    }
  });
})();
