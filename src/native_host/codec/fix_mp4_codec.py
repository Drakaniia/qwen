"""
fix_mp4_codec — Post-processing fix for MP4 files with incorrect codec metadata.

Detects and repairs a common yt-dlp remux issue where H.264 video data is
labeled as "mp4v" (MPEG-4 Part 2 Visual) instead of "avc1" (H.264/AVC),
and the esds box is present instead of the required avcC box.

When a player sees "mp4v", it loads an MPEG-4 Part 2 decoder and feeds it
H.264 NAL units, producing green/garbled video.

Fix strategy (avoids size-adjustment bugs):
  1. Replace "mp4v" → "avc1" in-place (same 4-byte length)
  2. Extract SPS/PPS NAL units from the mdat box
  3. Build an avcC box and pad/truncate it to exactly match the esds box size
  4. Overwrite esds box with the padded avcC box in-place (same overall size)
"""

import re
import shutil
from pathlib import Path
from typing import Optional

# ── AVC configuration record builder ──────────────────────────────────────


def _sps_profile_level(sps_nal: bytes) -> tuple[int, int, int]:
    """Extract AVC profile, compatibility, and level from an SPS NAL unit."""
    if len(sps_nal) < 5:
        return (100, 0, 40)  # safe defaults: High Profile, Level 4.0
    offset = 0
    if sps_nal[0:4] == b"\x00\x00\x00\x01":
        offset = 5
    elif sps_nal[0:3] == b"\x00\x00\x01":
        offset = 4
    else:
        offset = 1
    return (sps_nal[offset], sps_nal[offset + 1], sps_nal[offset + 2])


def _strip_start_code(nal: bytes) -> bytes:
    """Remove the start code prefix (0x000001 or 0x00000001) from a NAL unit."""
    if nal[0:4] == b"\x00\x00\x00\x01":
        return nal[4:]
    if nal[0:3] == b"\x00\x00\x01":
        return nal[3:]
    return nal


def _build_avcc_box(sps_list: list[bytes], pps_list: list[bytes]) -> bytes:
    """Build a complete avcC box (box header + AVCConfigurationRecord).

    ISO 14496-15:2014 Section 5.3.4.1.1
    """
    if not sps_list:
        return b""

    profile, compat, level = _sps_profile_level(sps_list[0])
    sps_data = [_strip_start_code(s) for s in sps_list]
    pps_data = [_strip_start_code(p) for p in pps_list]

    record = bytearray()
    record.append(1)  # configurationVersion
    record.append(profile)  # AVCProfileIndication
    record.append(compat)  # profile_compatibility
    record.append(level)  # AVCLevelIndication
    record.append(0xFF | 3)  # lengthSizeMinusOne = 3 (upper bits reserved=1)
    record.append(len(sps_data) & 0x1F)  # numOfSequenceParameterSets
    for s in sps_data:
        record.extend(len(s).to_bytes(2, "big"))
        record.extend(s)
    record.append(len(pps_data) & 0xFF)  # numOfPictureParameterSets
    for p in pps_data:
        record.extend(len(p).to_bytes(2, "big"))
        record.extend(p)

    # Wrap in avcC box (8-byte header).
    # MP4 box size MUST include the 8-byte header (ISOBMFF spec).
    total_size = 8 + len(record)
    return total_size.to_bytes(4, "big") + b"avcC" + bytes(record)


# ── NAL unit extraction ────────────────────────────────────────────────────


def _extract_nal_units(data: bytes, nal_type: int, max_count: int = 5) -> list[bytes]:
    """Extract NAL units of a given type from the bytestream.

    NAL units are separated by 0x00000001 or 0x000001 start codes.
    """
    units = []
    # Find all start code positions
    positions = []
    for m in re.finditer(b"\\x00\\x00\\x01", data):
        pos = m.start()
        if pos > 0 and data[pos - 1] == 0:
            positions.append(pos - 1)  # 4-byte start code
        else:
            positions.append(pos)  # 3-byte start code

    for i, start in enumerate(positions):
        if len(units) >= max_count:
            break
        end = positions[i + 1] if i + 1 < len(positions) else len(data)
        unit = data[start:end]
        if len(unit) < 5:
            continue
        nal_offset = 4 if unit[0:4] == b"\x00\x00\x00\x01" else 3
        if nal_offset < len(unit) and (unit[nal_offset] & 0x1F) == nal_type:
            units.append(unit)
    return units


# ── MP4 box navigation ─────────────────────────────────────────────────────


def _read_box(data: bytes, offset: int) -> tuple[int, bytes, int]:
    """Read an MP4 box at offset. Returns (size, type, payload_offset)."""
    if offset + 8 > len(data):
        return (0, b"", offset)
    size = int.from_bytes(data[offset : offset + 4], "big")
    box_type = data[offset + 4 : offset + 8]
    if size == 0:
        size = len(data) - offset
    elif size == 1:
        if offset + 16 > len(data):
            return (0, b"", offset)
        size = int.from_bytes(data[offset + 8 : offset + 16], "big")
        return (size, box_type, offset + 16)
    return (size, box_type, offset + 8)


def _find_box_in_range(data: bytes, box_type: bytes, start: int, end: int) -> Optional[int]:
    """Find first box of type within [start, end), searching recursively.

    Recursively descends into container boxes (moov, trak, mdia, minf, stbl, etc.)
    to find deeply nested boxes like stsd.
    """
    offset = start
    # Container box types that may contain nested boxes of interest.
    # Use bytes literals (hashable) and compare via bytes() for safety
    # since bytearray slicing returns unhashable bytearray objects.
    CONTAINER_TYPES = (
        b"moov",
        b"trak",
        b"mdia",
        b"minf",
        b"stbl",
        b"dinf",
        b"edts",
        b"udta",
        b"meta",
        b"stsd",
    )  # stsd sample entries (mp4v, avc1, etc.) contain esds/avcC boxes
    while offset + 8 <= end:
        size, btype, payload = _read_box(data, offset)
        if size == 0:
            break
        if offset + size > end:
            break
        # Convert to bytes for hashable comparison (data may be bytearray)
        btype_bytes = bytes(btype) if isinstance(btype, bytearray) else btype
        if btype_bytes == box_type:
            return offset
        # If this is a container box (including stsd sample entries), recurse into it
        if btype_bytes in CONTAINER_TYPES and size > 8:
            found = _find_box_in_range(data, box_type, payload, offset + size)
            if found is not None:
                return found
        # Also recurse into any box where the payload starts with a valid sub-box
        # (size field + 4-char ASCII type). This handles codec sample entries like
        # mp4v/avc1 which have fixed-size fields before sub-boxes (esds, avcC).
        # We attempt to read a box at payload+offset and check if the type is ASCII.
        elif size > 12 and payload + 8 <= offset + size:
            # Try to read a candidate sub-box at the payload start
            child_sz = int.from_bytes(
                data[payload : payload + 4] if isinstance(data, bytearray) else data[payload : payload + 4],
                "big",
            )
            child_bt = bytes(data[payload + 4 : payload + 8])
            # Valid box: size within bounds, type is 4 ASCII chars
            if 8 <= child_sz <= size - 8 and all(32 < c < 127 for c in child_bt):
                found = _find_box_in_range(data, box_type, payload, offset + size)
                if found is not None:
                    return found
        offset += size
    return None


# ── Main fix function ──────────────────────────────────────────────────────


def needs_codec_fix(filepath: str) -> bool:
    """Check if an MP4 file has mp4v → avc1 codec metadata issue."""
    path = Path(filepath)
    if not path.is_file() or path.suffix.lower() not in (".mp4", ".m4v"):
        return False
    try:
        data = path.read_bytes()
    except (OSError, PermissionError):
        return False
    moov_offset = _find_box_in_range(data, b"moov", 0, len(data))
    if moov_offset is None:
        return False
    _, _, moov_payload = _read_box(data, moov_offset)
    stsd_offset = _find_box_in_range(data, b"stsd", moov_payload, moov_payload + 200000)
    if stsd_offset is None:
        return False
    _, _, stsd_payload = _read_box(data, stsd_offset)
    check_end = min(stsd_payload + 2048, len(data))
    return data.find(b"mp4v", stsd_payload, check_end) >= 0


def fix_mp4_codec_metadata(filepath: str, backup: bool = True) -> dict:
    """Fix mp4v → avc1 codec metadata in a downloaded MP4 file.

    Strategy: Replace the esds box in-place with a padded avcC box,
    so no size adjustments are needed anywhere else in the file.
    """
    path = Path(filepath)
    if not path.is_file():
        return {"ok": False, "fixed": False, "error": "File not found", "filepath": filepath}

    try:
        data = bytearray(path.read_bytes())
    except (OSError, PermissionError) as exc:
        return {"ok": False, "fixed": False, "error": str(exc), "filepath": filepath}

    # ── Step 1: Find moov box by scanning from file start ─────────────
    moov_offset = _find_box_in_range(data, b"moov", 0, len(data))
    if moov_offset is None:
        return {"ok": False, "fixed": False, "error": "No moov box", "filepath": filepath}

    _, _, moov_payload = _read_box(data, moov_offset)
    stsd_offset = _find_box_in_range(data, b"stsd", moov_payload, moov_payload + 200000)
    if stsd_offset is None:
        return {"ok": False, "fixed": False, "error": "No stsd box", "filepath": filepath}

    _, _, stsd_payload = _read_box(data, stsd_offset)

    mp4v_offset = data.find(b"mp4v", stsd_payload, stsd_payload + 1024)
    if mp4v_offset < 0:
        return {
            "ok": False,
            "fixed": False,
            "error": "No mp4v entry (codec already correct)",
            "filepath": filepath,
        }

    # ── Step 2: Replace mp4v → avc1 (always same size) ─────────────────
    data[mp4v_offset : mp4v_offset + 4] = b"avc1"

    # ── Step 3: Find esds box to replace ───────────────────────────────
    # Use raw find() like we do for mp4v — sample entries have fixed-size
    # reserved fields before sub-boxes, so recursive box parsing fails.
    esds_type_pos = data.find(b"esds", stsd_payload, stsd_payload + 2048)
    if esds_type_pos < 0:
        return {
            "ok": True,
            "fixed": True,
            "warning": "mp4v→avc1 patched but no esds box to replace",
            "filepath": filepath,
        }
    # Box header is 4 bytes before the type field
    esds_offset = esds_type_pos - 4
    esds_size = int.from_bytes(data[esds_offset:esds_type_pos], "big")
    if esds_size < 12 or esds_offset + esds_size > stsd_payload + 2048:
        return {
            "ok": True,
            "fixed": True,
            "warning": "mp4v→avc1 patched but esds box too small",
            "filepath": filepath,
        }

    # ── Step 4: Extract SPS/PPS from mdat ──────────────────────────────
    mdat_offset = _find_box_in_range(data, b"mdat", 0, len(data))
    search_start = mdat_offset if mdat_offset is not None else moov_offset
    search_end = min(search_start + 5_000_000, len(data))  # check first 5MB of mdat
    mdat_data = bytes(data[search_start:search_end])

    sps_list = _extract_nal_units(mdat_data, 7, max_count=2)  # NAL type 7 = SPS
    pps_list = _extract_nal_units(mdat_data, 8, max_count=4)  # NAL type 8 = PPS

    if not sps_list:
        # No H.264 SPS found — revert the mp4v change
        data[mp4v_offset : mp4v_offset + 4] = b"mp4v"
        return {
            "ok": False,
            "fixed": False,
            "error": "No H.264 SPS NAL units found — not H.264 video",
            "filepath": filepath,
        }

    # ── Step 5: Build avcC and pad/truncate to match esds size ────────
    avcc_box = _build_avcc_box(sps_list, pps_list)
    if not avcc_box or len(avcc_box) < 12:
        data[mp4v_offset : mp4v_offset + 4] = b"mp4v"
        return {"ok": False, "fixed": False, "error": "Failed to build avcC box", "filepath": filepath}

    # Pad or truncate avcC to exactly match the esds box size.
    # This avoids any size adjustments to parent boxes.
    if len(avcc_box) < esds_size:
        avcc_box = avcc_box + b"\x00" * (esds_size - len(avcc_box))
    elif len(avcc_box) > esds_size:
        # Truncate — the avcC box header + config record is small, this is safe
        avcc_box = avcc_box[:esds_size]

    data[esds_offset : esds_offset + esds_size] = avcc_box

    # ── Step 6: Write the fixed file ───────────────────────────────────
    try:
        if backup:
            backup_path = path.with_suffix(path.suffix + ".bak")
            shutil.copy2(str(path), str(backup_path))

        path.write_bytes(bytes(data))
        return {
            "ok": True,
            "fixed": True,
            "filepath": str(path),
            "spsCount": len(sps_list),
            "ppsCount": len(pps_list),
            "avccSize": len(avcc_box),
            "esdsSize": esds_size,
            "backup": str(backup_path) if backup else "",
        }
    except (OSError, PermissionError) as exc:
        if mp4v_offset >= 0:
            data[mp4v_offset : mp4v_offset + 4] = b"mp4v"
        return {"ok": False, "fixed": False, "error": str(exc), "filepath": filepath}


# ── CLI entry point ────────────────────────────────────────────────────────


if __name__ == "__main__":
    import sys as _sys

    # Force UTF-8 for print() to avoid UnicodeEncodeError on Windows
    if hasattr(_sys.stdout, "reconfigure"):
        _sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = _sys.argv[1:]
    if not args:
        print("Usage: python fix_mp4_codec.py <filepath> [--no-backup]")
        _sys.exit(1)
    filepath = args[0]
    backup = "--no-backup" not in args
    print(f"Checking: {filepath}")
    if needs_codec_fix(filepath):
        print("mp4v codec detected - applying fix...")
        result = fix_mp4_codec_metadata(filepath, backup=backup)
        print(f"Result: {result}")
        if result.get("fixed"):
            print("Fix applied successfully")
            _sys.exit(0)
        else:
            print(f"Fix failed: {result.get('error', 'unknown')}")
            _sys.exit(1)
    else:
        print("No mp4v codec issue detected - file is OK")
        _sys.exit(0)
