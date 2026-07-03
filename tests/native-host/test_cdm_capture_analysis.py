"""Tests for fMP4 segment analysis in cdm_capture.py.

Tests the analyze_fmp4_segments(), _extract_sequence_numbers(), and
_check_cmaf_from_files() functions that provide real-time gap reporting
and CMAF detection during the capture pipeline.
"""

import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path

from path_setup import *

from cdm_capture import (
    _check_cmaf_from_files,
    _extract_sequence_numbers,
    analyze_fmp4_segments,
)


class TestExtractSequenceNumbers(unittest.TestCase):
    """Tests for _extract_sequence_numbers()."""

    def _build_moof_with_seq(self, seq_num=1):
        """Build a minimal moof+mdat segment with the given sequence number."""
        mfhd_payload = b"\x00\x00\x00\x00" + struct.pack(">I", seq_num)
        mfhd = self._build_box("mfhd", mfhd_payload)
        trun_payload = (
            struct.pack(">I", 0x00010000)  # version=0, flags=0x0001 (data-offset-present)
            + struct.pack(">I", 1)  # sample_count=1
            + struct.pack(">i", 0)  # data_offset=0
        )
        trun = self._build_box("trun", trun_payload)
        tfhd_payload = (
            b"\x00\x00\x00\x01"  # version=0, flags=0x0001
            + struct.pack(">I", 1)  # track_id=1
            + struct.pack(">Q", 0)  # base_data_offset=0
        )
        tfhd = self._build_box("tfhd", tfhd_payload)
        traf = self._build_box("traf", tfhd + trun)
        moof = self._build_box("moof", mfhd + traf)
        mdat = self._build_box("mdat", b"\x00" * 16)
        return moof + mdat

    def _build_box(self, box_type: str, payload: bytes) -> bytes:
        size = 8 + len(payload)
        return struct.pack(">I", size) + box_type.encode() + payload

    def test_single_segment(self):
        """Extract sequence number from a single segment."""
        with tempfile.NamedTemporaryFile(suffix=".m4s", delete=False) as f:
            f.write(self._build_moof_with_seq(1))
            path = f.name
        try:
            seq_infos = _extract_sequence_numbers([path])
            self.assertEqual(len(seq_infos), 1)
            self.assertEqual(seq_infos[0]["seq_num"], 1)
            self.assertEqual(seq_infos[0]["path"], path)
        finally:
            os.unlink(path)

    def test_multiple_segments_ordered(self):
        """Extract sequence numbers from multiple segments, returned in order."""
        paths = []
        for seq in [3, 1, 2]:
            f = tempfile.NamedTemporaryFile(suffix=".m4s", delete=False)
            f.write(self._build_moof_with_seq(seq))
            f.close()
            paths.append(f.name)
        try:
            seq_infos = _extract_sequence_numbers(paths)
            self.assertEqual(len(seq_infos), 3)
            # Should be sorted by seq_num
            self.assertEqual(seq_infos[0]["seq_num"], 1)
            self.assertEqual(seq_infos[1]["seq_num"], 2)
            self.assertEqual(seq_infos[2]["seq_num"], 3)
        finally:
            for p in paths:
                os.unlink(p)

    def test_no_moof_box(self):
        """File without a moof box should not return seq info."""
        f = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
        f.write(b"\x00\x00\x00\x08ftyp\x00\x00\x00\x00")
        f.close()
        path = f.name
        try:
            seq_infos = _extract_sequence_numbers([path])
            self.assertEqual(len(seq_infos), 0)
        finally:
            os.unlink(path)

    def test_empty_file(self):
        """Empty file should be skipped."""
        f = tempfile.NamedTemporaryFile(suffix=".m4s", delete=False)
        f.close()
        path = f.name
        try:
            seq_infos = _extract_sequence_numbers([path])
            self.assertEqual(len(seq_infos), 0)
        finally:
            os.unlink(path)

    def test_missing_file(self):
        """Missing file should be skipped without raising."""
        seq_infos = _extract_sequence_numbers(["/nonexistent/seg1.m4s"])
        self.assertEqual(len(seq_infos), 0)


class TestCheckCmafFromFiles(unittest.TestCase):
    """Tests for _check_cmaf_from_files()."""

    def _build_ftyp(self, major_brand="isom", compatible_brands=None):
        """Build a minimal ftyp box."""
        brands = compatible_brands or ["isom", "iso2"]
        payload = major_brand.encode().ljust(4)[:4]
        payload += struct.pack(">I", 0x0200)
        for brand in brands:
            payload += brand.encode().ljust(4, b"\x00")[:4]
        size = 8 + len(payload)
        return struct.pack(">I", size) + b"ftyp" + payload

    def test_cmaf_video_detected(self):
        """cmfv brand should be detected as CMAF."""
        f = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
        f.write(self._build_ftyp("cmfv", ["cmfv", "iso6"]))
        f.close()
        path = f.name
        try:
            result = _check_cmaf_from_files([path])
            self.assertTrue(result["is_cmaf"])
            self.assertIn(path, result["detected_in"])
        finally:
            os.unlink(path)

    def test_cmaf_audio_detected(self):
        """cmfa brand should be detected as CMAF."""
        f = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
        f.write(self._build_ftyp("cmfa", ["cmfa", "iso6"]))
        f.close()
        path = f.name
        try:
            result = _check_cmaf_from_files([path])
            self.assertTrue(result["is_cmaf"])
            self.assertIn(path, result["detected_in"])
        finally:
            os.unlink(path)

    def test_no_cmaf(self):
        """Standard isom brand should not be detected as CMAF."""
        f = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
        f.write(self._build_ftyp("isom", ["isom", "iso2"]))
        f.close()
        path = f.name
        try:
            result = _check_cmaf_from_files([path])
            self.assertFalse(result["is_cmaf"])
            self.assertEqual(len(result["detected_in"]), 0)
        finally:
            os.unlink(path)

    def test_empty_init_list(self):
        """Empty init segment list should return no CMAF."""
        result = _check_cmaf_from_files([])
        self.assertFalse(result["is_cmaf"])
        self.assertEqual(len(result["detected_in"]), 0)

    def test_missing_init_file(self):
        """Missing init file should be skipped."""
        result = _check_cmaf_from_files(["/nonexistent/init.mp4"])
        self.assertFalse(result["is_cmaf"])
        self.assertEqual(len(result["detected_in"]), 0)


class TestAnalyzeFmp4Segments(unittest.TestCase):
    """Tests for analyze_fmp4_segments()."""

    def _build_ftyp(self, major_brand="isom", compatible_brands=None):
        brands = compatible_brands or ["isom", "iso2"]
        payload = major_brand.encode().ljust(4)[:4]
        payload += struct.pack(">I", 0x0200)
        for brand in brands:
            payload += brand.encode().ljust(4, b"\x00")[:4]
        size = 8 + len(payload)
        return struct.pack(">I", size) + b"ftyp" + payload

    def _build_moov(self):
        mvhd_content = b"\x00\x00\x00\x00" + b"\x00" * 8  # version(1)+flags(3)+times(8)
        mvhd_content += struct.pack(">I", 1000)  # timescale
        mvhd_content += struct.pack(">I", 10000)  # duration
        mvhd_content += b"\x00" * 52  # remaining mvhd fields
        mvhd = self._build_box("mvhd", mvhd_content)
        return self._build_box("moov", mvhd)

    def _build_box(self, box_type: str, payload: bytes) -> bytes:
        size = 8 + len(payload)
        return struct.pack(">I", size) + box_type.encode() + payload

    def _build_moof_with_seq(self, seq_num=1):
        mfhd_payload = b"\x00\x00\x00\x00" + struct.pack(">I", seq_num)
        mfhd = self._build_box("mfhd", mfhd_payload)
        trun_payload = struct.pack(">I", 0x00010000) + struct.pack(">I", 1) + struct.pack(">i", 0)
        trun = self._build_box("trun", trun_payload)
        tfhd_payload = b"\x00\x00\x00\x01" + struct.pack(">I", 1) + struct.pack(">Q", 0)
        tfhd = self._build_box("tfhd", tfhd_payload)
        traf = self._build_box("traf", tfhd + trun)
        moof = self._build_box("moof", mfhd + traf)
        mdat = self._build_box("mdat", b"\x00" * 16)
        return moof + mdat

    def test_basic_analysis_no_gaps(self):
        """Analysis with sequential segments should report no gaps."""
        f_init = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
        f_init.write(self._build_ftyp() + self._build_moov())
        f_init.close()
        init_path = f_init.name

        seg_paths = []
        for seq in [1, 2, 3]:
            f = tempfile.NamedTemporaryFile(suffix=".m4s", delete=False)
            f.write(self._build_moof_with_seq(seq))
            f.close()
            seg_paths.append(f.name)

        try:
            result = analyze_fmp4_segments(
                init_seg_paths=[init_path],
                media_seg_paths=seg_paths,
            )
            self.assertEqual(result["analyzed_segments"], 3)
            self.assertEqual(result["sequence_count"], 3)
            self.assertFalse(result["has_gaps"])
            self.assertEqual(result["gap_count"], 0)
            self.assertFalse(result["cmaf"]["is_cmaf"])
        finally:
            os.unlink(init_path)
            for p in seg_paths:
                os.unlink(p)

    def test_analysis_with_gaps(self):
        """Analysis with missing sequence numbers should report gaps."""
        f_init = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
        f_init.write(self._build_ftyp() + self._build_moov())
        f_init.close()
        init_path = f_init.name

        seg_paths = []
        for seq in [1, 3, 5]:  # seq 2 and 4 missing
            f = tempfile.NamedTemporaryFile(suffix=".m4s", delete=False)
            f.write(self._build_moof_with_seq(seq))
            f.close()
            seg_paths.append(f.name)

        try:
            result = analyze_fmp4_segments(
                init_seg_paths=[init_path],
                media_seg_paths=seg_paths,
            )
            self.assertEqual(result["analyzed_segments"], 3)
            self.assertTrue(result["has_gaps"])
            self.assertEqual(result["gap_count"], 2)
            self.assertEqual(result["gaps"][0]["missing"], 2)
            self.assertEqual(result["gaps"][1]["missing"], 4)
        finally:
            os.unlink(init_path)
            for p in seg_paths:
                os.unlink(p)

    def test_analysis_cmaf_detected(self):
        """Analysis should detect CMAF from init segment."""
        f_init = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
        f_init.write(self._build_ftyp("cmfv", ["cmfv", "iso6"]) + self._build_moov())
        f_init.close()
        init_path = f_init.name

        try:
            result = analyze_fmp4_segments(
                init_seg_paths=[init_path],
                media_seg_paths=[],
            )
            self.assertTrue(result["cmaf"]["is_cmaf"])
            self.assertIn(init_path, result["cmaf"]["detected_in"])
            self.assertEqual(result["analyzed_segments"], 0)
        finally:
            os.unlink(init_path)

    def test_analysis_empty_segments(self):
        """Analysis with no segments should still return basic CMAF info."""
        result = analyze_fmp4_segments(
            init_seg_paths=[],
            media_seg_paths=[],
        )
        self.assertEqual(result["analyzed_segments"], 0)
        self.assertEqual(result["gap_count"], 0)
        self.assertFalse(result["has_gaps"])
        self.assertFalse(result["cmaf"]["is_cmaf"])
        self.assertEqual(result["error"], "")

    def test_analysis_no_init_segments(self):
        """Analysis with only media segments (no init) should still work."""
        seg_paths = []
        for seq in [1, 2]:
            f = tempfile.NamedTemporaryFile(suffix=".m4s", delete=False)
            f.write(self._build_moof_with_seq(seq))
            f.close()
            seg_paths.append(f.name)

        try:
            result = analyze_fmp4_segments(
                init_seg_paths=[],
                media_seg_paths=seg_paths,
            )
            self.assertEqual(result["analyzed_segments"], 2)
            self.assertFalse(result["has_gaps"])
            self.assertFalse(result["cmaf"]["is_cmaf"])
        finally:
            for p in seg_paths:
                os.unlink(p)


if __name__ == "__main__":
    unittest.main()
