"""Verify curl_cffi is importable and print its version.

Called from install.bat — avoids CMD parser choking on inline -c code
that contains periods and special characters.
"""
import sys

try:
    from curl_cffi import requests as _curl_requests

    ver = getattr(_curl_requests, "__version__", "unknown")
    print(f"curl_cffi version: {ver}")
    sys.exit(0)
except ImportError:
    print("curl_cffi is not available")
    sys.exit(1)
