# Poly Style Lab

Poly Style Lab downloads a representative set of 10–20 videos from a YouTube channel or playlist, normalizes every source to constant 30 FPS, measures frame and landmark motion, and aggregates recurring patterns into `polystudio.motion-style-blueprint/v1`.

It also exports a PolyStudio-compatible declarative story-format `pack.json` and matching `style-guide.md`.

## Run

```bash
npm start
```

Open `http://127.0.0.1:8788`.

The screenshot shown in the UI is automatically extracted from an analysed video so a human can verify what the agent is studying. It is evidence, not an input or a replacement for multi-video analysis.

Node 18+, FFmpeg, Python 3.9+, and the packages in `requirements.txt` are required. Run `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`; the UI follows PolyStudio’s three-panel workspace language because it is a complementary inspector, not the main automation surface.

## Agent-first workflow

The CLI and MCP server expose the same shared commands. Most production use should happen through Codex or another MCP-capable agent.

```bash
# discover tools
node bin/poly-style-lab.js tools

# download 15 videos, measure them at 30 FPS, and create the reusable blueprint
node bin/poly-style-lab.js style_analyze_channel --input '{"source":"https://youtube.com/@channel/videos","videoCount":15,"outputDir":"./workspaces/channel-study"}' --json
```

The same command accepts a playlist URL, a single video URL for pipeline checks, a local video, or a local folder. Channel and playlist studies choose evenly spaced entries across the available source order.

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

Ask Codex: “Use Poly Style Lab through MCP. Analyse 15 videos from this YouTube channel at 30 FPS and load the resulting motion-style blueprint into PolyStudio.”

### PolyStudio handoff

`style_export_pack` produces `pack.json` and `style-guide.md`. Copy the output folder to `PolyStudio/packs/<style-id>/` and reload PolyStudio; the format then appears in the director’s format registry and contributes its planning guidance and AI Render video prompt.

## Test

```bash
npm test
```

## Export contract

The motion blueprint records:

- source-native FPS and the normalized 30 FPS analysis clock;
- duplicate-frame ratio and hold-length distributions;
- landmark speed and acceleration for head, shoulders, hands, torso, hips, and legs;
- mouth/head, mouth/shoulder, and mouth/hand motion correlation;
- head-motion distributions while the mouth is active versus quiet;
- high-speed pose discontinuities used as measurable snap/frame-skip evidence;
- per-video confidence, representative screenshot, source title, timestamp, and frame number;
- aggregate distributions and a direct `polystudio.motionContract` adapter.

The included **Stormbound Shōnen** preset captures the grammar of high-energy ninja-era television animation without naming or copying franchise characters, costumes, symbols, settings or signature attacks.
