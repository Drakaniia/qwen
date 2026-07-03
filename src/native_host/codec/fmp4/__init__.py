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

from .iso_box import ISOBox, _parse_box_at, BOX_TYPE_CONTAINERS
from .container import is_container_box, parse_boxes, parse_boxes_hierarchical
from .queries import find_box, find_boxes
from .init_segments import (
    parse_ftyp,
    parse_mvhd,
    parse_tkhd,
    parse_hdlr,
    parse_stsd,
    parse_init_segment,
    is_cmaf,
)
from .fragments import parse_moof, _extract_sequence_number
from .samples import (
    _extract_mdat_from_segment,
    demux_streams,
    detect_track_gaps,
    interleave_tracks,
    remux_to_mp4,
)
from .encryption import has_encryption_boxes, detect_encryption

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
    "demux_streams",
    "detect_track_gaps",
    "interleave_tracks",
    "remux_to_mp4",
    "has_encryption_boxes",
    "detect_encryption",
]
