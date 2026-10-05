"""Buffered line iterator for a subprocess stdout pipe (spec D13).

Replaces the old `stream.read(1)` loop in `progress_parser.py`, which cost one
read syscall *per character* -- thousands per second once a backend live-renders
a table (N_m3u8DL-RE repaints its whole grid ~10x/sec). Same yielded strings,
one read per 4 KB instead.

`read1` rather than `read`: on a `TextIOWrapper` (what `Popen(text=True)`
returns) `read(n)` loops until it has exactly n characters, so a quiet pipe
would stall progress lines for the whole download. `read1` returns whatever has
already arrived. File-like objects without `read1` fall back to `read`.
"""

import re

READ_CHUNK = 4096

# ponytail: a line with no delimiter in it is truncated at 64 KB. Real output
# lines (yt-dlp progress, aria2 rows, ffmpeg key=value) are well under 1 KB, so
# this only ever fires for a backend printing a runaway unterminated line, which
# would otherwise grow the buffer without bound. Raise it if a real backend ever
# needs longer lines.
MAX_LINE = 65536

_DELIMITER_RE = re.compile(r"[\r\n]")


def iter_process_output_lines(stream):
    """Yield one string per `\r`- or `\n`-terminated chunk, like the old reader.

    Empty chunks are skipped, and a trailing partial line is flushed at EOF, so
    the sequence is byte-identical to the previous `read(1)` implementation.
    """
    read = stream.read1 if hasattr(stream, "read1") else stream.read
    buffer = ""
    while True:
        chunk = read(READ_CHUNK)
        if not chunk:
            break
        buffer += chunk
        match = _DELIMITER_RE.search(buffer)
        while match:
            line = buffer[: match.start()]
            buffer = buffer[match.end() :]
            if line:
                yield line
            match = _DELIMITER_RE.search(buffer)
        if len(buffer) > MAX_LINE:
            yield buffer[:MAX_LINE]
            buffer = ""

    if buffer:
        yield buffer
