"""Fallback download engines for sites yt-dlp cannot handle.

Provides gallery-dl support for image/gallery sites, you-get and lux for
Asian media platforms, and a direct HTTP downloader for explicit media URLs.
"""

from fallback_engines.direct_download import (
    _SUPPORTED_DIRECT_EXTS,
    download_direct,
    is_direct_media_url,
)
from fallback_engines.gallery_dl_engine import (
    download_with_gallery_dl,
    has_gallery_dl,
    list_formats_gallery_dl,
    resolve_gallery_dl_command,
)
from fallback_engines.helpers import (
    _find_latest_file,
    _human_size,
)
from fallback_engines.lux_engine import (
    download_with_lux,
    has_lux,
    list_formats_lux,
    resolve_lux_command,
)
from fallback_engines.you_get_engine import (
    download_with_you_get,
    has_you_get,
    list_formats_you_get,
    resolve_you_get_command,
)

# Backward compatibility: HostError was re-exported from this module
from native_protocol import HostError
