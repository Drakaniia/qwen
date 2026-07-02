"""CDM (Content Decryption Module) API for Widevine key extraction and segment decryption.

Extracted from capture_manager.py for modularity. These functions wrap the Go
binary's CDM commands (cdmInit, extractKeys, decryptSegments, assembleSegments)
through the CaptureManager singleton.

Also provides fMP4 segment analysis (CMAF detection, track gap detection) for
real-time gap reporting during the capture pipeline.

Uses lazy imports internally to avoid circular imports with capture_manager.py.
"""

import struct
import subprocess
from pathlib import Path as _Path

from native_protocol import HostError
from stream_backends import build_mp4decrypt_command


def cdm_init(cdm_path, timeout=15.0):
    """Initialize the Widevine CDM at the given path.

    Sends a 'cdmInit' command to the Go binary.

    Args:
        cdm_path: Path to the directory containing widevinecdm.dll.
        timeout: Maximum seconds to wait for a response.

    Returns:
        Dict with keys: ok, cdmVersion, l1Only, error (if any).
    """
    # Lazy import to avoid circular dependency
    from capture_manager import get_capture_manager

    manager = get_capture_manager()
    if not manager.is_running:
        manager.start()

    try:
        response = manager.send_command(
            "cdmInit",
            data={"cdmPath": cdm_path},
            timeout=timeout,
        )
        return {
            "ok": response.get("ok", False),
            "cdmVersion": response.get("cdmVersion", ""),
            "l1Only": response.get("l1Only", False),
            "cdmPath": response.get("cdmPath", ""),
            "error": response.get("error", ""),
        }
    except HostError as exc:
        return {"ok": False, "error": str(exc)}


def extract_keys(session_id, response_b64, challenge_b64="", init_data_b64="", timeout=30.0):
    """Extract decryption keys from a Widevine license response.

    Sends an 'extractKeys' command to the Go binary with the captured
    license exchange data from CDP network interception.

    Args:
        session_id: Opaque session identifier from the license exchange.
        response_b64: Base64-encoded license response body.
        challenge_b64: Optional base64-encoded license challenge (POST body).
        init_data_b64: Optional base64-encoded PSSH init data.
        timeout: Maximum seconds to wait for key extraction.

    Returns:
        Dict with keys: ok, sessionId, keys (list of DecryptionKey), l1Only, error.
    """
    # Lazy import to avoid circular dependency
    from capture_manager import get_capture_manager

    manager = get_capture_manager()
    if not manager.is_running:
        manager.start()

    data = {
        "sessionId": session_id,
        "responseB64": response_b64,
    }
    if challenge_b64:
        data["challengeB64"] = challenge_b64
    if init_data_b64:
        data["initDataB64"] = init_data_b64

    try:
        response = manager.send_command("extractKeys", data=data, timeout=timeout)
        return {
            "ok": response.get("ok", False),
            "sessionId": response.get("sessionId", session_id),
            "keys": response.get("keys", []),
            "l1Only": response.get("l1Only", False),
            "error": response.get("error", ""),
        }
    except HostError as exc:
        return {"ok": False, "sessionId": session_id, "keys": [], "error": str(exc)}


def decrypt_segments(job_id, segments, keys, output_dir="", timeout=60.0):
    """Decrypt encrypted media segments using provided keys.

    Sends a 'decryptSegments' command to the Go binary.

    Args:
        job_id: Identifier for this decryption job.
        segments: List of dicts with streamId, index, dataB64, mimeType, isLast.
        keys: List of dicts with keyIdB64, keyB64, type.
        output_dir: Optional directory for decrypted outputs.
        timeout: Maximum seconds to wait for decryption.

    Returns:
        Dict with keys: ok, jobId, decrypted (count), segmentPaths, error.
    """
    # Lazy import to avoid circular dependency
    from capture_manager import get_capture_manager

    manager = get_capture_manager()
    if not manager.is_running:
        manager.start()

    data = {
        "jobId": job_id,
        "segments": segments,
        "keys": keys,
    }
    if output_dir:
        data["outputDir"] = output_dir

    try:
        response = manager.send_command("decryptSegments", data=data, timeout=timeout)
        return {
            "ok": response.get("ok", False),
            "jobId": response.get("jobId", job_id),
            "decrypted": response.get("decrypted", 0),
            "segmentPaths": response.get("segmentPaths", []),
            "error": response.get("error", ""),
        }
    except HostError as exc:
        return {"ok": False, "jobId": job_id, "decrypted": 0, "error": str(exc)}


def decrypt_with_mp4decrypt(job_id, encrypted_segments, keys, output_dir="", mp4decrypt_location=None):
    """Decrypt encrypted media segments using mp4decrypt (Bento4).

    Uses ``build_mp4decrypt_command`` from stream_backends to construct
    mp4decrypt invocations for each encrypted segment. This serves as a
    post-processing step or alternative to the Go binary's built-in
    AES-128 CTR/CBC decryption, providing support for additional cipher
    modes and validation via Bento4's implementation.

    Args:
        job_id: Identifier for this decryption job.
        encrypted_segments: List of dicts with keys:
            - inputPath: Path to the encrypted segment file.
            - outputPath: Path for the decrypted output (optional, auto-generated if omitted).
            - key: Key string (e.g. "1:XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX") or list of keys.
        keys: List of dicts with keyIdB64, keyB64, type (fallback if segment has no key).
        output_dir: Optional output directory (defaults to parent of each input).
        mp4decrypt_location: Path to mp4decrypt binary.

    Returns:
        Dict with keys: ok, jobId, decrypted (count), segmentPaths, error.
    """

    decrypted_count = 0
    decrypted_paths = []
    errors = []

    for i, segment in enumerate(encrypted_segments):
        input_path = segment.get("inputPath", "")
        if not input_path:
            errors.append(f"Segment {i}: missing inputPath")
            continue

        if not _Path(input_path).is_file():
            errors.append(f"Segment {i}: input file not found: {input_path}")
            continue

        # Determine output path
        output_path = segment.get("outputPath", "")
        if not output_path:
            stem = _Path(input_path).stem
            if output_dir:
                output_path = str(_Path(output_dir) / f"{stem}_decrypted.mp4")
            else:
                output_path = str(_Path(input_path).parent / f"{stem}_decrypted.mp4")

        # Determine key(s) for this segment
        segment_key = segment.get("key")
        if segment_key is None and keys:
            # Use first available key
            first_key = keys[0]
            key_b64 = first_key.get("keyB64", "")
            segment_key = f"1:{key_b64}"

        if segment_key is None:
            errors.append(f"Segment {i}: no key available for decryption")
            continue

        try:
            command = build_mp4decrypt_command(
                input_path=input_path,
                output_path=output_path,
                key=segment_key,
                mp4decrypt_location=mp4decrypt_location,
            )

            completed = subprocess.run(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
            )

            if completed.returncode == 0 and _Path(output_path).is_file():
                decrypted_count += 1
                decrypted_paths.append(output_path)
            else:
                error_msg = (completed.stderr or "").strip() or f"mp4decrypt exited with code {completed.returncode}"
                errors.append(f"Segment {i} ({input_path}): {error_msg}")
        except subprocess.TimeoutExpired:
            errors.append(f"Segment {i} ({input_path}): mp4decrypt timed out after 120s")
        except Exception as exc:
            errors.append(f"Segment {i} ({input_path}): {exc}")

    result = {
        "ok": decrypted_count > 0,
        "jobId": job_id,
        "decrypted": decrypted_count,
        "segmentPaths": decrypted_paths,
    }
    if errors:
        result["error"] = " | ".join(errors[:5])
        if len(errors) > 5:
            result["error"] += f" (...and {len(errors) - 5} more)"

    return result


def _extract_sequence_numbers(file_paths: list[str]) -> list[dict]:
    """Extract sequence numbers from moof boxes in segment files.

    Reads each file, finds the moof box, and extracts the mfhd
    sequence number for gap detection.

    Args:
        file_paths: List of paths to media segment files.

    Returns:
        List of dicts with 'seq_num' and 'path' keys, sorted by seq_num.
    """
    seq_infos = []
    for file_path in file_paths:
        try:
            with open(file_path, "rb") as f:
                data = f.read(65536)  # Read first 64KB — moof is always early
        except OSError:
            continue

        offset = 0
        seq_num = None
        while offset + 8 <= len(data):
            box_size = struct.unpack_from(">I", data, offset)[0]
            box_type = data[offset + 4 : offset + 8].decode("latin-1")

            if box_type == "moof":
                inner_offset = offset + 8
                moof_end = offset + box_size if box_size > 1 else len(data)
                if box_size == 1:
                    large_size = struct.unpack_from(">Q", data, offset + 8)[0]
                    moof_end = offset + large_size
                    inner_offset = offset + 16

                while inner_offset + 12 <= min(moof_end, len(data)):
                    inner_size = struct.unpack_from(">I", data, inner_offset)[0]
                    inner_type = data[inner_offset + 4 : inner_offset + 8].decode("latin-1")
                    if inner_type == "mfhd":
                        seq_num = struct.unpack_from(">I", data, inner_offset + 12)[0]
                        break
                    if inner_size == 0:
                        break
                    inner_offset += inner_size
                break

            if box_size == 0:
                break
            offset += box_size

        if seq_num is not None:
            seq_infos.append({"seq_num": seq_num, "path": file_path})

    seq_infos.sort(key=lambda x: x["seq_num"])
    return seq_infos


def _check_cmaf_from_files(init_seg_paths: list[str]) -> dict:
    """Check if init segments have CMAF brands.

    Scans init segment files for ftyp boxes containing 'cmfv' or 'cmfa'
    compatible brands.

    Args:
        init_seg_paths: List of paths to init segment files.

    Returns:
        Dict with 'is_cmaf' (bool) and 'detected_in' (list of file paths).
    """
    from fmp4_demuxer import is_cmaf as _is_cmaf

    cmaf_detected_in = []
    for file_path in init_seg_paths:
        try:
            with open(file_path, "rb") as f:
                data = f.read(65536)  # Init segments are small
            if _is_cmaf(data):
                cmaf_detected_in.append(file_path)
        except OSError:
            continue

    return {"is_cmaf": len(cmaf_detected_in) > 0, "detected_in": cmaf_detected_in}


def analyze_fmp4_segments(
    init_seg_paths: list[str],
    media_seg_paths: list[str],
) -> dict:
    """Analyze fMP4 segments for CMAF detection and track gaps.

    Reads init segment and media segment files from disk and runs:
    - ``is_cmaf()`` on init segments to detect CMAF-compatible brands
    - ``_extract_sequence_numbers()`` on media segments to identify
      sequence numbers
    - ``detect_track_gaps()`` on extracted sequence numbers to find
      missing segments

    Args:
        init_seg_paths: List of paths to init segment files (ftyp + moov).
        media_seg_paths: List of paths to media segment files (moof + mdat).

    Returns:
        Dict with keys:
        - cmaf: CMAF detection result (is_cmaf bool, detected_in list)
        - sequence_count: Total number of segments with sequence numbers
        - gaps: List of gap dicts from detect_track_gaps(), each with
                'missing', 'before', 'after' keys
        - gap_count: Number of gaps detected
        - has_gaps: True if any gaps were found
        - analyzed_segments: Number of media segments successfully analyzed
        - error: Error message if analysis failed entirely
    """
    from fmp4_demuxer import detect_track_gaps as _detect_track_gaps

    result: dict = {
        "cmaf": {"is_cmaf": False, "detected_in": []},
        "sequence_count": 0,
        "gaps": [],
        "gap_count": 0,
        "has_gaps": False,
        "analyzed_segments": 0,
        "error": "",
    }

    # Run CMAF detection on init segments
    result["cmaf"] = _check_cmaf_from_files(init_seg_paths)

    # Extract sequence numbers from media segments
    seq_infos = _extract_sequence_numbers(media_seg_paths)
    result["analyzed_segments"] = len(seq_infos)
    result["sequence_count"] = len(seq_infos)

    # Run gap detection on all segments
    # Group by track and detect gaps per-track
    tracks: dict[int, list[dict]] = {}
    for seq_info in seq_infos:
        # For simplicity, assume single track per assembly
        # (track id is always 1 unless multi-track segments were captured)
        track_id = 1
        if track_id not in tracks:
            tracks[track_id] = []
        tracks[track_id].append(seq_info)

    all_gaps: list[dict] = []
    for track_id, track_segments in tracks.items():
        gaps = _detect_track_gaps(track_segments)
        for gap in gaps:
            gap["track_id"] = track_id
        all_gaps.extend(gaps)

    result["gaps"] = all_gaps
    result["gap_count"] = len(all_gaps)
    result["has_gaps"] = len(all_gaps) > 0

    return result


def assemble_segments(job_id, file_paths, output_path, timeout=60.0, init_seg_paths=None):
    """Assemble decrypted segment files into a single output file.

    Before sending to the Go binary, runs fMP4 analysis on the segment
    files (CMAF detection, track gap detection) and includes the report
    in the response.

    Args:
        job_id: Identifier for this assembly job.
        file_paths: List of file paths to decrypted segments.
        output_path: Path for the assembled output file.
        timeout: Maximum seconds to wait for assembly.
        init_seg_paths: Optional list of init segment paths for CMAF/gap analysis.

    Returns:
        Dict with keys: ok, jobId, filePath, error, fmp4_analysis.
    """
    # Run fMP4 analysis before assembly (non-blocking metadata)
    analysis_result = None
    if init_seg_paths is not None or file_paths:
        try:
            analysis_result = analyze_fmp4_segments(
                init_seg_paths=init_seg_paths or [],
                media_seg_paths=file_paths,
            )
        except Exception as exc:
            analysis_result = {
                "cmaf": {"is_cmaf": False, "detected_in": []},
                "sequence_count": 0,
                "gaps": [],
                "gap_count": 0,
                "has_gaps": False,
                "analyzed_segments": 0,
                "error": f"Analysis failed: {exc}",
            }

    # Lazy import to avoid circular dependency
    from capture_manager import get_capture_manager

    manager = get_capture_manager()
    if not manager.is_running:
        manager.start()

    data = {
        "jobId": job_id,
        "filePaths": file_paths,
        "outputPath": output_path,
    }

    try:
        response = manager.send_command("assembleSegments", data=data, timeout=timeout)
        result = {
            "ok": response.get("ok", False),
            "jobId": response.get("jobId", job_id),
            "filePath": response.get("filePath", ""),
            "error": response.get("error", ""),
        }
    except HostError as exc:
        result = {"ok": False, "jobId": job_id, "error": str(exc)}

    # Attach analysis to the result
    if analysis_result is not None:
        result["fmp4_analysis"] = analysis_result

    return result


def analyze_segments_files(init_seg_paths: list[str] | None = None, media_seg_paths: list[str] | None = None) -> dict:
    """Standalone entry point for segment analysis.

    Wraps ``analyze_fmp4_segments()`` with default empty lists for
    convenient calling from message handlers.

    Args:
        init_seg_paths: Optional list of init segment file paths.
        media_seg_paths: Optional list of media segment file paths.

    Returns:
        Analysis result dict from ``analyze_fmp4_segments()``.
    """
    return analyze_fmp4_segments(
        init_seg_paths=init_seg_paths or [],
        media_seg_paths=media_seg_paths or [],
    )
