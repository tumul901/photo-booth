# Template System

This directory contains PNG templates and their metadata configurations.

## Schema

Each template requires a JSON metadata file following `template_schema.json`.

### Key Fields

| Field        | Type   | Description                                     |
| ------------ | ------ | ----------------------------------------------- |
| `templateId` | string | Unique identifier                               |
| `pngUrl`     | string | Path to template PNG with transparent cutouts   |
| `slots[]`    | array  | Photo placement zones (supports multiple slots) |
| `anchorMode` | enum   | Global anchor detection strategy                |

### Slots Array

Each slot defines a photo placement zone:

```json
{
  "slotId": "main",
  "x": 100,
  "y": 200,
  "width": 1000,
  "height": 1000,
  "anchor": {
    "targetX": 500,
    "targetY": 400
  },
  "zIndex": 0
}
```

### Anchor Modes

| Mode          | Description                             |
| ------------- | --------------------------------------- |
| `face_center` | Align by detected face center (default) |
| `eyes`        | Align by eye-line detection             |
| `shoulders`   | Align by shoulder detection             |
| `bbox_center` | Align by sticker bounding box center    |
| `none`        | No anchor adjustment, simple fit        |

## Adding New Templates

1. Create PNG with transparent photo cutout zone(s)
2. Create JSON metadata file with slot coordinates
3. Use the slot coordinates that match the transparent areas in your PNG

## Recommended Specifications

To balance high-quality output with fast processing time, follow these guidelines for your template PNGs:

- **Resolution**: **1080 x 1920** (Portrait) or **1920 x 1080** (Landscape).
- **Quality Balance**: Avoid using 4K or 8K images. While the backend can handle them, they significantly increase processing time for no noticeable gain on sharing screens.
- **File Format**: Save as **Transparent PNG**, optimized for web (aim for < 2MB).
- **Metadata**: Ensure the `dimensions` in your JSON file (width/height) exactly match the pixel dimensions of your PNG file for consistent coordinate mapping.

## Examples

- `example_template.json` - Single slot party frame
- `multi_slot_example.json` - Dual slot photo strip
