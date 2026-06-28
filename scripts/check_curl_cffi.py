"""Verify curl_cffi is importable and print its version.

Called from install.sh — avoids shell parser choking on inline -c code
that contains periods and special characters.
"""
import sys
import importlib.metadata

try:
    from curl_cffi import requests as _curl_requests

    # Try several approaches to get the version
    try:
        ver = importlib.metadata.version("curl-cffi")
    except importlib.metadata.PackageNotFoundError:
        try:
            ver = importlib.metadata.version("curl_cffi")
        except importlib.metadata.PackageNotFoundError:
            ver = getattr(_curl_requests, "__version__", "unknown")

    print(f"curl_cffi version: {ver}")
    sys.exit(0)
except ImportError as e:
    print(f"curl_cffi is not available: {e}")
    sys.exit(1)
