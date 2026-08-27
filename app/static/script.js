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

  const generateBtn = document.getElementById("generate-btn");
  const statusEl = document.getElementById("status");

  let currentFile = null;
  let previewDebounce = null;

  const PRESETS = {
    small: { label: "small", width_mm: 50, thickness_mm: 3 },
    medium: { label: "medium", width_mm: 100, thickness_mm: 4 },
    large: { label: "large", width_mm: 150, thickness_mm: 5 },
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
    thicknessInput.value = preset.thickness_mm ?? 4;
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

  function setDropzoneFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      setStatus("Please choose an image file.", true);
      return;
    }
    currentFile = file;
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
    return form;
  }

  function schedulePreview() {
    if (!currentFile) return;
    clearTimeout(previewDebounce);
    previewDebounce = setTimeout(runPreview, 250);
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
