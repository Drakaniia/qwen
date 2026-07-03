"""Fallback download engines for sites yt-dlp cannot handle.

Provides gallery-dl support for image/gallery sites, you-get and lux for
Asian media platforms, and a direct HTTP downloader for explicit media URLs.
"""

# Backward compatibility: HostError was re-exported from this module
from native_protocol import HostError as HostError

# Direct download engine
from .direct_download import download_direct as download_direct
from .direct_download import is_direct_media_url as is_direct_media_url

# gallery-dl engine
from .gallery_dl_engine import has_gallery_dl as has_gallery_dl
from .gallery_dl_engine import list_formats_gallery_dl as list_formats_gallery_dl
from .gallery_dl_engine import download_with_gallery_dl as download_with_gallery_dl
from .gallery_dl_engine import resolve_gallery_dl_command as resolve_gallery_dl_command

# lux engine
from .lux_engine import has_lux as has_lux
from .lux_engine import list_formats_lux as list_formats_lux
from .lux_engine import download_with_lux as download_with_lux
from .lux_engine import resolve_lux_command as resolve_lux_command

# you-get engine
from .you_get_engine import has_you_get as has_you_get
from .you_get_engine import list_formats_you_get as list_formats_you_get
from .you_get_engine import download_with_you_get as download_with_you_get
from .you_get_engine import resolve_you_get_command as resolve_you_get_command
