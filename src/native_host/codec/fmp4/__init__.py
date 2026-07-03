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

from .container import is_container_box, parse_boxes, parse_boxes_hierarchical
from .encryption import detect_encryption, has_encryption_boxes
from .fragments import _extract_sequence_number, parse_moof
from .init_segments import (
    is_cmaf,
    parse_ftyp,
    parse_hdlr,
    parse_init_segment,
    parse_mvhd,
    parse_stsd,
    parse_tkhd,
)
from .iso_box import BOX_TYPE_CONTAINERS, ISOBox, _parse_box_at
from .queries import find_box, find_boxes
from .samples import (
    _extract_mdat_from_segment,
    demux_streams,
    detect_track_gaps,
    interleave_tracks,
    remux_to_mp4,
)

__all__ = [
    "ISOBox",
    "BOX_TYPE_CONTAINERS",
    "is_container_box",
    "parse_boxes",
    "parse_boxes_hierarchical",
    "find_box",
    "find_boxes",
    "parse_ftyp",
    "parse_mvhd",
    "parse_tkhd",
    "parse_hdlr",
    "parse_stsd",
    "parse_init_segment",
    "is_cmaf",
    "parse_moof",
    "_extract_sequence_number",
    "demux_streams",
    "detect_track_gaps",
    "interleave_tracks",
    "remux_to_mp4",
    "_extract_mdat_from_segment",
    "has_encryption_boxes",
    "detect_encryption",
    "_parse_box_at",
]
