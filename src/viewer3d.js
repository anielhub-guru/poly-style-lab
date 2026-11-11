import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** Render an .aikiscene as an approximate 3D diorama: projected ground and wall, extruded cutouts, contact shadows. */
const dataUrl = svg => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const loadImage = src => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src; });

async function rasterize(svg, fill, longSide = 1536, blur = 0) {
  const image = await loadImage(dataUrl(svg));
  const ratio = image.naturalWidth / image.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = ratio >= 1 ? longSide : Math.round(longSide * ratio);
  canvas.height = ratio >= 1 ? Math.round(longSide / ratio) : longSide;
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.fillStyle = fill; context.fillRect(0, 0, canvas.width, canvas.height);
  if (blur) context.filter = `blur(${blur}px)`;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function projectedMaterial(texture, referenceMatrix, fallback) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: texture }, referenceMatrix: { value: referenceMatrix }, fallback: { value: new THREE.Color(fallback) } },
    vertexShader: 'varying vec3 vWorld; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform sampler2D map; uniform mat4 referenceMatrix; uniform vec3 fallback; varying vec3 vWorld;
      void main(){ vec4 c = referenceMatrix * vec4(vWorld,1.0); vec2 uv = c.xy / c.w * 0.5 + 0.5; uv.y = 1.0 - uv.y;
        vec3 base = texture2D(map, clamp(uv, 0.001, 0.999)).rgb;
        float outside = max(max(-uv.x, uv.x - 1.0), max(-uv.y, uv.y - 1.0));
        gl_FragColor = vec4(mix(base, fallback, smoothstep(0.0, 0.6, outside)), 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

function shadowTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(0,0,0,1)'); gradient.addColorStop(0.5, 'rgba(0,0,0,.55)'); gradient.addColorStop(1, 'rgba(0,0,0,0)');
  context.fillStyle = gradient; context.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

function shade(color, factor) {
  const hsl = {}; color.getHSL(hsl);
  return new THREE.Color().setHSL(hsl.h, hsl.s, Math.min(1, hsl.l * factor));
}

function buildLayer(scene, layer, svg, thicknessScale, disposables) {
  const loader = new SVGLoader();
  const data = loader.parse(svg);
  const viewBox = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const pxWidth = Number(viewBox?.[1]) || layer.sourceBoundsPx[2], pxHeight = Number(viewBox?.[2]) || layer.sourceBoundsPx[3];
  const scaleX = layer.size[0] / pxWidth, scaleY = layer.size[1] / pxHeight;
  const group = new THREE.Group();
  group.name = layer.id; group.userData.layerId = layer.id;
  const thickness = Math.max(0.02, layer.thickness * thicknessScale);
  let order = 0;
  for (const path of data.paths) {
    const fill = path.userData?.style?.fill;
    if (!fill || fill === 'none') continue;
    const color = new THREE.Color().setStyle(fill);
    const front = new THREE.MeshBasicMaterial({ color }), side = new THREE.MeshLambertMaterial({ color: shade(color, 0.72) });
    disposables.push(front, side);
    for (const shape of SVGLoader.createShapes(path)) {
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 10 });
      geometry.translate(-pxWidth / 2, -pxHeight / 2, 0);
      geometry.scale(scaleX, -scaleY, 1);               // SVG y points down
      geometry.translate(0, 0, -thickness + order * 0.0006);  // front face at the reference plane, volume behind it
      const mesh = new THREE.Mesh(geometry, [front, side]);
      disposables.push(geometry);
      group.add(mesh); order += 1;
    }
  }
  group.position.set(...layer.transform.position);
  scene.add(group);
  return group;
}

export async function createAikiSceneViewer(container, aikiscene, options = {}) {
  const { camera: ref, world, layers, primitives = [], assets } = aikiscene;
  const disposables = [];
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(world.skyColor);
  const aspect = aikiscene.canvas.widthPx / aikiscene.canvas.heightPx;
  const camera = new THREE.PerspectiveCamera(ref.verticalFovDeg, aspect, ref.near, ref.far);
  const shift = ref.lensShiftNdcY || 0;
  const applyShift = () => { camera.updateProjectionMatrix(); camera.projectionMatrix.elements[9] = -shift; camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert(); };
  camera.position.set(...ref.position);
  const target = new THREE.Vector3(...ref.target);
  camera.lookAt(target);
  camera.updateMatrixWorld(); applyShift();
  const referenceMatrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8890a0, world.lights.ambient));
  const key = new THREE.DirectionalLight(0xffffff, world.lights.key.intensity);
  key.position.set(...world.lights.key.direction.map(value => value * 10));
  scene.add(key);

  // Ground and backdrop wall are textured by projecting the reference backdrop from the reference camera.
  const backdrop = new THREE.CanvasTexture(await rasterize(assets[world.ground.assetId].content, world.skyColor, 1536, 4.5));
  backdrop.colorSpace = THREE.SRGBColorSpace; backdrop.anisotropy = renderer.capabilities.getMaxAnisotropy(); backdrop.generateMipmaps = true;
  backdrop.minFilter = THREE.LinearMipmapLinearFilter; backdrop.magFilter = THREE.LinearFilter;
  disposables.push(backdrop);
  const reach = world.wallDistance * Math.tan(THREE.MathUtils.degToRad(ref.verticalFovDeg / 2)) * aspect * 1.7;
  const groundDepth = world.ground.zNear - world.ground.zFar;
  const groundGeometry = new THREE.PlaneGeometry(reach * 2, groundDepth);
  groundGeometry.rotateX(-Math.PI / 2);
  const ground = new THREE.Mesh(groundGeometry, projectedMaterial(backdrop, referenceMatrix, world.ground.fallbackColor));
  ground.position.set(0, world.ground.y, (world.ground.zNear + world.ground.zFar) / 2);
  const wallHeight = world.wallDistance * Math.tan(THREE.MathUtils.degToRad(ref.verticalFovDeg / 2)) * 3.2;
  const wallGeometry = new THREE.PlaneGeometry(reach * 2, wallHeight);
  const wall = new THREE.Mesh(wallGeometry, projectedMaterial(backdrop, referenceMatrix, world.wall.fallbackColor));
  wall.position.set(0, world.ground.y + wallHeight / 2, world.wall.z);
  scene.add(ground, wall);
  disposables.push(groundGeometry, wallGeometry, ground.material, wall.material);

  const thicknessScale = { value: options.thicknessScale ?? 1 };
  const layerGroups = layers.filter(layer => !layer.projectedBackdrop).map(layer => buildLayer(scene, layer, assets[layer.assetId].content, thicknessScale.value, disposables));

  const shadowMap = shadowTexture(); disposables.push(shadowMap);
  for (const primitive of primitives.filter(item => item.kind === 'contact-shadow')) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(primitive.radius[0] * 2, primitive.radius[1] * 2), new THREE.MeshBasicMaterial({ map: shadowMap, transparent: true, opacity: primitive.opacity, depthWrite: false }));
    mesh.rotation.x = -Math.PI / 2; mesh.position.set(...primitive.position); mesh.renderOrder = 1;
    scene.add(mesh); disposables.push(mesh.geometry, mesh.material);
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target); controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minDistance = 2.5; controls.maxDistance = 14;
  controls.minAzimuthAngle = -0.75; controls.maxAzimuthAngle = 0.75;
  controls.minPolarAngle = 0.55; controls.maxPolarAngle = 1.75;
  controls.update();

  let mode = options.mode || 'sway', frame = 0, disposed = false;
  const rest = camera.position.clone();
  const resize = () => {
    const boxWidth = container.clientWidth || 640, boxHeight = container.clientHeight || Math.round(boxWidth / aspect);
    const width = Math.min(boxWidth, Math.round(boxHeight * aspect)), height = Math.round(width / aspect);
    renderer.setSize(width, height, false);
    Object.assign(renderer.domElement.style, { width: `${width}px`, height: `${height}px`, position: 'absolute', left: `${(boxWidth - width) / 2}px`, top: `${(boxHeight - height) / 2}px` });
    camera.aspect = aspect; applyShift();
  };
  const render = time => {
    if (disposed) return;
    frame = requestAnimationFrame(render);
    if (mode === 'sway') {
      const t = time / 1000;
      camera.position.set(rest.x + Math.sin(t * 0.6) * 0.9, rest.y + Math.sin(t * 0.43) * 0.25, rest.z);
      camera.lookAt(target); camera.updateMatrixWorld(); applyShift();
    } else controls.update();
    renderer.render(scene, camera);
  };
  const observer = new ResizeObserver(resize); observer.observe(container); resize();
  frame = requestAnimationFrame(render);
  return {
    setMode(next) { mode = next; controls.enabled = next === 'orbit'; if (next === 'reference') { camera.position.copy(rest); camera.lookAt(target); camera.updateMatrixWorld(); applyShift(); } },
    setThickness(value) { layerGroups.forEach((group, index) => group.children.forEach(mesh => { mesh.scale.z = value; })); },
    renderOnce(position) { if (position) { camera.position.set(...position); camera.lookAt(target); camera.updateMatrixWorld(); applyShift(); } renderer.render(scene, camera); },
    dispose() { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); controls.dispose(); disposables.forEach(item => item.dispose?.()); renderer.dispose(); renderer.domElement.remove(); },
  };
}
