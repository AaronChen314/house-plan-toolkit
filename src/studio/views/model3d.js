// 单一 3D 舞台：户型白模与外部模型（Blender/SketchUp 导出）共用。
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {FBXLoader} from 'three/addons/loaders/FBXLoader.js';
import {OBJLoader} from 'three/addons/loaders/OBJLoader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';

function loaderFor(url) {
  const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
  if (ext === 'fbx') return {kind: 'fbx', load: (u) => new FBXLoader().loadAsync(u)};
  if (ext === 'obj') return {kind: 'obj', load: async (u) => { const text = await (await fetch(u)).text(); return new OBJLoader().parse(text); }};
  return {kind: 'gltf', load: (u) => new Promise((resolve, reject) => new GLTFLoader().load(u, resolve, undefined, reject))};
}

export async function createModelStage(container, url, {onStats, onError} = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xedf0f1);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
  const renderer = new THREE.WebGLRenderer({antialias: true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.replaceChildren(renderer.domElement);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8d99a6, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(4, 8, 6);
  scene.add(key);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 0.05;
  controls.maxDistance = 2000;

  const root = new THREE.Group();
  scene.add(root);
  const grid = new THREE.GridHelper(20, 20, 0xc9d2d7, 0xdfe6e9);
  grid.position.y = -0.001;
  scene.add(grid);

  let mixer = null, actions = [], playing = true, wireframe = false, disposed = false;
  const clock = new THREE.Clock();

  function fit() {
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    const distance = (radius / Math.tan((camera.fov * Math.PI) / 360)) * 1.25;
    const dir = new THREE.Vector3(1, 0.75, 1).normalize();
    camera.position.copy(center).addScaledVector(dir, distance);
    camera.near = Math.max(distance / 1000, 0.01);
    camera.far = distance * 20;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
    grid.position.y = box.min.y;
    grid.scale.setScalar(Math.max(radius / 10, 0.2));
    return {size, center, radius};
  }

  function applyWireframe(value) {
    wireframe = value;
    root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.wireframe = wireframe;
    });
  }

  function toggleAnimation() {
    playing = !playing;
    if (mixer) mixer.timeScale = playing ? 1 : 0;
    return playing;
  }

  const resize = () => {
    const w = container.clientWidth || 1, hgt = container.clientHeight || 1;
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  const target = loaderFor(url);
  let stats = {file: url, kind: target.kind, meshes: 0, triangles: 0, materials: 0, textures: 0, animations: [], size: null};
  try {
    const loaded = await target.load(url);
    const object = loaded.scene || loaded;
    if (loaded.animations?.length) {
      mixer = new THREE.AnimationMixer(object);
      actions = loaded.animations.map(clip => mixer.clipAction(clip));
      actions[0]?.play();
      stats.animations = loaded.animations.map(c => c.name || '(未命名)');
    }
    root.add(object);
    const fitted = fit();

    const materials = new Set(), textures = new Set();
    object.traverse((o) => {
      if (o.isMesh) {
        stats.meshes += 1;
        const g = o.geometry;
        if (g?.index) stats.triangles += g.index.count / 3;
        else if (g?.attributes?.position) stats.triangles += g.attributes.position.count / 3;
        for (const m of Array.isArray(o.material) ? o.material : [o.material].filter(Boolean)) {
          materials.add(m);
          for (const v of Object.values(m)) if (v && v.isTexture) textures.add(v);
        }
      }
    });
    stats.materials = materials.size;
    stats.textures = textures.size;
    if (fitted) stats.size = [fitted.size.x, fitted.size.y, fitted.size.z].map(v => Number(v.toFixed(2)));
    onStats?.(stats);
  } catch (e) {
    onError?.(e.message || String(e));
  }

  renderer.setAnimationLoop(() => {
    if (disposed) return;
    const dt = clock.getDelta();
    if (mixer && playing) mixer.update(dt);
    controls.update();
    renderer.render(scene, camera);
  });

  return {
    stats,
    fit,
    setWireframe: applyWireframe,
    toggleAnimation,
    dispose() {
      disposed = true;
      observer.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      root.traverse((o) => {
        o.geometry?.dispose?.();
        const mats = Array.isArray(o.material) ? o.material : [o.material].filter(Boolean);
        for (const m of mats) {
          for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
          m.dispose?.();
        }
      });
      pmrem.dispose();
      renderer.dispose();
      container.replaceChildren();
    }
  };
}
