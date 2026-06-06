import json
import os
import struct
import sys
import threading


MAX_INCOMING_BYTES = 64 * 1024 * 1024
MAX_OUTGOING_BYTES = 1024 * 1024
OUTGOING_LOCK = threading.Lock()


class HostError(Exception):
    pass


def configure_binary_stdio():
    if os.name != "nt":
        return

    try:
        import msvcrt

        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    except Exception as exc:
        print(f"Failed to switch stdio to binary mode: {exc}", file=sys.stderr)


def encode_native_message(message):
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_OUTGOING_BYTES:
        raise HostError("Native messaging response is too large.")
    return struct.pack("=I", len(payload)) + payload


def read_native_message(input_stream=None):
    stream = input_stream or sys.stdin.buffer
    raw_length = stream.read(4)
    if raw_length == b"":
        raise EOFError
    if len(raw_length) != 4:
        raise HostError("Received an incomplete native messaging length prefix.")

    message_length = struct.unpack("=I", raw_length)[0]
    if message_length > MAX_INCOMING_BYTES:
        raise HostError("Native messaging request is too large.")

    raw_payload = stream.read(message_length)
    if len(raw_payload) != message_length:
        raise HostError("Received an incomplete native messaging payload.")

    return json.loads(raw_payload.decode("utf-8"))


def send_native_message(message, output_stream=None):
    stream = output_stream or sys.stdout.buffer
    encoded = encode_native_message(message)
    with OUTGOING_LOCK:
        stream.write(encoded)
        stream.flush()
