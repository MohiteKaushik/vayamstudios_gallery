#!/usr/bin/env python3
"""
Watches a folder and uploads new photographs to the VAYAM gallery.

Point it at the folder the camera's card empties into. Every new photograph
that appears is uploaded to one event, once, and then remembered so that
restarting the script does not upload it again.

    pip install requests pillow rawpy pillow-heif
    python watch_and_upload.py

WHAT IT CAN READ

JPEG, PNG, WebP, AVIF, TIFF, BMP and GIF out of the box. HEIC, which is what an
iPhone writes, if pillow-heif is installed. Raw files from every common camera,
ARW and CR3 and NEF and the rest, if rawpy is installed. Everything is converted
to JPEG before it is uploaded, so the gallery only ever sees one format.

A camera set to raw plus JPEG writes two files for one press of the shutter.
Both are found, and only one is uploaded: the JPEG, because it is the picture
the camera already developed and it opens in a fraction of the time.

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

import argparse
import json
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

# HEIC and HEIF, which is what an iPhone writes by default. Optional, because
# the camera at an event is usually not a phone, and a missing decoder should
# cost those files rather than the whole run.
try:
    import pillow_heif

    pillow_heif.register_heif_opener()
    HEIF_READY = True
except ImportError:
    HEIF_READY = False

# Raw files: ARW, CR2, CR3, NEF and the rest. Pillow cannot read any of them,
# so this is LibRaw through rawpy. Also optional, and the run says so clearly
# the first time it meets a raw file it cannot open.
try:
    import rawpy

    RAW_READY = True
except ImportError:
    RAW_READY = False


HERE = Path(__file__).resolve().parent
SETTINGS_FILE = HERE / "watcher.json"
UPLOADED_FILE = HERE / "uploaded.json"

# What a camera or a phone might drop into the folder.
#
# Everything is converted to JPEG before it is uploaded, so this list is about
# what can be READ, not what the gallery stores. A photographer shooting raw
# plus JPEG gets both files for one frame; the pairing below sends one of them.
RAW_SUFFIXES = {
    ".arw", ".srf", ".sr2",          # Sony
    ".cr2", ".cr3", ".crw",          # Canon
    ".nef", ".nrw",                  # Nikon
    ".raf",                          # Fujifilm
    ".orf",                          # Olympus and OM System
    ".rw2",                          # Panasonic
    ".pef", ".ptx",                  # Pentax
    ".srw",                          # Samsung
    ".dng",                          # Adobe, and many phones
    ".3fr",                          # Hasselblad
    ".erf",                          # Epson
    ".kdc", ".dcr",                  # Kodak
    ".mrw",                          # Minolta
    ".x3f",                          # Sigma
    ".iiq",                          # Phase One
    ".rwl",                          # Leica
    ".raw",
}
HEIF_SUFFIXES = {".heic", ".heif"}
PLAIN_SUFFIXES = {
    ".jpg", ".jpeg", ".jpe", ".png", ".webp", ".avif",
    ".tif", ".tiff", ".bmp", ".gif",
}
SUFFIXES = RAW_SUFFIXES | HEIF_SUFFIXES | PLAIN_SUFFIXES

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


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Watches a folder and uploads new photographs to the VAYAM gallery.",
    )
    p.add_argument("--folder", help="Folder to watch. Asked for if not given.")
    p.add_argument("--email", help="Operator email. Asked for if not given.")
    p.add_argument("--event", help="Event name or id to upload into.")
    p.add_argument("--url", help="Gallery address.")
    p.add_argument(
        "--check",
        action="store_true",
        help="Open every file in the folder and report what can be read. Uploads nothing.",
    )
    p.add_argument(
        "--once",
        action="store_true",
        help="Upload what is already there and stop, instead of watching.",
    )
    return p.parse_args()


def ask(prompt: str, default: str = "", preset: str = "") -> str:
    """A question, unless the answer was already given on the command line."""
    if preset:
        print(f"{prompt}: {preset}")
        return preset
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


def choose_collection(
    session: requests.Session, base: str, s: Settings, wanted: str = ""
) -> None:
    r = session.get(f"{base}/api/collections", timeout=30)
    r.raise_for_status()
    events = r.json().get("collections", [])
    if not events:
        raise SystemExit("There are no events yet. Create one in the console first.")

    if wanted:
        match = next(
            (e for e in events if e["id"] == wanted or e["name"].lower() == wanted.lower()),
            None,
        )
        if not match:
            names = ", ".join(e["name"] for e in events)
            raise SystemExit(f"No event called '{wanted}'. There is: {names}")
        s.collection_id = match["id"]
        s.collection_name = match["name"]
        print(f"Uploading into: {match['name']}")
        return

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


def open_raw(path: Path) -> Image.Image:
    """
    Reads a raw file, preferring the preview the camera already made.

    Every raw file carries a JPEG preview, usually at or near full size, which
    the camera produced with its own processing. Pulling that out takes
    milliseconds. Demosaicing the sensor data instead takes a second or more per
    frame and, for our purposes, looks no better: the gallery shrinks it to 2048
    pixels and a face detector runs over it.

    So the preview is the fast path and a full decode is the fallback, for the
    rare file whose preview is missing or postage-stamp sized.
    """
    if not RAW_READY:
        raise RuntimeError(
            f"{path.suffix.upper().lstrip('.')} files need the rawpy package:  pip install rawpy"
        )

    with rawpy.imread(str(path)) as raw:
        try:
            thumb = raw.extract_thumb()
        except (rawpy.LibRawNoThumbnailError, rawpy.LibRawUnsupportedThumbnailError):
            thumb = None

        if thumb is not None:
            if thumb.format == rawpy.ThumbFormat.JPEG:
                from io import BytesIO

                preview = Image.open(BytesIO(thumb.data))
                # A tiny preview is worse than decoding properly. Anything at
                # least as wide as we store is plenty.
                if max(preview.size) >= STORE_MAX_EDGE:
                    return ImageOps.exif_transpose(preview)
            elif thumb.format == rawpy.ThumbFormat.BITMAP:
                preview = Image.fromarray(thumb.data)
                if max(preview.size) >= STORE_MAX_EDGE:
                    return preview

        # No usable preview: develop the sensor data. Camera white balance,
        # because the whole point is that it looks like what the photographer
        # saw on the back of the camera.
        rgb = raw.postprocess(use_camera_wb=True, no_auto_bright=False, output_bps=8)
        return Image.fromarray(rgb)


def open_image(path: Path) -> Image.Image:
    """Opens anything in SUFFIXES, whatever it takes."""
    suffix = path.suffix.lower()

    if suffix in RAW_SUFFIXES:
        return open_raw(path)

    if suffix in HEIF_SUFFIXES and not HEIF_READY:
        raise RuntimeError(
            "HEIC files need the pillow-heif package:  pip install pillow-heif"
        )

    return ImageOps.exif_transpose(Image.open(path))


def prepare(path: Path, max_edge: int) -> tuple[bytes, int, int]:
    """Rotates by EXIF, shrinks to fit, and re-encodes as JPEG."""
    from io import BytesIO

    img = open_image(path)
    try:
        # A PNG with transparency, or a raw developed to 16 bits, has to become
        # plain RGB before it can be a JPEG. Transparency flattens onto white
        # rather than black, which is what a photograph expects.
        if img.mode in ("RGBA", "LA", "P"):
            flattened = Image.new("RGB", img.size, (255, 255, 255))
            converted = img.convert("RGBA")
            flattened.paste(converted, mask=converted.split()[-1])
            img = flattened
        elif img.mode != "RGB":
            img = img.convert("RGB")

        img.thumbnail((max_edge, max_edge), Image.LANCZOS)
        width, height = img.size

        buffer = BytesIO()
        img.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        return buffer.getvalue(), width, height
    finally:
        img.close()

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


def readable_formats() -> list[str]:
    """What this machine can actually open, said plainly before the event starts."""
    names = ["JPEG", "PNG", "WebP", "AVIF", "TIFF", "BMP", "GIF"]
    if HEIF_READY:
        names.append("HEIC")
    if RAW_READY:
        names.append("raw (ARW, CR2, CR3, NEF, DNG and others)")
    return names


def pick_files(folder: Path, done: dict[str, str]) -> list[Path]:
    """
    What to upload next, with raw-plus-JPEG pairs resolved to one file.

    A camera set to raw plus JPEG writes two files for one press of the shutter:
    DSC01234.ARW and DSC01234.JPG. They are the same photograph. Uploading both
    puts every frame in the gallery twice, and every guest finds themselves
    twice.

    When both are there, the JPEG wins. It is the picture the camera already
    developed, it opens in a fraction of the time, and it needs no extra
    package on whichever laptop is doing this.
    """
    files = [
        p for p in folder.iterdir()
        if p.is_file() and p.suffix.lower() in SUFFIXES
    ]

    developed = {
        p.stem.lower() for p in files if p.suffix.lower() in PLAIN_SUFFIXES | HEIF_SUFFIXES
    }
    chosen = [
        p for p in files
        if not (p.suffix.lower() in RAW_SUFFIXES and p.stem.lower() in developed)
    ]
    return sorted(p for p in chosen if p.name not in done)


def check_folder(folder: Path) -> int:
    """
    Opens everything in the folder and says what happened, uploading nothing.

    This is the thing to run before an event, with a few real files from the
    camera that will be used on the day. It answers the only question that
    matters in advance: can this machine read what that camera writes? Finding
    out at the event, with a card full of ARW files and no rawpy, is expensive.
    """
    files = sorted(p for p in folder.iterdir() if p.is_file())
    if not files:
        print(f"There is nothing in {folder}")
        return 0

    chosen = {p.name for p in pick_files(folder, {})}
    failures = 0

    print(f"\nCan read: {', '.join(readable_formats())}")
    print(f"\n{len(files)} file(s) in {folder}\n")

    for path in files:
        suffix = path.suffix.lower()
        if suffix not in SUFFIXES:
            print(f"  ignored   {path.name}  (not an image)")
            continue
        if path.name not in chosen:
            print(f"  paired    {path.name}  (the developed copy is uploaded instead)")
            continue
        try:
            data, width, height = prepare(path, STORE_MAX_EDGE)
            print(f"  ok        {path.name}  -> {width}x{height}, {len(data) // 1024} KB")
        except Exception as e:  # noqa: BLE001 - reporting every failure is the point
            failures += 1
            print(f"  CANNOT    {path.name}  -> {e}")

    print()
    if failures:
        print(f"{failures} file(s) could not be read. Fix that before the event.")
    else:
        print("Everything here can be uploaded.")
    return failures


def settled(path: Path) -> bool:
    """True once the file has stopped growing, so it is finished copying."""
    try:
        first = path.stat().st_size
        time.sleep(SETTLE_SECONDS)
        return first == path.stat().st_size and first > 0
    except OSError:
        return False


def main() -> None:
    args = parse_args()
    s = load_settings()

    # Checking what can be read needs no account and no network, so it happens
    # before any of the questions. Point it at a card from the camera that will
    # be used on the day and it answers the one question worth answering early.
    if args.check:
        folder = Path(args.folder or s.folder or HERE).expanduser().resolve()
        if not folder.is_dir():
            raise SystemExit(f"There is no folder at {folder}")
        raise SystemExit(1 if check_folder(folder) else 0)

    s.base_url = ask(
        "Gallery address",
        s.base_url or "https://vayamstudios-gallery.vayamdesigners.workers.dev",
        args.url or "",
    ).rstrip("/")
    s.email = ask("Operator email", s.email, args.email or "")
    s.folder = ask("Folder to watch", s.folder or str(HERE), args.folder or "")

    folder = Path(s.folder).expanduser().resolve()
    if not folder.is_dir():
        raise SystemExit(f"There is no folder at {folder}")
    s.folder = str(folder)

    password = os.environ.get("VAYAM_PASSWORD") or getpass("Operator password (not saved): ")

    session = requests.Session()
    sign_in(session, s.base_url, s.email, password)
    choose_collection(session, s.base_url, s, args.event or "")
    save_settings(s)

    done = load_uploaded()
    print("\nCan read: " + ", ".join(readable_formats()))
    if not RAW_READY or not HEIF_READY:
        missing = []
        if not RAW_READY:
            missing.append("rawpy, for ARW, CR3, NEF and other raw files")
        if not HEIF_READY:
            missing.append("pillow-heif, for HEIC from iPhones")
        print("Not installed: " + "; ".join(missing))
        print("  pip install " + " ".join(
            name for name, ok in (("rawpy", RAW_READY), ("pillow-heif", HEIF_READY)) if not ok
        ))

    print(f"\nWatching {folder}")
    print(f"Uploading into '{s.collection_name}'")
    print(f"{len(done)} photo(s) already uploaded and will be skipped.")
    print("\nNow open that event in the console and press 'Live indexing',")
    print("or nobody will be able to search these photographs.")
    if args.once:
        print("\nUploading what is already there, then stopping.\n")
    else:
        print("\nPress Ctrl+C to stop.\n")

    while True:
        try:
            candidates = pick_files(folder, done)
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
            if args.once:
                print(f"\nDone. {len(done)} photo(s) uploaded in total.")
                return
            time.sleep(POLL_SECONDS)
        except KeyboardInterrupt:
            print(f"\nStopped. {len(done)} photo(s) uploaded in total.")
            return


if __name__ == "__main__":
    main()
