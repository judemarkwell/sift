"""Image uploads.

Every image is decoded and re-encoded on the server, which:
  * proves it really is an image (the file extension isn't trusted),
  * removes EXIF and other metadata (GPS location, camera serials),
  * downscales it so the long edge is at most MAX_EDGE, which keeps the
    token cost predictable.

Cost: Claude counts an image as ceil(w/28) * ceil(h/28) input tokens
(https://platform.claude.com/docs/en/build-with-claude/vision), so a
1568x1176 photo is 56 * 42 = 2,352 tokens. Because the whole conversation
is re-sent each turn, an image is paid for again on every later message.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_EDGE = 1568
MAX_PIXELS = 8000 * 8000
ALLOWED = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "GIF": "image/png"}

Image.MAX_IMAGE_PIXELS = MAX_PIXELS  # refuse decompression bombs


class ImageError(ValueError):
    pass


@dataclass
class Processed:
    data: bytes
    media_type: str
    width: int
    height: int
    original_width: int
    original_height: int
    original_bytes: int
    metadata_removed: bool

    @property
    def tokens(self) -> int:
        return image_tokens(self.width, self.height)


def image_tokens(width: int, height: int) -> int:
    return math.ceil(width / 28) * math.ceil(height / 28)


def process(raw: bytes) -> Processed:
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ImageError("Images can be up to 10 MB.")
    try:
        img = Image.open(io.BytesIO(raw))
        fmt = img.format
        img.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ImageError("That file isn't an image Sift can read. Use PNG, JPEG, WebP or GIF.") from exc
    if fmt not in ALLOWED:
        raise ImageError("Use PNG, JPEG, WebP or GIF.")

    had_metadata = bool(img.getexif()) or "exif" in img.info or "xmp" in img.info
    ow, oh = img.size
    img = ImageOps.exif_transpose(img)  # keep the orientation the camera recorded, then drop the tag
    if fmt == "GIF":
        img.seek(0)  # animations aren't supported; the first frame is what the model sees
    scale = min(1.0, MAX_EDGE / max(img.size))
    if scale < 1.0:
        img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)

    out = io.BytesIO()
    media_type = ALLOWED[fmt]
    if media_type == "image/jpeg":
        img.convert("RGB").save(out, "JPEG", quality=88, optimize=True)
    elif media_type == "image/webp":
        img.save(out, "WEBP", quality=88)
    else:
        if img.mode not in ("RGB", "RGBA", "L", "LA", "P"):
            img = img.convert("RGBA")
        img.save(out, "PNG", optimize=True)
    return Processed(
        data=out.getvalue(),
        media_type=media_type,
        width=img.width,
        height=img.height,
        original_width=ow,
        original_height=oh,
        original_bytes=len(raw),
        metadata_removed=had_metadata,
    )
