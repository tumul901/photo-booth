"""
Fetch corporate-looking sample portraits from Pexels into one flat folder.

    cd backend
    venv/Scripts/python.exe scripts/fetch_portraits.py

Needs PEXELS_API_KEY in backend/.env (gitignored). Free key: pexels.com/api

Pexels rather than Openverse: Openverse indexes Flickr-style documentary
photography, so "businessman portrait" there returns street and gig photos.
Pexels is stock, which is what "corporate headshot" actually means.

Over-fetches a few per query so there is something to choose from, then you keep
the ten that work. Pexels licence allows commercial use without attribution, but
manifest.json records the photographer anyway.
"""
import json
import os
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT.parent / "docs" / "test-photos" / "portraits"
API = "https://api.pexels.com/v1/search"

# Two per country, one man one woman, so the ten cover the four countries evenly.
QUERIES = [
    "indian businessman portrait",
    "indian businesswoman portrait",
    "american businessman headshot",
    "american businesswoman headshot",
    "filipino businessman portrait",
    "filipino businesswoman portrait",
    "south african businessman portrait",
    "south african businesswoman portrait",
]
PER_QUERY = 3


def load_key() -> str:
    key = os.environ.get("PEXELS_API_KEY", "").strip()
    if key:
        return key
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.strip().startswith("PEXELS_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("PEXELS_API_KEY not found — add it to backend/.env")


def main() -> None:
    key = load_key()
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = []
    n = 0
    for q in QUERIES:
        try:
            r = requests.get(
                API,
                params={"query": q, "per_page": PER_QUERY, "orientation": "portrait"},
                headers={"Authorization": key},
                timeout=30,
            )
            r.raise_for_status()
            photos = r.json().get("photos", [])
        except Exception as exc:
            print(f"  !! {q}: {exc}")
            continue

        for p in photos:
            # "large" is ~940px on the long edge — plenty, since the booth
            # pipeline works off a cutout well under that.
            url = (p.get("src") or {}).get("large")
            if not url:
                continue
            n += 1
            dest = OUT / f"c{n:02d}.jpg"
            try:
                img = requests.get(url, timeout=30)
                img.raise_for_status()
                dest.write_bytes(img.content)
            except Exception as exc:
                print(f"  !! c{n:02d}: {exc}")
                n -= 1
                continue
            manifest.append({
                "file": dest.name, "query": q,
                "photographer": p.get("photographer"),
                "source": p.get("url"), "licence": "Pexels licence",
            })
            print(f"  {dest.name}  {len(img.content) // 1024}KB  {q}")
        time.sleep(0.3)

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{len(manifest)} candidates -> {OUT}")


if __name__ == "__main__":
    main()
