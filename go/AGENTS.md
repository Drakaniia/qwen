# go/

Go companion binary (`qwin-capture`). Handles Widevine CDM initialization, license key extraction, AES-128 CTR decryption, and CDP relay. Communicates via native messaging protocol (4-byte LE length prefix + UTF-8 JSON over stdin/stdout).

## STRUCTURE

```
go/
├── main.go              # Entry: stdin/stdout IPC loop
├── commands.go          # Command dispatch (CDM, decrypt, CDP relay)
├── ipc.go               # Native message protocol framing
├── cdm.go               # Widevine CDM initialization
├── cdm_license.go       # License key extraction
├── cdm_provider.go      # CDM provider abstraction
├── decrypt.go           # AES-128 CTR segment decryption
├── cdm_test.go          # CDM unit tests
├── decrypt_test.go      # Decrypt unit tests
├── cdp_relay_test.go    # CDP relay tests
├── main_test.go         # Integration tests
└── go.mod               # Module: github.com/qwin/capture
```

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| **Entry point / IPC** | `main.go` | stdin/stdout loop, command dispatch |
| **Command dispatch** | `commands.go` | Route commands to handlers |
| **CDM init** | `cdm.go` | Widevine CDM initialization |
| **CDM license** | `cdm_license.go` | License key extraction |
| **CDM provider** | `cdm_provider.go` | CDM provider abstraction |
| **Decryption** | `decrypt.go` | AES-128 CTR segment decryption |
| **CDP relay** | `commands.go` (cdp section) | Chrome DevTools Protocol relay |
| **IPC framing** | `ipc.go` | Native message protocol |
| **Tests** | `cdm_test.go`, `decrypt_test.go`, `cdp_relay_test.go`, `main_test.go` | Unit tests |
| **Module def** | `go.mod` | `module github.com/qwin/capture` |

## CONVENTIONS

- Standard Go formatting (`gofmt`).
- No external HTTP server — IPC only via stdin/stdout.
- AES-128 CTR decryption with IV handling for MP4 segments.
- CDM implementation follows Widevine L3 API patterns.

## ANTI-PATTERNS

- **No direct HTTP** — IPC only via stdin/stdout. Never listen on a port.
- **No stdout logging** — stdout reserved for native messaging protocol. Use stderr for debug output.
- **No blocking main loop** — command dispatch must be non-blocking for concurrent CDM operations.

## NOTES

- Binary built via `go build` in the `go/` directory.
- Called by Python native host (`cdm_capture.py`) via subprocess.
- Requires `cdm_path` and `license_server_url` parameters from the extension.
