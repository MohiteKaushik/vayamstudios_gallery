"""Exercises open_raw's branches with a stand-in for LibRaw.

A genuine ARW was not to hand, and the risk in open_raw is the branching, not
LibRaw itself: which preview it accepts, when it gives up on one and develops
the sensor data instead.
"""
import sys, types, io
from pathlib import Path
import numpy as np
from PIL import Image

sys.path.insert(0, "tools")
import watch_and_upload as w

class ThumbFormat:
    JPEG = "jpeg"
    BITMAP = "bitmap"

class Thumb:
    def __init__(self, fmt, data):
        self.format, self.data = fmt, data

class FakeRaw:
    def __init__(self, thumb, exc=None):
        self._thumb, self._exc = thumb, exc
        self.postprocessed = False
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def extract_thumb(self):
        if self._exc: raise self._exc
        return self._thumb
    def postprocess(self, **kw):
        self.postprocessed = True
        return np.zeros((3000, 4000, 3), dtype=np.uint8)

def jpeg_bytes(size):
    buf = io.BytesIO()
    Image.new("RGB", size, (120, 60, 30)).save(buf, format="JPEG")
    return buf.getvalue()

NoThumb = type("LibRawNoThumbnailError", (Exception,), {})
BadThumb = type("LibRawUnsupportedThumbnailError", (Exception,), {})

def run(thumb, raise_no_thumb=False):
    # The exception has to be the very class open_raw catches, not merely one
    # with the same name, or the test proves nothing about the except clause.
    raw = FakeRaw(thumb, NoThumb() if raise_no_thumb else None)
    fake = types.SimpleNamespace(
        imread=lambda p: raw,
        ThumbFormat=ThumbFormat,
        LibRawNoThumbnailError=NoThumb,
        LibRawUnsupportedThumbnailError=BadThumb,
    )
    saved_rawpy, saved_ready = w.rawpy, w.RAW_READY
    w.rawpy, w.RAW_READY = fake, True
    try:
        img = w.open_raw(Path("DSC01234.arw"))
        return img.size, raw.postprocessed
    finally:
        w.rawpy, w.RAW_READY = saved_rawpy, saved_ready

fails = 0
def check(name, ok, detail=""):
    global fails
    print(("PASS  " if ok else "FAIL  ") + name + ("  — " + detail if detail else ""))
    if not ok: fails += 1

size, developed = run(Thumb(ThumbFormat.JPEG, jpeg_bytes((4000, 3000))))
check("a full-size JPEG preview is used as is", size == (4000, 3000) and not developed, f"{size}, developed={developed}")

size, developed = run(Thumb(ThumbFormat.JPEG, jpeg_bytes((320, 240))))
check("a postage-stamp preview is rejected and the sensor data developed", developed, f"{size}")

arr = np.zeros((3000, 4000, 3), dtype=np.uint8)
size, developed = run(Thumb(ThumbFormat.BITMAP, arr))
check("a large bitmap preview is used as is", size == (4000, 3000) and not developed, f"{size}")

size, developed = run(Thumb(ThumbFormat.BITMAP, np.zeros((240, 320, 3), dtype=np.uint8)))
check("a small bitmap preview is rejected", developed)

size, developed = run(None, raise_no_thumb=True)
check("a file with no preview at all is developed instead", developed, f"{size}")

w_saved = w.RAW_READY
w.RAW_READY = False
try:
    w.open_raw(Path("DSC01234.arw"))
    check("a missing rawpy is reported clearly", False)
except RuntimeError as e:
    check("a missing rawpy is reported clearly", "pip install rawpy" in str(e), str(e)[:70])
finally:
    w.RAW_READY = w_saved

print("\n" + ("ALL CHECKS PASSED" if fails == 0 else f"{fails} CHECK(S) FAILED"))
sys.exit(0 if fails == 0 else 1)
