"""Fallback download engines for sites yt-dlp cannot handle.

Provides gallery-dl support for image/gallery sites, you-get and lux for
Asian media platforms, and a direct HTTP downloader for explicit media URLs.
"""

# Backward compatibility: HostError was re-exported from this module
from native_protocol import HostError as HostError
