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

	ResStatus        = "cdmStatus"
	ResEcho          = "echo"
	ResCDPResult     = "cdpResult"
	ResCDPForward    = "cdpRelayForward"
	ResCDPRelayInput = "cdpRelayInput"
	ResDone          = "done"
	ResError         = "error"
)
