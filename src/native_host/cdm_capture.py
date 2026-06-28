"""CDM (Content Decryption Module) API for Widevine key extraction and segment decryption.

Extracted from capture_manager.py for modularity. These functions wrap the Go
binary's CDM commands (cdmInit, extractKeys, decryptSegments, assembleSegments)
through the CaptureManager singleton.

Uses lazy imports internally to avoid circular imports with capture_manager.py.
"""

import subprocess

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
    import os as _os
    from pathlib import Path as _Path

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
            key_id_b64 = first_key.get("keyIdB64", "")
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


def assemble_segments(job_id, file_paths, output_path, timeout=60.0):
    """Assemble decrypted segment files into a single output file.

    Sends an 'assembleSegments' command to the Go binary.

    Args:
        job_id: Identifier for this assembly job.
        file_paths: List of file paths to decrypted segments.
        output_path: Path for the assembled output file.
        timeout: Maximum seconds to wait for assembly.

    Returns:
        Dict with keys: ok, jobId, filePath, error.
    """
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
        return {
            "ok": response.get("ok", False),
            "jobId": response.get("jobId", job_id),
            "filePath": response.get("filePath", ""),
            "error": response.get("error", ""),
        }
    except HostError as exc:
        return {"ok": False, "jobId": job_id, "error": str(exc)}
