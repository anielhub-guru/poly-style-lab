# AikiScene Reconstruction Handoff

## Understanding

- Aiki Style Map exports an editable reconstruction package rather than a flattened reference image.
- A valid scene may consist entirely of separate SVG layers arranged as fixed planes in 3D world space.
- SVG planes retain their world orientation while the camera moves around the constructed set.
- Each plane has slight thickness and a generated solid-colour back instead of an invisible or mirrored rear face.
- The solved reference camera must closely reproduce the source framing; novel views may reveal the flat-set construction.
- AikiStudio imports the package through the existing **Recreate reference** drawer and applies it as one undoable transaction.
- Procedural primitives supplement SVG planes only when supported by evidence; arbitrary hidden geometry is not required.

## Assumptions

- AikiStudio remains a no-build, local-first browser application.
- One local user imports one reconstruction package at a time.
- Standard exports remain real-time on Intel CPUs and integrated graphics.
- Package import never executes JavaScript or resolves remote assets.
- Failed validation or materialisation leaves the current project unchanged.
- Aiki Style Map owns scene analysis, camera fitting, and package generation.
- AikiStudio owns strict validation, deterministic materialisation, editing, persistence, and rendering.
- Existing provider-driven raw-reference reconstruction remains available.

## Package Architecture

The authoritative interchange is a single UTF-8 JSON `.aikiscene` file using schema `aikistudio.scene-reconstruction/v1`. It embeds multiple independent sanitized SVG documents as named assets. The container is one file for transport, but its scene remains componentized and editable.

The manifest contains:

- units and Three.js Y-up coordinate system;
- solved perspective camera, confidence, and framing error;
- fixed SVG layers with asset references, physical dimensions, thickness, backing colour, world transforms, source bounds, and confidence;
- bounded procedural primitives;
- embedded SVG assets;
- reconstruction metrics, warnings, and supported status;
- an export-quality profile and requested rendering features.
- numeric subject features, classification scores, and the selected reconstruction strategy;
- declarative cutout or spline rigs with embedded SVG part assets;
- finite, seek-safe animation clip definitions.

## Automatic Reconstruction Strategy

Every subject is classified from measurements rather than names or prompt labels. Current features are aspect ratio, elongation, occupied-area compactness, palette size, normalized displacement, temporal persistence, and occupied-row ratio. The exported score vector remains in the package so AikiStudio can explain or override the result.

The initial strategy mapping is:

| Classification | Reconstruction strategy |
|---|---|
| Articulated 2D cutout | Segmented SVG cutout |
| Flexible character | Centerline-driven SVG bands |
| Rigid sprite | Single editable SVG plane |
| 2D subject in a measured 3D scene | SVG billboard |
| Measured low-poly world | Primitive mesh with SVG billboards |

Low-confidence classifications remain editable and retain unsupported-feature declarations. Classification does not invent semantic anatomy: generic regions are named upper, core, sides, and lower until stronger evidence exists.

## Extended `.aikiscene` Fields

- `subjects` contains measured features, score vectors, classification confidence, selected strategy, pivots, and unsupported controls.
- `rigs` maps each subject to its declarative part or bone IDs.
- `animations` contains finite absolute-time clip definitions.
- `reconstructionStrategy` records the scene-level representation decision.
- Rig SVGs are embedded in `assets`; no external paths or remote URLs are retained.
- `packageDigest` is a deterministic SHA-256 digest of the complete package.

Generated `scene.js` may remain a preview artifact but is not imported or executed by AikiStudio.

## AikiStudio Integration

The existing **Recreate reference** drawer provides two sources:

1. analyse a reference image through the existing provider workflow;
2. import a local Aiki Style Map `.aikiscene` package.

The importer validates the complete package before mutation. Imported layers are stored as native `sceneryLayers`, separate from screen-space `coverLayers`. Each layer materializes as a fixed Three.js group containing a textured SVG front plane and a thin solid backing box. The front plane never copies the camera quaternion.

The imported camera becomes a normal editable shot camera. AikiStudio performs only bounded verification and correction of target, distance, and field of view; it does not independently reinterpret the scene. A correction is retained only when it reduces framing error.

## Procedural Geometry

The initial generator whitelist is:

- box;
- cylinder;
- sphere;
- ground plane;
- extruded polygon when valid contour data exists.

Unknown required generators reject the import. Unknown optional generators may become labelled placeholders after explicit user confirmation.

## Export Quality

| Profile | Target | SVG layers | Scene objects | Texture ceiling | Package target |
|---|---|---:|---:|---:|---:|
| Standard (recommended) | Integrated graphics and normal laptops | 64 | 128 | 2048² | 8 MB |
| High | Modern discrete or strong integrated GPUs | 128 | 256 | 4096² | 24 MB |
| Ultra | Workstations and high-memory GPUs | 256 | 512 | 8192² | 64 MB |

Profiles control decomposition detail, editable-layer count, primitive density, SVG rasterization, shadows, filtering, and antialiasing. They never alter the solved camera, world transforms, or evidence. AikiStudio may downgrade rendering quality during import without changing scene composition.

Separate absolute parser and memory safety limits protect the browser from malformed packages. These are not normal authoring limits.

## Validation and Security

AikiStudio rejects unknown schemas or coordinate systems, duplicate IDs, missing assets, non-finite transforms, invalid camera parameters, and packages beyond absolute safety limits.

SVG assets are parsed and rebuilt from an allowed subset. Scripts, event attributes, external URLs, embedded HTML, animation elements, remote fonts, and unbounded filters are rejected or removed. Asset references use package-local IDs rather than file paths.

## Failure Behaviour

- Invalid root contract: reject without project mutation.
- Invalid required asset: reject and identify the asset.
- Invalid optional asset: warn and require confirmation before omission.
- Camera verification failure: preserve the exported camera and report the mismatch.
- Texture preparation failure: stop before project mutation.
- Unsupported reconstruction: retain diagnostic output but disable scene construction.
- Reload failure: preserve reconstruction metadata and identify the layer that failed.

## Testing

Automated tests cover deterministic manifest generation, multiple independent SVG assets, fixed transforms, solid backing data, camera fields, framing metrics, malicious SVG rejection, atomic materialisation, projection and parallax, save/reload, undo, quality profiles, complexity limits, and regression of existing image reconstruction.

Browser verification imports a generated benchmark, compares the reference camera, orbits around the fixed layers, inspects backs and edges, saves, reloads, and undoes the import. Visual QA is claimed only after inspecting the browser render.

## Risks

- Single-view depth is ambiguous.
- Detailed SVGs may soften after texture rasterization.
- Transparent layers can create GPU overdraw.
- Correct framing does not prove correct physical scale.
- Ultra exports may exceed practical GPU memory despite passing structural validation.

## Decision Log

1. Use componentized SVG layers when reliable 3D meshes cannot be recovered.
2. Keep SVG planes fixed in world space rather than camera-facing.
3. Use a generated solid-colour back with slight thickness rather than an invisible or mirrored rear face.
4. Prioritize reproduction of the reference shot while allowing novel views to expose the flat set.
5. Extend the existing **Recreate reference** drawer instead of adding a parallel import workflow.
6. Use a declarative `.aikiscene` package rather than executable `scene.js` imports.
7. Use one dependency-free JSON container with multiple embedded SVG assets rather than requiring ZIP support.
8. Export explicit transforms and dimensions instead of deriving placement during import.
9. Store imported set pieces as native `sceneryLayers`, not screen-space overlays.
10. Use bounded camera verification rather than a second full camera solve.
11. Apply imports atomically.
12. Provide Standard, High, and Ultra quality profiles, with Standard recommended.
13. Keep absolute safety limits separate from normal export-quality profiles.
14. Select subject reconstruction strategies from numeric measurements rather than scene-specific names or track IDs.
15. Embed rigs, clips, and their SVG assets inside the existing single-file `.aikiscene` JSON container.
