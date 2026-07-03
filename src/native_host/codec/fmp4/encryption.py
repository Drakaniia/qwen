"""Encrypted segment detection — sinf, pssh, schm, tenc, frma boxes."""

from .container import parse_boxes
from .iso_box import ISOBox


def has_encryption_boxes(boxes: list[ISOBox]) -> bool:
    """Check if any encryption-related boxes are present.

    Looks for sinf (protection scheme info), frma (original format),
    schm (scheme type), tenc (track encryption), and pssh (PSSH data).
    Recursively scans both children and raw data of non-container boxes.
    """
    encryption_types = {"sinf", "frma", "schm", "tenc", "pssh"}
    for box in boxes:
        if box.type in encryption_types:
            return True
        if box.children and has_encryption_boxes(box.children):
            return True
        # Also scan raw data of non-container boxes that may contain
        # encryption sub-boxes (e.g. sinf is not a container but holds schm)
        if not box.children and box.data:
            nested = parse_boxes(box.data)
            if has_encryption_boxes(nested):
                return True
    return False


def detect_encryption(boxes: list[ISOBox]) -> dict:
    """Detect encryption scheme and extract PSSH boxes from init segment.

    Returns dict with:
      - has_cenc: bool
      - scheme_type: str (e.g. 'cenc', 'cbcs')
      - pssh_boxes: list[bytes] (raw PSSH data per key system)

    Recursively scans both children and raw data of non-container boxes
    to find encryption-related boxes at any nesting level.
    """
    result = {"has_cenc": False, "scheme_type": "", "pssh_boxes": []}

    def _merge_nested(nested: dict):
        if nested["has_cenc"]:
            result["has_cenc"] = True
            result["pssh_boxes"].extend(nested["pssh_boxes"])
            if not result["scheme_type"]:
                result["scheme_type"] = nested["scheme_type"]

    encryption_types = {"sinf", "frma", "schm", "tenc", "pssh"}

    for box in boxes:
        # Type check — the presence of any encryption box indicates encryption
        if box.type in encryption_types:
            result["has_cenc"] = True

        if box.type == "pssh":
            result["pssh_boxes"].append(box.data)

        if box.type == "schm":
            if len(box.data) >= 8:
                scheme = box.data[4:8].decode("latin-1", errors="replace")
                result["scheme_type"] = scheme

        # Recurse into children
        if box.children:
            _merge_nested(detect_encryption(box.children))

        # Recurse into raw data of non-container boxes that may contain
        # encryption sub-boxes (e.g. sinf holds schm but is not a container)
        if not box.children and box.data:
            nested = parse_boxes(box.data)
            if nested:
                _merge_nested(detect_encryption(nested))

    return result
