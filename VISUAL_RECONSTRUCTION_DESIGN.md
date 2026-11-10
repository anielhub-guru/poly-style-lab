# Measurement-Driven Visual Reconstruction

## Status

Validated design for a local-only research implementation. This document does not authorize production implementation by itself.

## Objective

Analyze 10–20 videos that share a visual style, select frames that can be reconstructed reliably, recover a numeric visual contract, and export a performant Three.js representation for iKi Studio. First prove aligned-frame reconstruction; then test whether the recovered contract transfers to a novel scene.

## Product boundary

- Measurements and fitted renderer parameters are the source of truth.
- Human-readable style labels are optional deterministic summaries, not inputs.
- The system reconstructs observable appearance; it does not claim to recover the creator's original software or authoring process.
- Unsupported properties are reported as unavailable rather than guessed.
- Large downloaded raster textures are prohibited.

## Operating constraints

- Local-only processing; no cloud or API dependency.
- Baseline: 6–8-core Intel Mac, 16 GB RAM, integrated graphics.
- Primary test system: approximately 8-core 2.4 GHz Intel Core i9, 64 GB RAM, Intel UHD 630.
- Typical study target: 5–10 minutes; hard ceiling: 30 minutes with early convergence stopping.
- One 10–20-video study at a time, producing one primary reconstruction.
- Expensive fitting occurs during analysis; the exported scene renders immediately.
- Prefer FFmpeg, NumPy, browser APIs, Three.js, and a small WASM vectorizer over large model runtimes.

## Architecture

### 1. Frame qualification

Sample across videos and score frames for blur, compression, occlusion, cut proximity, edge stability, palette stability, subject coverage, similarity to the study median, and predicted reconstruction cost. Retain several representative frames and select the best-supported reconstruction target automatically.

### 2. Visual measurement

Measure spatial color regions, gradients, stroke widths, curvature, polygonality, texture spectra, symmetry, perspective cues, light direction, shadow softness, composition, temporal parallax, and the motion quantities already supported by the project.

### 3. Representation trials

Test bounded candidates in increasing complexity:

1. indexed pixel grid;
2. SVG regions and strokes;
3. layered SVG or procedural alpha planes;
4. low-poly primitives and sparse meshes;
5. lightweight procedural textured regions.

Representations may be combined within one scene. Selection happens per coherent region, not once for the whole frame.

### Hybrid 2D characters in 3D worlds

A common mixed scene places drawn 2D characters inside a perspective 3D environment. The analyzer must preserve that split instead of flattening the world or forcing the characters into meshes.

- Fit character regions as SVG geometry, alpha-cutout planes, or camera-facing billboards.
- Fit the environment as a perspective camera plus bounded Three.js primitives, ground planes, sparse low-poly meshes, lights, and procedural materials.
- Measure character screen scale, world anchoring, ground-contact point, billboard orientation, depth order, occlusion, parallax, and whether characters cast or receive shadows.
- Compare independent-motion and parallax measurements across frames to separate character layers from world geometry.
- Allow hybrid shadows: a 2D character may use a measured procedural ground shadow without requiring volumetric character geometry.
- Export the relationship explicitly so iKi Studio can move a 2D character through the reconstructed 3D world without changing its drawing treatment.

### 4. Representation selection

Render a preview for each candidate and minimize:

```text
selectionScore = calibratedReconstructionError + lambda * sceneComplexity
```

Complexity includes object count, path points, triangles, textures, asset bytes, draw calls, and render time. The selector chooses the simplest candidate that passes calibrated reconstruction thresholds.

### 5. Parameter fitting

Fit and freeze parameter groups in order:

1. camera and composition;
2. geometry and silhouettes;
3. palette, gradients, and outlines;
4. lighting and materials;
5. procedural textures and effects.

Freezing completed groups prevents unrelated parameters from hiding incorrect geometry.

### 6. Export and verification

Produce:

- `visual-reconstruction-blueprint.json`;
- a self-contained Three.js scene;
- lightweight SVG and procedural assets;
- reference and reconstruction PNGs;
- a difference image;
- raw per-metric errors;
- a supported/unsupported capability report.

## Numeric measurement contract

Every exported property carries evidence:

```json
{
  "value": 1.8,
  "unit": "px@1080p",
  "method": "edge-profile-fit",
  "confidence": 0.91,
  "samples": 146,
  "sourceFrames": ["video-03@12.4"],
  "status": "measured"
}
```

Allowed statuses:

- `measured`: obtained directly from pixels or temporal differences;
- `fitted`: selected by minimizing reconstruction error;
- `derived`: calculated deterministically from other measurements;
- `unavailable`: insufficient observable evidence.

Measurement groups:

- canvas and camera: projection, horizon, vanishing points, framing, focal estimate, and depth layers;
- color: linear RGB and OKLab palette, region shares, spatial roles, gradients, luminance, and contrast;
- geometry: regions, contours, Bezier controls, polygon counts, curvature, primitive residuals, symmetry, and repetition;
- lines: coverage, width distribution, color, opacity, joins, caps, smoothness, and variation;
- materials: flatness, roughness fit, metalness fit, emissive contribution, transparency, shading bands, and normal variation;
- lighting: direction, ambient/key ratio, shadows, softness, tint, and intensity ratios;
- texture: spatial-frequency energy, orientation, scale, variance, tiling, and generator parameters;
- layers: masks, ordering, relative depth, parallax, occlusion, motion coherence, billboarding, world anchors, ground contact, and shadow participation;
- reconstruction: representation, parameter count, asset size, render time, and error components.

## Adaptive representation rules

- Pixel fitting is attempted when stable color runs align to a grid and nearest-neighbor reconstruction preserves edges.
- Vector fitting is attempted when segmented regions are stable and contours compress into paths without material error.
- Layered 2D fitting is attempted when regions exhibit coherent independent motion or parallax.
- Low-poly fitting is attempted when boundaries, shading bands, perspective, and lighting are consistent with sparse flat-shaded geometry.
- Hybrid fitting is selected when character-like coherent regions retain 2D appearance while the surrounding scene exhibits perspective, depth-dependent scale, parallax, lighting, or planar geometry.
- Procedural textures are introduced only when flat regions cannot reproduce measured frequency and variance statistics.
- If no compact representation passes, export the best bounded approximation and mark reconstruction as failed. Do not hide failure with a large raster copy.

## Validation metrics

Report a metric vector rather than one opaque score:

- color: OKLab region distance, palette shares, luminance histograms, and gradient endpoints;
- structure: aligned structural similarity;
- edges: distance, orientation, outline width, and missing-edge ratio;
- shapes: mask intersection-over-union, contour distance, primitive residual, symmetry, and area;
- texture: multiscale frequency energy, orientation histograms, variance, and autocorrelation;
- composition: bounds, centroid, horizon, negative space, and depth ordering;
- complexity: objects, paths, triangles, texture bytes, draw calls, and frame time.

Normalize and weight metrics only after calibration against synthetic scenes with known parameters. Preserve raw metrics in all reports.

Two independent gates apply:

1. Reconstruction gate: reproduce an automatically selected aligned source frame within calibrated limits.
2. Transfer gate: change content, arrangement, pose, or camera while preserving the exported visual distributions.

Passing reconstruction does not imply passing transfer.

## Testing and failure handling

Generate procedural calibration videos with known camera, geometry, palette, line, light, material, texture, layer, and motion parameters. Vary independent properties rather than calibrating against named styles.

Test parameter recovery, reconstruction error, representation selection, determinism, unavailable measurements, analysis runtime, peak memory, object count, draw calls, asset bytes, frame time, and novel-scene transfer.

Explicit failure states include corrupt media, insufficient frame diversity, inconsistent source styles, watermarks or captions, camera/object-motion ambiguity, 2D/3D ambiguity, excessive vector complexity, and texture budgets exceeded. Preserve completed measurements and resume from checkpoints.

Use real videos only as holdout evaluations after synthetic recovery thresholds pass.

## Research basis

- VTracer supplies local colored raster-to-vector segmentation, polygon or curve fitting, palette controls, and a Node/WASM build without a native runtime dependency: <https://github.com/visioncortex/vtracer>
- Three.js SVGLoader converts SVG paths into ShapeGeometry and materials: <https://threejs.org/docs/pages/SVGLoader.html>
- Three.js OrthographicCamera supports stable 2D and layered compositions: <https://threejs.org/docs/pages/OrthographicCamera.html>
- Layered depth images and multiplane images establish efficient layered image-based rendering: <https://dash.harvard.edu/entities/publication/73120378-7e84-6bd4-e053-0100007fdf3b> and <https://tinghuiz.github.io/papers/siggraph18_mpi_lowres.pdf>
- Differentiable vector rasterization demonstrates fitting vector primitives against image-space objectives, but is not required for the first lightweight implementation: <https://people.csail.mit.edu/tzumao/diffvg/diffvg.pdf>
- SSIM provides a structural comparison component, but must be combined with color, edge, shape, texture, composition, and complexity measurements: <https://ece.uwaterloo.ca/~z70wang/publications/ssim.pdf>

## Decision log

1. Use staged target C: aligned-frame reconstruction, then novel-scene transfer.
2. Keep processing local-only.
3. Use adaptive runtime with a 30-minute ceiling.
4. Support Intel CPU and integrated graphics; require no CUDA or Apple-Silicon-only dependency.
5. Choose reconstruction frames automatically using evidence and reconstructability.
6. Require a runnable Three.js output, not only a report.
7. Prefer SVG, primitives, layered planes, flat materials, gradients, and procedural textures.
8. Select adaptive measured reconstruction over universal differentiable inverse rendering.
9. Select representations through calibrated render error plus scene complexity.
10. Keep measured, fitted, derived, and unavailable values distinct.
11. Report a metric vector and calibrate aggregate weights from known ground truth.
12. Prohibit large raster fallback and preserve explicit failure states.
13. Select representations per region so 2D characters can remain 2D inside measured 3D environments.

## Accepted implementation boundary

The smallest sufficient first implementation should prove one complete path:

1. select one flat or moderately layered frame automatically;
2. vectorize it locally;
3. measure and export camera, palette, regions, paths, lines, and gradients;
4. render it through Three.js;
5. report reconstruction error and runtime complexity;
6. perturb composition to run an initial transfer test.

Low-poly mesh fitting and procedural texture synthesis should follow only after the vector/layer path meets its calibrated reconstruction target.

The next bounded slice should combine the proven 2D path with a simple perspective environment made from a ground plane, sky/background, lights, and primitive geometry. This validates the common 2D-character-in-3D-world case before attempting arbitrary low-poly mesh recovery.

## Implemented semantic-layer slice

The local reconstructor now extracts colour-connected atomic regions, excludes border-connected environment regions, detects repeated compact instances, and groups adjacent residual regions into editable visual entities. It exports each accepted instance as a cropped SVG, records numeric bounds, area, palette, role confidence, and repeated-family membership, then composes the assets as ordered orthographic Three.js planes.

Role labels such as `subject-candidate` and `repeated-prop` are deliberately provisional. A single frame supports appearance and topology measurements but cannot prove semantic identity; cross-frame motion coherence is the next evidence source needed to promote candidates into stable characters, props, and world assets.

## Implemented temporal-confirmation slice

Each normalized clip is now sampled locally around its chosen evidence time before temporary video cleanup. A median-background motion pass measures coherent component masks, persistence, displacement, reference bounds, and centroid tracks without pose models; confirmed motion can split one appearance-based layer into a moving `character-candidate` and a nonmoving `static-support` asset.

Temporal evidence takes precedence over single-frame hybrid heuristics when the two disagree. Weak or absent motion evidence leaves the previous reconstruction unchanged, and role promotion remains bounded to the measured frame window rather than claiming universal semantic identity.
## Articulated character handoff slice

When temporal evidence promotes at least two character candidates, the reconstruction now emits `rig/rig-definition.json` and lightweight clipped SVG parts. The woman rig contains measured bounds, numeric cut rectangles, pivots, layer order, source-derived translation amplitude, supported motions, and explicit unsupported joints. The snake rig contains eight measured image bands, a centerline sampled from temporal mask runs, numeric bone pivots, and a seek-safe spline-wave definition.

`src/rigged-scene.js` consumes this contract without owning Three.js. It returns an editable `THREE.Group` hierarchy and an `applyPose(timeSec)` function whose state is derived only from absolute time, so iKi Studio can seek, retime, or replace the motion without replaying the source clip.
