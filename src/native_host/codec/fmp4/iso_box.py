"""ISOBase Media File Format (ISO BMFF) box low-level types and constants."""

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
