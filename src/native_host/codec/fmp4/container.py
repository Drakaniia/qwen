"""Container box detection and flat/hierarchical parsing."""

from .iso_box import BOX_TYPE_CONTAINERS, ISOBox, _parse_box_at


def is_container_box(box_type: str) -> bool:
    """Check if a box type is a container that can hold child boxes."""
    return box_type in BOX_TYPE_CONTAINERS


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
