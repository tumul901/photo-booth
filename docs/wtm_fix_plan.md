# Fix WTM Final Output — Sticker vs WTM Pipeline Comparison

## Problem

WTM final output shows only the background-removed sticker on white — the composed word template is completely missing. The standard sticker mode works perfectly with the same compose engine.

## Side-by-Side Comparison

I compared the working `doodle2` sticker pipeline with the broken WTM pipeline:

| Aspect | ✅ Sticker (`generate.py`) | ❌ WTM (`wtm.py`) |
|--------|--------------------------|-------------------|
| `template_path` construction | **Absolute**: `os.path.join(TEMPLATES_DIR, meta.png_path)` → `d:\...\templates\doodle2.png` | **Relative**: `composed_template_path` → `templates\wtm_cache\<hash>.png` |
| `TemplateMetadata.png_path` | Basename only: `"doodle2.png"` | Full relative path: `"templates\wtm_cache\<hash>.png"` |
| `template_path` passed to `compose_final()` | Always absolute, always resolves | Relative — depends on CWD |
| Template dimensions | Small (225×400), triggers auto-upscale (4.8×) | Large (1687×3000), multiplier = 1.0 |

## Root Cause

> [!CAUTION]
> **Bug #1 (Critical): `template_path` is a relative path that fails `os.path.exists()` silently.**

In [generate.py:L186](file:///d:/work2/photo-booth/backend/api/generate.py#L186), the sticker pipeline builds an **absolute** template path:
```python
template_path = os.path.join(TEMPLATES_DIR, template_meta.png_path)
# → d:\work2\photo-booth\templates\doodle2.png  (always exists)
```

In [wtm.py:L148-149](file:///d:/work2/photo-booth/backend/api/wtm.py#L148-L149), the WTM pipeline passes the **raw relative path** from the frontend:
```python
final_image = compose_service.compose_final(
    template_path=composed_template_path,  # → "templates\wtm_cache\<hash>.png"
```

This relative path resolves from the **process working directory**. If you start the backend with `cd backend && python -m uvicorn main:app`, the CWD is `backend/`, so the resolved path is `backend/templates/wtm_cache/<hash>.png`.

However, the compose API (`wtm_composer.py`) writes the file using `WTM_CACHE_DIR = Path(settings.WTM_CACHE_DIR)` = `Path("templates/wtm_cache")` — also relative to CWD. So the **compose step** creates the file at `backend/templates/wtm_cache/` BUT returns the string `"templates/wtm_cache/<hash>.png"`.

When **both** the compose and generate run in the same process (same CWD), the path should resolve correctly. But if the CWD ever changes, or if `main.py` lifespan creates directories at a different root, the path breaks.

**Evidence**: The project has TWO independent `wtm_cache` directories:
- `d:\work2\photo-booth\templates\wtm_cache\` — 2 files (2.8MB each) ← created when CWD was project root
- `d:\work2\photo-booth\backend\templates\wtm_cache\` — 1 file (427KB) ← created when CWD was backend/

The `main.py` lifespan at lines 27-28 does:
```python
Path(settings.WTM_TEMPLATES_DIR).mkdir(parents=True, exist_ok=True)
Path(settings.WTM_CACHE_DIR).mkdir(parents=True, exist_ok=True)
```

This creates the directories relative to CWD, and the compose step writes there too. So the compose works. But the `os.path.exists()` check in `compose_final()` line 394 **may use a different CWD context** or the path may be stale from a previous session.

> [!IMPORTANT]
> **The real issue is actually in `compose.py` lines 393-396.** The composed WTM template has a **fully opaque white background** (no alpha transparency). When `alpha_composite` is used with this template on a transparent canvas, it works. Then the sticker is pasted on top. But the sticker (after background removal) is being **scaled to fill the full canvas** rather than being constrained to the `photo_slot` region, effectively covering the entire template.

> [!WARNING]
> **Bug #2 (Visual): Sticker overflows the `photo_slot` and covers the template content.**
> 
> The `photo_slot` is `543×1029` within a `1687×3000` canvas. The sticker after face-anchored scaling is much larger than the slot and `canvas.paste()` has **no clipping** — the sticker extends over the words/doodles. The working `doodle2` template doesn't have this problem because it uses `anchorMode: "none"` (bottom-center) which naturally constrains placement, and the slot proportions are different.

## Proposed Fix

Replicate the sticker pipeline's approach — make `wtm.py` resolve the template path to **absolute** and ensure the compose flow is identical:

### [MODIFY] [wtm.py](file:///d:/work2/photo-booth/backend/api/wtm.py)

1. Resolve `composed_template_path` to an absolute path before passing to `compose_final()`
2. This ensures `os.path.exists()` always works regardless of CWD

```diff
+        # Resolve to absolute path (match sticker pipeline behavior)
+        composed_template_path = os.path.abspath(composed_template_path)
+
         # Validate composed path
         if not os.path.exists(composed_template_path):
```

### [MODIFY] [compose.py](file:///d:/work2/photo-booth/backend/services/compose.py)

Add slot-clipping after sticker placement to prevent overflow. This is what differentiates a full-canvas slot (standard sticker) from a partial-canvas slot (WTM photo_slot):

```diff
             # Paste photo onto canvas
-            canvas.paste(sticker_scaled, (x, y), sticker_scaled)
+            # Clip sticker to slot bounds (critical for WTM where slot != full canvas)
+            sx, sy = s_slot.x, s_slot.y
+            sw, sh = s_slot.width, s_slot.height
+            clip_l = max(0, sx - x)
+            clip_t = max(0, sy - y)
+            clip_r = min(sticker_scaled.width, sx + sw - x)
+            clip_b = min(sticker_scaled.height, sy + sh - y)
+            if clip_r > clip_l and clip_b > clip_t:
+                clipped = sticker_scaled.crop((clip_l, clip_t, clip_r, clip_b))
+                canvas.paste(clipped, (x + clip_l, y + clip_t), clipped)
+            else:
+                canvas.paste(sticker_scaled, (x, y), sticker_scaled)
```

> [!NOTE]
> For standard sticker templates where the slot IS the full canvas, `clip_l=0, clip_t=0, clip_r=full_width, clip_b=full_height` — the clipping is a mathematical no-op, so existing behavior is preserved.

## Open Questions

> [!IMPORTANT]
> **Should clipping always apply?** The clipping math is safe for all cases (no-op when slot = canvas), so I recommend always applying it. This future-proofs any template with a smaller-than-canvas slot.

## Verification Plan

### Manual Verification
1. Start backend from `d:\work2\photo-booth\backend`
2. Run the full WTM wizard: select template → choose words → capture photo → verify output has both template AND photo
3. Also run a standard sticker flow to confirm no regression
