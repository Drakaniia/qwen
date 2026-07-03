# go/

> ⚡ **PRIMARY BROWSER: Yandex** — CDP relay and CDM extraction are primarily debugged against Yandex Browser.

Go companion binary (`qwin-capture`). Handles Widevine CDM initialization, license key extraction, AES-128 CTR decryption, ISO BMFF box parsing, and CDP relay. Communicates via native messaging protocol (4-byte LE length prefix + UTF-8 JSON over stdin/stdout).

## STRUCTURE

```
go/
├── main.go              # Entry: stdin/stdout IPC loop
├── commands.go          # Command dispatch (CDM, decrypt, CDP relay)
├── ipc.go               # Native message protocol framing
├── fmp4.go              # ISO BMFF box parser, CENC types, encrypted sample extraction
├── cdm.go               # Widevine CDM initialization
├── cdm_license.go       # License key extraction
├── cdm_provider.go      # CDM provider abstraction
├── decrypt.go           # AES-128 CTR decryption + segment pipeline
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
| **ISO BMFF box parsing** | `fmp4.go` | `MP4Box`, `parseMP4Boxes`, `isContainerBox`, `parseBoxesAt` |
| **CENC types** | `fmp4.go` | `CENCSample`, `CENCSubsample`, `TenBox` |
| **CENC box queries** | `fmp4.go` | `findTenBox`, `parseTenBox`, `findPSSHBox` |
| **Encrypted sample extraction** | `fmp4.go` | `extractEncryptedSamples` — moof+mdat pair processing |
| **CDM init** | `cdm.go` | Widevine CDM initialization |
| **CDM license** | `cdm_license.go` | License key extraction |
| **CDM provider** | `cdm_provider.go` | CDM provider abstraction |
| **AES decryption** | `decrypt.go` | `decryptAES128CTR` — AES-128 CTR core |
| **Segment pipeline** | `decrypt.go` | `decryptSegment`, `decryptAllSegments`, `assembleDecryptedSegments` |
| **CDP relay** | `commands.go` (cdp section) | Chrome DevTools Protocol relay |
| **IPC framing** | `ipc.go` | Native message protocol |
| **Tests** | `cdm_test.go`, `decrypt_test.go`, `cdp_relay_test.go`, `main_test.go` | Unit tests |
| **Module def** | `go.mod` | `module github.com/qwin/capture` |

## CONVENTIONS

- Standard Go formatting (`gofmt`).
- No external HTTP server — IPC only via stdin/stdout.
- AES-128 CTR decryption with IV handling for MP4 segments.
- CDM implementation follows Widevine L3 API patterns.
- fMP4 box parsing follows ISO 14496-12 / ISO 23000-19 (CMAF).

## ANTI-PATTERNS

- **No direct HTTP** — IPC only via stdin/stdout. Never listen on a port.
- **No stdout logging** — stdout reserved for native messaging protocol. Use stderr for debug output.
- **No blocking main loop** — command dispatch must be non-blocking for concurrent CDM operations.

## NOTES

- Binary built via `go build` in the `go/` directory.
- Called by Python native host (`cdm_capture.py`) via subprocess.
- Requires `cdm_path` and `license_server_url` parameters from the extension.
- fMP4 parsing in `fmp4.go` handles flat and container recursion, 32/64-bit box sizes, and CENC sample extraction.
