# HOW TO USE THESE FILES

## Files in This Package
```
context.md              <- Architecture, rules, patterns, API. ALWAYS in context.
schema.json             <- All data models, field names, validation rules. ALWAYS in context.
impl-01-backend-core.md    <- Session 1: schemas, config loader, cache, utils
impl-02-backend-api.md     <- Session 2: composer, guest router, admin router
impl-03-admin-ui.md        <- Session 3: WTM admin tab + slot/word/bundle managers
impl-04-guest-wizard.md    <- Session 4: word selection step + all modified screens
prompt-template.md      <- This file
```

## Commit Location
Put all files in `/docs/wtm/` at your project root before starting.
```
photo-booth/
└── docs/
    └── wtm/
        ├── context.md
        ├── schema.json
        ├── impl-01-backend-core.md
        ├── impl-02-backend-api.md
        ├── impl-03-admin-ui.md
        ├── impl-04-guest-wizard.md
        └── prompt-template.md
```

---

## Session Start Prompt (copy-paste every time, change X and name)

```
Read /docs/wtm/context.md and /docs/wtm/schema.json first.
Then read /docs/wtm/impl-0X-name.md.

Before writing any code:
1. Read every file listed under "Files to Modify" in the impl doc
2. Read every file listed under "DO NOT MODIFY" in context.md
3. Confirm you understand the existing patterns you must follow
4. List what you've read

Then implement all files in "Files to Create".
Then apply all changes in "Files to Modify" — surgical only, nothing extra.
Then write all required tests from the impl doc.

Hard rules:
- Use exact field names from schema.json. Do not rename anything.
- Follow every pattern in context.md marked "Follow These Exactly".
- Do not modify any file listed as DO NOT MODIFY.
- Do not implement anything in "Out of Scope".
- Every new .tsx component needs a matching .module.css file.
- If something is ambiguous, ask before implementing.
```

---

## Session Order

| Session | Impl File | Start when |
|---------|-----------|-----------|
| 1 | impl-01-backend-core.md | Immediately |
| 2 | impl-02-backend-api.md | Session 1 complete |
| 3 | impl-03-admin-ui.md | Session 1 complete |
| 4 | impl-04-guest-wizard.md | Session 1 complete |

Sessions 2, 3, 4 can all run in parallel after session 1 is done.

---

## Three Things to Say Explicitly Before Critical Code

### Before any canvas code (Session 3 — WTMSlotEditor):
```
IMPORTANT: Follow the EXACT same coordinate pattern as TemplateEditor.tsx.
- scale = canvas.width / image.naturalWidth (set after image loads)
- Stored slot x, y, width, height are ALWAYS in original image pixels
- Mouse input → image pixels: divide by scale (same as TemplateEditor's getImageCoords)
- Image pixels → display: multiply by scale (same as TemplateEditor's redrawCanvas)
- Minimum slot size: 50×50 image pixels — matches TemplateEditor (width > 50 && height > 50)
Do not invent a different pattern.
```

### Before the async lock code (Session 2 — wtm_composer.py):
```
IMPORTANT: Implement the double-check pattern inside the per-hash lock exactly as written.
After acquiring the lock, re-check disk before compositing.
Do NOT simplify this away. It prevents duplicate compositing on concurrent requests.
```

### Before page.tsx changes (Session 4):
```
IMPORTANT:
- WordSelectionStep renders ONLY at step===3 AND processingMode==='word_template'
- CaptureScreen renders at step===3 (frame/sticker) OR step===4 (word_template)
- ResultScreen renders at step===4 (frame/sticker) OR step===5 (word_template)
- The existing step 1→2→3→4 flow for frame/sticker must remain IDENTICAL to today
- Check generate.py before touching executeGeneration — do not modify generate.py
```

---

## Verification Checklist — Run After Each Session

### After Session 1
- [ ] backend/schemas/ directory created (NOT backend/models/)
- [ ] backend/utils/ directory created
- [ ] WTM_TEMPLATES_DIR and WTM_CACHE_DIR read from settings, not hardcoded
- [ ] SlotDefinition has ge=50 on width and height (NOT ge=20)
- [ ] config.py has exactly 2 new lines added (WTM_TEMPLATES_DIR and WTM_CACHE_DIR)
- [ ] wtm_cache singleton exported as `wtm_cache = WTMCache(max_size=200)`
- [ ] load_all_configs() does not raise even if zero valid templates exist
- [ ] Slot order gap validation present (sorted orders must equal [0,1,...,n-1])

### After Session 2
- [ ] main.py uses lifespan() — startup added inside it, NOT @app.on_event
- [ ] main.py router registration uses exact prefix strings from context.md
- [ ] WTM dirs created in lifespan() before load_all_configs()
- [ ] `import services.compose as compose_service` — NOT compose_service.py
- [ ] compose_service.clear_template_cache() AND wtm_cache.clear() both called in _save_raw_config()
- [ ] Double-check inside async lock is present in compose_template()
- [ ] selected_words sorted before make_cache_key() call
- [ ] Word delete atomically removes word from all bundles
- [ ] SVG filename is always {word_id}.svg — never the raw uploaded filename
- [ ] SVG upload validates .endswith('.svg')
- [ ] PNG upload validates content_type == 'image/png'

### After Session 3
- [ ] Only 4 lines changed in admin/page.tsx (type, button, render, import)
- [ ] TemplateEditor.tsx not touched
- [ ] admin.py not touched
- [ ] Every new component has a .module.css file
- [ ] Slot minimum size is 50×50 in handleMouseUp (NOT 20)
- [ ] Scale factor pattern matches TemplateEditor.tsx exactly
- [ ] word_id validated ^[a-z0-9-]+$ client-side before form submit
- [ ] SVG extension validated client-side before form submit

### After Session 4
- [ ] frame/sticker flow steps 1→2→3→4 unchanged — test this manually
- [ ] WordSelectionStep only shown when processingMode === 'word_template'
- [ ] StepIndicator receives processingMode prop
- [ ] effectiveMax = Math.min(maxSelections, slotCount) in hook
- [ ] Back button disabled during compose loading
- [ ] handleBack clears selectedWords + composedTemplatePath when going back from WTM step 3
- [ ] handleStartOver clears selectedWords + composedTemplatePath
- [ ] TemplateSelector fetches from /api/admin/wtm/templates when mode is word_template
- [ ] TemplateSelector maps template_id (snake_case) → templateId (camelCase) for WTM templates
- [ ] StartScreen has 3 mode cards — existing 2 untouched
- [ ] generate.py not modified
- [ ] WordTile has no internal state — all from props
