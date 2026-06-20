package main

import "encoding/json"

// ─── Incoming commands ──────────────────────────────────────────────────────

// Command is a generic incoming message from the Python host.
type Command struct {
	Type string          `json:"type"`
	ID   string          `json:"id"`
	Data json.RawMessage `json:"data,omitempty"`
}

// StatusData is the payload for a "status" command.
type StatusData struct {
	TabID int `json:"tabId,omitempty"`
}

// CDPCommandData is the payload for a "cdpCommand" command.
// The Python host relays CDP method calls from the Go binary to
// the extension, which forwards them to chrome.debugger.sendCommand.
type CDPCommandData struct {
	TabID  int             `json:"tabId"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// CDPRelayData is the payload for a "cdp_relay" command.
// Python sends this to Go when it wants Go to relay a CDP command
// through the chain: Go → Python → Extension → chrome.debugger.
type CDPRelayData struct {
	TabID  int             `json:"tabId"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// CDPRelayResult is the message Python sends back to Go with
// the result of a CDP command that was relayed through the chain.
type CDPRelayResult struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// CDPForwardMessage is the message Go writes to stdout to forward
// a CDP command through the relay chain.
type CDPForwardMessage struct {
	Type string          `json:"type"`
	ID   string          `json:"id"`
	Data CDPCommandData  `json:"data"`
}

// ─── CDM Commands ───────────────────────────────────────────────────────────

// CDMInitData is the payload for a "cdm_init" command.
// Tells the Go binary where to find the Widevine CDM and initializes it.
type CDMInitData struct {
	CDMPath string `json:"cdmPath"` // Path to directory containing widevinecdm.dll
}

// ExtractKeysData is the payload for an "extractKeys" command.
// Contains a captured Widevine license exchange for key extraction.
type ExtractKeysData struct {
	SessionID     string `json:"sessionId"`                // CDM session identifier
	InitDataB64   string `json:"initDataB64,omitempty"`    // PSSH init data (base64)
	ChallengeB64  string `json:"challengeB64,omitempty"`   // License challenge (base64, POST body)
	ResponseB64   string `json:"responseB64"`              // License response (base64)
	LicenseURL    string `json:"licenseUrl,omitempty"`     // License server URL
	TabID         int    `json:"tabId,omitempty"`          // Source tab
}

// DecryptSegmentsData is the payload for a "decryptSegments" command.
type DecryptSegmentsData struct {
	JobID       string             `json:"jobId"`
	Segments    []EncryptedSegment `json:"segments"`
	Keys        []DecryptionKey    `json:"keys"`
	OutputDir   string             `json:"outputDir,omitempty"`
}

// EncryptedSegment describes one encrypted media segment.
type EncryptedSegment struct {
	StreamID string `json:"streamId"`  // "video" or "audio"
	Index    int    `json:"index"`
	DataB64  string `json:"dataB64"`  // Encrypted segment bytes (base64)
	MimeType string `json:"mimeType,omitempty"`
	IsLast   bool   `json:"isLast"`
}

// DecryptionKey holds one decryption key for a KID.
type DecryptionKey struct {
	KeyIDB64 string `json:"keyIdB64"` // Key ID (base64)
	KeyB64   string `json:"keyB64"`   // AES-128 key bytes (base64)
	Type     string `json:"type,omitempty"` // "CENC" (default)
}

// AssembleSegmentsData is the payload for an "assemble" command.
type AssembleSegmentsData struct {
	JobID      string   `json:"jobId"`
	SegmentDir string   `json:"segmentDir"`
	OutputPath string   `json:"outputPath"`
	FilePaths  []string `json:"filePaths,omitempty"`
}

// ─── Outgoing responses ─────────────────────────────────────────────────────

// Response is a generic outgoing message to the Python host.
type Response struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// StatusResponse is the response to a "status" command.
// Reflects real CDM availability based on initialization state.
type StatusResponse struct {
	Type         string `json:"type"`
	ID           string `json:"id"`
	CDMAvailable bool   `json:"cdmAvailable"`
	CDMVersion   string `json:"cdmVersion,omitempty"`
	L1Only       bool   `json:"l1Only"`
	CaptureReady bool   `json:"captureReady"`
	Version      string `json:"version"`
}

// CDMInitResponse is the response to a "cdm_init" command.
type CDMInitResponse struct {
	Type         string `json:"type"`
	ID           string `json:"id"`
	Ok           bool   `json:"ok"`
	CDMVersion   string `json:"cdmVersion,omitempty"`
	L1Only       bool   `json:"l1Only"`
	CDMPath      string `json:"cdmPath,omitempty"`
	Error        string `json:"error,omitempty"`
}

// KeysExtractedResponse is the response to an "extractKeys" command.
type KeysExtractedResponse struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Ok        bool            `json:"ok"`
	SessionID string          `json:"sessionId"`
	Keys      []DecryptionKey `json:"keys,omitempty"`
	L1Only    bool            `json:"l1Only"`
	Error     string          `json:"error,omitempty"`
}

// DecryptResponse is the response to a "decryptSegments" command.
type DecryptResponse struct {
	Type         string `json:"type"`
	ID           string `json:"id"`
	Ok           bool   `json:"ok"`
	JobID        string `json:"jobId"`
	Decrypted    int    `json:"decrypted"`
	SegmentPaths []string `json:"segmentPaths,omitempty"`
	Error        string `json:"error,omitempty"`
}

// AssembleResponse is the response to an "assemble" command.
type AssembleResponse struct {
	Type     string `json:"type"`
	ID       string `json:"id"`
	Ok       bool   `json:"ok"`
	JobID    string `json:"jobId"`
	FilePath string `json:"filePath,omitempty"`
	Error    string `json:"error,omitempty"`
}

// EchoResponse is the response to an "echo" command (used for testing IPC).
type EchoResponse struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Message string `json:"message"`
}

// CDPResult is the response to a "cdpCommand" (sync) or "cdp_relay" (async relay).
type CDPResult struct {
	Type   string          `json:"type"`
	ID     string          `json:"id"`
	Ok     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// ErrorResponse is sent when a command fails.
type ErrorResponse struct {
	Type  string `json:"type"`
	ID    string `json:"id"`
	Error string `json:"error"`
}

// ─── Protocol constants ─────────────────────────────────────────────────────

const (
	VERSION = "1.0.0-alpha"

	CmdStatus     = "status"
	CmdEcho       = "echo"
	CmdCDPCommand = "cdpCommand"
	CmdCDPRelay   = "cdp_relay"
	CmdStop       = "stop"

	// CDM commands
	CmdCDMInit          = "cdmInit"
	CmdExtractKeys      = "extractKeys"
	CmdDecryptSegments  = "decryptSegments"
	CmdAssembleSegments = "assembleSegments"

	ResStatus            = "cdmStatus"
	ResEcho              = "echo"
	ResCDPResult         = "cdpResult"
	ResCDPForward        = "cdpRelayForward"
	ResCDPRelayInput     = "cdpRelayInput"
	ResCDMInit           = "cdmInitResult"
	ResKeysExtracted     = "keysExtracted"
	ResDecryptResult     = "decryptResult"
	ResAssembleResult    = "assembleResult"
	ResDone              = "done"
	ResError             = "error"
)
