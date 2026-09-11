# Uploading photographs during an event

Two things have to be running. They can be on different machines.

## 1. The uploader, next to the camera

Double-click **Start uploading.bat**.

The first time it asks four things and remembers all of them except the
password:

| It asks | Answer |
|---|---|
| Gallery address | Press Enter to accept the default |
| Operator email | `vayamdesigners@gmail.com` |
| Folder to watch | The folder the camera's card empties into |
| Which event | Pick the number from the list it prints |

Then leave the window open. Every photograph that appears in that folder is
uploaded once, and the window prints each filename as it goes. Closing the
window stops it; nothing already uploaded is lost, and starting it again picks
up where it left off rather than uploading everything twice.

It waits about two seconds after spotting a file, so a photograph still being
copied off the card is never uploaded half-written.

## What it can read

| Format | Needs |
|---|---|
| JPEG, PNG, WebP, AVIF, TIFF, BMP, GIF | nothing extra |
| HEIC and HEIF, what an iPhone writes | `pillow-heif` |
| Raw: ARW, CR2, CR3, NEF, DNG, ORF, RAF, RW2, PEF, SRW and the rest | `rawpy` |

**Start uploading.bat** installs all of it. Everything is converted to JPEG
before it goes up, so the gallery only ever holds one format.

A camera set to raw plus JPEG writes two files for one press of the shutter,
`DSC01234.ARW` and `DSC01234.JPG`. Both are found and one is uploaded: the
JPEG, because it is the picture the camera already developed and it opens in a
fraction of the time. Without this every frame would appear twice and every
guest would find themselves twice.

For a raw file with no JPEG beside it, the full-size preview inside the raw is
used where there is one, which is quick. Where there is not, the sensor data is
developed with the camera's own white balance, which takes about a second a
frame.

### Check this before the event

Put a handful of files straight from the camera you will use on the day into a
folder, and run:

```
python watch_and_upload.py --check --folder "D:\card"
```

It opens every one and prints what it could read, uploading nothing and asking
for no password. Finding out at the event, with a full card of ARW files and no
`rawpy` installed, is expensive.

## 2. The console, anywhere

Open the event on the Live Event tab and press **Live indexing**. Leave that
tab open.

This is not optional. The uploader cannot find faces: that needs a browser,
which is what this tab is. Photographs it uploads are stored and visible
immediately, but nobody can search for themselves in them until this tab has
read them. It picks up new arrivals within a few seconds and the green dot says
how many it has done.

## If somebody else runs the uploader

They sign in as your operator account, which lets them upload to and delete
from every event. Run it yourself where you can. If you cannot, change the
operator password after the event.

## Running it from a terminal instead

```
pip install requests pillow
python watch_and_upload.py
```

Options, all optional, for skipping the questions:

```
python watch_and_upload.py --folder "D:\event" --event "CareerNexus 2025" --once
```

`--once` uploads what is already in the folder and stops, which is the quickest
way to check it works. `VAYAM_PASSWORD` in the environment skips the password
prompt.
