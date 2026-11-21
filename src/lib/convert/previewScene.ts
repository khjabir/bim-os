// The Convert page's 3D preview: draws the preview buffers from the
// conversion worker with three.js — materials with their colours, shine,
// transparency and textures as the Autodesk viewer showed them, or the single
// colours IFC viewers without textures show. Renders on demand.

import type { PreviewData, PreviewElement, PreviewMaterial } from "./preview";

type Three = typeof import("three");
type Mode = "textured" | "ifc";

/** sRGB byte -> linear, for vertex colours (three.js treats colour attributes as linear). */
const SRGB_TO_LINEAR = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    table[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return table;
})();

export interface PreviewPick {
  element: PreviewElement;
  point: [number, number, number];
}

export class PreviewScene {
  private readonly THREE: Three;
  private readonly container: HTMLElement;
  private readonly renderer: import("three").WebGLRenderer;
  private readonly scene: import("three").Scene;
  private readonly camera: import("three").PerspectiveCamera;
  private readonly controls: import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;
  private readonly environment: import("three").Texture;

  private constructor(
    THREE: Three,
    container: HTMLElement,
    renderer: import("three").WebGLRenderer,
    scene: import("three").Scene,
    camera: import("three").PerspectiveCamera,
    controls: import("three/examples/jsm/controls/OrbitControls.js").OrbitControls,
    environment: import("three").Texture,
  ) {
    this.THREE = THREE;
    this.container = container;
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.controls = controls;
    this.environment = environment;
  }

  private root: import("three").Group | null = null;
  private data: PreviewData | null = null;
  private textures: (import("three").Texture | null)[] = [];
  private textureVariants = new Map<string, import("three").Texture>();
  private urls: string[] = [];
  private materials = new Map<string, import("three").Material>();
  private objects: { object: import("three").Mesh | import("three").LineSegments; batch: number }[] = [];
  private mode: Mode = "textured";
  private pending = false;
  private observer: ResizeObserver | null = null;
  private marker: import("three").Mesh | null = null;
  disposed = false;

  static async create(container: HTMLElement): Promise<PreviewScene> {
    const THREE = await import("three");
    const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
    const { RoomEnvironment } = await import("three/examples/jsm/environments/RoomEnvironment.js");
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Highlights roll off instead of clipping light colours to white.
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.setAttribute("aria-label", "3D preview of the extracted model");
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    scene.environment = environment;
    scene.environmentIntensity = 0.65;
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.4);
    hemisphere.position.set(0, 0, 1);
    scene.add(hemisphere);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 50_000);
    camera.up.set(0, 0, 1);
    // A light that follows the camera, as in the Autodesk viewer.
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(0.6, 1, 1.4);
    camera.add(key);
    scene.add(camera);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;

    const view = new PreviewScene(THREE, container, renderer, scene, camera, controls, environment);
    view.applyBackground();
    controls.addEventListener("change", () => view.requestRender());
    view.observer = new ResizeObserver(() => view.resize());
    view.observer.observe(container);
    view.resize();
    return view;
  }

  /** A page colour behind the model (follows light and dark themes). */
  applyBackground() {
    const css = getComputedStyle(this.container).getPropertyValue("--surface-3").trim() || "#e5e8ed";
    this.scene.background = new this.THREE.Color(css);
    this.requestRender();
  }

  private resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender() {
    if (this.pending || this.disposed) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      if (this.disposed) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  // ---------------------------------------------------------------------------
  // Content

  async load(data: PreviewData, mode: Mode) {
    this.clear();
    const THREE = this.THREE;
    this.data = data;
    this.mode = mode;

    // Texture pictures, as decoded images (PNG, saved the way texture coordinates read them).
    this.textures = await Promise.all(
      data.textures.map(async (t) => {
        const url = URL.createObjectURL(new Blob([t.bytes as BlobPart], { type: "image/png" }));
        this.urls.push(url);
        const image = new Image();
        image.src = url;
        try {
          await image.decode();
        } catch {
          return null;
        }
        const texture = new THREE.Texture(image);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        texture.needsUpdate = true;
        return texture;
      }),
    );
    if (this.disposed) return;

    const root = new THREE.Group();
    data.batches.forEach((batch, index) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(batch.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(batch.indices, 1));
      if (batch.uvs) geometry.setAttribute("uv", new THREE.BufferAttribute(batch.uvs, 2));
      if (batch.colors) {
        const linear = new Float32Array(batch.colors.length);
        for (let i = 0; i < linear.length; i++) linear[i] = SRGB_TO_LINEAR[batch.colors[i]];
        geometry.setAttribute("color", new THREE.BufferAttribute(linear, 3));
      }
      let object: import("three").Mesh | import("three").LineSegments;
      if (batch.lines) object = new THREE.LineSegments(geometry, this.materialFor(batch.material, false, true));
      else {
        geometry.computeVertexNormals();
        const material = this.materialFor(batch.material, Boolean(batch.colors), false);
        if (batch.matrices) {
          const count = batch.matrices.length / 16;
          const mesh = new THREE.InstancedMesh(geometry, material, count);
          mesh.instanceMatrix = new THREE.InstancedBufferAttribute(batch.matrices, 16);
          mesh.computeBoundingSphere();
          object = mesh;
        } else object = new THREE.Mesh(geometry, material);
      }
      object.matrixAutoUpdate = false;
      root.add(object);
      this.objects.push({ object, batch: index });
    });
    this.root = root;
    this.scene.add(root);
    this.fit();
  }

  /** The texture with the material's wrapping: the picture itself the first time, a copy for other wrappings. */
  private texturesFor(index: number, material: PreviewMaterial): import("three").Texture | null {
    const base = this.textures[index];
    if (!base) return null;
    const key = `${index}|${material.repeatS ? 1 : 0}${material.repeatT ? 1 : 0}`;
    let texture = this.textureVariants.get(key);
    if (!texture) {
      const THREE = this.THREE;
      texture = [...this.textureVariants.keys()].some((k) => k.startsWith(`${index}|`)) ? base.clone() : base;
      texture.wrapS = material.repeatS ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      texture.wrapT = material.repeatT ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;
      this.textureVariants.set(key, texture);
    }
    return texture;
  }

  private materialFor(index: number, vertexColors: boolean, lines: boolean): import("three").Material {
    const key = `${this.mode}|${index}|${vertexColors ? 1 : 0}|${lines ? 1 : 0}`;
    const cached = this.materials.get(key);
    if (cached) return cached;
    const THREE = this.THREE;
    const m = this.data!.materials[index];
    let material: import("three").Material;
    if (lines) material = new THREE.LineBasicMaterial({ color: new THREE.Color(`#${m.color}`) });
    else {
      const transparent = m.opacity < 0.999;
      if (this.mode === "ifc") {
        // One colour per surface, as most IFC viewers show it.
        material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(`#${vertexColors ? m.color : m.surface}`),
          vertexColors,
          roughness: 0.75,
          metalness: 0,
          transparent,
          opacity: m.opacity,
          depthWrite: !transparent,
          side: THREE.DoubleSide,
        });
      } else {
        const roughness = m.roughness ?? (m.shininess !== null ? Math.min(1, Math.max(0.08, Math.sqrt(2 / (m.shininess + 2)))) : 0.7);
        const texture = m.texture >= 0 ? this.texturesFor(m.texture, m) : null;
        const standard = new THREE.MeshStandardMaterial({
          // Metals take their colour from their reflections (the specular colour).
          color: new THREE.Color(`#${m.metal && m.specular ? m.specular : m.color}`),
          map: texture,
          vertexColors,
          roughness,
          metalness: m.metal ? 1 : 0,
          transparent,
          opacity: m.opacity,
          depthWrite: !transparent,
          side: THREE.DoubleSide,
        });
        if (m.emissive) {
          standard.emissive.set(`#${m.emissive}`);
          standard.emissiveIntensity = 0.35;
        }
        material = standard;
      }
    }
    this.materials.set(key, material);
    return material;
  }

  setMode(mode: Mode) {
    if (mode === this.mode || !this.data) return;
    this.mode = mode;
    for (const { object, batch } of this.objects) {
      const b = this.data.batches[batch];
      object.material = this.materialFor(b.material, Boolean(b.colors), b.lines);
    }
    this.requestRender();
  }

  /** Frames the whole model. */
  fit() {
    const box = this.data?.bbox;
    if (!box) {
      this.requestRender();
      return;
    }
    const THREE = this.THREE;
    const center = new THREE.Vector3((box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2);
    const size = Math.max(1e-3, Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]));
    const direction = new THREE.Vector3(1, -1.25, 0.85).normalize();
    // The closest distance at which every corner of the box is in view, both ways.
    const forward = direction.clone().negate();
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward);
    const tanV = Math.tan((this.camera.fov * Math.PI) / 360);
    const tanH = tanV * this.camera.aspect;
    let distance = 0;
    for (let i = 0; i < 8; i++) {
      const corner = new THREE.Vector3(i & 1 ? box[3] : box[0], i & 2 ? box[4] : box[1], i & 4 ? box[5] : box[2]).sub(center);
      const toward = corner.dot(direction);
      distance = Math.max(distance, toward + Math.abs(corner.dot(right)) / tanH, toward + Math.abs(corner.dot(up)) / tanV);
    }
    distance = Math.max(distance * 1.08, size * 0.05);
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.near = Math.max(size / 5000, 0.001);
    this.camera.far = size * 20 + distance;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    if (this.marker) this.marker.scale.setScalar(size / 300);
    this.requestRender();
  }

  /** The element under a point of the canvas (client coordinates). */
  pick(clientX: number, clientY: number): PreviewPick | null {
    if (!this.data || !this.root) return null;
    const THREE = this.THREE;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    const box = this.data.bbox;
    raycaster.params.Line.threshold = box ? Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]) / 800 : 0.05;
    const hits = raycaster.intersectObjects(
      this.objects.map((o) => o.object),
      false,
    );
    for (const hit of hits) {
      const entry = this.objects.find((o) => o.object === hit.object);
      if (!entry) continue;
      const batch = this.data.batches[entry.batch];
      let element = -1;
      if (batch.matrices) element = hit.instanceId !== undefined ? batch.picks[hit.instanceId] : -1;
      else {
        const primitive = batch.lines ? Math.floor((hit.index ?? 0) / 2) : (hit.faceIndex ?? 0);
        // picks: [first primitive, element] pairs, ascending.
        let lo = 0,
          hi = batch.picks.length / 2 - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (batch.picks[mid * 2] <= primitive) lo = mid;
          else hi = mid - 1;
        }
        element = batch.picks[lo * 2 + 1];
      }
      const info = this.data.elements[element];
      if (!info) continue;
      this.showMarker(hit.point);
      return { element: info, point: [hit.point.x, hit.point.y, hit.point.z] };
    }
    this.hideMarker();
    return null;
  }

  private showMarker(point: import("three").Vector3) {
    const THREE = this.THREE;
    if (!this.marker) {
      this.marker = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff5a1f, depthTest: false, transparent: true, opacity: 0.9 }));
      this.marker.renderOrder = 10;
      this.scene.add(this.marker);
    }
    const box = this.data?.bbox;
    const size = box ? Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]) : 10;
    this.marker.scale.setScalar(Math.max(size / 400, 0.005));
    this.marker.position.copy(point);
    this.marker.visible = true;
    this.requestRender();
  }

  hideMarker() {
    if (this.marker) this.marker.visible = false;
    this.requestRender();
  }

  private clear() {
    if (this.root) {
      this.scene.remove(this.root);
      for (const { object } of this.objects) object.geometry.dispose();
    }
    for (const material of this.materials.values()) material.dispose();
    for (const texture of this.textures) texture?.dispose();
    for (const texture of this.textureVariants.values()) texture.dispose();
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.textureVariants.clear();
    this.root = null;
    this.objects = [];
    this.materials.clear();
    this.textures = [];
    this.urls = [];
    this.data = null;
    this.hideMarker();
  }

  dispose() {
    this.clear();
    this.disposed = true;
    this.observer?.disconnect();
    this.controls.dispose();
    this.environment.dispose();
    if (this.marker) {
      this.marker.geometry.dispose();
      (this.marker.material as import("three").Material).dispose();
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
