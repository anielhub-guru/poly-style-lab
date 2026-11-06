"""Measure the LOOK of one short video: colour, edge lines, softness and 2D overlay effects (numpy only).

Read from the constant-rate clip as small RGB frames (8 per second, longest side 288 px), so numbers are comparable across
videos of any size. Everything is a measurement of the picture, never of the story:

  palette     k-means swatches with shares, saturation, brightness, contrast, warm highlights vs cool shadows,
              a sky gradient (top band vs lower band colour)
  edges       share of pixels on strong edges, share of THIN DARK lines (an ink outline: darker than both sides within
              3 px), and how wide edges are (a one-pixel step is crisp, a wide ramp is blur or bloom)
  softness    background sharpness against the centre (depth-of-field or a blurred plate), vignette
  effects2d   soft, desaturated areas that change over a short time (smoke, dust, cloud puffs, glow sprites), how often,
              how big and how long; and how still the top of the frame stays while the rest moves (a flat 2D backdrop)

The effect and backdrop numbers are heuristics. The evidence sheet (frame | strong edges in white, ink lines in red) lets a
person check the edge claim by eye.
"""

import re
import subprocess

import numpy as np

LONG_SIDE = 288
FPS = 8
STAT_FRAMES = 40
CUT_DIFF = 0.2          # mean luma change between sampled frames that counts as a cut (those pairs are skipped)
CHANGE = 0.035          # luma change that counts a pixel as changed
SOFT_GRAD = 0.045       # gradient magnitude below which a changed pixel is "soft" (no hard edge)
SOFT_SAT = 0.32         # smoke and cloud are grey or white, not saturated
TRANSITION = 0.03       # mean luma change between sampled frames that marks a fade, not an effect
EFFECT_MIN_FRAMES = 3   # an effect lasts at least this many sampled frames (0.375 s)
EFFECT_MIN_SHARE = 0.012
EFFECT_MAX_SHARE = 0.6
INK_DEPTH = 0.12        # a line must be this much darker than both sides
EDGE_MIN = 0.12         # gradient magnitude that counts as a strong edge


def r(value, places=4):
    return round(float(value), places)


def hexof(rgb):
    return "#" + "".join(f"{int(round(min(1, max(0, c)) * 255)):02x}" for c in rgb)


def probe_size(path):
    err = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    for line in err.splitlines():
        if "Video:" in line:
            match = re.search(r"[ ,](\d{2,5})x(\d{2,5})[ ,\[]", line)
            if match:
                return int(match.group(1)), int(match.group(2))
    raise RuntimeError("could not read the video size")


def read_frames(path, max_sec):
    width, height = probe_size(path)
    scale = LONG_SIDE / max(width, height)
    w, h = max(16, int(round(width * scale / 2)) * 2), max(16, int(round(height * scale / 2)) * 2)
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-t", str(max_sec), "-an",
               "-vf", f"fps={FPS},scale={w}:{h}:flags=area", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]
    data = subprocess.run(command, capture_output=True).stdout
    size = w * h * 3
    count = len(data) // size
    if count < 6:
        raise RuntimeError("video is too short or unreadable")
    return np.frombuffer(data[:count * size], dtype=np.uint8).reshape(count, h, w, 3)


def luma_of(rgb):
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def saturation_of(rgb):
    mx, mn = rgb.max(-1), rgb.min(-1)
    return np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)


def gradient(L):
    gx = np.zeros_like(L)
    gy = np.zeros_like(L)
    gx[:, 1:-1] = (L[:, 2:] - L[:, :-2]) / 2
    gy[1:-1, :] = (L[2:, :] - L[:-2, :]) / 2
    return gx, gy


def thin_dark(L, w=3, depth=INK_DEPTH):
    """Pixels darker than the pixels w px away on BOTH sides, horizontally or vertically: a drawn line, not the edge of a dark shape."""
    mask = np.zeros(L.shape, dtype=bool)
    a, left, right = L[:, w:-w], L[:, :-2 * w], L[:, 2 * w:]
    mask[:, w:-w] |= (a < left - depth) & (a < right - depth) & (a < 0.55)
    a, up, down = L[w:-w, :], L[:-2 * w, :], L[2 * w:, :]
    mask[w:-w, :] |= (a < up - depth) & (a < down - depth) & (a < 0.55)
    return mask


def edge_width(L, gx):
    """Median width in px of strong horizontal edges: step height over peak slope (about 1 for a hard step, larger for blur or glow)."""
    mag = np.abs(gx)
    peak = (mag > 0.06)
    peak[:, 1:-1] &= (mag[:, 1:-1] >= mag[:, :-2]) & (mag[:, 1:-1] >= mag[:, 2:])
    peak[:, :4] = False
    peak[:, -4:] = False
    rows, cols = np.nonzero(peak)
    if rows.size < 30:
        return None
    step = np.abs(L[rows, cols + 3] - L[rows, cols - 3])
    keep = step > 0.12
    if keep.sum() < 30:
        return None
    return float(np.median(step[keep] / np.maximum(mag[rows, cols][keep], 1e-6)))


def laplacian_var(L):
    lap = 4 * L[1:-1, 1:-1] - L[:-2, 1:-1] - L[2:, 1:-1] - L[1:-1, :-2] - L[1:-1, 2:]
    return float(lap.var())


def kmeans(points, k=7, iterations=12, seed=0):
    rng = np.random.default_rng(seed)
    centers = [points[rng.integers(len(points))]]
    for _ in range(k - 1):  # k-means++ seeding
        distance = np.min([((points - c) ** 2).sum(1) for c in centers], axis=0)
        total = distance.sum()
        centers.append(points[rng.choice(len(points), p=distance / total)] if total > 0 else points[rng.integers(len(points))])
    centers = np.array(centers)
    for _ in range(iterations):
        labels = np.argmin(((points[:, None, :] - centers[None]) ** 2).sum(2), axis=1)
        for i in range(k):
            if (labels == i).any():
                centers[i] = points[labels == i].mean(0)
    labels = np.argmin(((points[:, None, :] - centers[None]) ** 2).sum(2), axis=1)
    return centers, np.bincount(labels, minlength=k) / len(points)


def palette_of(frames, rng):
    sample = []
    for frame in frames:
        flat = frame.reshape(-1, 3)
        sample.append(flat[rng.choice(len(flat), size=min(len(flat), 700), replace=False)])
    points = np.concatenate(sample).astype(np.float64) / 255.0
    centers, shares = kmeans(points, k=7)
    merged = []
    for index in np.argsort(-shares):  # fold swatches that are nearly the same colour into the bigger one
        for item in merged:
            if np.linalg.norm(item["rgb"] - centers[index]) < 0.07:
                item["share"] += shares[index]
                break
        else:
            merged.append({"rgb": centers[index], "share": float(shares[index])})
    return [{"hex": hexof(item["rgb"]), "share": r(item["share"], 3)} for item in merged[:6]]


def effect_events(L, S, G, cuts):
    """Soft, low-saturation areas that change over a short time. Returns per-frame area share and the events built from them."""
    count = L.shape[0]
    share = np.zeros(count)
    masks = {}
    for i in range(1, count):
        if cuts[i]:
            continue
        if abs(float(L[i].mean() - L[i - 1].mean())) > TRANSITION:  # a fade or dissolve between scenes, not an effect inside one
            continue
        delta = np.abs(L[i] - L[i - 1])
        changed = delta > CHANGE
        if changed.mean() > 0.5:  # camera or whole-scene change, not a local effect
            continue
        mask = changed & (G[i] < SOFT_GRAD) & (S[i] < SOFT_SAT)
        share[i] = mask.mean()
        if share[i] >= EFFECT_MIN_SHARE:
            masks[i] = mask
    events, current = [], None
    for i in range(1, count):
        active = EFFECT_MIN_SHARE <= share[i] <= EFFECT_MAX_SHARE
        if active:
            if current and i - current["end"] <= 2:
                current["end"] = i
                current["frames"].append(i)
            else:
                current = {"start": i, "end": i, "frames": [i]}
                events.append(current)
    result = []
    for event in events:
        if len(event["frames"]) < EFFECT_MIN_FRAMES:
            continue
        peak = max(event["frames"], key=lambda f: share[f])
        mask = masks[peak]
        ys = np.nonzero(mask.any(1))[0]
        result.append({"frame": peak, "durationSec": (event["end"] - event["start"] + 1) / FPS, "areaShare": float(share[peak]),
                       "centerY": float(ys.mean() / mask.shape[0]) if ys.size else 0.5,
                       "brightness": float(L[peak][mask].mean()) if mask.any() else 0.5})
    return share, result


def write_sheet(path, frame, L, ink):
    """PPM, frame | strong edges (white) and ink lines (red). The Node side converts it to a JPEG."""
    h, w = L.shape
    gx, gy = gradient(L)
    edges = np.hypot(gx, gy) > EDGE_MIN
    panel = np.zeros((h, w, 3), dtype=np.uint8)
    panel[edges] = (255, 255, 255)
    panel[ink] = (255, 40, 40)
    both = np.concatenate([frame, panel], axis=1)
    with open(path, "wb") as handle:
        handle.write(f"P6\n{both.shape[1]} {both.shape[0]}\n255\n".encode())
        handle.write(both.tobytes())


def analyze(path, max_sec, sheet_path=None):
    frames = read_frames(path, max_sec)
    count, h, w, _ = frames.shape
    rng = np.random.default_rng(7)
    rgb = frames.astype(np.float32) / 255.0
    L = luma_of(rgb)
    S = saturation_of(rgb)
    G = np.empty_like(L)
    for i in range(count):
        gx, gy = gradient(L[i])
        G[i] = np.hypot(gx, gy)

    deltas = np.abs(np.diff(L, axis=0)).mean(axis=(1, 2))
    cuts = np.concatenate([[False], deltas > CUT_DIFF])
    index = np.unique(np.linspace(0, count - 1, min(count, STAT_FRAMES)).astype(int))

    # --- colour
    bright = L[index] > np.percentile(L[index], 75)
    dark = L[index] < np.percentile(L[index], 25)
    warm = (rgb[index][..., 0] - rgb[index][..., 2])
    visible = rgb[index].max(-1) > 0.15
    colour = {
        "saturationMean": r(S[index][visible].mean()), "saturationP90": r(np.percentile(S[index][visible], 90)),
        "brightnessMean": r(L[index].mean()), "contrast": r(np.percentile(L[index], 95) - np.percentile(L[index], 5)),
        "highlightWarmth": r(warm[bright].mean()), "shadowWarmth": r(warm[dark].mean()),
        "palette": palette_of(frames[index], rng),
    }
    colour["warmHighlightCoolShadow"] = r(colour["highlightWarmth"] - colour["shadowWarmth"])
    top = rgb[index][:, : max(2, int(h * 0.08))].mean(axis=(1, 2))
    lo, hi = int(h * 0.30), int(h * 0.45)
    band = rgb[index][:, lo:hi]
    band_soft = G[index][:, lo:hi] < 0.03
    low = np.array([band[i][band_soft[i]].mean(0) if band_soft[i].sum() > 40 else band[i].mean(axis=(0, 1)) for i in range(len(index))])
    sky_top, sky_low = np.median(top, axis=0), np.median(low, axis=0)
    colour["skyTop"], colour["skyLower"] = hexof(sky_top), hexof(sky_low)
    colour["skyGradient"] = r(np.linalg.norm(sky_top - sky_low))

    # --- edges
    ink_all = np.stack([thin_dark(L[i]) for i in index])
    strong = G[index] > EDGE_MIN
    near_ink = ink_all.copy()                      # ink within 2 px: a true outline sits on (nearly) every silhouette edge
    for dy in (-2, -1, 1, 2):
        near_ink[:, max(dy, 0):h + min(dy, 0)] |= ink_all[:, max(-dy, 0):h + min(-dy, 0)]
    for dx in (-2, -1, 1, 2):
        near_ink[:, :, max(dx, 0):w + min(dx, 0)] |= ink_all[:, :, max(-dx, 0):w + min(-dx, 0)]
    widths = [w_ for w_ in (edge_width(L[i], gradient(L[i])[0]) for i in index) if w_ is not None]
    edges = {
        "edgeDensity": r(strong.mean()), "inkLineRatio": r(ink_all.mean()),
        "inkShareOfEdges": r(ink_all.sum() / max(strong.sum(), 1)),
        "outlineCoverage": r((strong & near_ink).sum() / max(strong.sum(), 1)),
        "edgeWidthPx": r(np.median(widths), 2) if widths else None,
        "edgeWidthPctOfFrame": r(np.median(widths) / max(h, w) * 100, 3) if widths else None, "frameLongSidePx": max(h, w),
    }

    # --- softness
    cy0, cy1, cx0, cx1 = int(h * 0.25), int(h * 0.75), int(w * 0.25), int(w * 0.75)
    ratios, vignettes = [], []
    for i in index:
        centre = laplacian_var(L[i][cy0:cy1, cx0:cx1])
        top_band = laplacian_var(L[i][: int(h * 0.2)])
        bottom_band = laplacian_var(L[i][int(h * 0.8):])
        if centre > 1e-7:
            ratios.append(((top_band + bottom_band) / 2) / centre)
        corner = np.mean([L[i][:h // 10, :w // 10].mean(), L[i][:h // 10, -w // 10:].mean(), L[i][-h // 10:, :w // 10].mean(), L[i][-h // 10:, -w // 10:].mean()])
        vignettes.append(corner / max(L[i][cy0:cy1, cx0:cx1].mean(), 1e-3))
    softness = {"sharpness": r(np.mean([laplacian_var(L[i]) for i in index]) * 1000, 3),
                "backgroundSharpnessRatio": r(np.median(ratios)) if ratios else None, "vignette": r(np.median(vignettes))}

    # --- 2D effects and backdrop
    share, events = effect_events(L, S, G, cuts)
    duration = count / FPS
    effects = {"eventsPer10s": r(len(events) * 10 / duration, 2), "softAreaShareMedian": r(np.median(share[share > 0])) if (share > 0).any() else 0.0,
               "events": {"count": len(events), "areaShare": {"median": r(np.median([e["areaShare"] for e in events])) if events else None, "peak": r(max(e["areaShare"] for e in events)) if events else None},
                          "durationSec": r(np.median([e["durationSec"] for e in events]), 2) if events else None,
                          "lightShare": r(np.mean([e["brightness"] > 0.5 for e in events])) if events else None},
               "top": [{"timeSec": r(e["frame"] / FPS, 2), "areaShare": r(e["areaShare"]), "durationSec": r(e["durationSec"], 2), "centerY": r(e["centerY"], 2)} for e in sorted(events, key=lambda e: -e["areaShare"])[:4]]}
    still = []
    for i in range(1, count):
        if cuts[i]:
            continue
        changed = np.abs(L[i] - L[i - 1]) > CHANGE
        cut_row = int(h * 0.3)
        rest = changed[cut_row:].mean()
        if rest > 0.02 and changed.mean() < 0.5:
            still.append(1.0 - min(1.0, changed[:cut_row].mean() / rest))
    top_smooth = (G[index][:, : int(h * 0.4)] < 0.015).mean()
    backdrop = {"topStillness": r(np.median(still)) if still else None, "smoothTopShare": r(top_smooth), "samples": len(still)}

    sheet = None
    if sheet_path:
        pick = index[len(index) // 3]
        write_sheet(sheet_path, frames[pick], L[pick], ink_all[len(index) // 3])
        sheet = {"timeSec": r(pick / FPS, 2)}
    return {"available": True, "sampleFps": FPS, "frames": count, "colour": colour, "edges": edges, "softness": softness, "effects2d": effects, "backdrop": backdrop,
            "sheet": sheet}
