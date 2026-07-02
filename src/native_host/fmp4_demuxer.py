"""ISO Base Media File Format (ISO BMFF) box parser for fMP4 demuxing.

Provides low-level box parsing for fragmented MP4 files, supporting:
- 32-bit and 64-bit (extended) box sizes
- Container box recursion (moov, trak, moof, etc.)
- Both flat (all leaves) and hierarchical (nested tree) output modes
- Init segment parsing (ftyp + moov) for track metadata extraction
- Movie fragment (moof) parsing for per-track sample info
- Demuxing of samples across multiple segments grouped by track ID
- Reassembly into valid flat MP4 (ftyp + moov + mdat)
- Encrypted segment detection (sinf, pssh, schm, tenc boxes)
"""

import struct
from typing import Optional

# ─── Constants ─────────────────────────────────────────────────────────────

BOX_TYPE_CONTAINERS = frozenset(
    {
        "moov",
        "trak",
        "mdia",
        "minf",
        "stbl",
        "moof",
        "traf",
        "mvex",
        "edts",
        "dinf",
        "udta",
        "meco",
        "mere",
        "skip",
    }
)


# ─── ISOBox ────────────────────────────────────────────────────────────────


class ISOBox:
    """Represents a single ISO BMFF box.

    Attributes:
        size: Total box size in bytes (including header).
        type: 4-character box type code (e.g. 'ftyp', 'moov', 'mdat').
        data: Raw box payload (everything after header). For container
              boxes when parsed hierarchically, this is the raw nested data.
        children: List of child ISOBox objects (populated in hierarchical mode).
        offset: Byte offset of this box in the original data.
    """

    __slots__ = ("size", "type", "data", "children", "offset")

    def __init__(self, size: int, type_: str, data: bytes, offset: int = 0):
        self.size = size
        self.type = type_
        self.data = data
        self.children: list["ISOBox"] = []
        self.offset = offset

    def __repr__(self) -> str:
        return (
            f"ISOBox(type={self.type!r}, size={self.size}, data_len={len(self.data)}, n_children={len(self.children)})"
        )


# ─── Container detection ──────────────────────────────────────────────────


def is_container_box(box_type: str) -> bool:
    """Check if a box type is a container that can hold child boxes."""
    return box_type in BOX_TYPE_CONTAINERS


# ─── Low-level parsing ────────────────────────────────────────────────────


def _parse_box_at(data: bytes, offset: int) -> tuple[Optional[ISOBox], int]:
    """Parse a single ISO BMFF box at the given offset.

    Returns:
        Tuple of (ISOBox | None, new_offset).
        Returns (None, offset) if data is too short for a header.
    """
    if offset + 8 > len(data):
        return None, offset

    size = struct.unpack_from(">I", data, offset)[0]
    box_type = data[offset + 4 : offset + 8].decode("latin-1")

    header_size = 8
    if size == 1:
        # 64-bit extended size
        if offset + 16 > len(data):
            return None, offset
        large_size = struct.unpack_from(">Q", data, offset + 8)[0]
        size = large_size
        header_size = 16
    elif size == 0:
        # Box extends to end of file
        size = len(data) - offset

    if offset + size > len(data):
        # Truncated box — parse what we can
        size = len(data) - offset
        if size < 8:
            return None, offset

    payload_offset = offset + header_size
    payload_end = offset + size
    payload = data[payload_offset:payload_end]

    box = ISOBox(size, box_type, payload, offset=offset)

    return box, offset + size


# ─── Flat parsing (all leaves) ────────────────────────────────────────────


def parse_boxes(data: bytes) -> list[ISOBox]:
    """Parse ISO BMFF boxes into a flat list of non-container leaf boxes.

    Container boxes (moov, trak, etc.) are recursed into; their child
    boxes are added to the flat list. Container boxes themselves are NOT
    included in the output.

    Args:
        data: Raw bytes of the MP4 file or segment.

    Returns:
        List of ISOBox objects, each representing a leaf (non-container) box.
    """
    result: list[ISOBox] = []
    offset = 0

    while offset < len(data):
        box, new_offset = _parse_box_at(data, offset)
        if box is None:
            break

        if is_container_box(box.type):
            # Recurse into container
            result.extend(parse_boxes(box.data))
        else:
            result.append(box)

        offset = new_offset

    return result


# ─── Hierarchical parsing (preserves tree structure) ──────────────────────


def parse_boxes_hierarchical(data: bytes) -> list[ISOBox]:
    """Parse ISO BMFF boxes into a hierarchical tree.

    Container boxes are returned with their children populated.
    Non-container boxes are returned as leaf nodes.

    Args:
        data: Raw bytes of the MP4 file or segment.

    Returns:
        List of ISOBox objects at the top level. Container boxes have
        their ``children`` attribute populated.
    """
    result: list[ISOBox] = []
    offset = 0

    while offset < len(data):
        box, new_offset = _parse_box_at(data, offset)
        if box is None:
            break

        if is_container_box(box.type):
            box.children = parse_boxes_hierarchical(box.data)

        result.append(box)
        offset = new_offset

    return result


# ─── Query helpers ───────────────────────────────────────────────────────


def find_box(boxes: list[ISOBox], box_type: str) -> Optional[ISOBox]:
    """Find the first box of a given type in a flat box list.

    Args:
        boxes: List of ISOBox objects (flat, from ``parse_boxes``).
        box_type: 4-character type code to find.

    Returns:
        The first matching ISOBox, or None if not found.
    """
    for box in boxes:
        if box.type == box_type:
            return box
        if box.children:
            found = find_box(box.children, box_type)
            if found is not None:
                return found
    return None


def find_boxes(boxes: list[ISOBox], box_type: str) -> list[ISOBox]:
    """Find all boxes of a given type in a flat box list.

    Args:
        boxes: List of ISOBox objects.
        box_type: 4-character type code to find.

    Returns:
        List of all matching ISOBox objects (empty if none found).
    """
    result: list[ISOBox] = []
    for box in boxes:
        if box.type == box_type:
            result.append(box)
        if box.children:
            result.extend(find_boxes(box.children, box_type))
    return result


# ─── Init Segment Parsing ─────────────────────────────────────────────────


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


# ─── CMAF Detection ────────────────────────────────────────────────────────


def is_cmaf(data: bytes) -> bool:
    """Check if the given data contains a CMAF-compatible ftyp brand.

    CMAF (Common Media Application Format) uses 'cmfv' for video
    and 'cmfa' for audio as the major brand or compatible brand.

    Args:
        data: Raw bytes containing at least an ftyp box (e.g. init segment).

    Returns:
        True if 'cmfv' or 'cmfa' is found as brand in the ftyp box.
    """
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


# ─── Moof Parsing ─────────────────────────────────────────────────────────


def parse_moof(data: bytes) -> list[dict]:
    """Parse a Movie Fragment Box (moof) and return per-track fragment info.

    Args:
        data: Raw bytes of the moof box (including header).

    Returns:
        List of dicts, each with keys: track_id, sample_count, sequence_number,
        sample_sizes (list of ints), data_offset.
    """
    boxes = parse_boxes_hierarchical(data)

    # Find the top-level moof
    moof_box = None
    for box in boxes:
        if box.type == "moof":
            moof_box = box
            break

    if moof_box is None:
        return []

    # Extract sequence number from mfhd
    sequence_number = 0
    for child in moof_box.children:
        if child.type == "mfhd":
            if len(child.data) >= 8:
                sequence_number = struct.unpack_from(">I", child.data, 4)[0]
            break

    fragments = []

    # Parse each traf
    for traf in (c for c in moof_box.children if c.type == "traf"):
        track_id = 0
        base_data_offset = 0
        sample_sizes = []
        data_offset = 0

        for traf_child in traf.children:
            if traf_child.type == "tfhd":
                # tfhd: version(1) + flags(3) + track_id(4) + optional fields
                tfhd_data = traf_child.data
                if len(tfhd_data) >= 8:
                    tfhd_flags_raw = struct.unpack_from(">I", tfhd_data, 0)[0]
                    tfhd_flags = tfhd_flags_raw & 0x00FFFFFF
                    track_id = struct.unpack_from(">I", tfhd_data, 4)[0]

                    offset = 8
                    if tfhd_flags & 0x000001:  # base-data-offset-present
                        if offset + 8 <= len(tfhd_data):
                            base_data_offset = struct.unpack_from(">Q", tfhd_data, offset)[0]
                            offset += 8

            if traf_child.type == "trun":
                # trun: version(1) + flags(3) + sample_count(4) + optional fields
                trun_data = traf_child.data
                if len(trun_data) < 8:
                    continue

                trun_version = trun_data[0]
                trun_flags_raw = struct.unpack_from(">I", trun_data, 0)[0]
                trun_flags = trun_flags_raw & 0x00FFFFFF
                sample_count = struct.unpack_from(">I", trun_data, 4)[0]

                trun_offset = 8

                if trun_flags & 0x000001:  # data-offset-present
                    if trun_offset + 4 <= len(trun_data):
                        data_offset = struct.unpack_from(">i", trun_data, trun_offset)[0]
                        trun_offset += 4

                if trun_flags & 0x000004:  # first-sample-flags-present
                    trun_offset += 4

                # Parse per-sample fields
                sample_sizes = []
                for _ in range(sample_count):
                    sample_size = None
                    if trun_flags & 0x1000:  # sample-size-present
                        if trun_offset + 4 <= len(trun_data):
                            sample_size = struct.unpack_from(">I", trun_data, trun_offset)[0]
                            trun_offset += 4
                    if trun_flags & 0x0100:  # sample-duration-present
                        if trun_offset + 4 <= len(trun_data):
                            trun_offset += 4
                    if trun_flags & 0x0200:  # sample-flags-present
                        if trun_offset + 4 <= len(trun_data):
                            trun_offset += 4
                    if trun_flags & 0x0400:  # sample-composition-time-offset-present
                        size = 4 if trun_version == 1 else 2
                        if trun_offset + size <= len(trun_data):
                            trun_offset += size

                    if sample_size is not None:
                        sample_sizes.append(sample_size)

        if track_id > 0:
            fragments.append(
                {
                    "track_id": track_id,
                    "sample_count": len(sample_sizes),
                    "sample_sizes": sample_sizes,
                    "sequence_number": sequence_number,
                    "data_offset": data_offset,
                    "base_data_offset": base_data_offset,
                }
            )

    return fragments


# ─── Demux Streams ────────────────────────────────────────────────────────


def _extract_mdat_from_segment(seg_data: bytes) -> Optional[bytes]:
    """Extract the mdat payload from a segment (moof + mdat pair).

    Args:
        seg_data: Raw segment bytes containing moof + mdat.

    Returns:
        The mdat payload bytes, or None if not found.
    """
    offset = 0
    while offset + 8 <= len(seg_data):
        size = struct.unpack_from(">I", seg_data, offset)[0]
        box_type = seg_data[offset + 4 : offset + 8].decode("latin-1")

        if box_type == "mdat":
            header_size = 8
            if size == 1:
                if offset + 16 > len(seg_data):
                    return None
                header_size = 16
            elif size == 0:
                size = len(seg_data) - offset

            payload_offset = offset + header_size
            payload_end = offset + size
            if payload_end > len(seg_data):
                payload_end = len(seg_data)
            return seg_data[payload_offset:payload_end]

        if size == 0:
            break
        if size == 1:
            if offset + 16 > len(seg_data):
                break
            offset += 16
        else:
            offset += size

    return None


def demux_streams(init_seg: bytes, media_segs: list[bytes]) -> dict[int, list[bytes]]:
    """Demux fMP4 media segments into per-track sample lists.

    Segments are processed in mfhd sequence number order to ensure
    correct temporal ordering of samples across tracks.

    Args:
        init_seg: Raw init segment bytes (ftyp + moov) for context.
        media_segs: List of media segment bytes (moof + mdat pairs).

    Returns:
        Dict mapping track_id -> list of sample data bytes.
    """
    tracks: dict[int, list[bytes]] = {}

    # Sort segments by mfhd sequence number for correct ordering
    segs_with_seq = []
    for seg_data in media_segs:
        seq = _extract_sequence_number(seg_data)
        segs_with_seq.append((seq, seg_data))
    segs_with_seq.sort(key=lambda x: x[0])

    for _seq, seg_data in segs_with_seq:
        fragments = parse_moof(seg_data)
        mdat_data = _extract_mdat_from_segment(seg_data)
        if mdat_data is None:
            continue

        for frag in fragments:
            track_id = frag["track_id"]
            sample_sizes = frag["sample_sizes"]
            data_offset = frag["data_offset"]
            base_data_offset = frag["base_data_offset"]

            if track_id not in tracks:
                tracks[track_id] = []

            # Determine starting offset within mdat
            sample_start = data_offset
            if base_data_offset > 0:
                sample_start = max(0, data_offset - 8)  # account for mdat header

            for size in sample_sizes:
                if size > 0 and sample_start + size <= len(mdat_data):
                    tracks[track_id].append(mdat_data[sample_start : sample_start + size])
                    sample_start += size

    return tracks


def _extract_sequence_number(seg_data: bytes) -> int:
    """Extract the mfhd sequence number from a media segment.

    Args:
        seg_data: Raw segment bytes (moof + mdat pair).

    Returns:
        Sequence number, or float('inf') if not found (sorts last).
    """
    offset = 0
    while offset + 8 <= len(seg_data):
        size = struct.unpack_from(">I", seg_data, offset)[0]
        box_type = seg_data[offset + 4 : offset + 8].decode("latin-1")

        if box_type == "moof":
            # Parse inside moof for mfhd
            inner_offset = offset + 8
            if size == 1:
                if offset + 16 > len(seg_data):
                    return float("inf")
                large_size = struct.unpack_from(">Q", seg_data, offset + 8)[0]
                moof_end = offset + large_size
                inner_offset = offset + 16
            elif size == 0:
                moof_end = len(seg_data)
            else:
                moof_end = offset + size

            while inner_offset + 8 <= min(moof_end, len(seg_data)):
                inner_size = struct.unpack_from(">I", seg_data, inner_offset)[0]
                inner_type = seg_data[inner_offset + 4 : inner_offset + 8].decode("latin-1")
                if inner_type == "mfhd" and inner_offset + 16 <= len(seg_data):
                    return struct.unpack_from(">I", seg_data, inner_offset + 12)[0]
                if inner_size == 0:
                    break
                inner_offset += inner_size
            return float("inf")

        if size == 0:
            break
        offset += size

    return float("inf")


# ─── Track Gap Detection ──────────────────────────────────────────────────


def detect_track_gaps(segments: list[dict]) -> list[dict]:
    """Detect gaps in segment sequence numbers.

    Scans a list of segment metadata dicts (each with a 'seq_num' key)
    and reports missing sequence numbers.

    Args:
        segments: List of dicts, each with at least a 'seq_num' integer key.

    Returns:
        List of gap dicts, each with keys: missing, before, after.
        Each gap represents one missing sequence number.
        Returns empty list if no gaps or empty input.
    """
    if not segments:
        return []

    seq_nums = []
    for seg in segments:
        seq = seg.get("seq_num")
        if seq is not None:
            seq_nums.append(seq)

    if len(seq_nums) < 2:
        return []

    seq_nums.sort()
    gaps: list[dict] = []

    for i in range(len(seq_nums) - 1):
        current = seq_nums[i]
        next_seq = seq_nums[i + 1]
        if next_seq - current > 1:
            for missing in range(current + 1, next_seq):
                gaps.append({"missing": missing, "before": current, "after": next_seq})

    return gaps


# ─── Track Interleaving ────────────────────────────────────────────────────


def interleave_tracks(tracks: dict[int, list[dict]]) -> list[tuple[int, dict]]:
    """Interleave samples from multiple tracks by timestamp.

    Takes per-track sample lists (each sample is a dict with at least
    a 'timestamp' key representing presentation time) and returns a
    single globally-ordered list of (track_id, sample) tuples.

    Samples without a 'timestamp' key are assigned timestamp 0
    (placed at the beginning). Same-timestamp samples preserve
    track iteration order (dict insertion order, Python 3.7+).

    Args:
        tracks: Dict mapping track_id -> list of sample dicts.
                Each sample dict should have a 'timestamp' integer key
                and at least a 'data' key.

    Returns:
        List of (track_id, sample) tuples sorted by timestamp ascending.
        Returns empty list if tracks is empty.
    """
    if not tracks:
        return []

    pairs: list[tuple[int, int, dict]] = []  # (track_id, timestamp, sample)
    for track_id, samples in tracks.items():
        for sample in samples:
            ts = sample.get("timestamp", 0)
            pairs.append((track_id, ts, sample))

    # Sort by timestamp, then track_id as tiebreaker
    pairs.sort(key=lambda x: (x[1], x[0]))

    return [(pair[0], pair[2]) for pair in pairs]


# ─── MP4 Reassembly ──────────────────────────────────────────────────────


def remux_to_mp4(tracks: dict[int, list[bytes]], init_info: dict) -> bytes:
    """Reassemble demuxed tracks into a valid flat MP4 file.

    Builds: ftyp + moov (from init_info) + mdat (all samples concatenated).

    Args:
        tracks: Dict mapping track_id -> list of sample bytes.
        init_info: Dict from parse_init_segment().

    Returns:
        Complete MP4 file bytes.
    """
    result = bytearray()

    # Build ftyp
    major = init_info.get("major_brand", "isom")
    compatible_brands = init_info.get("compatible_brands", ["isom", "iso2", "avc1", "mp41"])
    ftyp_payload = major.encode().ljust(4)[:4]
    ftyp_payload += struct.pack(">I", 0x0200)
    for brand in compatible_brands:
        brand_bytes = brand.encode().ljust(4, b"\x00")[:4]
        ftyp_payload += brand_bytes
    ftyp_box = struct.pack(">I", 8 + len(ftyp_payload)) + b"ftyp" + ftyp_payload
    result.extend(ftyp_box)

    # Build minimal moov
    # mvhd
    mvhd_timescale = init_info.get("timescale") or 1000
    mvhd_duration = init_info.get("duration") or 0
    mvhd_payload = b"\x00" + b"\x00\x00\x00"  # version + flags
    mvhd_payload += b"\x00" * 8  # creation/modification time
    mvhd_payload += struct.pack(">I", mvhd_timescale)
    mvhd_payload += struct.pack(">I", mvhd_duration)
    mvhd_payload += b"\x00" * 52  # rate(4) + volume(2) + reserved(10) + matrix(36)
    mvhd_box = struct.pack(">I", 8 + len(mvhd_payload)) + b"mvhd" + mvhd_payload

    # trak boxes (one per track in init_info)
    track_boxes = bytearray()
    for i, track_info in enumerate(init_info.get("tracks", [])):
        track_id = track_info.get("track_id", i + 1)
        handler_type = track_info.get("handler_type", "vide")
        width = track_info.get("width", 0)
        height = track_info.get("height", 0)

        # tkhd
        tkhd_payload = b"\x00" + b"\x00\x00\x00"  # version + flags
        tkhd_payload += b"\x00" * 8  # creation/modification time
        tkhd_payload += struct.pack(">I", track_id)
        tkhd_payload += b"\x00" * 16  # reserved(4) + layer(2) + alternate_group(2) + volume(2) + reserved(6)
        tkhd_payload += b"\x00" * 36  # matrix
        tkhd_payload += struct.pack(">I", int(width * 65536))
        tkhd_payload += struct.pack(">I", int(height * 65536))
        tkhd_box = struct.pack(">I", 8 + len(tkhd_payload)) + b"tkhd" + tkhd_payload

        # mdia → hdlr + minf → stbl → stsd
        hdlr_payload = b"\x00\x00\x00\x00" + b"\x00" * 4
        hdlr_payload += handler_type.encode().ljust(4)[:4]
        hdlr_payload += b"\x00" * 12 + b"Handler\x00"
        hdlr_box = struct.pack(">I", 8 + len(hdlr_payload)) + b"hdlr" + hdlr_payload

        stsd_entry_data = b"\x00" * 8 + b"\x00\x00" + b"\x00\x00" + b"\x00" * 70
        codec = track_info.get("codec_string", "avc1")
        stsd_entry = struct.pack(">I", 8 + len(stsd_entry_data)) + codec.encode().ljust(4)[:4] + stsd_entry_data
        stsd_payload = b"\x00\x00\x00\x00" + struct.pack(">I", 1) + stsd_entry
        stsd_box = struct.pack(">I", 8 + len(stsd_payload)) + b"stsd" + stsd_payload
        stbl_box = struct.pack(">I", 8 + len(stsd_box)) + b"stbl" + stsd_box

        vmhd_payload = b"\x00\x00\x00\x01" + b"\x00" * 4  # version + flags + graphicsmode(2) + opcolor(2)
        vmhd_box = struct.pack(">I", 8 + len(vmhd_payload)) + b"vmhd" + vmhd_payload

        dinf_payload = (
            struct.pack(">I", 8 + 12)
            + b"dref\x00\x00\x00\x00\x00\x00\x00\x01"
            + struct.pack(">I", 12)
            + b"url \x00\x00\x00\x01"
        )
        dinf_box = struct.pack(">I", 8 + len(dinf_payload)) + b"dinf" + dinf_payload

        minf_payload = vmhd_box + dinf_box + stbl_box
        minf_box = struct.pack(">I", 8 + len(minf_payload)) + b"minf" + minf_payload

        mdia_payload = hdlr_box + minf_box
        mdia_box = struct.pack(">I", 8 + len(mdia_payload)) + b"mdia" + mdia_payload

        trak_payload = tkhd_box + mdia_box
        trak_box = struct.pack(">I", 8 + len(trak_payload)) + b"trak" + trak_payload
        track_boxes.extend(trak_box)

    moov_payload = mvhd_box + bytes(track_boxes)
    moov_box = struct.pack(">I", 8 + len(moov_payload)) + b"moov" + moov_payload
    result.extend(moov_box)

    # Build mdat — all samples concatenated
    all_data = bytearray()
    for track_samples in tracks.values():
        for sample in track_samples:
            all_data.extend(sample)

    mdat_box = struct.pack(">I", 8 + len(all_data)) + b"mdat" + bytes(all_data)
    result.extend(mdat_box)

    return bytes(result)


# ─── Encrypted Segment Detection ─────────────────────────────────────────


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
