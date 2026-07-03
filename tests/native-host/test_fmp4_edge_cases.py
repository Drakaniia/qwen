"""Tests for fMP4 edge cases: interleaved tracks, segment gaps, CMAF detection.

Tests the edge case handling functions added in Phase 4:
- detect_track_gaps(): missing sequence number detection
- is_cmaf(): CMAF-formatted segment detection
- interleave_tracks(): multi-track sample interleaving by timestamp
- Enhanced demux_streams(): sequence number sorting
"""

import struct
import unittest

import path_setup  # noqa: F401
from codec.fmp4 import (
    demux_streams,
    detect_track_gaps,
    interleave_tracks,
    is_cmaf,
)


class TestFmp4EdgeCases(unittest.TestCase):
    """Test fMP4 edge cases: interleaved tracks, segment gaps, CMAF."""

    def _build_box(self, box_type: str, payload: bytes) -> bytes:
        size = 8 + len(payload)
        return struct.pack(">I", size) + box_type.encode() + payload

    def _build_mfhd(self, sequence_number=1):
        """Build a minimal mfhd box."""
        payload = b"\x00" + b"\x00\x00\x00"  # version + flags
        payload += struct.pack(">I", sequence_number)
        return self._build_box("mfhd", payload)

    # ─── detect_track_gaps tests ───────────────────────────────────────

    def test_detect_segment_gaps_no_gaps(self):
        """detect_track_gaps should return empty for sequential segments."""
        segments = [
            {"seq_num": 1, "data": b"seg1"},
            {"seq_num": 2, "data": b"seg2"},
            {"seq_num": 3, "data": b"seg3"},
        ]
        gaps = detect_track_gaps(segments)
        self.assertEqual(len(gaps), 0, "No gaps should be detected for sequential segments")

    def test_detect_segment_gaps_missing(self):
        """detect_track_gaps should detect missing sequence numbers."""
        segments = [
            {"seq_num": 1, "data": b"seg1"},
            {"seq_num": 3, "data": b"seg3"},  # seq 2 missing
            {"seq_num": 5, "data": b"seg5"},  # seq 4 missing
        ]
        gaps = detect_track_gaps(segments)
        self.assertEqual(len(gaps), 2, "Should detect 2 gaps")
        self.assertEqual(gaps[0]["missing"], 2, "First gap should be sequence 2")
        self.assertEqual(gaps[1]["missing"], 4, "Second gap should be sequence 4")

    def test_detect_segment_gaps_single_segment(self):
        """detect_track_gaps should return empty for a single segment."""
        gaps = detect_track_gaps([{"seq_num": 1, "data": b"seg1"}])
        self.assertEqual(len(gaps), 0, "Single segment should have no gaps")

    def test_detect_segment_gaps_empty_list(self):
        """detect_track_gaps should return empty for an empty list."""
        gaps = detect_track_gaps([])
        self.assertEqual(len(gaps), 0, "Empty list should have no gaps")

    def test_detect_segment_gaps_reports_before_after(self):
        """detect_track_gaps should report the before and after seq nums for each gap."""
        segments = [
            {"seq_num": 1, "data": b"seg1"},
            {"seq_num": 4, "data": b"seg4"},  # seq 2, 3 missing
        ]
        gaps = detect_track_gaps(segments)
        self.assertEqual(len(gaps), 2, "Should detect 2 gaps")
        self.assertEqual(gaps[0]["before"], 1)
        self.assertEqual(gaps[0]["after"], 4)
        self.assertEqual(gaps[0]["missing"], 2)
        self.assertEqual(gaps[1]["missing"], 3)

    def test_detect_segment_gaps_no_seq_num_key(self):
        """Segments without seq_num should be skipped."""
        segments = [
            {"data": b"seg1"},  # no seq_num
            {"seq_num": 2, "data": b"seg2"},
        ]
        gaps = detect_track_gaps(segments)
        self.assertEqual(len(gaps), 0)

    # ─── is_cmaf tests ─────────────────────────────────────────────────

    def test_is_cmaf_video_positive(self):
        """CMAF video (cmfv brand) should be detected."""
        ftyp_payload = b"cmfv" + b"\x00\x00\x02\x00" + b"cmfv" + b"iso6"
        ftyp = self._build_box("ftyp", ftyp_payload)
        self.assertTrue(is_cmaf(ftyp), "cmfv brand should be detected as CMAF")

    def test_is_cmaf_audio_positive(self):
        """CMAF audio (cmfa brand) should be detected."""
        ftyp_payload = b"cmfa" + b"\x00\x00\x02\x00" + b"cmfa" + b"iso6"
        ftyp = self._build_box("ftyp", ftyp_payload)
        self.assertTrue(is_cmaf(ftyp), "cmfa brand should be detected as CMAF")

    def test_is_cmaf_negative(self):
        """Standard isom brand should NOT be detected as CMAF."""
        ftyp_payload = b"isom" + b"\x00\x00\x02\x00" + b"isom" + b"iso2"
        ftyp = self._build_box("ftyp", ftyp_payload)
        self.assertFalse(is_cmaf(ftyp), "Standard isom brand should NOT be CMAF")

    def test_is_cmaf_no_ftyp(self):
        """Data without an ftyp box should return False."""
        data = b"\x00\x00\x00\x08moov"  # no ftyp box
        self.assertFalse(is_cmaf(data))

    def test_is_cmaf_short_payload(self):
        """ftyp with payload shorter than 8 bytes should return False."""
        ftyp = self._build_box("ftyp", b"abc")  # short payload
        self.assertFalse(is_cmaf(ftyp))

    # ─── interleave_tracks tests ───────────────────────────────────────

    def test_interleave_tracks_alternating(self):
        """interleave_tracks should merge tracks by timestamp order."""
        track1 = [
            {"timestamp": 0, "data": b"v0"},
            {"timestamp": 2000, "data": b"v2"},
        ]
        track2 = [
            {"timestamp": 1000, "data": b"a1"},
            {"timestamp": 3000, "data": b"a3"},
        ]
        interleaved = interleave_tracks({1: track1, 2: track2})
        self.assertEqual(len(interleaved), 4)
        # Order by timestamp: v0(0), a1(1000), v2(2000), a3(3000)
        self.assertEqual(interleaved[0][1]["data"], b"v0")
        self.assertEqual(interleaved[1][1]["data"], b"a1")
        self.assertEqual(interleaved[2][1]["data"], b"v2")
        self.assertEqual(interleaved[3][1]["data"], b"a3")

    def test_interleave_tracks_single_track(self):
        """A single track should be returned unchanged."""
        track = [{"timestamp": 100, "data": b"s1"}, {"timestamp": 200, "data": b"s2"}]
        interleaved = interleave_tracks({1: track})
        self.assertEqual(len(interleaved), 2)
        self.assertEqual(interleaved[0][0], 1)  # track_id
        self.assertEqual(interleaved[0][1]["data"], b"s1")
        self.assertEqual(interleaved[1][1]["data"], b"s2")

    def test_interleave_tracks_empty(self):
        """Empty tracks dict should return empty list."""
        interleaved = interleave_tracks({})
        self.assertEqual(interleaved, [])

    def test_interleave_tracks_no_timestamps(self):
        """Samples without timestamps should be sorted to the beginning."""
        track = [{"data": b"no_ts"}, {"timestamp": 500, "data": b"with_ts"}]
        interleaved = interleave_tracks({1: track})
        self.assertEqual(len(interleaved), 2)
        # Sample without timestamp gets timestamp 0, so it comes first
        self.assertEqual(interleaved[0][1]["data"], b"no_ts")
        self.assertEqual(interleaved[1][1]["data"], b"with_ts")

    def test_interleave_tracks_same_timestamp(self):
        """Samples with the same timestamp should preserve input order."""
        track1 = [{"timestamp": 100, "data": b"v1"}]
        track2 = [{"timestamp": 100, "data": b"a1"}]
        interleaved = interleave_tracks({1: track1, 2: track2})
        self.assertEqual(len(interleaved), 2)
        # Both have timestamp 100, so order depends on track iteration
        # which is deterministic in Python 3.7+
        self.assertEqual(interleaved[0][0], 1)  # track 1 first
        self.assertEqual(interleaved[1][0], 2)  # track 2 second

    # ─── Demux stream ordering tests ────────────────────────────────────

    def _build_ftyp(self):
        return self._build_box("ftyp", b"isom\x00\x00\x02\x00isomiso2avc1mp41")

    def _build_mvhd(self):
        payload = b"\x00" + b"\x00\x00\x00" + b"\x00" * 8
        payload += struct.pack(">I", 1000)
        payload += struct.pack(">I", 10000)
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

    def _build_tfhd(self, track_id=1):
        flags = 0x000001
        payload = b"\x00" + struct.pack(">I", flags)[1:]
        payload += struct.pack(">I", track_id)
        payload += struct.pack(">Q", 0)
        return self._build_box("tfhd", payload)

    def _build_segment_with_seq(self, samples: list[bytes], seq=1, track_id=1):
        """Build a segment with a specific mfhd sequence number."""
        mfhd = self._build_box("mfhd", b"\x00\x00\x00\x00" + struct.pack(">I", seq))
        mdat_payload = b"".join(samples)
        trun_flags = 0x0001 | 0x1000
        trun_payload = struct.pack(">I", 0 << 24 | trun_flags)
        trun_payload += struct.pack(">I", len(samples))
        trun_payload += struct.pack(">i", 0)
        for s in samples:
            trun_payload += struct.pack(">I", len(s))
        trun = self._build_box("trun", trun_payload)
        tfhd = self._build_tfhd(track_id)
        traf = self._build_box("traf", tfhd + trun)
        moof = self._build_box("moof", mfhd + traf)
        mdat = self._build_box("mdat", mdat_payload)
        return moof + mdat

    def test_demux_streams_ordered_by_seq(self):
        """Demux should process segments in sequence number order, not input order."""
        ftyp = self._build_ftyp()
        moov = self._build_moov()
        init = ftyp + moov
        # Out of order: seq 3, seq 1, seq 2
        seg3 = self._build_segment_with_seq([b"\xcc" * 30], seq=3)
        seg1 = self._build_segment_with_seq([b"\xaa" * 30], seq=1)
        seg2 = self._build_segment_with_seq([b"\xbb" * 30], seq=2)
        tracks = demux_streams(init, [seg3, seg1, seg2])
        # Should be ordered: seg1, seg2, seg3
        self.assertEqual(len(tracks[1]), 3)
        self.assertEqual(tracks[1][0], b"\xaa" * 30, "First sample should be from seq 1")
        self.assertEqual(tracks[1][1], b"\xbb" * 30, "Second sample should be from seq 2")
        self.assertEqual(tracks[1][2], b"\xcc" * 30, "Third sample should be from seq 3")

    def test_demux_streams_multiple_tracks_interleaved(self):
        """Demux should handle multiple tracks with interleaved segments."""
        ftyp = self._build_box("ftyp", b"isom\x00\x00\x02\x00isomiso2avc1mp41")
        mvhd = self._build_mvhd()
        # Video track (1) + Audio track (2)
        trak1 = self._build_trak(1, "vide")
        trak2 = self._build_trak(2, "soun")
        moov = self._build_box("moov", mvhd + trak1 + trak2)
        init = ftyp + moov

        # Interleaved segments: v1, a1, v2, a2
        seg_v1 = self._build_segment_with_seq([b"v" * 50], seq=1, track_id=1)
        seg_a1 = self._build_segment_with_seq([b"a" * 30], seq=2, track_id=2)
        seg_v2 = self._build_segment_with_seq([b"v" * 60], seq=3, track_id=1)
        seg_a2 = self._build_segment_with_seq([b"a" * 40], seq=4, track_id=2)

        tracks = demux_streams(init, [seg_v1, seg_a1, seg_v2, seg_a2])
        self.assertIn(1, tracks, "Track 1 (video) should be present")
        self.assertIn(2, tracks, "Track 2 (audio) should be present")
        self.assertEqual(len(tracks[1]), 2, "Video track should have 2 samples")
        self.assertEqual(len(tracks[2]), 2, "Audio track should have 2 samples")
        # Video samples
        self.assertEqual(tracks[1][0], b"v" * 50)
        self.assertEqual(tracks[1][1], b"v" * 60)
        # Audio samples
        self.assertEqual(tracks[2][0], b"a" * 30)
        self.assertEqual(tracks[2][1], b"a" * 40)

    # ─── detect_track_gaps additional edge cases ───────────────────────

    def test_detect_track_gaps_unsorted_input(self):
        """detect_track_gaps should handle unsorted input."""
        segments = [
            {"seq_num": 5, "data": b"seg5"},
            {"seq_num": 1, "data": b"seg1"},
            {"seq_num": 3, "data": b"seg3"},
        ]
        gaps = detect_track_gaps(segments)
        self.assertEqual(len(gaps), 2)
        self.assertEqual(gaps[0]["missing"], 2)
        self.assertEqual(gaps[1]["missing"], 4)

    def test_detect_track_gaps_large_gap(self):
        """detect_track_gaps should detect a gap of many missing numbers."""
        segments = [
            {"seq_num": 1, "data": b"seg1"},
            {"seq_num": 10, "data": b"seg10"},
        ]
        gaps = detect_track_gaps(segments)
        self.assertEqual(len(gaps), 8)
        self.assertEqual(gaps[0]["missing"], 2)
        self.assertEqual(gaps[-1]["missing"], 9)

    def test_detect_track_gaps_duplicate_seq_nums(self):
        """detect_track_gaps should handle duplicate sequence numbers."""
        segments = [
            {"seq_num": 1, "data": b"seg1"},
            {"seq_num": 1, "data": b"seg1_dup"},
            {"seq_num": 3, "data": b"seg3"},
        ]
        gaps = detect_track_gaps(segments)
        # dupes should not create false gaps; only seq 2 is missing
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0]["missing"], 2)

    def test_detect_track_gaps_consecutive_missing(self):
        """detect_track_gaps should report consecutive missing sequences with correct before/after."""
        segments = [
            {"seq_num": 1, "data": b"seg1"},
            {"seq_num": 6, "data": b"seg6"},
        ]
        gaps = detect_track_gaps(segments)
        self.assertEqual(len(gaps), 4)
        self.assertEqual(gaps[0], {"missing": 2, "before": 1, "after": 6})
        self.assertEqual(gaps[3], {"missing": 5, "before": 1, "after": 6})

    # ─── is_cmaf additional edge cases ─────────────────────────────────

    def test_is_cmaf_compatible_brand_not_major(self):
        """CMAF detection should work when cmfv is a compatible brand, not major."""
        ftyp_payload = b"isom" + b"\x00\x00\x02\x00" + b"cmfv" + b"iso6"
        ftyp = self._build_box("ftyp", ftyp_payload)
        self.assertTrue(is_cmaf(ftyp))

    def test_is_cmaf_compatible_brand_cmfa(self):
        """CMAF detection should work with cmfa as compatible brand."""
        ftyp_payload = b"isom" + b"\x00\x00\x02\x00" + b"iso6" + b"cmfa"
        ftyp = self._build_box("ftyp", ftyp_payload)
        self.assertTrue(is_cmaf(ftyp))

    def test_is_cmaf_empty_data(self):
        """Empty data should not crash, returns False."""
        self.assertFalse(is_cmaf(b""))

    def test_is_cmaf_no_ftyp_box_first(self):
        """Data starting with non-ftyp box should not crash, returns False."""
        data = self._build_box("moov", b"\x00" * 20)
        self.assertFalse(is_cmaf(data))

    def test_is_cmaf_truncated_ftyp_64bit(self):
        """64-bit extended ftyp with truncated payload should return False."""
        header = struct.pack(">I", 1) + b"ftyp" + struct.pack(">Q", 100)
        # Only provide 4 bytes after the 16-byte header
        data = header + b"abcd"
        self.assertFalse(is_cmaf(data))

    def test_is_cmaf_multiple_boxes_second_is_ftyp(self):
        """CMAF should detect ftyp even when it's not the first box."""
        moov = self._build_box("moov", b"\x00" * 8)
        ftyp_payload = b"cmfv" + b"\x00\x00\x02\x00" + b"cmfv" + b"iso6"
        ftyp = self._build_box("ftyp", ftyp_payload)
        data = moov + ftyp
        self.assertTrue(is_cmaf(data))

    # ─── interleave_tracks additional edge cases ───────────────────────

    def test_interleave_tracks_empty_track_in_dict(self):
        """interleave_tracks should handle a track with an empty sample list."""
        track1 = [{"timestamp": 100, "data": b"v1"}]
        track2 = []  # Empty track
        interleaved = interleave_tracks({1: track1, 2: track2})
        self.assertEqual(len(interleaved), 1)
        self.assertEqual(interleaved[0][0], 1)

    def test_interleave_tracks_three_tracks(self):
        """interleave_tracks with 3 tracks."""
        t1 = [{"timestamp": 0, "data": b"v0"}]
        t2 = [{"timestamp": 100, "data": b"a1"}]
        t3 = [{"timestamp": 50, "data": b"s0"}]
        interleaved = interleave_tracks({1: t1, 2: t2, 3: t3})
        self.assertEqual(len(interleaved), 3)
        # Order: v0(0), s0(50), a1(100)
        self.assertEqual(interleaved[0][1]["data"], b"v0")
        self.assertEqual(interleaved[1][1]["data"], b"s0")
        self.assertEqual(interleaved[2][1]["data"], b"a1")

    def test_interleave_tracks_all_same_timestamp(self):
        """All samples with same timestamp should preserve track iteration order."""
        t1 = [{"timestamp": 100, "data": b"t1s1"}, {"timestamp": 100, "data": b"t1s2"}]
        t2 = [{"timestamp": 100, "data": b"t2s1"}]
        interleaved = interleave_tracks({1: t1, 2: t2})
        self.assertEqual(len(interleaved), 3)
        self.assertEqual(interleaved[0][1]["data"], b"t1s1")
        self.assertEqual(interleaved[1][1]["data"], b"t1s2")
        self.assertEqual(interleaved[2][1]["data"], b"t2s1")

    def test_interleave_tracks_negative_timestamps(self):
        """Negative timestamps should sort before positive ones."""
        t1 = [{"timestamp": 100, "data": b"pos"}]
        t2 = [{"timestamp": -50, "data": b"neg"}]
        interleaved = interleave_tracks({1: t1, 2: t2})
        self.assertEqual(len(interleaved), 2)
        self.assertEqual(interleaved[0][1]["data"], b"neg")
        self.assertEqual(interleaved[1][1]["data"], b"pos")

    def test_interleave_tracks_float_timestamps(self):
        """Float timestamps should sort correctly."""
        t1 = [{"timestamp": 1.5, "data": b"mid"}]
        t2 = [{"timestamp": 0.5, "data": b"early"}]
        interleaved = interleave_tracks({1: t1, 2: t2})
        self.assertEqual(len(interleaved), 2)
        self.assertEqual(interleaved[0][1]["data"], b"early")
        self.assertEqual(interleaved[1][1]["data"], b"mid")

    def test_interleave_tracks_zero_timestamps(self):
        """Timestamp=0 should sort correctly alongside positive timestamps."""
        t1 = [{"timestamp": 0, "data": b"zero"}]
        t2 = [{"timestamp": 50, "data": b"late"}]
        interleaved = interleave_tracks({1: t1, 2: t2})
        self.assertEqual(interleaved[0][1]["data"], b"zero")
        self.assertEqual(interleaved[1][1]["data"], b"late")

    # ─── Demux segment ordering edge cases ─────────────────────────────

    def test_demux_streams_gap_in_sequence(self):
        """Demux should handle gaps in segment sequence without data loss."""
        ftyp = self._build_box("ftyp", b"isom\x00\x00\x02\x00isomiso2avc1mp41")
        mvhd = self._build_mvhd()
        trak1 = self._build_trak(1, "vide")
        moov = self._build_box("moov", mvhd + trak1)
        init = ftyp + moov
        # Segments with gap: seq 1, seq 3 (seq 2 missing)
        seg1 = self._build_segment_with_seq([b"\xaa" * 30], seq=1)
        seg3 = self._build_segment_with_seq([b"\xcc" * 30], seq=3)
        tracks = demux_streams(init, [seg1, seg3])
        self.assertEqual(len(tracks[1]), 2)
        self.assertEqual(tracks[1][0], b"\xaa" * 30)
        self.assertEqual(tracks[1][1], b"\xcc" * 30)

    def test_demux_streams_same_seq_number(self):
        """Segments with same sequence number should both be processed."""
        ftyp = self._build_box("ftyp", b"isom\x00\x00\x02\x00isomiso2avc1mp41")
        mvhd = self._build_mvhd()
        trak1 = self._build_trak(1, "vide")
        moov = self._build_box("moov", mvhd + trak1)
        init = ftyp + moov
        seg1a = self._build_segment_with_seq([b"\xaa" * 30], seq=1)
        seg1b = self._build_segment_with_seq([b"\xbb" * 30], seq=1)
        tracks = demux_streams(init, [seg1a, seg1b])
        self.assertEqual(len(tracks[1]), 2)


if __name__ == "__main__":
    unittest.main()
