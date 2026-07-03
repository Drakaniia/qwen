"""Sample demuxing, track gap detection, interleaving, and MP4 reassembly."""

import struct
from typing import Optional

from .fragments import _extract_sequence_number, parse_moof


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

        # mdia -> hdlr + minf -> stbl -> stsd
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

    # Build mdat -- all samples concatenated
    all_data = bytearray()
    for track_samples in tracks.values():
        for sample in track_samples:
            all_data.extend(sample)

    mdat_box = struct.pack(">I", 8 + len(all_data)) + b"mdat" + bytes(all_data)
    result.extend(mdat_box)

    return bytes(result)
