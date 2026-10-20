import { registerDisposer, showError } from "./lazy.js";

const EXT = /\.(glb|gltf|stl)(?:[?#]|$)/i;

export const isModelUrl = (url) => EXT.test(url);

// Draws only when something changes (orbit, resize), so idle viewers cost nothing.
export async function renderModels(nodes) {
  const THREE = await import("three");
  const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
  await Promise.all(nodes.map((el) => mount(el, THREE, OrbitControls).catch((err) => showError(el, "3D model", err))));
}

async function load(THREE, url) {
  const ext = EXT.exec(url)[1].toLowerCase();
  if (ext === "stl") {
    const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
    const geometry = await new STLLoader().loadAsync(url);
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x9aa7b4, metalness: 0.1, roughness: 0.55 }));
    mesh.rotation.x = -Math.PI / 2; // STL files are conventionally Z-up
    return mesh;
  }
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  return (await new GLTFLoader().loadAsync(url)).scene;
}

async function mount(el, THREE, OrbitControls) {
  const model = await load(THREE, el.dataset.src);
  if (!el.isConnected) return;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  el.textContent = "";
  el.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  camera.add(key); // light travels with the camera, so the visible side is always lit
  scene.add(camera);

  const pivot = new THREE.Group();
  pivot.add(model);
  scene.add(pivot);

  // Centre the model on the origin and back the camera off until it fits.
  const box = new THREE.Box3().setFromObject(pivot);
  const size = box.getSize(new THREE.Vector3());
  model.position.sub(box.getCenter(new THREE.Vector3()));
  const dim = Math.max(size.x, size.y, size.z) || 1;
  const dist = (dim / (2 * Math.tan((camera.fov * Math.PI) / 360))) * 1.7;
  camera.near = dim / 100;
  camera.far = dim * 100;
  camera.position.set(0.8, 0.55, 1).normalize().multiplyScalar(dist);
  camera.updateProjectionMatrix();

  const controls = new OrbitControls(camera, renderer.domElement);
  const draw = () => renderer.render(scene, camera);
  controls.addEventListener("change", draw);

  const resize = () => {
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    draw();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  resize();

  el.classList.add("ready"); // clears the "Loading…" caption styling
  registerDisposer(() => {
    ro.disconnect();
    controls.dispose();
    model.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material || [])) m.dispose();
    });
    renderer.dispose();
    renderer.forceContextLoss();
  });
}
