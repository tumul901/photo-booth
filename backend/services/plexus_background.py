"""
Plexus Background Service
=========================
The low-poly triangulated network the watercolor portrait sits on: irregular
facets graded warm on one side and cool on the other, thin connecting edges, and
a scatter of brighter shards.

Generated rather than loaded from an asset, for two reasons. It has to render at
any canvas size the templates ask for without an artist re-exporting, and it has
to follow the event's colour theme — the same background in orange and blue
without maintaining two files.

Deterministic by construction: the point layout is seeded from the canvas size
and theme, so the same template always produces the same background. A booth that
generated a different backdrop per guest would look like a bug rather than a
design, and prints from one event would not sit together as a set.
"""

from functools import lru_cache

import cv2
import numpy as np

from services.cartoon_service import get_theme


def _seed_for(width: int, height: int, theme: str) -> int:
    return (width * 73856093) ^ (height * 19349663) ^ (hash(theme) & 0xFFFF)


@lru_cache(maxsize=16)
def generate_plexus(
    width: int,
    height: int,
    theme: str = "orange",
    *,
    density: float = 1.0,
    edge_opacity: float = 0.55,
    shard_count: int = 26,
) -> np.ndarray:
    """
    Render the plexus field as an RGB array.

    Args:
        width/height:  Canvas size in pixels.
        theme:         Theme name; supplies the warm accent and the base tone.
        density:       Multiplier on facet count. Facet SIZE is held roughly
                       constant in pixels, so a 1920-wide canvas gets more
                       triangles rather than bigger ones — otherwise the same
                       artwork would read as coarse mosaic on one template and
                       fine mesh on another.
        edge_opacity:  Strength of the connecting lines over the facet fills.
        shard_count:   Number of bright accent fragments.

    Returns:
        (height, width, 3) uint8 RGB.

    Cached on its arguments — the background is identical for every guest on a
    given template, so it is built once per process rather than per photo.
    """
    palette = get_theme(theme)
    base = np.array(palette["backdrop"], np.float32)
    warm = np.array(palette["accent"], np.float32)
    cool = np.array(palette["triangle"], np.float32)

    rng = np.random.default_rng(_seed_for(width, height, theme))

    # ── Point field ──
    # A jittered grid rather than uniform random: pure random clumps, and the
    # empty patches between clumps triangulate into long thin slivers that read
    # as glitches instead of facets.
    cell = max(40.0, 96.0 / max(density, 0.2))
    cols = max(int(width / cell) + 2, 3)
    rows = max(int(height / cell) + 2, 3)
    gx, gy = np.meshgrid(
        np.linspace(-cell, width + cell, cols),
        np.linspace(-cell, height + cell, rows),
    )
    jitter = cell * 0.42
    pts = np.stack([
        gx.ravel() + rng.uniform(-jitter, jitter, gx.size),
        gy.ravel() + rng.uniform(-jitter, jitter, gy.size),
    ], axis=1).astype(np.float32)

    # ── Delaunay ──
    pad = int(cell * 2)
    subdiv = cv2.Subdiv2D((-pad, -pad, width + pad, height + pad))
    for p in pts:
        try:
            subdiv.insert((float(p[0]), float(p[1])))
        except cv2.error:
            continue

    canvas = np.tile(base, (height, width, 1))
    edges = np.zeros((height, width), np.float32)

    for t in subdiv.getTriangleList():
        tri = t.reshape(3, 2)
        if not np.isfinite(tri).all() or np.abs(tri).max() > max(width, height) * 4:
            continue
        cx = float(np.clip(tri[:, 0].mean() / max(width, 1), 0.0, 1.0))
        cy = float(np.clip(tri[:, 1].mean() / max(height, 1), 0.0, 1.0))

        # Warm on the left, cool on the right, as in the reference. The vertical
        # term keeps the field from reading as a flat two-stop gradient.
        mix = cx * 0.85 + cy * 0.15
        tint = warm * (1.0 - mix) + cool * mix
        strength = 0.05 + 0.11 * float(rng.random())
        col = base + (tint - base) * strength

        ipts = np.round(tri).astype(np.int32)
        cv2.fillConvexPoly(canvas, ipts, tuple(float(c) for c in col), cv2.LINE_AA)
        cv2.polylines(edges, [ipts], True, 1.0, 1, cv2.LINE_AA)

    if edge_opacity > 0:
        line_tint = (warm + cool) * 0.5
        a = np.clip(edges * edge_opacity, 0.0, 1.0)[..., None]
        canvas = canvas * (1.0 - a * 0.5) + line_tint * (a * 0.5)

    # ── Shards ──
    # Small bright fragments, warm-biased toward the left where the accent lives.
    for _ in range(max(shard_count, 0)):
        sx = float(rng.random())
        px = sx * width
        py = float(rng.random()) * height
        size = cell * (0.06 + 0.16 * float(rng.random()))
        col = warm if sx < 0.55 else cool
        shard = np.array([
            [px, py - size], [px + size * 0.8, py], [px, py + size], [px - size * 0.8, py],
        ], np.float32)
        rot = float(rng.random()) * 3.14159
        c, s = np.cos(rot), np.sin(rot)
        ctr = shard.mean(axis=0)
        shard = (shard - ctr) @ np.array([[c, -s], [s, c]], np.float32) + ctr
        cv2.fillConvexPoly(canvas, np.round(shard).astype(np.int32),
                           tuple(float(v) for v in col * 0.85), cv2.LINE_AA)

    # A soft vignette keeps attention on the portrait rather than the corners.
    yy, xx = np.mgrid[0:height, 0:width]
    r = np.sqrt(((xx / width - 0.5) * 2) ** 2 + ((yy / height - 0.5) * 2) ** 2)
    vig = np.clip(1.0 - 0.30 * np.clip(r - 0.45, 0, None) / 0.85, 0.62, 1.0)[..., None]

    return np.clip(canvas * vig, 0, 255).astype(np.uint8)
