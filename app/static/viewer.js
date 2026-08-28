// Minimal STL viewer: flat-shaded solid + optional triangle wireframe, with a
// hand-rolled orbit control (three.js core only, no extra vendored addons).
import * as THREE from "./vendor/three.module.min.js";

const BG = 0x20211f;
const SOLID = 0xffb03b;

function parseBinarySTL(buffer) {
  const view = new DataView(buffer);
  const triangles = view.getUint32(80, true);
  // Sanity-check against the file length before trusting the count; an ASCII
  // STL would otherwise read a garbage triangle count out of its text.
  if (84 + triangles * 50 !== buffer.byteLength) {
    throw new Error("Not a binary STL");
  }
  const positions = new Float32Array(triangles * 9);
  let offset = 84;
  for (let i = 0; i < triangles; i++) {
    offset += 12; // skip the stored facet normal; we recompute flat normals
    for (let v = 0; v < 9; v++) {
      positions[i * 9 + v] = view.getFloat32(offset, true);
      offset += 4;
    }
    offset += 2; // attribute byte count
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return { geometry, triangles };
}

export function createViewer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(1, 1.4, 1);
  const fill = new THREE.DirectionalLight(0xffffff, 0.7);
  fill.position.set(-1, -0.6, -0.8);
  scene.add(key, fill, new THREE.AmbientLight(0xffffff, 0.55));

  const grid = new THREE.GridHelper(200, 20, 0x3a3a40, 0x2a2a30);
  scene.add(grid);

  const pivot = new THREE.Group();
  scene.add(pivot);

  let solid = null;
  let wire = null;
  let radius = 100;
  // Spherical camera coordinates around the model centre.
  let theta = Math.PI * 0.25;
  let phi = Math.PI * 0.32;
  let distance = 300;

  function updateCamera() {
    const d = distance;
    camera.position.set(
      d * Math.sin(phi) * Math.sin(theta),
      d * Math.cos(phi),
      d * Math.sin(phi) * Math.cos(theta)
    );
    camera.lookAt(0, 0, 0);
  }

  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function render() {
    resize();
    updateCamera();
    renderer.render(scene, camera);
  }

  // --- orbit / zoom -------------------------------------------------------
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointerup", (e) => {
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    theta -= (e.clientX - lastX) * 0.01;
    phi -= (e.clientY - lastY) * 0.01;
    phi = Math.max(0.05, Math.min(Math.PI - 0.05, phi));
    lastX = e.clientX;
    lastY = e.clientY;
    render();
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      distance = Math.max(radius * 0.6, Math.min(radius * 20, distance * (1 + Math.sign(e.deltaY) * 0.12)));
      render();
    },
    { passive: false }
  );
  window.addEventListener("resize", render);

  function clear() {
    for (const obj of [solid, wire]) {
      if (!obj) continue;
      pivot.remove(obj);
      obj.geometry.dispose();
      obj.material.dispose();
    }
    solid = null;
    wire = null;
  }

  return {
    /** Load binary STL bytes; returns the triangle count actually rendered. */
    load(buffer, { showWireframe = false, resetView = true } = {}) {
      const { geometry, triangles } = parseBinarySTL(buffer);
      clear();

      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      const centre = new THREE.Vector3();
      box.getCenter(centre);
      geometry.translate(-centre.x, -centre.y, -centre.z);
      // The mesh is authored Z-up (slicer convention); three.js is Y-up.
      geometry.rotateX(-Math.PI / 2);
      geometry.computeBoundingBox();

      const size = new THREE.Vector3();
      geometry.boundingBox.getSize(size);
      radius = Math.max(size.x, size.y, size.z) || 1;

      solid = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: SOLID,
          roughness: 0.55,
          metalness: 0.05,
          flatShading: true,
          side: THREE.DoubleSide,
        })
      );
      pivot.add(solid);

      wire = new THREE.LineSegments(
        new THREE.WireframeGeometry(geometry),
        new THREE.LineBasicMaterial({ color: 0x101012, transparent: true, opacity: 0.55 })
      );
      wire.visible = showWireframe;
      pivot.add(wire);

      // Sit the grid under the model, like a print bed.
      grid.scale.setScalar(Math.max(radius / 100, 0.2));
      grid.position.y = -size.y / 2;

      if (resetView) {
        distance = radius * 2.6;
        theta = Math.PI * 0.25;
        phi = Math.PI * 0.32;
      }
      render();
      return triangles;
    },
    /** Current orbit state — used by tests to prove the camera is held. */
    getCamera() {
      return { theta, phi, distance };
    },
    /** Frame the model again after the user has orbited/zoomed away. */
    resetView() {
      distance = radius * 2.6;
      theta = Math.PI * 0.25;
      phi = Math.PI * 0.32;
      render();
    },
    setWireframe(on) {
      if (wire) wire.visible = on;
      render();
    },
    clear() {
      clear();
      render();
    },
    render,
  };
}
