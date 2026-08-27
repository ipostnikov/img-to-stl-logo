import { createViewer } from "./viewer.js";

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
  const meshStats = document.getElementById("mesh-stats");

  const generateBtn = document.getElementById("generate-btn");
  const statusEl = document.getElementById("status");

  let currentFile = null;
  let previewDebounce = null;
  let meshDebounce = null;
  // Triangle count of the undecimated mesh, learned from the most recent
  // full-detail preview; the budget slider is a percentage of it.
  let fullTriangleCount = 0;
  let meshRequestId = 0;

  const viewer = createViewer(viewerCanvas);

  // Thickness is deliberately a substantial fraction of width (~30-40%),
  // matching the reference STLs shipped with this project - this is meant
  // to emboss/press into another surface, not sit as a thin flat badge.
  const PRESETS = {
    small: { label: "small", width_mm: 50, thickness_mm: 20 },
    medium: { label: "medium", width_mm: 100, thickness_mm: 35 },
    large: { label: "large", width_mm: 150, thickness_mm: 50 },
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
    widthInput.min = "1";
    widthInput.step = "any";
    widthInput.value = preset.width_mm ?? 100;
    widthTd.appendChild(widthInput);

    const thicknessTd = document.createElement("td");
    const thicknessInput = document.createElement("input");
    thicknessInput.type = "number";
    thicknessInput.min = "0.1";
    thicknessInput.step = "any";
    thicknessInput.value = preset.thickness_mm ?? 30;
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
  updateTriangleLabel();

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
    dropzoneText.textContent = file.name;
    originalPreview.src = URL.createObjectURL(file);
    generateBtn.disabled = false;
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
    form.append("image", currentFile);
    form.append("width_mm", String(size.width_mm));
    form.append("thickness_mm", String(size.thickness_mm));

    const requestId = ++meshRequestId;
    setStatus("Building 3D preview…");
    try {
      const res = await fetch("/api/mesh", { method: "POST", body: form });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      const buffer = await res.arrayBuffer();
      // A slower earlier request must not overwrite a newer preview.
      if (requestId !== meshRequestId) return;

      const triangles = viewer.load(buffer, { showWireframe: wireframeInput.checked });
      viewerEmpty.hidden = true;
      if (!Number(trianglesInput.value)) {
        fullTriangleCount = triangles;
        updateTriangleLabel();
      }
      const dims = res.headers.get("X-Size-Mm");
      const watertight = res.headers.get("X-Watertight") === "1";
      meshStats.textContent =
        `${triangles.toLocaleString()} triangles` +
        (dims ? ` · ${dims.split(",").map((v) => `${Number(v).toFixed(1)}`).join(" × ")} mm` : "") +
        (watertight ? " · watertight" : " · not watertight");
      setStatus("");
    } catch (err) {
      if (requestId === meshRequestId) setStatus(`3D preview failed: ${err.message}`, true);
    }
  }

  async function runPreview() {
    if (!currentFile) return;
    const form = currentParams();
    form.append("image", currentFile);
    setStatus("Updating preview…");
    try {
      const res = await fetch("/api/preview", { method: "POST", body: form });
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
    form.append("image", currentFile);
    form.append("sizes", JSON.stringify(sizes));

    generateBtn.disabled = true;
    setStatus("Generating STL…");
    try {
      const res = await fetch("/api/generate", { method: "POST", body: form });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : "logo.stl";

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus("Done.");
    } catch (err) {
      setStatus(`Generation failed: ${err.message}`, true);
    } finally {
      generateBtn.disabled = false;
    }
  });
})();
