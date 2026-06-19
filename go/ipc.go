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

// ─── Outgoing responses ─────────────────────────────────────────────────────

// Response is a generic outgoing message to the Python host.
type Response struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// StatusResponse is the response to a "status" command.
type StatusResponse struct {
	Type         string `json:"type"`
	ID           string `json:"id"`
	CDMAvailable bool   `json:"cdmAvailable"`
	CDMVersion   string `json:"cdmVersion,omitempty"`
	L1Only       bool   `json:"l1Only"`
	CaptureReady bool   `json:"captureReady"`
	Version      string `json:"version"`
}

// EchoResponse is the response to an "echo" command (used for testing IPC).
type EchoResponse struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Message string `json:"message"`
}

// CDPResult is the response to a "cdpCommand".
type CDPResult struct {
	Type   string          `json:"type"`
	ID     string          `json:"id"`
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
	CmdStop       = "stop"

	ResStatus    = "cdmStatus"
	ResEcho      = "echo"
	ResCDPResult = "cdpResult"
	ResDone      = "done"
	ResError     = "error"
)
