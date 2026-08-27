# --- build stage: compile/collect dependencies into a self-contained venv ---
FROM python:3.11-slim AS builder

# gcc is only needed if a dependency has no manylinux wheel; it stays in this
# stage and never reaches the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends gcc \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .
# --no-compile: .pyc files are ~40 MB of pure duplication here, and the app is
# long-running so the one-off import cost is irrelevant.
RUN pip install --no-cache-dir --no-compile -r requirements.txt

# Debug symbols in the shipped shared objects are dead weight at runtime.
RUN find /opt/venv -name '*.so*' -exec strip --strip-unneeded {} + 2>/dev/null || true

# Prune what the running app provably never touches:
#   pip/setuptools - nothing installs packages at runtime
#   cv2/data       - Haar cascade XML for face detection; we only trace contours
# The bundled OpenBLAS/ffmpeg libraries in opencv_python_headless.libs look
# equally unused, but cv2.abi3.so lists them as NEEDED and fails to import if
# they are removed, so they stay.
RUN rm -rf /opt/venv/lib/python3.11/site-packages/pip \
           /opt/venv/lib/python3.11/site-packages/pip-* \
           /opt/venv/lib/python3.11/site-packages/setuptools \
           /opt/venv/lib/python3.11/site-packages/setuptools-* \
           /opt/venv/lib/python3.11/site-packages/pkg_resources \
           /opt/venv/lib/python3.11/site-packages/cv2/data

# --- runtime stage ---
FROM python:3.11-slim

# libcairo2 backs cairosvg (SVG input). Deliberately NOT installing libgl1:
# opencv-python-headless has no GL dependency, and libgl1 drags in Mesa plus a
# 124 MB LLVM, which was over a third of the previous image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY app/ .

EXPOSE 8080

CMD ["gunicorn", "-b", "0.0.0.0:8080", "-w", "2", "--timeout", "120", "app:app"]
