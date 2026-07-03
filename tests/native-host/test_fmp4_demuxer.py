"""Tests for the fMP4 demuxer — ISO BMFF box parser, init segment parsing,
moof/mdat parsing, and MP4 reassembly.

Following TDD: these tests are written BEFORE the implementation.
"""

import struct
import sys
import unittest
from pathlib import Path

from path_setup import *

from codec.fmp4 import (
    ISOBox,
    demux_streams,
    detect_encryption,
    find_box,
    find_boxes,
    has_encryption_boxes,
    is_container_box,
    parse_boxes,
    parse_boxes_hierarchical,
    parse_ftyp,
    parse_hdlr,
    parse_init_segment,
    parse_moof,
    parse_mvhd,
    parse_stsd,
    parse_tkhd,
    remux_to_mp4,
)

# ─── Task 1: ISO BMFF Box Parser ─────────────────────────────────────────


class TestISOBoxParser(unittest.TestCase):
    """Test the low-level ISO BMFF box parser."""

    def _build_box(self, box_type: str, payload: bytes) -> bytes:
        """Build a serialized MP4 box."""
        size = 8 + len(payload)
        return struct.pack(">I", size) + box_type.encode() + payload

    def test_parse_single_ftyp_box(self):
        """A single ftyp box should parse correctly."""
        data = self._build_box("ftyp", b"isom")
        boxes = parse_boxes(data)
        self.assertEqual(len(boxes), 1)
        self.assertEqual(boxes[0].type, "ftyp")
        self.assertEqual(boxes[0].size, 12)
        self.assertEqual(boxes[0].data, b"isom")

    def test_parse_multiple_boxes(self):
        """Multiple sibling boxes should all be found."""
        ftyp = self._build_box("ftyp", b"isom")
        moov = self._build_box("moov", self._build_box("mvhd", b"\x00" * 20))
        data = ftyp + moov
        boxes = parse_boxes(data)
        self.assertEqual(len(boxes), 2)
        types = [b.type for b in boxes]
        self.assertIn("ftyp", types)
        self.assertIn("mvhd", types)

    def test_parse_boxes_returns_leaf_boxes(self):
        """Container boxes should be recursed, only leaves returned."""
        mdat = self._build_box("mdat", b"some media data")
        trak = self._build_box("trak", mdat)
        moov = self._build_box("moov", trak)
        boxes = parse_boxes(moov)
        types = [b.type for b in boxes]
        self.assertIn("mdat", types, "leaf box should be present")
        self.assertNotIn("moov", types, "container box should not be in flat list")
        self.assertNotIn("trak", types, "nested container box should not be in flat list")

    def test_parse_boxes_hierarchical_preserves_structure(self):
        """Hierarchical parsing should return container boxes with children."""
        mdat_inner = self._build_box("mdat", b"media")
        trak = self._build_box("trak", mdat_inner)
        moov = self._build_box("moov", trak)
        boxes = parse_boxes_hierarchical(moov)
        self.assertEqual(len(boxes), 1)
        self.assertEqual(boxes[0].type, "moov")
        self.assertEqual(len(boxes[0].children), 1)
        self.assertEqual(boxes[0].children[0].type, "trak")
        self.assertEqual(len(boxes[0].children[0].children), 1)
        self.assertEqual(boxes[0].children[0].children[0].type, "mdat")

    def test_find_box_by_type(self):
        """find_box should return the first matching box."""
        ftyp = self._build_box("ftyp", b"isom")
        moov = self._build_box("moov", b"\x00" * 8)
        boxes = parse_boxes(ftyp + moov)
        found = find_box(boxes, "ftyp")
        self.assertIsNotNone(found)
        self.assertEqual(found.type, "ftyp")

    def test_find_box_not_found(self):
        """find_box should return None for missing types."""
        boxes = parse_boxes(self._build_box("ftyp", b"isom"))
        self.assertIsNone(find_box(boxes, "moov"))

    def test_find_boxes_multiple_matches(self):
        """find_boxes should return all boxes of a type."""
        mdat1 = self._build_box("mdat", b"data1")
        mdat2 = self._build_box("mdat", b"data2")
        ftyp = self._build_box("ftyp", b"isom")
        boxes = parse_boxes(ftyp + mdat1 + mdat2)
        mdats = find_boxes(boxes, "mdat")
        self.assertEqual(len(mdats), 2)

    def test_is_container_box_known_types(self):
        """Known container types should return True."""
        for t in ["moov", "trak", "mdia", "minf", "stbl", "moof", "traf"]:
            self.assertTrue(is_container_box(t), f"{t} should be a container")

    def test_is_container_box_non_container(self):
        """Non-container types should return False."""
        self.assertFalse(is_container_box("ftyp"))
        self.assertFalse(is_container_box("mdat"))
        self.assertFalse(is_container_box("mvhd"))

    def test_parse_box_extended_size_64bit(self):
        """Boxes with 64-bit extended size should be parsed."""
        payload = b"\x00" * 100
        extended_size = 8 + 8 + len(payload)
        header = struct.pack(">I", 1) + b"free" + struct.pack(">Q", extended_size)
        data = header + payload
        boxes = parse_boxes(data)
        self.assertEqual(len(boxes), 1)
        self.assertEqual(boxes[0].type, "free")

    def test_parse_box_size_zero_extends_to_end(self):
        """Size==0 means box extends to end of data."""
        payload = b"\x00" * 50
        header = struct.pack(">I", 0) + b"free"
        data = header + payload
        boxes = parse_boxes(data)
        self.assertEqual(len(boxes), 1)
        self.assertEqual(boxes[0].size, len(data))

    def test_parse_boxes_truncated_data(self):
        """Truncated data should not crash."""
        data = b"\x00\x00\x00\x10"  # size=16 but no type bytes
        boxes = parse_boxes(data)
        self.assertEqual(len(boxes), 0)

    def test_isobox_slots_no_dict(self):
        """ISOBox should use __slots__ and not have a __dict__."""
        box = ISOBox(12, "ftyp", b"isom")
        with self.assertRaises(AttributeError):
            _ = box.__dict__

    def test_isobox_repr(self):
        """ISOBox repr should include type, size, data_len, children."""
        box = ISOBox(12, "ftyp", b"isom")
        r = repr(box)
        self.assertIn("ftyp", r)
        self.assertIn("size=12", r)
        self.assertIn("data_len=4", r)

    def test_parse_boxes_hierarchical_empty_data(self):
        """Empty data in hierarchical mode should return empty list."""
        boxes = parse_boxes_hierarchical(b"")
        self.assertEqual(len(boxes), 0)

    def test_parse_boxes_container_no_leaves(self):
        """Container with only empty sub-containers should return empty list."""
        trak = self._build_box("trak", b"")
        moov = self._build_box("moov", trak)
        boxes = parse_boxes(moov)
        self.assertEqual(len(boxes), 0)

    def test_find_box_empty_list(self):
        """find_box with empty list should return None."""
        self.assertIsNone(find_box([], "ftyp"))

    def test_find_boxes_empty_list(self):
        """find_boxes with empty list should return empty list."""
        self.assertEqual(find_boxes([], "ftyp"), [])

    def test_find_boxes_no_matches(self):
        """find_boxes with no matching type should return empty list."""
        ftyp = self._build_box("ftyp", b"isom")
        boxes = parse_boxes(ftyp)
        self.assertEqual(find_boxes(boxes, "moov"), [])

    def test_parse_box_8_bytes_no_payload(self):
        """Box with exactly 8 bytes (header only, no payload) should parse."""
        data = struct.pack(">I", 8) + b"free"
        boxes = parse_boxes(data)
        self.assertEqual(len(boxes), 1)
        self.assertEqual(boxes[0].type, "free")
        self.assertEqual(boxes[0].data, b"")

    def test_parse_box_64bit_extended_then_normal(self):
        """64-bit extended box followed by normal box should both parse."""
        large_payload = b"\x00" * 100
        large_size = 8 + 8 + len(large_payload)
        large_header = struct.pack(">I", 1) + b"free" + struct.pack(">Q", large_size)
        small_box = self._build_box("mdat", b"data")
        data = large_header + large_payload + small_box
        boxes = parse_boxes(data)
        self.assertEqual(len(boxes), 2)
        self.assertEqual(boxes[0].type, "free")
        self.assertEqual(boxes[1].type, "mdat")

    def test_isobox_offset_tracking(self):
        """ISOBox offset should reflect position in original data."""
        ftyp = self._build_box("ftyp", b"isom")
        mdat = self._build_box("mdat", b"data")
        data = ftyp + mdat
        boxes = parse_boxes_hierarchical(data)
        self.assertEqual(boxes[0].offset, 0)
        self.assertEqual(boxes[1].offset, 12)

    def test_parse_boxes_truncated_inside_container(self):
        """Container with truncated nested data should not crash."""
        truncated_moof = self._build_box("moof", b"\x00\x00\x00\x10")
        moov = self._build_box("moov", truncated_moof)
        boxes = parse_boxes(moov)
        self.assertEqual(len(boxes), 0)

    def test_parse_box_type_latin1_decode(self):
        """Box type bytes should decode as latin-1 (handles any byte 0-255)."""
        data = struct.pack(">I", 12) + b"\xc0\xc1\xc2\xc3" + b"payload"
        boxes = parse_boxes(data)
        self.assertEqual(len(boxes), 1)
        self.assertEqual(boxes[0].type.encode("latin-1"), b"\xc0\xc1\xc2\xc3")

    def test_parse_boxes_only_garbage_no_valid_box(self):
        """Data too short for even a box header should return empty."""
        boxes = parse_boxes(b"\x00\x00")
        self.assertEqual(len(boxes), 0)

    def test_isobox_no_dict(self):
        """Accessing __dict__ on ISOBox should raise AttributeError (__slots__)."""
        box = ISOBox(12, "ftyp", b"data")
        with self.assertRaises(AttributeError):
            _ = box.__dict__


# ─── Task 2: Init Segment Parsing ────────────────────────────────────────


class TestInitSegmentParsing(unittest.TestCase):
    """Test parsing of fMP4 init segments (ftyp + moov)."""

    def _build_box(self, box_type: str, payload: bytes) -> bytes:
        size = 8 + len(payload)
        return struct.pack(">I", size) + box_type.encode() + payload

    def _build_ftyp(self, major="isom", minor=0x0200, brands=None):
        """Build a minimal ftyp box."""
        brands = brands or ["isom", "iso2", "avc1", "mp41"]
        payload = major.encode() + struct.pack(">I", minor)
        for b in brands:
            payload += b.encode().ljust(4, b"\x00")[:4]
        return self._build_box("ftyp", payload)

    def _build_mvhd(self, timescale=1000, duration=60000):
        """Build a minimal mvhd box (version 0)."""
        payload = b"\x00" + b"\x00\x00\x00"  # version + flags
        payload += b"\x00" * 8  # creation/modification time
        payload += struct.pack(">I", timescale)
        payload += struct.pack(">I", duration)
        payload += b"\x00" * 52  # rate, volume, reserved, matrix, pre-defined, next track id
        return self._build_box("mvhd", payload)

    def _build_hdlr(self, handler_type="vide"):
        """Build a minimal hdlr box."""
        payload = b"\x00" + b"\x00\x00\x00"  # version + flags
        payload += b"\x00" * 4  # pre-defined
        payload += handler_type.encode().ljust(4)[:4]
        payload += b"\x00" * 12  # reserved
        payload += b"VideoHandler\x00"
        return self._build_box("hdlr", payload)

    def _build_stsd(self, codec="avc1"):
        """Build a minimal stsd box with one entry."""
        entry_data = b"\x00" * 8 + b"\x00\x00" + b"\x00\x00" + b"\x00" * 70
        entry = struct.pack(">I", 8 + len(entry_data)) + codec.encode().ljust(4)[:4] + entry_data
        payload = b"\x00" + b"\x00\x00\x00"  # version + flags
        payload += struct.pack(">I", 1)  # entry count
        payload += entry
        return self._build_box("stsd", payload)

    def _build_stbl(self):
        """Build a minimal stbl box with stsd."""
        stsd = self._build_stsd()
        return self._build_box("stbl", stsd)

    def _build_minf(self):
        """Build a minimal minf box."""
        hdlr = self._build_hdlr("vide")
        stbl = self._build_stbl()
        # vmhd placeholder
        vmhd = self._build_box("vmhd", b"\x00" * 8)
        # dinf placeholder
        dinf = self._build_box("dinf", self._build_box("dref", b"\x00" * 12))
        return self._build_box("minf", hdlr + vmhd + dinf + stbl)

    def _build_mdia(self, handler_type="vide"):
        """Build a minimal mdia box."""
        mdhd = self._build_box("mdhd", b"\x00" * 24)
        hdlr = self._build_hdlr(handler_type)
        minf = self._build_minf()
        return self._build_box("mdia", mdhd + hdlr + minf)

    def _build_tkhd(self, track_id=1, width=1920, height=1080):
        """Build a minimal tkhd box."""
        payload = b"\x00" + b"\x00\x00\x00"  # version + flags
        payload += b"\x00" * 8  # creation/modification time
        payload += struct.pack(">I", track_id)
        payload += b"\x00" * 16  # reserved, layer, alternate_group, volume
        payload += b"\x00" * 36  # matrix
        payload += struct.pack(">I", int(width * 65536))  # width (16.16 fixed-point)
        payload += struct.pack(">I", int(height * 65536))  # height (16.16 fixed-point)
        return self._build_box("tkhd", payload)

    def _build_trak(self, track_id=1, handler_type="vide"):
        """Build a minimal trak box."""
        tkhd = self._build_tkhd(track_id, 1920, 1080)
        mdia = self._build_mdia(handler_type)
        return self._build_box("trak", tkhd + mdia)

    def _build_moov(self, track_count=1):
        """Build a minimal moov box with track_count tracks."""
        mvhd = self._build_mvhd()
        payload = mvhd
        for i in range(track_count):
            handler = "vide" if i == 0 else "soun"
            payload += self._build_trak(track_id=i + 1, handler_type=handler)
        return self._build_box("moov", payload)

    def test_parse_init_segment_ftyp(self):
        """Init segment parsing should extract ftyp info."""
        ftyp = self._build_ftyp()
        moov = self._build_moov()
        init_data = ftyp + moov
        info = parse_init_segment(init_data)
        self.assertEqual(info["major_brand"], "isom")
        self.assertIn("isom", info["compatible_brands"])

    def test_parse_init_segment_tracks(self):
        """Init segment should report correct track count."""
        ftyp = self._build_ftyp()
        moov = self._build_moov(track_count=2)
        init_data = ftyp + moov
        info = parse_init_segment(init_data)
        self.assertEqual(len(info["tracks"]), 2)

    def test_parse_init_segment_track_handler(self):
        """Init segment should extract handler type per track."""
        ftyp = self._build_ftyp()
        moov = self._build_moov(track_count=1)
        init_data = ftyp + moov
        info = parse_init_segment(init_data)
        self.assertEqual(info["tracks"][0]["handler_type"], "vide")

    def test_parse_init_segment_track_dimensions(self):
        """Init segment should extract track dimensions."""
        ftyp = self._build_ftyp()
        # Single video track at 1920x1080
        tkhd = self._build_tkhd(1, 1920, 1080)
        mdia = self._build_mdia("vide")
        trak = self._build_box("trak", tkhd + mdia)
        mvhd = self._build_mvhd()
        moov = self._build_box("moov", mvhd + trak)
        init_data = ftyp + moov
        info = parse_init_segment(init_data)
        self.assertEqual(len(info["tracks"]), 1)
        self.assertAlmostEqual(info["tracks"][0]["width"], 1920, delta=1)
        self.assertAlmostEqual(info["tracks"][0]["height"], 1080, delta=1)

    def test_parse_init_segment_timescale(self):
        """Init segment should extract timescale from mvhd."""
        ftyp = self._build_ftyp()
        moov = self._build_box("moov", self._build_mvhd(timescale=90000, duration=180000))
        init_data = ftyp + moov
        info = parse_init_segment(init_data)
        self.assertEqual(info["timescale"], 90000)
        self.assertEqual(info["duration"], 180000)

    def test_parse_init_segment_two_tracks_video_first(self):
        """Init segment with 2 tracks: first should be vide, second soun."""
        ftyp = self._build_ftyp()
        mvhd = self._build_mvhd()
        trak1 = self._build_trak(1, "vide")
        trak2 = self._build_trak(2, "soun")
        moov = self._build_box("moov", mvhd + trak1 + trak2)
        init_data = ftyp + moov
        info = parse_init_segment(init_data)
        self.assertEqual(len(info["tracks"]), 2)
        self.assertEqual(info["tracks"][0]["handler_type"], "vide")
        self.assertEqual(info["tracks"][1]["handler_type"], "soun")

    def test_parse_init_segment_no_moov(self):
        """Init segment with only ftyp (no moov) should not crash."""
        ftyp = self._build_ftyp()
        info = parse_init_segment(ftyp)
        self.assertEqual(info["major_brand"], "isom")
        self.assertEqual(len(info["tracks"]), 0)

    def test_parse_init_segment_empty_data(self):
        """Empty data should not crash."""
        info = parse_init_segment(b"")
        self.assertEqual(len(info["tracks"]), 0)

    def test_parse_ftyp_no_compatible_brands(self):
        """ftyp with only major brand (no compatible brands) should parse."""
        payload = b"isom" + struct.pack(">I", 0x0200)
        ftyp = ISOBox(8 + len(payload), "ftyp", payload)
        info = parse_ftyp(ftyp)
        self.assertEqual(info["major_brand"], "isom")
        self.assertEqual(info["compatible_brands"], [])

    def test_parse_mvhd_version1(self):
        """mvhd version 1 with 64-bit timestamps should parse correctly."""
        payload = b"\x01" + b"\x00\x00\x00"  # version 1 + flags
        payload += b"\x00" * 8  # creation time (64-bit)
        payload += b"\x00" * 8  # modification time (64-bit)
        payload += struct.pack(">I", 90000)  # timescale
        payload += struct.pack(">I", 0x00000001)  # duration high
        payload += struct.pack(">I", 0x23456789)  # duration low
        payload += b"\x00" * 40  # remaining
        mvhd = ISOBox(8 + len(payload), "mvhd", payload)
        info = parse_mvhd(mvhd)
        self.assertEqual(info["timescale"], 90000)
        expected_duration = (1 << 32) | 0x23456789
        self.assertEqual(info["duration"], expected_duration)
        self.assertAlmostEqual(info["duration_seconds"], expected_duration / 90000)

    def test_parse_mvhd_timescale_zero(self):
        """mvhd with timescale=0 should not crash (division by zero)."""
        payload = b"\x00" + b"\x00\x00\x00"
        payload += b"\x00" * 8
        payload += struct.pack(">I", 0)  # timescale = 0
        payload += struct.pack(">I", 5000)  # duration
        payload += b"\x00" * 52
        mvhd = ISOBox(8 + len(payload), "mvhd", payload)
        info = parse_mvhd(mvhd)
        self.assertEqual(info["timescale"], 0)
        self.assertEqual(info["duration_seconds"], 0)  # should not crash

    def test_parse_tkhd_version1(self):
        """tkhd version 1 with 64-bit timestamps should parse correctly."""
        payload = b"\x01" + b"\x00\x00\x00"  # version 1 + flags
        payload += b"\x00" * 8  # creation time (64-bit)
        payload += b"\x00" * 8  # modification time (64-bit)
        payload += struct.pack(">I", 42)  # track_id
        payload += b"\x00" * 4  # reserved
        payload += b"\x00" * 8  # duration (64-bit)
        payload += b"\x00" * 16  # layer, alternate_group, volume, reserved
        payload += b"\x00" * 36  # matrix
        payload += struct.pack(">I", int(3840 * 65536))  # width
        payload += struct.pack(">I", int(2160 * 65536))  # height
        tkhd = ISOBox(8 + len(payload), "tkhd", payload)
        info = parse_tkhd(tkhd)
        self.assertEqual(info["track_id"], 42)
        self.assertAlmostEqual(info["width"], 3840, delta=1)
        self.assertAlmostEqual(info["height"], 2160, delta=1)

    def test_parse_hdlr_sound_handler(self):
        """hdlr with 'soun' handler type should parse correctly."""
        payload = b"\x00\x00\x00\x00" + b"\x00" * 4
        payload += b"soun"
        payload += b"\x00" * 12 + b"SoundHandler\x00"
        hdlr = ISOBox(8 + len(payload), "hdlr", payload)
        self.assertEqual(parse_hdlr(hdlr), "soun")

    def test_parse_hdlr_hint_handler(self):
        """hdlr with 'hint' handler type should parse."""
        payload = b"\x00\x00\x00\x00" + b"\x00" * 4
        payload += b"hint"
        payload += b"\x00" * 12 + b"HintHandler\x00"
        hdlr = ISOBox(8 + len(payload), "hdlr", payload)
        self.assertEqual(parse_hdlr(hdlr), "hint")

    def test_parse_stsd_zero_entries(self):
        """stsd with 0 entries should return empty list."""
        payload = b"\x00\x00\x00\x00" + struct.pack(">I", 0)
        stsd = ISOBox(8 + len(payload), "stsd", payload)
        entries = parse_stsd(stsd)
        self.assertEqual(len(entries), 0)

    def test_parse_stsd_multiple_entries(self):
        """stsd with 2 entries should return both."""
        entry1_data = b"\x00" * 8 + b"\x00\x00" + b"\x00\x00" + b"\x00" * 70
        entry1 = struct.pack(">I", 8 + len(entry1_data)) + b"avc1" + entry1_data
        entry2_data = b"\x00" * 8 + b"\x00\x02" + b"\x00\x01" + b"\x00" * 70
        entry2 = struct.pack(">I", 8 + len(entry2_data)) + b"mp4a" + entry2_data
        payload = b"\x00\x00\x00\x00" + struct.pack(">I", 2) + entry1 + entry2
        stsd = ISOBox(8 + len(payload), "stsd", payload)
        entries = parse_stsd(stsd)
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["format"], "avc1")
        self.assertEqual(entries[1]["format"], "mp4a")

    def test_parse_init_segment_no_ftyp(self):
        """Init segment without ftyp should not crash."""
        mvhd = self._build_mvhd()
        trak = self._build_trak(1, "vide")
        moov = self._build_box("moov", mvhd + trak)
        info = parse_init_segment(moov)
        self.assertEqual(info["major_brand"], "")

    def test_parse_init_segment_moov_no_mvhd(self):
        """Moov without mvhd should not crash."""
        ftyp = self._build_ftyp()
        trak = self._build_trak(1, "vide")
        moov = self._build_box("moov", trak)
        info = parse_init_segment(ftyp + moov)
        self.assertEqual(info["timescale"], 0)

    def test_parse_init_segment_moov_no_trak(self):
        """Moov without trak should return empty tracks list."""
        ftyp = self._build_ftyp()
        mvhd = self._build_mvhd()
        moov = self._build_box("moov", mvhd)
        info = parse_init_segment(ftyp + moov)
        self.assertEqual(len(info["tracks"]), 0)

    def test_parse_init_segment_encrypted_init(self):
        """Init segment with pssh should detect encryption."""
        system_id = bytes([0xED, 0xEF, 0x8B, 0xA9, 0x79, 0xD6, 0x4A, 0xCE,
                           0xA3, 0xC8, 0x10, 0x0D, 0x6F, 0x33, 0x26, 0x7E])
        pssh_payload = b"\x00\x00\x00\x00" + system_id + b"\x00\x00\x00\x00"
        pssh_payload += b"\x00\x00\x00\x0c" + b"testpsshdata"
        pssh = self._build_box("pssh", pssh_payload)
        ftyp = self._build_ftyp()
        moov = self._build_moov()
        info = parse_init_segment(ftyp + pssh + moov)
        self.assertTrue(info["has_cenc"])
        self.assertEqual(len(info["pssh_boxes"]), 1)

    def test_parse_init_segment_custom_codec(self):
        """Init segment with hvc1 codec should extract correctly."""
        ftyp = self._build_ftyp()
        tkhd = self._build_tkhd(1, 1920, 1080)
        hdlr = self._build_hdlr("vide")
        stsd_entry_data = b"\x00" * 8 + b"\x00\x00" + b"\x00\x00" + b"\x00" * 70
        stsd_entry = struct.pack(">I", 8 + len(stsd_entry_data)) + b"hvc1" + stsd_entry_data
        stsd_payload = b"\x00\x00\x00\x00" + struct.pack(">I", 1) + stsd_entry
        stsd = self._build_box("stsd", stsd_payload)
        stbl = self._build_box("stbl", stsd)
        vmhd = self._build_box("vmhd", b"\x00" * 8)
        dinf = self._build_box("dinf", self._build_box("dref", b"\x00" * 12 + b"\x00\x00\x00\x01"))
        minf = self._build_box("minf", vmhd + dinf + stbl)
        mdhd = self._build_box("mdhd", b"\x00" * 24)
        mdia = self._build_box("mdia", mdhd + hdlr + minf)
        trak = self._build_box("trak", tkhd + mdia)
        mvhd = self._build_mvhd()
        moov = self._build_box("moov", mvhd + trak)
        info = parse_init_segment(ftyp + moov)
        self.assertEqual(info["tracks"][0]["codec_string"], "hvc1")

    def test_parse_init_segment_opus_codec(self):
        """Init segment with Opus audio codec should extract correctly."""
        ftyp = self._build_ftyp()
        tkhd = self._build_tkhd(1, 0, 0)
        hdlr = self._build_hdlr("soun")
        stsd_entry_data = b"\x00" * 8 + b"\x00\x02" + b"\x00\x01" + b"\x00" * 70
        stsd_entry = struct.pack(">I", 8 + len(stsd_entry_data)) + b"Opus" + stsd_entry_data
        stsd_payload = b"\x00\x00\x00\x00" + struct.pack(">I", 1) + stsd_entry
        stsd = self._build_box("stsd", stsd_payload)
        stbl = self._build_box("stbl", stsd)
        smhd = self._build_box("smhd", b"\x00" * 8)
        dinf = self._build_box("dinf", self._build_box("dref", b"\x00" * 12 + b"\x00\x00\x00\x01"))
        minf = self._build_box("minf", smhd + dinf + stbl)
        mdhd = self._build_box("mdhd", b"\x00" * 24)
        mdia = self._build_box("mdia", mdhd + hdlr + minf)
        trak = self._build_box("trak", tkhd + mdia)
        mvhd = self._build_mvhd()
        moov = self._build_box("moov", mvhd + trak)
        info = parse_init_segment(ftyp + moov)
        self.assertEqual(info["tracks"][0]["codec_string"], "Opus")

    def test_parse_init_segment_first_moov_wins(self):
        """Only the first moov box should be used."""
        ftyp = self._build_ftyp()
        mvhd1 = self._build_mvhd()
        trak1_1 = self._build_trak(1, "vide")
        moov1 = self._build_box("moov", mvhd1 + trak1_1)
        mvhd2 = self._build_mvhd()
        trak2_1 = self._build_trak(2, "soun")
        moov2 = self._build_box("moov", mvhd2 + trak2_1)
        info = parse_init_segment(ftyp + moov1 + moov2)
        self.assertEqual(len(info["tracks"]), 1)
        self.assertEqual(info["tracks"][0]["track_id"], 1)


# ─── Task 3: Moof/Mdat Parsing ───────────────────────────────────────────


class TestFMP4MoofParsing(unittest.TestCase):
    """Test parsing of fMP4 movie fragments (moof/mdat)."""

    def _build_box(self, box_type: str, payload: bytes) -> bytes:
        size = 8 + len(payload)
        return struct.pack(">I", size) + box_type.encode() + payload

    def _build_mfhd(self, sequence_number=1):
        """Build a Movie Fragment Header Box (mfhd)."""
        payload = b"\x00" + b"\x00\x00\x00"  # version + flags
        payload += struct.pack(">I", sequence_number)
        return self._build_box("mfhd", payload)

    def _build_tfhd(self, track_id=1, base_data_offset=0):
        """Build a Track Fragment Header Box (tfhd)."""
        flags = 0x000001  # base-data-offset-present
        payload = b"\x00" + struct.pack(">I", flags)[1:]  # version + flags (3 bytes)
        payload += struct.pack(">I", track_id)
        if flags & 0x000001:
            payload += struct.pack(">Q", base_data_offset)
        return self._build_box("tfhd", payload)

    def _build_trun(self, sample_sizes, data_offset=0):
        """Build a Track Fragment Run Box (trun) with sample sizes."""
        flags = 0x0001 | 0x1000  # data-offset-present + sample-size-present
        version = 0
        payload = struct.pack(">I", version << 24 | flags)
        payload += struct.pack(">I", len(sample_sizes))
        payload += struct.pack(">i", data_offset)
        for size in sample_sizes:
            payload += struct.pack(">I", size)
        return self._build_box("trun", payload)

    def test_parse_moof_single_track(self):
        """A single-track moof should parse correctly."""
        mfhd = self._build_mfhd(1)
        tfhd = self._build_tfhd(1)
        trun = self._build_trun([100, 200, 150], data_offset=0)
        traf = self._build_box("traf", tfhd + trun)
        moof = self._build_box("moof", mfhd + traf)
        fragments = parse_moof(moof)
        self.assertEqual(len(fragments), 1)
        self.assertEqual(fragments[0]["track_id"], 1)
        self.assertEqual(fragments[0]["sample_count"], 3)

    def test_parse_moof_sequence_number(self):
        """parse_moof should extract sequence number from mfhd."""
        mfhd = self._build_mfhd(42)
        tfhd = self._build_tfhd(1)
        traf = self._build_box("traf", tfhd)
        moof = self._build_box("moof", mfhd + traf)
        fragments = parse_moof(moof)
        self.assertEqual(len(fragments), 1)
        self.assertEqual(fragments[0]["sequence_number"], 42)

    def test_parse_moof_multiple_tracks(self):
        """A moof with multiple traf boxes should parse all tracks."""
        mfhd = self._build_mfhd(1)
        tfhd1 = self._build_tfhd(1)
        trun1 = self._build_trun([100, 200])
        tfhd2 = self._build_tfhd(2)
        trun2 = self._build_trun([50, 60, 70])
        traf1 = self._build_box("traf", tfhd1 + trun1)
        traf2 = self._build_box("traf", tfhd2 + trun2)
        moof = self._build_box("moof", mfhd + traf1 + traf2)
        fragments = parse_moof(moof)
        self.assertEqual(len(fragments), 2)
        track_ids = [f["track_id"] for f in fragments]
        self.assertIn(1, track_ids)
        self.assertIn(2, track_ids)
        f1 = [f for f in fragments if f["track_id"] == 1][0]
        f2 = [f for f in fragments if f["track_id"] == 2][0]
        self.assertEqual(f1["sample_count"], 2)
        self.assertEqual(f2["sample_count"], 3)

    def test_parse_moof_empty_moof(self):
        """Empty moof data should not crash."""
        result = parse_moof(b"\x00\x00\x00\x08moof")
        self.assertEqual(result, [])

    def test_parse_moof_tfhd_no_flags(self):
        """tfhd with flags=0 (no optional fields) should still parse track_id."""
        tfhd_payload = b"\x00\x00\x00\x00" + struct.pack(">I", 1)  # version=0, flags=0, track_id=1
        tfhd = self._build_box("tfhd", tfhd_payload)
        mfhd = self._build_mfhd(1)
        traf = self._build_box("traf", tfhd)
        moof = self._build_box("moof", mfhd + traf)
        fragments = parse_moof(moof)
        self.assertEqual(len(fragments), 1)
        self.assertEqual(fragments[0]["track_id"], 1)

    def test_parse_moof_trun_version1(self):
        """trun version 1 should parse correctly (signed composition offsets)."""
        mfhd = self._build_mfhd(1)
        tfhd = self._build_tfhd(1)
        flags = 0x0001 | 0x1000  # data-offset + sample-size
        trun_payload = struct.pack(">I", 1 << 24 | flags)  # version=1
        trun_payload += struct.pack(">I", 2)  # 2 samples
        trun_payload += struct.pack(">i", 0)  # data_offset
        trun_payload += struct.pack(">I", 100)  # sample 1 size
        trun_payload += struct.pack(">I", 200)  # sample 2 size
        trun = self._build_box("trun", trun_payload)
        traf = self._build_box("traf", tfhd + trun)
        moof = self._build_box("moof", mfhd + traf)
        fragments = parse_moof(moof)
        self.assertEqual(len(fragments), 1)
        self.assertEqual(fragments[0]["sample_sizes"], [100, 200])

    def test_parse_moof_trun_no_sample_sizes(self):
        """trun without sample-size flag should parse empty sample list."""
        mfhd = self._build_mfhd(1)
        tfhd = self._build_tfhd(1)
        flags = 0x0001 | 0x0100 | 0x0200  # data-offset + duration + flags (no size)
        trun_payload = struct.pack(">I", 0 << 24 | flags)
        trun_payload += struct.pack(">I", 2)  # 2 samples
        trun_payload += struct.pack(">i", 0)  # data_offset
        for _ in range(2):
            trun_payload += struct.pack(">I", 100)  # duration
            trun_payload += struct.pack(">I", 0)  # flags
        trun = self._build_box("trun", trun_payload)
        traf = self._build_box("traf", tfhd + trun)
        moof = self._build_box("moof", mfhd + traf)
        fragments = parse_moof(moof)
        self.assertEqual(len(fragments), 1)
        self.assertEqual(fragments[0]["sample_sizes"], [])  # no sample-size flag → empty

    def test_parse_moof_trun_zero_samples(self):
        """trun with 0 samples should parse with empty sample_sizes."""
        mfhd = self._build_mfhd(1)
        tfhd = self._build_tfhd(1)
        flags = 0x0001 | 0x1000
        trun_payload = struct.pack(">I", 0 << 24 | flags)
        trun_payload += struct.pack(">I", 0)  # 0 samples
        trun_payload += struct.pack(">i", 0)  # data_offset
        trun = self._build_box("trun", trun_payload)
        traf = self._build_box("traf", tfhd + trun)
        moof = self._build_box("moof", mfhd + traf)
        fragments = parse_moof(moof)
        self.assertEqual(len(fragments), 1)
        self.assertEqual(fragments[0]["sample_count"], 0)
        self.assertEqual(fragments[0]["sample_sizes"], [])

    def test_parse_moof_no_traf(self):
        """Moof without traf boxes should return empty."""
        mfhd = self._build_mfhd(1)
        moof = self._build_box("moof", mfhd)
        fragments = parse_moof(moof)
        self.assertEqual(len(fragments), 0)

    def test_parse_moof_no_mfhd(self):
        """Moof without mfhd should still parse traf boxes."""
        tfhd = self._build_tfhd(1)
        flags = 0x0001 | 0x1000
        trun_payload = struct.pack(">I", 0 << 24 | flags)
        trun_payload += struct.pack(">I", 1)
        trun_payload += struct.pack(">i", 0)
        trun_payload += struct.pack(">I", 50)
        trun = self._build_box("trun", trun_payload)
        traf = self._build_box("traf", tfhd + trun)
        moof = self._build_box("moof", traf)
        fragments = parse_moof(moof)
        self.assertEqual(len(fragments), 1)
        self.assertEqual(fragments[0]["sequence_number"], 0)  # default when no mfhd

    def test_parse_moof_truncated_tfhd(self):
        """Truncated tfhd data should not crash."""
        mfhd = self._build_mfhd(1)
        tfhd = self._build_box("tfhd", b"\x00" * 2)  # only 2 bytes
        traf = self._build_box("traf", tfhd)
        moof = self._build_box("moof", mfhd + traf)
        fragments = parse_moof(moof)
        # Truncated tfhd → no valid track, so no fragments
        self.assertEqual(fragments, [])


# ─── Task 3b: Demux Streams & MP4 Reassembly ─────────────────────────────


class TestFMP4DemuxReassembly(unittest.TestCase):
    """Test demuxing fMP4 streams and reassembling into MP4."""

    def _build_box(self, box_type: str, payload: bytes) -> bytes:
        size = 8 + len(payload)
        return struct.pack(">I", size) + box_type.encode() + payload

    def _build_ftyp(self):
        return self._build_box("ftyp", b"isom\x00\x00\x02\x00isomiso2avc1mp41")

    def _build_mvhd(self):
        payload = b"\x00" + b"\x00\x00\x00" + b"\x00" * 8
        payload += struct.pack(">I", 1000)  # timescale
        payload += struct.pack(">I", 10000)  # duration
        payload += b"\x00" * 52
        return self._build_box("mvhd", payload)

    def _build_tkhd(self, track_id=1):
        payload = b"\x00" + b"\x00\x00\x00" + b"\x00" * 8
        payload += struct.pack(">I", track_id)
        payload += b"\x00" * 16 + b"\x00" * 36
        payload += struct.pack(">I", int(1920 * 65536))
        payload += struct.pack(">I", int(1080 * 65536))
        return self._build_box("tkhd", payload)

    def _build_hdlr(self, handler_type="vide"):
        payload = b"\x00\x00\x00\x00" + b"\x00" * 4
        payload += handler_type.encode().ljust(4)[:4]
        payload += b"\x00" * 12 + b"Handler\x00"
        return self._build_box("hdlr", payload)

    def _build_stsd(self, codec="avc1"):
        entry_data = b"\x00" * 8 + b"\x00\x00" + b"\x00\x00" + b"\x00" * 70
        entry = struct.pack(">I", 8 + len(entry_data)) + codec.encode().ljust(4)[:4] + entry_data
        payload = b"\x00\x00\x00\x00" + struct.pack(">I", 1) + entry
        return self._build_box("stsd", payload)

    def _build_minf(self):
        stsd = self._build_stsd()
        vmhd = self._build_box("vmhd", b"\x00" * 8)
        dinf = self._build_box("dinf", self._build_box("dref", b"\x00" * 12 + b"\x00\x00\x00\x01"))
        stbl = self._build_box("stbl", stsd)
        return self._build_box("minf", vmhd + dinf + stbl)

    def _build_mdia(self, handler_type="vide"):
        mdhd = self._build_box("mdhd", b"\x00" * 24)
        hdlr = self._build_hdlr(handler_type)
        minf = self._build_minf()
        return self._build_box("mdia", mdhd + hdlr + minf)

    def _build_trak(self, track_id=1, handler_type="vide"):
        tkhd = self._build_tkhd(track_id)
        mdia = self._build_mdia(handler_type)
        return self._build_box("trak", tkhd + mdia)

    def _build_moov(self):
        mvhd = self._build_mvhd()
        trak1 = self._build_trak(1, "vide")
        return self._build_box("moov", mvhd + trak1)

    def _build_mfhd(self, seq=1):
        return self._build_box("mfhd", b"\x00\x00\x00\x00" + struct.pack(">I", seq))

    def _build_tfhd(self, track_id=1):
        flags = 0x000001  # base-data-offset-present
        payload = b"\x00" + struct.pack(">I", flags)[1:]
        payload += struct.pack(">I", track_id)
        payload += struct.pack(">Q", 0)
        return self._build_box("tfhd", payload)

    def _build_segment(self, samples: list[bytes], seq=1, track_id=1):
        """Build a single fMP4 segment (moof + mdat) containing the given samples."""
        data_offset = 0
        mdat_payload = b"".join(samples)
        trun_flags = 0x0001 | 0x1000  # data-offset-present + sample-size-present
        trun_payload = struct.pack(">I", 0 << 24 | trun_flags)
        trun_payload += struct.pack(">I", len(samples))
        trun_payload += struct.pack(">i", data_offset)
        for s in samples:
            trun_payload += struct.pack(">I", len(s))
        trun = self._build_box("trun", trun_payload)
        mfhd = self._build_mfhd(seq)
        tfhd = self._build_tfhd(track_id)
        traf = self._build_box("traf", tfhd + trun)
        moof = self._build_box("moof", mfhd + traf)
        mdat = self._build_box("mdat", mdat_payload)
        return moof + mdat

    def test_demux_streams_single_track(self):
        """Demux a single track across one segment."""
        ftyp = self._build_ftyp()
        moov = self._build_moov()
        init = ftyp + moov
        seg = self._build_segment([b"\x00" * 100, b"\x01" * 200])
        tracks = demux_streams(init, [seg])
        self.assertIn(1, tracks)
        self.assertEqual(len(tracks[1]), 2)
        self.assertEqual(tracks[1][0], b"\x00" * 100)
        self.assertEqual(tracks[1][1], b"\x01" * 200)

    def test_demux_streams_two_segments(self):
        """Demux samples across two consecutive segments."""
        ftyp = self._build_ftyp()
        moov = self._build_moov()
        init = ftyp + moov
        seg1 = self._build_segment([b"\xaa" * 50], seq=1)
        seg2 = self._build_segment([b"\xbb" * 75], seq=2)
        tracks = demux_streams(init, [seg1, seg2])
        self.assertEqual(len(tracks[1]), 2)
        self.assertEqual(tracks[1][0], b"\xaa" * 50)
        self.assertEqual(tracks[1][1], b"\xbb" * 75)

    def test_remux_to_mp4_returns_valid_structure(self):
        """Remuxed MP4 should contain ftyp, moov, and mdat boxes."""
        ftyp = self._build_ftyp()
        moov = self._build_moov()
        init = ftyp + moov
        # Manually build tracks dict as demux_streams would
        tracks = {1: [b"\xcc" * 30]}
        init_info = parse_init_segment(init)
        output = remux_to_mp4(tracks, init_info)
        self.assertGreater(len(output), 0)
        # Should contain ftyp, moov, and mdat
        self.assertIn(b"ftyp", output[:20])
        # Check that output starts with ftyp
        self.assertEqual(output[4:8], b"ftyp")
        # Check that all sample data is present
        self.assertIn(b"\xcc" * 30, output)

    def test_demux_streams_empty_segments(self):
        """Empty media segments list should return empty tracks."""
        ftyp = self._build_ftyp()
        moov = self._build_moov()
        init = ftyp + moov
        tracks = demux_streams(init, [])
        self.assertEqual(len(tracks), 0)

    def test_demux_streams_segment_no_mdat(self):
        """Segment without mdat should be skipped gracefully."""
        ftyp = self._build_ftyp()
        moov = self._build_moov()
        init = ftyp + moov
        # Build a segment with only moof, no mdat
        mfhd = self._build_mfhd(1)
        tfhd = self._build_tfhd(1)
        trun_flags = 0x0001 | 0x1000
        trun_payload = struct.pack(">I", 0 << 24 | trun_flags)
        trun_payload += struct.pack(">I", 1)
        trun_payload += struct.pack(">i", 0)
        trun_payload += struct.pack(">I", 50)
        trun = self._build_box("trun", trun_payload)
        traf = self._build_box("traf", tfhd + trun)
        moof = self._build_box("moof", mfhd + traf)
        # No mdat appended
        tracks = demux_streams(init, [moof])
        self.assertEqual(len(tracks), 0)  # No mdat → no samples

    def test_demux_streams_sample_size_zero(self):
        """Samples with size=0 should not be included."""
        ftyp = self._build_ftyp()
        moov = self._build_moov()
        init = ftyp + moov
        # Segment with one sample of size=0 and one of size=50
        mdat_payload = b"\x00" * 50
        data_offset = 0
        trun_flags = 0x0001 | 0x1000
        trun_payload = struct.pack(">I", 0 << 24 | trun_flags)
        trun_payload += struct.pack(">I", 2)  # 2 samples
        trun_payload += struct.pack(">i", data_offset)
        trun_payload += struct.pack(">I", 0)    # sample 1: size 0 (skipped)
        trun_payload += struct.pack(">I", 50)   # sample 2: size 50 (included)
        trun = self._build_box("trun", trun_payload)
        mfhd = self._build_mfhd(1)
        tfhd = self._build_tfhd(1)
        traf = self._build_box("traf", tfhd + trun)
        moof = self._build_box("moof", mfhd + traf)
        mdat = self._build_box("mdat", mdat_payload)
        seg = moof + mdat
        tracks = demux_streams(init, [seg])
        self.assertEqual(len(tracks[1]), 1)  # Only 1 sample included
        self.assertEqual(tracks[1][0], b"\x00" * 50)

    def test_demux_streams_sample_beyond_mdat(self):
        """Sample whose offset extends beyond mdat should be skipped."""
        ftyp = self._build_ftyp()
        moov = self._build_moov()
        init = ftyp + moov
        mdat_payload = b"\x00" * 30
        trun_flags = 0x0001 | 0x1000
        trun_payload = struct.pack(">I", 0 << 24 | trun_flags)
        trun_payload += struct.pack(">I", 2)  # 2 samples
        trun_payload += struct.pack(">i", 0)
        trun_payload += struct.pack(">I", 20)  # sample 1: fits (offset 0-19)
        trun_payload += struct.pack(">I", 100)  # sample 2: extends beyond mdat (offset 20-119, mdat only has 30 bytes)
        trun = self._build_box("trun", trun_payload)
        mfhd = self._build_mfhd(1)
        tfhd = self._build_tfhd(1)
        traf = self._build_box("traf", tfhd + trun)
        moof = self._build_box("moof", mfhd + traf)
        mdat = self._build_box("mdat", mdat_payload)
        seg = moof + mdat
        tracks = demux_streams(init, [seg])
        self.assertEqual(len(tracks[1]), 1)  # Only first sample included
        self.assertEqual(tracks[1][0], b"\x00" * 20)

    def test_demux_streams_base_data_offset(self):
        """Segment with base_data_offset > 0 should still extract samples."""
        ftyp = self._build_ftyp()
        moov = self._build_moov()
        init = ftyp + moov
        mdat_payload = b"\x00" * 100
        # tfhd with base_data_offset
        tfhd_flags = 0x000001  # base-data-offset-present
        tfhd_payload = b"\x00" + struct.pack(">I", tfhd_flags)[1:]
        tfhd_payload += struct.pack(">I", 1)  # track_id
        tfhd_payload += struct.pack(">Q", 1000)  # base_data_offset
        tfhd = self._build_box("tfhd", tfhd_payload)
        trun_payload = struct.pack(">I", 0 << 24 | 0x1001)  # data-offset + sample-size
        trun_payload += struct.pack(">I", 1)
        trun_payload += struct.pack(">i", 20)  # data_offset = 20
        trun_payload += struct.pack(">I", 50)
        trun = self._build_box("trun", trun_payload)
        mfhd = self._build_mfhd(1)
        traf = self._build_box("traf", tfhd + trun)
        moof = self._build_box("moof", mfhd + traf)
        mdat = self._build_box("mdat", mdat_payload)
        seg = moof + mdat
        tracks = demux_streams(init, [seg])
        # base_data_offset > 0: sample_start = max(0, 20 - 8) = 12
        # So we get mdat_payload[12:62]
        self.assertEqual(len(tracks[1]), 1)
        self.assertEqual(tracks[1][0], mdat_payload[12:62])

    def test_remux_to_mp4_empty_tracks(self):
        """Remux with empty tracks dict should produce valid MP4 with empty mdat."""
        ftyp = self._build_ftyp()
        moov = self._build_moov()
        init = ftyp + moov
        init_info = parse_init_segment(init)
        output = remux_to_mp4({}, init_info)
        self.assertIn(b"ftyp", output[:20])
        self.assertIn(b"moov", output)
        self.assertIn(b"mdat", output)

    def test_remux_to_mp4_multiple_tracks(self):
        """Remux with multiple tracks should include all samples."""
        ftyp = self._build_ftyp()
        mvhd = self._build_mvhd()
        trak1 = self._build_trak(1, "vide")
        trak2 = self._build_trak(2, "soun")
        moov = self._build_box("moov", mvhd + trak1 + trak2)
        init = ftyp + moov
        init_info = parse_init_segment(init)
        tracks = {1: [b"v" * 100], 2: [b"a" * 50]}
        output = remux_to_mp4(tracks, init_info)
        self.assertIn(b"v" * 100, output)
        self.assertIn(b"a" * 50, output)

    def test_remux_to_mp4_empty_init_info(self):
        """Remux with empty init_info should use defaults and not crash."""
        output = remux_to_mp4({1: [b"data"]}, {})
        self.assertIn(b"ftyp", output[:20])
        self.assertIn(b"data", output)

    def test_remux_to_mp4_output_parses_back(self):
        """Remuxed output should be parseable by parse_boxes."""
        ftyp = self._build_ftyp()
        moov = self._build_moov()
        init = ftyp + moov
        init_info = parse_init_segment(init)
        tracks = {1: [b"\xdd" * 60]}
        output = remux_to_mp4(tracks, init_info)
        # Re-parse the output to verify valid structure
        boxes = parse_boxes_hierarchical(output)
        types = [b.type for b in boxes]
        self.assertIn("ftyp", types)
        self.assertIn("moov", types)
        self.assertIn("mdat", types)
        # Verify mdat contains our samples
        mdat_box = [b for b in boxes if b.type == "mdat"][0]
        self.assertIn(b"\xdd" * 60, mdat_box.data)

    def test_demux_streams_mdat_size_zero(self):
        """Segment with size=0 mdat (extends to end) should still work."""
        ftyp = self._build_ftyp()
        moov = self._build_moov()
        init = ftyp + moov
        sample_data = b"\xff" * 40
        mdat_header = struct.pack(">I", 0) + b"mdat"  # size=0 means extends to end
        mdat = mdat_header + sample_data + b"extra_garbage_that_should_be_part_of_mdat"
        trun_payload = struct.pack(">I", 0 << 24 | 0x1001)
        trun_payload += struct.pack(">I", 2)
        trun_payload += struct.pack(">i", 0)
        trun_payload += struct.pack(">I", 20)
        trun_payload += struct.pack(">I", 20)
        trun = self._build_box("trun", trun_payload)
        mfhd = self._build_mfhd(1)
        tfhd = self._build_tfhd(1)
        traf = self._build_box("traf", tfhd + trun)
        moof = self._build_box("moof", mfhd + traf)
        seg = moof + mdat
        tracks = demux_streams(init, [seg])
        self.assertEqual(len(tracks[1]), 2)
        self.assertEqual(tracks[1][0], b"\xff" * 20)
        self.assertEqual(tracks[1][1], b"\xff" * 20)


# ─── Task 3c: Encrypted Segment Detection ────────────────────────────────


class TestEncryptedSegmentDetection(unittest.TestCase):
    """Test detection of encrypted segments (sinf, pssh, schm boxes)."""

    def _build_box(self, box_type: str, payload: bytes) -> bytes:
        size = 8 + len(payload)
        return struct.pack(">I", size) + box_type.encode() + payload

    def test_detect_encryption_pssh(self):
        """PSSH boxes should be detected as encrypted."""
        system_id = bytes(
            [
                0xED,
                0xEF,
                0x8B,
                0xA9,
                0x79,
                0xD6,
                0x4A,
                0xCE,
                0xA3,
                0xC8,
                0x10,
                0x0D,
                0x6F,
                0x33,
                0x26,
                0x7E,
            ]
        )
        payload = b"\x00\x00\x00\x00" + system_id
        payload += b"\x00\x00\x00\x00"  # KID count = 0
        payload += b"\x00\x00\x00\x0c" + b"testpsshdata"
        pssh = self._build_box("pssh", payload)
        boxes = parse_boxes(pssh)
        enc = detect_encryption(boxes)
        self.assertTrue(enc["has_cenc"])
        self.assertEqual(len(enc["pssh_boxes"]), 1)

    def test_has_encryption_boxes_sinf(self):
        """sinf boxes should be detected as encryption."""
        sinf = self._build_box("sinf", b"dummydata")
        boxes = parse_boxes(sinf)
        self.assertTrue(has_encryption_boxes(boxes))

    def test_has_encryption_boxes_negative(self):
        """Non-encryption boxes should return False."""
        ftyp = self._build_box("ftyp", b"isom")
        boxes = parse_boxes(ftyp)
        self.assertFalse(has_encryption_boxes(boxes))

    def test_detect_encryption_no_encryption(self):
        """Clean init segment should return no encryption."""
        ftyp = self._build_box("ftyp", b"isom")
        enc = detect_encryption(parse_boxes(ftyp))
        self.assertFalse(enc["has_cenc"])
        self.assertEqual(len(enc["pssh_boxes"]), 0)

    def test_has_encryption_boxes_nested_pssh(self):
        """PSSH inside a moov container should be detected."""
        pssh = self._build_box("pssh", b"\x00" * 30)
        moov = self._build_box("moov", pssh)
        boxes = parse_boxes(moov)
        self.assertTrue(has_encryption_boxes(boxes))

    def test_detect_encryption_schm_scheme_type(self):
        """schm box should report scheme type (cenc/cbcs)."""
        payload = b"\x00\x00\x00\x00" + b"cenc"
        schm = self._build_box("schm", payload)
        enc = detect_encryption(parse_boxes(schm))
        self.assertEqual(enc["scheme_type"], "cenc")

    def test_detect_encryption_empty_boxes(self):
        """detect_encryption with empty list should return safe defaults."""
        enc = detect_encryption([])
        self.assertFalse(enc["has_cenc"])
        self.assertEqual(enc["scheme_type"], "")
        self.assertEqual(enc["pssh_boxes"], [])

    def test_detect_encryption_nested_schm(self):
        """schm inside nested container should be detected."""
        payload = b"\x00\x00\x00\x00" + b"cbcs"
        schm = self._build_box("schm", payload)
        sinf = self._build_box("sinf", schm)
        stsd = self._build_box("stsd", sinf)
        stbl = self._build_box("stbl", stsd)
        moov = self._build_box("moov", stbl)
        enc = detect_encryption(parse_boxes(moov))
        self.assertTrue(enc["has_cenc"])
        self.assertEqual(enc["scheme_type"], "cbcs")

    def test_detect_encryption_tenc_box(self):
        """tenc box should be detected."""
        tenc = self._build_box("tenc", b"\x00" * 20)
        boxes = parse_boxes(tenc)
        self.assertTrue(has_encryption_boxes(boxes))
        enc = detect_encryption(boxes)
        self.assertTrue(enc["has_cenc"])

    def test_detect_encryption_frma_box(self):
        """frma box should be detected."""
        frma = self._build_box("frma", b"avc1")
        boxes = parse_boxes(frma)
        self.assertTrue(has_encryption_boxes(boxes))

    def test_detect_encryption_multiple_pssh(self):
        """Multiple PSSH boxes should all be collected."""
        pssh1 = self._build_box("pssh", b"\x00" * 30)
        pssh2 = self._build_box("pssh", b"\x00" * 30)
        boxes = parse_boxes(pssh1 + pssh2)
        enc = detect_encryption(boxes)
        self.assertEqual(len(enc["pssh_boxes"]), 2)

    def test_detect_encryption_pssh_and_schm(self):
        """PSSH + schm together should report both."""
        pssh = self._build_box("pssh", b"\x00" * 30)
        schm = self._build_box("schm", b"\x00\x00\x00\x00" + b"cenc")
        boxes = parse_boxes(pssh + schm)
        enc = detect_encryption(boxes)
        self.assertTrue(enc["has_cenc"])
        self.assertEqual(enc["scheme_type"], "cenc")
        self.assertEqual(len(enc["pssh_boxes"]), 1)

    def test_has_encryption_boxes_empty_list(self):
        """has_encryption_boxes with empty list should return False."""
        self.assertFalse(has_encryption_boxes([]))

    def test_has_encryption_boxes_tenc(self):
        """tenc box should be detected by has_encryption_boxes."""
        tenc = self._build_box("tenc", b"\x00" * 20)
        boxes = parse_boxes(tenc)
        self.assertTrue(has_encryption_boxes(boxes))

    def test_has_encryption_boxes_frma(self):
        """frma box should be detected."""
        frma = self._build_box("frma", b"avc1")
        boxes = parse_boxes(frma)
        self.assertTrue(has_encryption_boxes(boxes))

    def test_detect_encryption_nested_multiple_pssh(self):
        """PSSH boxes at different nesting levels should all be collected."""
        pssh1 = self._build_box("pssh", b"\x00" * 30)
        pssh2 = self._build_box("pssh", b"\x01" * 30)
        moov = self._build_box("moov", pssh1)
        boxes = parse_boxes(pssh2 + moov)
        enc = detect_encryption(boxes)
        self.assertEqual(len(enc["pssh_boxes"]), 2)

    def test_detect_encryption_cbcs_scheme(self):
        """cbcs scheme type should be detected."""
        payload = b"\x00\x00\x00\x00" + b"cbcs"
        schm = self._build_box("schm", payload)
        enc = detect_encryption(parse_boxes(schm))
        self.assertEqual(enc["scheme_type"], "cbcs")


if __name__ == "__main__":
    unittest.main()
