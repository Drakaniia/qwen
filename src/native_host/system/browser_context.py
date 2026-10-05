import re
import tempfile
from pathlib import Path
from urllib.parse import urlparse

from native_protocol import HostError

HEADER_NAME_RE = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")
NATIVE_HEADER_NAMES = {
    "accept",
    "accept-language",
    "authorization",
    "cookie",
    "origin",
    "priority",
    "referer",
    "sec-ch-ua",
    "sec-ch-ua-arch",
    "sec-ch-ua-bitness",
    "sec-ch-ua-full-version",
    "sec-ch-ua-full-version-list",
    "sec-ch-ua-mobile",
    "sec-ch-ua-model",
    "sec-ch-ua-platform",
    "sec-ch-ua-platform-version",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
    "user-agent",
    "x-requested-with",
}
MAX_HEADER_VALUE_LENGTH = 8192


def canonical_header_name(name):
    return "-".join(part[:1].upper() + part[1:].lower() for part in str(name).split("-") if part)


def clean_header_value(value):
    cleaned = re.sub(r"[\r\n]+", " ", str(value or "")).strip()
    return cleaned[:MAX_HEADER_VALUE_LENGTH]


def clean_request_headers(headers):
    cleaned = {}
    if not isinstance(headers, list):
        return []

    for header in headers:
        if not isinstance(header, dict):
            continue
        raw_name = str(header.get("name") or "").strip()
        name = raw_name.lower()
        value = clean_header_value(header.get("value"))
        if not name or not value:
            continue
        if name not in NATIVE_HEADER_NAMES or not HEADER_NAME_RE.match(raw_name):
            continue
        cleaned[name] = {
            "name": canonical_header_name(raw_name),
            "value": value,
        }

    return list(cleaned.values())


def cookie_header_from_request_headers(request_headers):
    for header in clean_request_headers(request_headers):
        if header["name"].lower() == "cookie":
            return header["value"]
    return ""


def parse_cookie_header(cookie_header):
    cookies = []
    for item in str(cookie_header or "").split(";"):
        if "=" not in item:
            continue
        name, value = item.split("=", 1)
        name = re.sub(r"[\t\r\n]+", " ", name).strip()
        value = re.sub(r"[\t\r\n]+", " ", value).strip()
        if name:
            cookies.append((name, value))
    return cookies


def _write_netscape_cookie_file(cookies, url, temp_dir, error_source):
    """Write parsed cookies to a Netscape-format temp file for yt-dlp's --cookies.

    Shared body of write_cookie_file_from_headers() and
    write_cookie_file_from_string(), which differ only in how they obtain the raw
    Cookie header. ``error_source`` only picks the wording of the OSError that
    ``HostError`` wraps, so each caller keeps its own user-facing message.

    Returns the temp file path, or None if there is nothing to write or no host.
    """
    if not cookies:
        return None

    parsed = urlparse(str(url or ""))
    host = (parsed.hostname or "").lower()
    if not host:
        return None

    temp_base = Path(temp_dir) if temp_dir else Path(tempfile.gettempdir())
    try:
        temp_base.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            newline="\n",
            delete=False,
            dir=str(temp_base),
            prefix="qwin-cookies-",
            suffix=".txt",
        ) as cookie_file:
            cookie_file.write("# Netscape HTTP Cookie File\n")
            secure = "TRUE" if parsed.scheme == "https" else "FALSE"
            for name, value in cookies:
                cookie_file.write(f"{host}\tFALSE\t/\t{secure}\t0\t{name}\t{value}\n")
            return cookie_file.name
    except OSError as exc:
        raise HostError(f"Could not create temporary cookie file {error_source}: {exc}") from exc


def write_cookie_file_from_headers(url, request_headers, temp_dir=None):
    return _write_netscape_cookie_file(
        parse_cookie_header(cookie_header_from_request_headers(request_headers)),
        url,
        temp_dir,
        "for yt-dlp",
    )


def remove_temp_files(paths):
    for path in paths or []:
        if not path:
            continue
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            pass


def write_cookie_file_from_string(cookie_str, url, temp_dir=None):
    """Write a raw Cookie header string to a Netscape-format cookies file.

    Unlike write_cookie_file_from_headers() which takes a list of header
    dicts, this function takes a raw cookie string like
    ``"session=abc123; pref=lang=en"`` and creates a cookies.txt file
    suitable for yt-dlp's ``--cookies`` flag.

    Returns the path to the temp file, or None if the cookie string is empty.
    """
    return _write_netscape_cookie_file(
        parse_cookie_header(cookie_str or ""),
        url,
        temp_dir,
        "from string",
    )


def _quote_ytdlp_config_value(value):
    """Quote a value for yt-dlp's config file parser (shlex).

    yt-dlp's config file uses shlex.split() which splits on whitespace
    unless quoted. Values containing spaces, quotes, or shell metacharacters
    must be wrapped in double quotes with internal quotes escaped.

    Returns the value, double-quoted if it needs quoting, or as-is if
    it is safe (single token).  Even when quoting is not strictly needed,
    wrapping in quotes is idempotent-safe — yt-dlp strips the outer quotes.
    """
    cleaned = str(value or "")
    # Always quote to avoid any edge case with special characters
    escaped = cleaned.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def write_header_config_file(headers, user_agent, config_path):
    """Write browser-context headers to a yt-dlp-compatible config file.

    Writes ``--user-agent`` and ``--add-header`` directives so they can be
    loaded via ``--config-location`` instead of being placed on the command
    line.  This avoids Windows ``CreateProcess`` command-line length limits
    (``ERROR_FILENAME_EXCED_RANGE`` — WinError 206).

    Values with spaces are quoted so yt-dlp's shlex-based config parser
    treats them as a single argument (not split on spaces).

    The caller is responsible for deleting *config_path* after use.

    Returns True if any lines were written, False if the file is empty.
    """
    written = False
    with open(config_path, "w", encoding="utf-8", newline="\n") as f:
        if user_agent:
            f.write(f"--user-agent {_quote_ytdlp_config_value(user_agent)}\n")
            written = True
        for header in headers.values():
            if header["name"].lower() == "cookie":
                continue
            f.write("--add-header {}\n".format(_quote_ytdlp_config_value(f"{header['name']}:{header['value']}")))
            written = True
    return written


def append_browser_context_options(
    command,
    referer=None,
    user_agent=None,
    request_headers=None,
    cookies_file=None,
    headers_config_path=None,
):
    headers = {header["name"].lower(): header for header in clean_request_headers(request_headers)}
    cleaned_referer = clean_header_value(referer)
    cleaned_user_agent = clean_header_value(user_agent)

    if cleaned_referer and "referer" not in headers:
        headers["referer"] = {"name": "Referer", "value": cleaned_referer}
    if cleaned_user_agent and "user-agent" not in headers:
        headers["user-agent"] = {"name": "User-Agent", "value": cleaned_user_agent}

    if cookies_file:
        command.extend(["--cookies", str(cookies_file)])

    if headers_config_path:
        # Write all headers to a yt-dlp config file to avoid blowing the
        # Windows command-line length limit (32 767 chars for CreateProcess).
        write_header_config_file(headers, cleaned_user_agent, headers_config_path)
        command.extend(["--config-location", str(headers_config_path)])
    else:
        if cleaned_user_agent:
            command.extend(["--user-agent", cleaned_user_agent])
        for header in headers.values():
            if header["name"].lower() == "cookie":
                continue
            command.extend(["--add-header", f"{header['name']}:{header['value']}"])
