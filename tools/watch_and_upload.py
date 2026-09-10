#!/usr/bin/env python3
"""
Watches a folder and uploads new photographs to the VAYAM gallery.

Point it at the folder the camera's card empties into. Every new photograph
that appears is uploaded to one event, once, and then remembered so that
restarting the script does not upload it again.

    pip install requests pillow
    python watch_and_upload.py

It will ask for whatever it needs the first time and write the answers to
watcher.json beside itself, except the password, which is never written down.

WHAT THIS DOES NOT DO

It does not find faces. Face detection runs in a browser, on a canvas, with a
model this script has no way to use. So the photographs it uploads are stored
and visible immediately, but nobody can search for themselves in them until a
browser has looked at them.

That is one step, on the machine running the console:

    Open the event, press "Live indexing", leave the tab open.

It watches for photographs with no faces recorded yet and reads them as they
arrive, which is exactly what this script produces. The two halves are separate
on purpose: this can run on a borrowed laptop while the console runs on yours.

ON CREDENTIALS

Sign in as the operator account. If somebody else is running this on their
machine, they are signing in as your operator, which lets them upload to and
delete from every event. Prefer running it yourself; if you cannot, change the
operator password afterwards.
"""

from __future__ import annotations

import json
import mimetypes
import os
import sys
import time
from dataclasses import dataclass
from getpass import getpass
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("This needs the requests package:  pip install requests pillow")

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("This needs the Pillow package:  pip install requests pillow")


HERE = Path(__file__).resolve().parent
SETTINGS_FILE = HERE / "watcher.json"
UPLOADED_FILE = HERE / "uploaded.json"

SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".avif", ".heic", ".heif"}

# Matches STORE_MAX_EDGE and THUMB_MAX_EDGE in the app. Uploading the camera's
# full frame would waste the card's worth of bandwidth on a phone hotspot, and
# the gallery would only shrink it anyway.
STORE_MAX_EDGE = 2048
THUMB_MAX_EDGE = 512
JPEG_QUALITY = 86

# A file still being written by the card reader has a size that keeps changing.
# Uploading it half-written gives a truncated image nobody notices until later.
SETTLE_SECONDS = 2.0
POLL_SECONDS = 3.0


@dataclass
class Settings:
    base_url: str
    email: str
    folder: str
    collection_id: str
    collection_name: str


def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    answer = input(f"{prompt}{suffix}: ").strip()
    return answer or default


def load_settings() -> Settings:
    if SETTINGS_FILE.exists():
        data = json.loads(SETTINGS_FILE.read_text("utf-8"))
        return Settings(**data)
    return Settings("", "", "", "", "")


def save_settings(s: Settings) -> None:
    SETTINGS_FILE.write_text(json.dumps(s.__dict__, indent=2), "utf-8")


def load_uploaded() -> dict[str, str]:
    if UPLOADED_FILE.exists():
        try:
            return json.loads(UPLOADED_FILE.read_text("utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def save_uploaded(done: dict[str, str]) -> None:
    UPLOADED_FILE.write_text(json.dumps(done, indent=2), "utf-8")


def sign_in(session: requests.Session, base: str, email: str, password: str) -> None:
    r = session.post(
        f"{base}/api/auth/signin",
        json={"email": email, "password": password},
        timeout=30,
    )
    if not r.ok:
        raise SystemExit(f"Sign-in failed: {r.status_code} {r.text[:200]}")
    me = session.get(f"{base}/api/me", timeout=30).json()
    if me.get("role") != "admin":
        raise SystemExit("That account is not an operator, so it cannot upload.")
    print(f"Signed in as {me.get('email')}")


def choose_collection(session: requests.Session, base: str, s: Settings) -> None:
    r = session.get(f"{base}/api/collections", timeout=30)
    r.raise_for_status()
    events = r.json().get("collections", [])
    if not events:
        raise SystemExit("There are no events yet. Create one in the console first.")

    if s.collection_id and any(e["id"] == s.collection_id for e in events):
        current = next(e for e in events if e["id"] == s.collection_id)
        s.collection_name = current["name"]
        keep = ask(f"Upload into '{current['name']}'? (y/n)", "y")
        if keep.lower().startswith("y"):
            return

    print("\nEvents:")
    for i, e in enumerate(events, 1):
        print(f"  {i}. {e['name']}  ({e.get('photoCount', 0)} photos)")
    while True:
        pick = ask("Which one (number)")
        if pick.isdigit() and 1 <= int(pick) <= len(events):
            chosen = events[int(pick) - 1]
            s.collection_id = chosen["id"]
            s.collection_name = chosen["name"]
            return
        print("  Pick one of the numbers listed.")


def prepare(path: Path, max_edge: int) -> tuple[bytes, int, int]:
    """Rotates by EXIF, shrinks to fit, and re-encodes as JPEG."""
    with Image.open(path) as img:
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
        img.thumbnail((max_edge, max_edge), Image.LANCZOS)
        width, height = img.size
        from io import BytesIO

        buffer = BytesIO()
        img.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        return buffer.getvalue(), width, height


def upload(session: requests.Session, base: str, s: Settings, path: Path) -> str:
    full, width, height = prepare(path, STORE_MAX_EDGE)

    r = session.post(
        f"{base}/media/upload",
        params={"collection": s.collection_id},
        data=full,
        headers={
            "content-type": "image/jpeg",
            "x-file-name": path.name,
            "x-width": str(width),
            "x-height": str(height),
        },
        timeout=120,
    )
    if not r.ok:
        raise RuntimeError(f"{r.status_code} {r.text[:200]}")
    photo_id = r.json()["photoId"]

    # The grid shows thumbnails. Without one it falls back to the full image,
    # which works and makes a phone download the whole event to scroll it.
    thumb, _, _ = prepare(path, THUMB_MAX_EDGE)
    session.post(
        f"{base}/media/upload",
        params={"collection": s.collection_id, "photo": photo_id, "kind": "thumb"},
        data=thumb,
        headers={"content-type": "image/jpeg"},
        timeout=60,
    )
    return photo_id


def settled(path: Path) -> bool:
    """True once the file has stopped growing, so it is finished copying."""
    try:
        first = path.stat().st_size
        time.sleep(SETTLE_SECONDS)
        return first == path.stat().st_size and first > 0
    except OSError:
        return False


def main() -> None:
    s = load_settings()
    s.base_url = ask("Gallery address", s.base_url or "https://vayamstudios-gallery.vayamdesigners.workers.dev").rstrip("/")
    s.email = ask("Operator email", s.email)
    s.folder = ask("Folder to watch", s.folder or str(HERE))

    folder = Path(s.folder).expanduser().resolve()
    if not folder.is_dir():
        raise SystemExit(f"There is no folder at {folder}")
    s.folder = str(folder)

    password = os.environ.get("VAYAM_PASSWORD") or getpass("Operator password (not saved): ")

    session = requests.Session()
    sign_in(session, s.base_url, s.email, password)
    choose_collection(session, s.base_url, s)
    save_settings(s)

    done = load_uploaded()
    print(f"\nWatching {folder}")
    print(f"Uploading into '{s.collection_name}'")
    print(f"{len(done)} photo(s) already uploaded and will be skipped.")
    print("\nNow open that event in the console and press 'Live indexing',")
    print("or nobody will be able to search these photographs.")
    print("\nPress Ctrl+C to stop.\n")

    while True:
        try:
            candidates = sorted(
                p for p in folder.iterdir()
                if p.is_file() and p.suffix.lower() in SUFFIXES and p.name not in done
            )
            for path in candidates:
                if not settled(path):
                    continue
                try:
                    photo_id = upload(session, s.base_url, s, path)
                    done[path.name] = photo_id
                    save_uploaded(done)
                    print(f"  uploaded  {path.name}")
                except Exception as e:  # noqa: BLE001 - one bad file must not stop the event
                    print(f"  FAILED    {path.name}: {e}")
                    # A session can expire during a long event. Signing in again
                    # is cheaper than making somebody notice and restart this.
                    if "401" in str(e) or "Not signed in" in str(e):
                        print("  signing in again…")
                        try:
                            sign_in(session, s.base_url, s.email, password)
                        except SystemExit as bad:
                            print(f"  could not sign in again: {bad}")
            time.sleep(POLL_SECONDS)
        except KeyboardInterrupt:
            print(f"\nStopped. {len(done)} photo(s) uploaded in total.")
            return


if __name__ == "__main__":
    main()
