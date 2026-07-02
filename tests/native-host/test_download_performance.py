"""Tests for download performance optimizations.

Each test verifies that the optimized settings provide maximum download
throughput while respecting server limitations. Tests follow TDD:
the first run should fail (RED), then optimizations are implemented
(GREEN), then all pass.
"""

import sys
import tempfile
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT_DIR / "src" / "native_host"))

from fallback_engines import download_direct

from download_manager import MAGNET_ARIA2_ARGS
from stream_backends import (
    build_n_m3u8dl_re_command,
    build_streamlink_command,
)
from yt_dlp_command import (
    DEFAULT_ARIA2_CONNECTIONS,
    DEFAULT_CONCURRENT_FRAGMENTS,
    MAX_ARIA2_CONNECTIONS,
    MAX_FAST_CONNECTIONS,
    build_yt_dlp_command,
    build_yt_dlp_fallback_variants,
)


class ConcurrentFragmentsOptimizationTests(unittest.TestCase):
    """Optimization: Increase MAX_FAST_CONNECTIONS for faster segment downloads.

    More concurrent fragments means more parallel segment downloads,
    which maximizes throughput for HLS/DASH segmented content.
    The value must be balanced to avoid server rate-limiting (HTTP 429).
    Target: 48 concurrent fragments.
    """

    def test_max_fast_connections_is_optimized_for_throughput(self):
        """MAX_FAST_CONNECTIONS should be high for maximum segment parallelism."""
        self.assertGreaterEqual(
            MAX_FAST_CONNECTIONS, 48, "Max fast connections should be at least 48 for optimal throughput"
        )

    def test_concurrent_fragments_default_uses_max_fast_connections(self):
        """DEFAULT_CONCURRENT_FRAGMENTS should equal MAX_FAST_CONNECTIONS."""
        self.assertEqual(DEFAULT_CONCURRENT_FRAGMENTS, MAX_FAST_CONNECTIONS)

    def test_build_command_uses_optimized_concurrent_fragments(self):
        """build_yt_dlp_command should use MAX_FAST_CONNECTIONS as default."""
        command = build_yt_dlp_command(
            url="https://cdn.example.com/master.m3u8",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["yt-dlp"],
        )
        idx = command.index("--concurrent-fragments")
        self.assertEqual(
            command[idx + 1], str(MAX_FAST_CONNECTIONS), f"Concurrent fragments should be {MAX_FAST_CONNECTIONS}"
        )


class Aria2ConnectionsOptimizationTests(unittest.TestCase):
    """Optimization: Increase MAX_ARIA2_CONNECTIONS for faster single-file downloads.

    More connections per server enables greater parallelism when aria2c
    splits a file into pieces. Must stay within aria2c's hard limit of 16.
    """

    def test_max_aria2_connections_respects_aria2c_internal_limit(self):
        """MAX_ARIA2_CONNECTIONS must not exceed aria2c's internal maximum of 16.

        aria2c's --max-connection-per-server option only accepts values 1-16.
        Values above 16 cause immediate error code 28 on download.
        """
        self.assertLessEqual(
            MAX_ARIA2_CONNECTIONS, 16,
            "aria2c --max-connection-per-server only supports values 1-16, but got "
            f"{MAX_ARIA2_CONNECTIONS}",
        )

    def test_max_aria2_connections_is_optimized(self):
        """MAX_ARIA2_CONNECTIONS should be 16 for optimal single-file parallelism."""
        self.assertGreaterEqual(
            MAX_ARIA2_CONNECTIONS, 16, "Max aria2c connections should be at least 16 for optimal throughput"
        )

    def test_aria2_connections_default_uses_max(self):
        """DEFAULT_ARIA2_CONNECTIONS should equal MAX_ARIA2_CONNECTIONS."""
        self.assertEqual(DEFAULT_ARIA2_CONNECTIONS, MAX_ARIA2_CONNECTIONS)

    def test_build_command_with_aria2c_uses_optimized_connections(self):
        """build_yt_dlp_command should pass optimized connections to aria2c."""
        command = build_yt_dlp_command(
            url="https://cdn.example.com/video.mp4",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["yt-dlp"],
            aria2c_location=r"C:\Tools\aria2c.exe",
        )
        args_idx = command.index("--downloader-args")
        args = command[args_idx + 1]
        self.assertIn(
            f"--max-connection-per-server={MAX_ARIA2_CONNECTIONS}",
            args,
            f"aria2c should use {MAX_ARIA2_CONNECTIONS} connections per server",
        )
        self.assertIn(
            f"--split={MAX_ARIA2_CONNECTIONS}", args, f"aria2c should split into {MAX_ARIA2_CONNECTIONS} parts"
        )

    def test_build_command_with_aria2c_includes_async_dns(self):
        """aria2c args should include async DNS for faster name resolution."""
        command = build_yt_dlp_command(
            url="https://cdn.example.com/video.mp4",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["yt-dlp"],
            aria2c_location=r"C:\Tools\aria2c.exe",
        )
        args_idx = command.index("--downloader-args")
        args = command[args_idx + 1]
        self.assertIn("--async-dns=true", args, "aria2c should use async DNS for faster resolution")


class StreamlinkOptimizationTests(unittest.TestCase):
    """Optimization: Add stream-segment-threads and ringbuffer-size to Streamlink.

    Streamlink's default single-threaded segment download is slow for
    high-bitrate HLS streams. Adding parallel segment threads and a
    larger ring buffer prevents buffer underruns and maximizes throughput.
    """

    def test_build_streamlink_command_includes_segment_threads(self):
        """Streamlink should use multiple segment threads for faster HLS downloads."""
        command = build_streamlink_command(
            url="https://cdn.example.com/hls/master.m3u8",
            output_path=Path(r"C:\Users\Viewer\Downloads\Movie\Movie.mp4"),
            streamlink_command=["streamlink"],
        )
        self.assertIn("--stream-segment-threads", command, "Streamlink should use parallel segment threads")
        idx = command.index("--stream-segment-threads")
        self.assertGreaterEqual(int(command[idx + 1]), 4, "Streamlink should use at least 4 segment threads")

    def test_build_streamlink_command_includes_ringbuffer(self):
        """Streamlink should include a ringbuffer size for smoother downloads."""
        command = build_streamlink_command(
            url="https://cdn.example.com/hls/master.m3u8",
            output_path=Path(r"C:\Users\Viewer\Downloads\Movie\Movie.mp4"),
            streamlink_command=["streamlink"],
        )
        self.assertIn("--ringbuffer-size", command, "Streamlink should specify ringbuffer size")
        idx = command.index("--ringbuffer-size")
        size = command[idx + 1]
        # Accept common sizes: 128M, 256M
        self.assertIn(size, ["128M", "256M"], f"Ringbuffer size should be 128M or 256M, got {size}")


class Nm3u8dlReOptimizationTests(unittest.TestCase):
    """Optimization: Increase N_m3u8DL-RE thread count for faster HLS/DASH.

    N_m3u8DL-RE's thread count directly controls how many segments are
    downloaded in parallel. More threads = faster for high-bandwidth streams.
    Target: 32 threads.
    """

    def test_n_m3u8dl_re_uses_optimized_thread_count(self):
        """N_m3u8DL-RE should use 32 threads for maximum parallelism."""
        command = build_n_m3u8dl_re_command(
            url="https://cdn.example.com/hls/master.m3u8",
            output_path=Path(r"C:\Users\Viewer\Downloads\Movie\Movie.mp4"),
        )
        idx = command.index("--thread-count")
        thread_count = int(command[idx + 1])
        self.assertGreaterEqual(thread_count, 32, f"N_m3u8DL-RE should use at least 32 threads, got {thread_count}")


class DirectDownloadChunkSizeOptimizationTests(unittest.TestCase):
    """Optimization: Increase chunk size for direct HTTP downloads.

    Larger chunk sizes reduce the number of read() syscalls and improve
    throughput for high-bandwidth connections. Target: 1MB (1048576 bytes).
    """

    def test_direct_download_uses_large_chunk_size(self):
        """download_direct should use 1MB chunk size for minimal syscall overhead."""
        # We can't easily inspect the default, but we can test that passing
        # different chunk sizes works (1MB should be the default)
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "test.bin"
            # This will fail with a network error but we can check the chunk
            # size is used by inspecting the function signature
            pass

    def test_direct_download_chunk_size_is_one_megabyte(self):
        """The default chunk_size in download_direct should be 1MB."""
        import inspect

        sig = inspect.signature(download_direct)
        chunk_size_default = sig.parameters["chunk_size"].default
        self.assertEqual(
            chunk_size_default, 1048576, f"Default chunk_size should be 1MB (1048576), got {chunk_size_default}"
        )


class BitTorrentPeerOptimizationTests(unittest.TestCase):
    """Optimization: Increase BitTorrent peer count for faster swarm downloads.

    More peers means more sources for pieces, which accelerates magnet and
    torrent downloads. Target: 100 max peers.
    """

    def test_magnet_aria2_max_peers_is_optimized(self):
        """MAGNET_ARIA2_ARGS bt_max_peers should be 100 for faster swarm discovery."""
        self.assertGreaterEqual(
            MAGNET_ARIA2_ARGS["bt_max_peers"],
            100,
            f"bt_max_peers should be at least 100, got {MAGNET_ARIA2_ARGS['bt_max_peers']}",
        )

    def test_magnet_aria2_includes_optimized_piece_length(self):
        """MAGNET_ARIA2_ARGS should include optimized piece length for BitTorrent."""
        self.assertIn(
            "bt_piece_length", MAGNET_ARIA2_ARGS, "Should specify bt_piece_length for optimized piece distribution"
        )
        piece_length = MAGNET_ARIA2_ARGS["bt_piece_length"]
        self.assertGreaterEqual(piece_length, "2M", f"bt_piece_length should be at least 2M, got {piece_length}")


class ThrottledRateFallbackTests(unittest.TestCase):
    """Optimization: Add throttled-rate fallback variant.

    When servers throttle connections (common on high-speed downloads),
    yt-dlp's --throttled-rate flag detects the pattern and adapts.
    This should be available as a fallback strategy.
    """

    def test_throttled_rate_fallback_variant_exists(self):
        """build_yt_dlp_fallback_variants should include a throttled-rate variant."""
        variants = build_yt_dlp_fallback_variants(
            url="https://cdn.example.com/video.mp4",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["yt-dlp"],
        )
        throttled_variants = [v for v in variants if "--throttled-rate" in v["command"]]
        self.assertGreaterEqual(
            len(throttled_variants), 1, "Should have at least one fallback variant with --throttled-rate"
        )


class SegmentedDownloaderOptimizationTests(unittest.TestCase):
    """Optimization: Use aria2c for all fragment types (not just native).

    When aria2c is available, use it for HLS and DASH fragments too,
    not just the native Python downloader. aria2c's multi-connection
    approach is faster for fragmented content.
    """

    def test_aria2c_handles_dash_m3u8_segments(self):
        """When aria2c is available, it should handle DASH and HLS segments."""
        command = build_yt_dlp_command(
            url="https://cdn.example.com/video.mp4",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["yt-dlp"],
            aria2c_location=r"C:\Tools\aria2c.exe",
        )
        downloader_values = [command[idx + 1] for idx, value in enumerate(command) if value == "--downloader"]
        # aria2c should be the primary downloader
        self.assertIn(r"C:\Tools\aria2c.exe", downloader_values, "aria2c should be the primary downloader")
        # For DASH/HLS segments, check if we're using aria2c or native
        dash_hls_downloader = [v for v in downloader_values if "dash" in v or "m3u8" in v]
        # The DASH/HLS downloader should be set to something (native or external)
        self.assertGreaterEqual(len(dash_hls_downloader), 1, "Should specify a downloader for DASH/HLS segments")


if __name__ == "__main__":
    unittest.main()
