# Qwin Capture — Go Companion Binary

`qwin-capture` is a Go companion binary for the Qwin Video Downloader native host. It handles performance-critical and platform-specific operations that are not suitable for the Python native host: **Widevine CDM initialization and key extraction**, **AES-128 CTR media segment decryption**, **fMP4 box parsing**, and **CDP relay forwarding** for Chrome DevTools Protocol commands.

## Overview

The Go binary communicates with the Python native host (`src/native_host/host.py`) through **native messaging framing** (4-byte little-endian length prefix + UTF-8 JSON payload) over stdin/stdout. The Python `CaptureManager` in `src/native_host/capture_manager.py` manages the subprocess lifecycle and routes commands.

## Architecture

```
Python Native Host                    Go qwin-capture
┌──────────────────────┐     stdin    ┌─────────────────────────┐
│  capture_manager.py  │ ──────────►  │  main.go (IPC loop)    │
│                      │              │     ↓                   │
│  Send JSON command   │     stdout   │  commands.go (dispatch) │
│  with 4-byte header  │ ◄──────────  │     ↓                   │
│                      │              │  cdm.go / decrypt.go    │
│  Background reader   │              │  ipc.go (protocol)      │
│  matches ID+response │              └─────────────────────────┘
└──────────────────────┘
```

The Python host spawns a persistent background reader thread that reads ALL messages from Go's stdout into a queue. When a command response matches a sent command ID, it's returned to the caller. Async CDP relay forwards (`"cdpRelayForward"`) are automatically routed to a separate queue.

## Commands

| Command | Description |
|---|---|
| `status` | Returns CDM availability, version, L1-only status, and capture-ready state |
| `echo` | Test-only command that returns the message back (IPC roundtrip validation) |
| `stop` | Graceful shutdown — sets `stopRequested` flag and exits cleanly |
| `cdpCommand` | Acknowledges receipt of a synchronous CDP command (legacy; use `cdp_relay`) |
| `cdp_relay` | Full async CDP relay: Go → Python → Extension → chrome.debugger, waits for result |
| `cdmInit` | Initialize the Widevine CDM from a directory path containing `widevinecdm.dll` |
| `extractKeys` | Extract decryption keys from a captured Widevine license response |
| `decryptSegments` | Decrypt encrypted media segments using provided AES-128 keys |
| `assembleSegments` | Concatenate decrypted segment files into a single output MP4 |

## Source Files

| File | Purpose |
|---|---|
| `main.go` | IPC main loop — reads framed JSON from stdin, dispatches, writes responses to stdout |
| `commands.go` | Command routing — maps type strings to handler functions; handles CDP relay wait |
| `ipc.go` | Protocol types — all JSON structs for commands, responses, and CDM data types |
| `cdm.go` | Widevine CDM provider interface and implementation — `parseLicenseResponse`, `extractLicenseKeys`, `unwrapKeys`, version detection |
| `decrypt.go` | AES-128 CTR decryption, MP4/fMP4 box parser, CENC sample extraction, segment assembly |
| `main_test.go` | Integration tests — builds binary, starts subprocess, validates IPC roundtrips |

## IPC Protocol

Both stdin and stdout use native messaging framing (same format as Chrome native messaging):

```
┌─────────────────────────────┐
│  4 bytes: payload length    │  (little-endian uint32)
├─────────────────────────────┤
│  N bytes: UTF-8 JSON        │  (the actual message)
└─────────────────────────────┘
```

### Example: Echo Command

**Sent to stdin:**
```json
{"type": "echo", "id": "test-1", "data": {"message": "hello"}}
```

**Received on stdout:**
```json
{"type": "echo", "id": "test-1", "message": "hello"}
```

## Widevine CDM Pipeline

### CDM Initialization (`cdmInit`)

The CDM provider (`cdm.go`) implements a `CDMProvider` interface:

```go
type CDMProvider interface {
    Init(cdmDir string) (version string, l1Only bool, err error)
    ExtractKeys(sessionID, responseB64, challengeB64, initDataB64 string) ([]DecryptionKey, bool, error)
    IsAvailable() bool
    Version() string
    IsL1Only() bool
}
```

The `defaultCDMProvider`:
1. Searches the CDM directory for `widevinecdm.dll`
2. Attempts version detection from `manifest.json`, `version.txt`, or binary scanning
3. Checks for L1 (hardware-backed) vs L3 (software) capability
4. Stores the provider instance globally for subsequent `extractKeys` calls

### License Key Extraction (`extractKeys`)

The Widevine key extraction pipeline:

1. **Parse license response protobuf**: `parseLicenseResponse()` decodes base64 and extracts `LicenseKey` entries from the SignedLicense protobuf structure
2. **Extract key material**: Each `LicenseKey` contains a KID (16 bytes), type (SW_SECURE_CRYPTO=1, SW_SECURE_DECODE=2, HW_SECURE=3), and encrypted key bytes
3. **Unwrap keys**: For L3, keys are encrypted with a session key derivable from the CDM's device private key. `unwrapKeys()` attempts AES-128 ECB decryption with the session key
4. **Report L1-only**: If only HW_SECURE keys are found, marks `l1Only=true` so the pipeline can fall through to screen recording

### Segment Decryption (`decryptSegments`)

The decryption pipeline handles both **fragmented MP4 (fMP4)** segments and **raw encrypted data**:

1. **fMP4 path**: Parses `moof` + `mdat` box pairs from the segment, extracts CENC sample info (tenc box, KID), finds the matching key, and decrypts each sample with AES-128 CTR
2. **Raw data path**: Falls back to decrypting the entire segment with a zero IV (for simple test vectors)
3. **Output**: Decrypted segment files are written to a `qwin-decrypted/` subdirectory
4. **Assembly**: `assembleSegments` concatenates decrypted segments in order into a single MP4 file

## CDP Relay Chain

The CDP relay is a 4-hop chain for Chrome DevTools Protocol commands:

```
1. Python sends "cdp_relay" to Go (stdin)
2. Go writes "cdpRelayForward" to stdout
   ────────────────────
   Python background reader catches it, queues it
3. Python forwards to Extension (native message)
   Extension sends to chrome.debugger.sendCommand()
4. Extension returns result to Python (native message)
   Python writes "cdpRelayInput" result to Go's stdin
5. Go reads the result and returns it as the command response
```

This synchronous relay allows the Python host to execute CDP commands with proper request-response semantics, even though the actual Chrome debugger communication is async.

## Testing

Run the Go tests:

```bat
cd go
go test -v ./...
```

Tests compile the binary and exercise the full IPC roundtrip:

- `Test_EchoCommand_ReturnsExpectedResponse` — validates JSON framing
- `Test_StatusCommand_ReturnsCaptureReady` — verifies status response
- `Test_CDPRelayCommand_ReturnsRelayedResult` — full CDP relay roundtrip
- `Test_CDMInitCommand_WithMissingPath_ReturnsError` — CDM init error handling
- `Test_ExtractKeysCommand_WithValidLicenseResponse_ReturnsKeys` — key extraction
- `Test_DecryptSegmentsCommand_WithValidKey_DecryptsData` — AES-128 CTR decrypt
- `TestParseLicenseResponse_WithValidProtobuf_ExtractsKeys` — protobuf parsing
- `TestDecryptAES128CTR_Roundtrip` — crypto correctness

## Building

```bat
cd go
go build -o qwin-capture.exe .
```

The Windows binary is typically installed via `scripts\install-capture.ps1` into `tools\capture\qwin-capture.exe`.

## Version

Current version: `1.0.0-alpha`

```bat
qwin-capture --version
```
