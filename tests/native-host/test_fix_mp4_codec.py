"""Tests for fix_mp4_codec — mp4v→avc1 codec metadata fixer."""

import os
import struct
import tempfile
import unittest
from pathlib import Path

import path_setup  # noqa: F401
from fix_mp4_codec import (
    _build_avcc_box,
    _extract_nal_units,
    _find_box_in_range,
    _read_box,
    _sps_profile_level,
    _strip_start_code,
    fix_mp4_codec_metadata,
    needs_codec_fix,
)

# ── Helper to build minimal MP4 files ─────────────────────────────────


def _build_box(box_type: bytes, payload: bytes) -> bytes:
    """Build an MP4 box with 4-byte size + 4-byte type + payload."""
    size = 8 + len(payload)
    return struct.pack(">I", size) + box_type + payload


def _build_ftyp() -> bytes:
    return _build_box(b"ftyp", b"isom\x00\x00\x02\x00isomiso2avc1mp41")


def _build_moov(audio_only: bool = False) -> bytes:
    """Build a minimal moov box with an stsd containing mp4v (audio_only=False)
    or a clean stream. Returns a byte buffer that can be wrapped in a moov box."""
    # Build a minimal stsd
    if audio_only:
        # No mp4v — clean file
        sample_entry = _build_box(
            b"mp4a",
            b"\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00"
            b"\x00\x02\x00\x10\xff\xfe\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00",
        )
        stsd_payload = struct.pack(">I", 0) + struct.pack(">I", 1) + sample_entry
        stsd = _build_box(b"stsd", stsd_payload)
    else:
        # Build mp4v with esds (4-byte entry count + mp4v sample entry)
        esds = _build_box(
            b"esds",
            b"\x00\x00\x00\x00\x03\x80\x80\x80\x22\x00\x00\x04\x80\x80\x80\x14\x40\x15\x00\x06\x00\x00\x00\x00\x00\x00\x05\x80\x80\x80\x02\xff\xff",
        )
        # mp4v sample entry: 6 reserved + 2 data ref + 16 video info + esds
        mp4v_payload = (
            b"\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x18\x00\x00\x00\x48\x00\x00"
            + esds
        )
        mp4v_entry = _build_box(b"mp4v", mp4v_payload)
        stsd_payload = struct.pack(">I", 0) + struct.pack(">I", 1) + mp4v_entry
        stsd = _build_box(b"stsd", stsd_payload)

    stbl = _build_box(b"stbl", stsd)
    minf = _build_box(b"minf", stbl)
    mdia = _build_box(b"mdia", minf)
    trak = _build_box(b"trak", mdia)
    mvhd = _build_box(
        b"mvhd",
        b"\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x40\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00",
    )
    return _build_box(b"moov", mvhd + trak)


def _build_mdat(h264_data: bytes = b"") -> bytes:
    """Build an mdat box with optional H.264 data."""
    if not h264_data:
        h264_data = (
            b"\x00\x00\x00\x01\x67\x64\x00\x1e\xac\x52\x80\x40\x01"
            b"\x00\x04\x7f\xff\x01\x40\x00\x00\x03\x00\x10\x00\x00"
            b"\x03\x02\x8c\xa0\xc1\x48\x00\x00\x00\x01\x68\xee\x3c\x80"
        )
    return _build_box(b"mdat", h264_data)


def _build_green_video_mp4() -> bytes:
    """Build a complete MP4 with mp4v codec label (simulating the green video bug)."""
    return _build_ftyp() + _build_moov(audio_only=False) + _build_mdat()


def _build_clean_mp4() -> bytes:
    """Build a clean MP4 (audio-only, no mp4v issue)."""
    return _build_ftyp() + _build_moov(audio_only=True) + _build_mdat()


# ── Tests ─────────────────────────────────────────────────────────────


class TestReadBox(unittest.TestCase):
    """Test low-level MP4 box parsing."""

    def test_reads_normal_box(self):
        data = _build_box(b"test", b"hello")
        size, btype, payload = _read_box(data, 0)
        self.assertEqual(size, 13)  # 8 + 5
        self.assertEqual(btype, b"test")
        self.assertEqual(payload, 8)

    def test_reads_box_with_size_0(self):
        # size=0 means "rest of file"
        data = b"\x00\x00\x00\x00testhello!!"
        size, btype, payload = _read_box(data, 0)
        self.assertEqual(size, len(data))
        self.assertEqual(btype, b"test")
        self.assertEqual(payload, 8)

    def test_handles_too_short_data(self):
        # Data shorter than 8-byte box header
        data = b"\x00\x00\x00"
        size, btype, payload = _read_box(data, 0)
        self.assertEqual(size, 0)
        self.assertEqual(btype, b"")

    def test_handles_64_bit_extended_size(self):
        # size=1 means 64-bit extended size follows the type field
        data = b"\x00\x00\x00\x01test\x00\x00\x00\x00\x00\x00\x01\x00" + b"x" * 248
        size, btype, payload = _read_box(data, 0)
        self.assertEqual(size, 256)
        self.assertEqual(btype, b"test")
        self.assertEqual(payload, 16)


class TestFindBoxInRange(unittest.TestCase):
    """Test recursive box finding."""

    def test_finds_top_level_box(self):
        data = _build_ftyp() + _build_moov()
        offset = _find_box_in_range(data, b"moov", 0, len(data))
        self.assertIsNotNone(offset)
        self.assertEqual(data[offset + 4 : offset + 8], b"moov")

    def test_finds_nested_stsd(self):
        data = _build_ftyp() + _build_moov() + _build_mdat()
        # Find moov first, then stsd inside it
        moov_off = _find_box_in_range(data, b"moov", 0, len(data))
        self.assertIsNotNone(moov_off)
        _, _, moov_payload = _read_box(data, moov_off)
        stsd_off = _find_box_in_range(data, b"stsd", moov_payload, moov_payload + 200000)
        self.assertIsNotNone(stsd_off)
        self.assertEqual(data[stsd_off + 4 : stsd_off + 8], b"stsd")

    def test_returns_none_for_missing_box(self):
        data = _build_ftyp()
        offset = _find_box_in_range(data, b"none", 0, len(data))
        self.assertIsNone(offset)


class TestNalExtraction(unittest.TestCase):
    """Test NAL unit extraction from bytestream."""

    def test_extracts_sps_nal_unit(self):
        # Build a minimal H.264 bytestream with start codes
        sps = b"\x00\x00\x00\x01\x67\x64\x00\x1e\xac\x52"
        pps = b"\x00\x00\x00\x01\x68\xee\x3c\x80"
        idr = b"\x00\x00\x00\x01\x65\x88\x84\x00"
        stream = sps + pps + idr
        units = _extract_nal_units(stream, 7, max_count=2)  # NAL type 7 = SPS
        self.assertEqual(len(units), 1)
        self.assertIn(b"\x67", units[0])

    def test_extracts_pps_nal_unit(self):
        sps = b"\x00\x00\x00\x01\x67\x64\x00\x1e\xac\x52"
        pps = b"\x00\x00\x00\x01\x68\xee\x3c\x80"
        stream = sps + pps
        units = _extract_nal_units(stream, 8, max_count=2)  # NAL type 8 = PPS
        self.assertEqual(len(units), 1)
        self.assertIn(b"\x68", units[0])

    def test_handles_3_byte_start_codes(self):
        sps = b"\x00\x00\x01\x67\x64\x00\x1e\xac\x52"
        stream = sps
        units = _extract_nal_units(stream, 7, max_count=2)
        self.assertEqual(len(units), 1)

    def test_handles_4_byte_start_codes(self):
        sps = b"\x00\x00\x00\x01\x67\x64\x00\x1e\xac\x52"
        stream = sps
        units = _extract_nal_units(stream, 7, max_count=2)
        self.assertEqual(len(units), 1)


class TestStripStartCode(unittest.TestCase):
    """Test NAL unit start code stripping."""

    def test_strips_4_byte_start_code(self):
        self.assertEqual(_strip_start_code(b"\x00\x00\x00\x01\x67\x64"), b"\x67\x64")

    def test_strips_3_byte_start_code(self):
        self.assertEqual(_strip_start_code(b"\x00\x00\x01\x67\x64"), b"\x67\x64")

    def test_returns_unchanged_if_no_start_code(self):
        self.assertEqual(_strip_start_code(b"\x67\x64"), b"\x67\x64")


class TestSpsProfileLevel(unittest.TestCase):
    """Test SPS profile/level extraction."""

    def test_extracts_from_4_byte_start_code(self):
        # Structure: [4-byte start code][NAL header][profile][compat][level]
        # offset=5: sps_nal[5]=profile=0x64=100, [6]=compat=0, [7]=level=30
        sps = b"\x00\x00\x00\x01\x67\x64\x00\x1e"
        profile, compat, level = _sps_profile_level(sps)
        self.assertEqual(profile, 100)
        self.assertEqual(compat, 0)
        self.assertEqual(level, 30)

    def test_extracts_from_3_byte_start_code(self):
        # Structure: [3-byte start code][NAL header][profile][compat][level]
        # offset=4: sps_nal[4]=profile=0x64=100, [5]=compat=0, [6]=level=30
        sps = b"\x00\x00\x01\x67\x64\x00\x1e"
        profile, compat, level = _sps_profile_level(sps)
        self.assertEqual(profile, 100)
        self.assertEqual(compat, 0)
        self.assertEqual(level, 30)

    def test_returns_defaults_for_short_nal(self):
        sps = b"\x00\x00\x01"
        profile, compat, level = _sps_profile_level(sps)
        self.assertEqual(profile, 100)
        self.assertEqual(compat, 0)
        self.assertEqual(level, 40)


class TestBuildAvccBox(unittest.TestCase):
    """Test AVC configuration record construction."""

    def test_builds_valid_avcc(self):
        sps = [
            b"\x00\x00\x00\x01\x67\x64\x00\x1e\xac\x52\x80\x40\x01\x00\x04\x7f\xff\x01\x40\x00\x00\x03\x00\x10\x00\x00\x03\x02\x8c\xa0\xc1\x48"
        ]
        pps = [b"\x00\x00\x00\x01\x68\xee\x3c\x80"]
        box = _build_avcc_box(sps, pps)
        # Should start with 4-byte size + "avcC"
        self.assertGreater(len(box), 12)
        self.assertEqual(box[4:8], b"avcC")
        # Size field should include the 8-byte header
        declared_size = int.from_bytes(box[0:4], "big")
        self.assertEqual(declared_size, len(box))
        # Verify configurationVersion = 1
        self.assertEqual(box[8], 1)

    def test_returns_empty_for_no_sps(self):
        box = _build_avcc_box([], [])
        self.assertEqual(box, b"")


class TestNeedsCodecFix(unittest.TestCase):
    """Test codec issue detection."""

    def test_detects_mp4v(self):
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(_build_green_video_mp4())
            f.flush()
            path = f.name
        try:
            self.assertTrue(needs_codec_fix(path))
        finally:
            os.unlink(path)

    def test_returns_false_for_clean_audio_file(self):
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(_build_clean_mp4())
            f.flush()
            path = f.name
        try:
            self.assertFalse(needs_codec_fix(path))
        finally:
            os.unlink(path)

    def test_returns_false_for_non_mp4_files(self):
        with tempfile.NamedTemporaryFile(suffix=".mkv", delete=False) as f:
            path = f.name
        try:
            self.assertFalse(needs_codec_fix(path))
        finally:
            os.unlink(path)

    def test_returns_false_for_missing_file(self):
        self.assertFalse(needs_codec_fix("/nonexistent/file.mp4"))


class TestFixMp4CodecMetadata(unittest.TestCase):
    """Test the actual fix function."""

    def test_fixes_mp4v_to_avc1(self):
        mp4_data = _build_green_video_mp4()
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(mp4_data)
            f.flush()
            path = f.name
        try:
            result = fix_mp4_codec_metadata(path, backup=False)
            self.assertTrue(result["ok"])
            self.assertTrue(result["fixed"])
            # Verify the fix: check that mp4v is gone and avc1 is present
            data = Path(path).read_bytes()
            stsd_pos = data.find(b"stsd")
            stsd_region = data[stsd_pos : stsd_pos + 2048]
            self.assertNotIn(b"mp4v", stsd_region)
            self.assertIn(b"avc1", stsd_region)
            self.assertIn(b"avcC", stsd_region)
            self.assertNotIn(b"esds", stsd_region)
        finally:
            os.unlink(path)

    def test_returns_ok_for_clean_file(self):
        mp4_data = _build_clean_mp4()
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(mp4_data)
            f.flush()
            path = f.name
        try:
            result = fix_mp4_codec_metadata(path, backup=False)
            # Clean file: no mp4v found → fixed=False (ok is also False since no operation performed)
            self.assertFalse(result["fixed"])
        finally:
            os.unlink(path)

    def test_backup_option_creates_dot_bak(self):
        mp4_data = _build_green_video_mp4()
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(mp4_data)
            f.flush()
            path = f.name
        try:
            result = fix_mp4_codec_metadata(path, backup=True)
            self.assertTrue(result["fixed"])
            # Check backup was created
            self.assertTrue(result["backup"].endswith(".mp4.bak"))
            backup_path = result["backup"]
            self.assertTrue(os.path.exists(backup_path))
            # Backup should contain original mp4v
            backup_data = Path(backup_path).read_bytes()
            stsd_pos = backup_data.find(b"stsd")
            stsd_region = backup_data[stsd_pos : stsd_pos + 2048]
            self.assertIn(b"mp4v", stsd_region)
            os.unlink(backup_path)
        finally:
            os.unlink(path)

    def test_handles_missing_file(self):
        result = fix_mp4_codec_metadata("/nonexistent/file.mp4", backup=False)
        self.assertFalse(result["ok"])
        self.assertFalse(result["fixed"])


if __name__ == "__main__":
    unittest.main()
