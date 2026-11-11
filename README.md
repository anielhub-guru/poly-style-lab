# Poly Style Lab

Poly Style Lab measures the **motion and rendered visual style** of a creator from a small, representative sample: 10–20 YouTube Shorts (or one short video, or a local folder). For each video it keeps only the first ~45 s at 480p, measures animation cadence at the video's native frame rate, cuts and (when pose tracking is installed) body motion in shoulder-widths per second, then automatically selects the evidence frame with the lowest measured reconstruction cost. It exports `polystudio.motion-style-blueprint/v1`, a ready-to-install PolyStudio pack, and a local numeric visual-reconstruction blueprint with a lightweight Three.js/SVG handoff.

It also exports a PolyStudio-compatible declarative story-format `pack.json` and matching `style-guide.md`.

## Run

```bash
npm start
```

Open `http://127.0.0.1:8788`.

The screenshot shown in the UI is automatically extracted from an analysed video so a human can verify what the agent is studying. It is evidence, not an input or a replacement for multi-video analysis.

### Requirements

- Node 18+ and **ffmpeg** on `PATH`.
- Python with `numpy` for cadence, cuts and landmark-free movement. This is the minimum and is enough for most studies; a study still works and says what it skipped.
- `yt-dlp` for YouTube sources.
- Optional, heavy (about 1 GB, Python ≤3.12) and only useful for live-action or realistic footage: pose tracking (`opencv-python-headless` + `mediapipe`) adds per-body-part speeds and speech-motion correlations. Install it with `uv pip install mediapipe opencv-python-headless`; without it those measurements are simply skipped.

Recommended setup (Python 3.10–3.12; current yt-dlp no longer supports 3.9, and the mediapipe download is large):

```bash
uv venv --python 3.12 .venv && uv pip install -r requirements.txt   # or: python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

`YT_DLP=/path/to/yt-dlp` points the tool at any yt-dlp binary. yt-dlp is intentionally not pinned: YouTube changes weekly and old releases fail with errors such as "The page needs to be reloaded". If downloads fail, update yt-dlp first.

The UI follows PolyStudio’s three-panel workspace language because it is a complementary inspector, not the main automation surface.

## Agent-first workflow

The CLI and MCP server expose the same shared commands. Most production use should happen through Codex or another MCP-capable agent.

```bash
# discover tools
node bin/poly-style-lab.js tools

# measure 12 Shorts from a channel (a bare channel URL means its Shorts) and write the blueprint, a short summary and a PolyStudio pack
node bin/poly-style-lab.js style_analyze_channel --input '{"source":"https://www.youtube.com/@channel","videoCount":12,"outputDir":"./workspaces/channel-study"}' --json

# long runs (MCP clients time out): start in the background, then poll cheaply
node bin/poly-style-lab.js style_analyze_channel --input '{"source":"https://www.youtube.com/@channel","outputDir":"./workspaces/channel-study","background":true}' --json
node bin/poly-style-lab.js style_analysis_status --input '{"outputDir":"./workspaces/channel-study"}' --json
```
```

`source` accepts a channel (its Shorts), a shorts/playlist URL, a single video URL, a local video, or a local folder. Per video only the first `maxSecondsPerVideo` (default 45, max 180) are downloaded, at ≤480p without audio, and videos are spread evenly across the newest 120 listed. Downloaded sources are deleted after measuring unless `keepSources` is true; only measurements and one evidence frame per video are kept. Re-running a study in the same folder reuses finished measurements. One failing video is skipped and reported, not fatal.

**Output for agents is small by design.** The command returns headline measurements, confidence, warnings, and compact reconstruction metrics. Read `summary.md` for the rules in plain language, `motion-style-blueprint.json` for the motion/look distributions, or `reconstruction/visual-reconstruction-blueprint.json` for evidence-backed reconstruction parameters. Import `reconstruction/scene.aikiscene` through AikiStudio's **Recreate reference** drawer to build separate fixed SVG set layers in 3D space; it never imports the reference as one flattened scene image. Choose `reconstructionQuality: standard | high | ultra` when starting the study; Standard is recommended for normal laptops. Copy `pack/` to `PolyStudio/packs/<id>/` to use the measured rules in PolyStudio.

### Approximate 3D view

`scene.aikiscene` now describes an approximate 3D diorama, not only flat cards. Open `http://127.0.0.1:8788/viewer.html?scene=/workspaces/<id>/reconstruction/scene.aikiscene` (or use **View in 3D** after a study) and sway, orbit or reset to the reference camera.

- **Smooth edges:** pixel outlines are resampled and relaxed (Taubin smoothing) and simplified; large rectangles and image borders stay exact.
- **Depth without a model:** an object standing on the ground meets it at a row below the horizon, which fixes its distance. Layers are placed by that ground contact; anything above the horizon is far backdrop. The horizon comes from the measured structure. There is no learned depth model, so depth is approximate and hidden surfaces are not recovered.
- **World:** a ground plane and back wall are textured by projecting the reference backdrop from the reference camera, so the reference view still matches the source. The camera carries `lensShiftNdcY` to put the horizon on the right row; importers must apply it.
- **Volume:** each cutout layer is extruded from its real silhouette (`thickness`, scaled by size and whether it stands on the ground), with flat front faces and shaded sides. Ground-standing layers get a contact-shadow primitive.
- Additive fields: `world`, `camera.lensShiftNdcY`, `layers[].depth`, `layers[].projectedBackdrop`, `primitives[]` of kind `contact-shadow`.

### Character handoff to AikiStudio

Each recovered subject carries `handoff` (`aikistudio.character-handoff/v1`): where to stand it (`anchor`), what to build from (`reference`), a replaceable extruded-cutout `placeholder`, and for 2D the cutout/spline `rig`. Whether a subject is a flat 2D sprite or a genuinely 3D character is **the user's decision**: the lab only measures shading as a hint (`dimensionality`, `choice.suggested`) because one frame cannot reliably tell stylised flat art from a textured render. Until chosen, `target` is `needs-choice` and `defaultTarget` is the 2D sprite. `applyCharacterChoice(scene, subjectId, '2d' | '3d' | null)` in `src/aikiscene.js` records the choice (`choice.selected`, `choice.source: "user"`), rebuilds the handoff and re-signs the package; choices survive re-embedding a rig into an existing package, but a fresh analysis starts unset.

### MCP configuration

```json
{
  "mcpServers": {
    "poly-style-lab": {
      "command": "node",
      "args": ["/absolute/path/to/poly-style-lab/mcp/server.js"]
    }
  }
}
```

Ask Codex: “Use Poly Style Lab through MCP. Analyse 12 Shorts from this YouTube channel in the background, read the summary when it finishes, and install the resulting pack into PolyStudio.”

### PolyStudio handoff

`style_export_pack` produces `pack.json` and `style-guide.md`. Copy the output folder to `PolyStudio/packs/<style-id>/` and reload PolyStudio; the format then appears in the director’s format registry and contributes its planning guidance and AI Render video prompt.

## Test

```bash
npm test
```

## Export contract

The motion blueprint records, as distributions across videos (never zero-filled when a video lacks a measurement):

- animation step (ones/twos/threes) and drawings per second, measured on the **native** frame grid, plus duplicate-frame ratio and hold lengths;
- cut rate and shot-length distribution (landmark-free, so it works on cartoons);
- **landmark-free movement** (numpy only, works on cartoons and needs no install): which third of the frame the movement is in, how much of the frame changes at once (localized/limited animation vs full-frame), how punchy or steady it is, and sharp accents per 10 s;
- speed and acceleration of head, shoulders, hands, torso, hips and legs in shoulder-widths per second, computed only on frames where the picture changed;
- mouth/head, mouth/shoulder and mouth/hand motion correlation and head speed while speaking versus quiet;
- sharp snap accents per 10 s (merged across body parts; cuts and tracking dropouts excluded);
- **look** (numpy only, colour frames at 8/s, longest side 288 px): a merged palette with shares; saturation, brightness and contrast; warm highlights vs cool shadows; the sky gradient (top vs lower colour); **edges** (outline coverage: the share of strong edges that sit on a thin dark line, 0.98 for a drawn outline and 0 for plain colour shapes in the tests; edge width, where a hard step reads about 2 px and blur reads above 3 px); **softness** (background sharpness as a multiple of the subject's, vignette); **2D effects** (soft, low-saturation areas that change over at least 0.4 s, such as smoke, dust or cloud puffs: events per 10 s, size, duration) and **backdrop** (how still the top of the frame stays while the rest moves, a sign of a flat plate). Each study also gets plain-language verdicts, look rules in the pack guidance and a suggested PolyStudio `brief.look`;
- per-video confidence, evidence images (the frame, an edge sheet with strong edges in white and thin dark lines in red, and the strongest effect moments) and explicit warnings.

## Limitations

- The look numbers are measurements of the picture, not a style classifier. Outline coverage and edge width are reliable; the 2D-effect and backdrop figures are heuristics that also fire on fades inside a scene, soft shadows and focus pulls, so check the effect evidence frames before trusting them. Palette and edge numbers describe the rendered frames, including any watermark.

- The AikiStudio handoff reconstructs the chosen view as separate fixed SVG flats with derived depth spacing and an analytically aligned perspective camera. This creates an editable physical-set effect and parallax, but it does not recover hidden surfaces or prove true metric depth from one view. If no independent foreground layer can be recovered, the package is marked unsupported instead of exporting a flattened scene.

- Pose tracking is trained on real people. Stylised or very small figures may not track; those videos still contribute cadence and cutting, are excluded from body-motion statistics, and the warnings say so.
- The sample is the newest ≤120 listed uploads, spread evenly; it describes recent style, not a creator's whole history.
- Only the first 45 s of each video is measured by default. A single long video is represented by its opening only.
- Measuring takes roughly 1–3 minutes per video with pose tracking, seconds without it.
- Downloading videos is subject to YouTube's terms; the tool keeps measurements, not the footage.
- The browser UI was not visually verified in this change; the HTTP API and the pipeline are covered by tests.

The included **Stormbound Shōnen** preset captures the grammar of high-energy ninja-era television animation without naming or copying franchise characters, costumes, symbols, settings or signature attacks.
