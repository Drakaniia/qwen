"""Init segment parsing — ftyp, moov, and track metadata extraction."""

import struct

from .container import parse_boxes_hierarchical
from .encryption import detect_encryption
from .iso_box import ISOBox


def parse_ftyp(box: ISOBox) -> dict:
    """Parse a File Type Box (ftyp).

    Returns dict with major_brand, minor_version, compatible_brands list.
    """
    data = box.data
    major = data[0:4].decode("latin-1", errors="replace")
    minor = struct.unpack_from(">I", data, 4)[0]
    brands = []
    for i in range(8, len(data), 4):
        if i + 4 <= len(data):
            brands.append(data[i : i + 4].decode("latin-1", errors="replace"))
    return {"major_brand": major, "minor_version": minor, "compatible_brands": brands}


def parse_mvhd(box: ISOBox) -> dict:
    """Parse a Movie Header Box (mvhd).

    Returns dict with timescale, duration (seconds).
    """
    data = box.data
    version = data[0]
    if version == 0:
        timescale = struct.unpack_from(">I", data, 12)[0]
        duration = struct.unpack_from(">I", data, 16)[0]
    else:
        # version 1: 8 bytes each
        timescale = struct.unpack_from(">I", data, 20)[0]
        duration_hi = struct.unpack_from(">I", data, 24)[0]
        duration_lo = struct.unpack_from(">I", data, 28)[0]
        duration = (duration_hi << 32) | duration_lo
    duration_secs = duration / timescale if timescale > 0 else 0
    return {"timescale": timescale, "duration": duration, "duration_seconds": duration_secs}


def parse_tkhd(box: ISOBox) -> dict:
    """Parse a Track Header Box (tkhd).

    Returns dict with track_id, width, height (in pixels from 16.16 fixed-point).
    """
    data = box.data
    version = data[0]
    if version == 0:
        track_id = struct.unpack_from(">I", data, 12)[0]
    else:
        track_id = struct.unpack_from(">I", data, 20)[0]

    width_fixed = struct.unpack_from(">I", data, len(data) - 8)[0]
    height_fixed = struct.unpack_from(">I", data, len(data) - 4)[0]
    width = width_fixed / 65536.0
    height = height_fixed / 65536.0

    return {"track_id": track_id, "width": width, "height": height}


def parse_hdlr(box: ISOBox) -> str:
    """Parse a Handler Reference Box (hdlr). Returns the handler type string."""
    data = box.data
    return data[8:12].decode("latin-1", errors="replace")


def parse_stsd(box: ISOBox) -> list[dict]:
    """Parse a Sample Description Box (stsd).

    Returns list of dicts with format codec info per track entry.
    """
    data = box.data
    entries = struct.unpack_from(">I", data, 4)[0]
    results = []
    offset = 8
    for _ in range(entries):
        if offset + 8 > len(data):
            break
        size = struct.unpack_from(">I", data, offset)[0]
        format_type = data[offset + 4 : offset + 8].decode("latin-1", errors="replace")

        entry_data = data[offset : offset + size] if offset + size <= len(data) else data[offset:]
        results.append(
            {
                "format": format_type,
                "data_size": size,
                "data": entry_data,
            }
        )
        offset += size
    return results


def parse_init_segment(data: bytes) -> dict:
    """Parse an fMP4 init segment (ftyp + moov) and return track metadata.

    Args:
        data: Raw bytes of the init segment.

    Returns:
        Dict with keys: major_brand, compatible_brands, timescale, duration,
        duration_seconds, tracks (list of track dicts).
    """
    boxes = parse_boxes_hierarchical(data)

    result = {
        "major_brand": "",
        "compatible_brands": [],
        "timescale": 0,
        "duration": 0,
        "duration_seconds": 0,
        "tracks": [],
        "has_cenc": False,
        "pssh_boxes": [],
    }

    # Parse ftyp
    for box in boxes:
        if box.type == "ftyp":
            result.update(parse_ftyp(box))
            break

    # Detect encryption from the parsed boxes (before moov guard to run once)
    encryption = detect_encryption(boxes)
    if encryption["has_cenc"]:
        result["has_cenc"] = True
        result["pssh_boxes"] = encryption["pssh_boxes"]
        if encryption["scheme_type"]:
            result["scheme_type"] = encryption["scheme_type"]

    # Find moov
    moov = None
    for box in boxes:
        if box.type == "moov":
            moov = box
            break

    if moov is None:
        return result

    # Parse mvhd from moov children
    for child in moov.children:
        if child.type == "mvhd":
            result.update(parse_mvhd(child))
            break

    # Parse tracks from trak children
    for trak in (c for c in moov.children if c.type == "trak"):
        track = {
            "track_id": 0,
            "handler_type": "",
            "width": 0,
            "height": 0,
            "codec_string": "",
            "language": "und",
        }

        for child in trak.children:
            if child.type == "tkhd":
                track.update(parse_tkhd(child))

            if child.type == "mdia":
                for mdia_child in child.children:
                    if mdia_child.type == "hdlr":
                        track["handler_type"] = parse_hdlr(mdia_child)
                    if mdia_child.type == "minf":
                        for minf_child in mdia_child.children:
                            if minf_child.type == "stbl":
                                for stbl_child in minf_child.children:
                                    if stbl_child.type == "stsd":
                                        entries = parse_stsd(stbl_child)
                                        if entries:
                                            track["codec_string"] = entries[0]["format"]

        result["tracks"].append(track)

    return result


def is_cmaf(data: bytes) -> bool:
    """Check if the given data contains a CMAF-compatible ftyp brand.

    CMAF (Common Media Application Format) uses 'cmfv' for video
    and 'cmfa' for audio as the major brand or compatible brand.

    Args:
        data: Raw bytes containing at least an ftyp box (e.g. init segment).

    Returns:
        True if 'cmfv' or 'cmfa' is found as brand in the ftyp box.
    """
    import struct

    offset = 0
    while offset + 8 <= len(data):
        size = struct.unpack_from(">I", data, offset)[0]
        box_type = data[offset + 4 : offset + 8].decode("latin-1")

        if box_type == "ftyp":
            payload_offset = offset + 8
            payload_end = offset + size if size > 1 else len(data)
            if size == 1:
                payload_offset = offset + 16
            if payload_offset + 8 > payload_end:
                return False  # payload too short for brands

            payload = data[payload_offset:payload_end]
            # Check major brand
            if len(payload) >= 4:
                major = payload[0:4].decode("latin-1")
                if major in ("cmfv", "cmfa"):
                    return True
            # Check compatible brands
            for i in range(8, len(payload), 4):
                if i + 4 <= len(payload):
                    brand = payload[i : i + 4].decode("latin-1")
                    if brand in ("cmfv", "cmfa"):
                        return True
            return False

        if size == 0:
            break
        offset += size

    return False
