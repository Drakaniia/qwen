"""Aria2c command builders for BitTorrent downloads (magnet links and .torrent files)."""

MAGNET_ARIA2_ARGS = {
    "seed_time": 0,
    "file_allocation": "none",
    "continue": True,
    "bt_max_peers": 100,
    "bt_piece_length": "2M",
    "summary_interval": 1,
    "enable_color": False,
    "human_readable": True,
    "console_log_level": "warn",
}


def _build_aria2c_bittorrent_command(
    aria2c_location,
    download_dir,
    bt_max_peers=None,
    seed_time=None,
):
    """Build the shared aria2c argument list used for BitTorrent downloads.

    Both magnet links and .torrent files share the same seeding, file
    allocation, and console output options; the caller appends the source
    (a magnet URL or a --torrent-file path).
    """
    return [
        str(aria2c_location),
        "--seed-time",
        str(seed_time if seed_time is not None else MAGNET_ARIA2_ARGS["seed_time"]),
        "--dir",
        str(download_dir),
        "--file-allocation",
        MAGNET_ARIA2_ARGS["file_allocation"],
        "--continue",
        "true",
        "--bt-max-peers",
        str(bt_max_peers if bt_max_peers is not None else MAGNET_ARIA2_ARGS["bt_max_peers"]),
        "--summary-interval",
        str(MAGNET_ARIA2_ARGS["summary_interval"]),
        "--console-log-level",
        MAGNET_ARIA2_ARGS["console_log_level"],
        "--enable-color",
        "false",
        "--human-readable",
        "true",
    ]


def build_aria2c_magnet_command(
    url,
    download_dir,
    aria2c_location,
    bt_max_peers=None,
    seed_time=None,
):
    """Build an aria2c command for downloading from a magnet link."""
    command = _build_aria2c_bittorrent_command(
        aria2c_location=aria2c_location,
        download_dir=download_dir,
        bt_max_peers=bt_max_peers,
        seed_time=seed_time,
    )
    command.append(str(url))
    return command


def build_aria2c_torrent_command(
    torrent_path,
    download_dir,
    aria2c_location,
    bt_max_peers=None,
    seed_time=None,
):
    """Build an aria2c command for downloading from a local .torrent file."""
    command = _build_aria2c_bittorrent_command(
        aria2c_location=aria2c_location,
        download_dir=download_dir,
        bt_max_peers=bt_max_peers,
        seed_time=seed_time,
    )
    command.extend(["--torrent-file", str(torrent_path)])
    return command
