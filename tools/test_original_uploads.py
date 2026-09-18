"""Offline uploader tests: python -m unittest discover -s tools -p 'test_*.py'."""
import hashlib
import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import Mock, patch

from PIL import Image

# No HTTP client is needed: the session is supplied by each test.
with patch.dict(sys.modules, {"requests": Mock()}):
    import watch_and_upload as uploader


class OriginalUploadTests(unittest.TestCase):
    def test_original_bytes_and_separate_thumbnail(self):
        for fmt, suffix, mime in [("JPEG", ".jpg", "image/jpeg"), ("PNG", ".png", "image/png")]:
            with self.subTest(fmt=fmt), tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / ("photo" + suffix)
                with Image.new("RGB", (3000, 2100), (180, 50, 90)) as image:
                    exif = Image.Exif()
                    exif[274] = 6
                    image.save(path, format=fmt, exif=exif)
                original = path.read_bytes()
                session = Mock()
                session.post.return_value.ok = True
                session.post.return_value.json.return_value = {"photoId": "test-photo"}
                settings = uploader.Settings("https://test.local", "", folder, "event", "Test")
                uploader.upload(session, settings.base_url, settings, path)
                full, thumb = session.post.call_args_list
                self.assertEqual(hashlib.sha256(full.kwargs["data"]).digest(), hashlib.sha256(original).digest())
                self.assertEqual(full.kwargs["headers"]["content-type"], mime)
                self.assertEqual(full.kwargs["headers"]["x-width"], "2100")
                self.assertEqual(full.kwargs["headers"]["x-height"], "3000")
                self.assertEqual(thumb.kwargs["params"]["kind"], "thumb")
                with Image.open(BytesIO(thumb.kwargs["data"])) as preview:
                    self.assertLessEqual(max(preview.size), 512)

    def test_unsupported_file_is_not_silently_converted(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "photo.tiff"
            with Image.new("RGB", (20, 20)) as image:
                image.save(path)
            with self.assertRaisesRegex(ValueError, "never converted"):
                uploader.prepare_original(path)


if __name__ == "__main__":
    unittest.main()
