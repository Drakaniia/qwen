"""Movie fragment (moof) parsing — per-track fragment info extraction."""

import struct

from .container import parse_boxes_hierarchical


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


def _extract_sequence_number(seg_data: bytes) -> int:
    """Extract the mfhd sequence number from a media segment.

    Args:
        seg_data: Raw segment bytes (moof + mdat pair).

    Returns:
        Sequence number, or float('inf') if not found (sorts last).
    """
    import struct

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
