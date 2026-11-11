"""Approximate 3D world layout for a single reference frame.

No learned depth model is used. Depth comes from one geometric cue that is
reliable in most drawn and filmed scenes: objects standing on the ground meet
it at a row below the horizon, and for a camera at fixed height that row fixes
their distance (distance = height * focal / (rows below horizon)). Everything
above the horizon is treated as far backdrop. This is approximate by design.
"""

import math

CAMERA_Z = 8.0
NEAR_DISTANCE = 3.0   # metres from camera to the ground at the bottom image edge
WALL_DISTANCE = 22.0  # metres from camera to the backdrop wall
CHARACTER_ROLES = {"subject-candidate", "character-candidate"}


def horizon_fraction(structure, height):
    try:
        value = float(structure.get("horizon")) / height
    except (TypeError, ValueError, ZeroDivisionError):
        return 0.5
    return value if math.isfinite(value) and 0.25 <= value <= 0.75 else 0.5


def build_world(width, height, fov, structure, background_asset_id, sky, ground):
    focal = 1 / math.tan(math.radians(fov / 2))
    hy = horizon_fraction(structure, height)
    shift = 1 - 2 * hy                                   # horizon height in NDC
    ground_height = NEAR_DISTANCE * (shift + 1) / focal   # camera height above ground
    return {
        "method": "ground-contact-depth",
        "horizonNdc": round(shift, 4),
        "horizonRow": round(hy, 4),
        "cameraHeight": round(ground_height, 4),
        "nearDistance": NEAR_DISTANCE,
        "wallDistance": WALL_DISTANCE,
        "ground": {"y": round(-ground_height, 4), "zNear": round(CAMERA_Z - NEAR_DISTANCE, 4), "zFar": round(CAMERA_Z - WALL_DISTANCE, 4), "assetId": background_asset_id, "mapping": "reference-camera-projection", "fallbackColor": ground},
        "wall": {"z": round(CAMERA_Z - WALL_DISTANCE, 4), "assetId": background_asset_id, "mapping": "reference-camera-projection", "fallbackColor": sky},
        "skyColor": sky,
        "lights": {"ambient": 0.65, "key": {"intensity": 0.85, "direction": [-0.45, 0.8, 0.55]}},
        "notes": ["Depth is estimated from ground contact, not measured; hidden surfaces are not recovered."],
    }


def place_layer(world, bbox, size_px, focal, index, role):
    """Return (distance, standing_on_ground) for a layer given its bbox in analysis pixels."""
    x0, y0, x1, y1 = bbox
    height = size_px[1]
    ndc_bottom = 1 - 2 * y1 / height
    below = world["horizonNdc"] - ndc_bottom
    if below > 0.03:
        distance = world["cameraHeight"] * focal / below
        distance = min(max(distance, NEAR_DISTANCE), WALL_DISTANCE - 1.0)
        return distance, True
    return WALL_DISTANCE - 1.5 - 0.01 * index, False


def layer_thickness(role, world_size, on_ground):
    smallest = min(world_size)
    if role in CHARACTER_ROLES:
        return round(min(max(0.1 * smallest, 0.06), 0.3), 3)
    factor = 0.4 if on_ground else 0.12
    return round(min(max(factor * smallest, 0.04), 2.5), 3)


def contact_shadow(layer_id, x, y_ground, z, width):
    return {"id": f"shadow-{layer_id}", "kind": "contact-shadow", "layerId": layer_id,
            "position": [round(x, 4), round(y_ground + 0.003, 4), round(z, 4)],
            "radius": [round(width * 0.55, 4), round(width * 0.18, 4)], "opacity": 0.32}
