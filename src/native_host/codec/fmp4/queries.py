"""Box query helpers — find boxes by type in parsed box lists."""

from typing import Optional

from .iso_box import ISOBox


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
