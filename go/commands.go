package main

import (
	"encoding/json"
	"fmt"
)

// handleCommand routes an incoming command to the appropriate handler.
func handleCommand(cmd Command) []byte {
	switch cmd.Type {
	case CmdStatus:
		return handleStatus(cmd)
	case CmdEcho:
		return handleEcho(cmd)
	case CmdCDPCommand:
		return handleCDPCommand(cmd)
	case CmdStop:
		return handleStop(cmd)
	default:
		return mustMarshal(ErrorResponse{
			Type:  ResError,
			ID:    cmd.ID,
			Error: fmt.Sprintf("unknown command type: %s", cmd.Type),
		})
	}
}

// handleStatus returns the current status of the capture binary.
// In this initial scaffold, CDM is not yet available (no Widevine CDM loaded).
// The Python host reads tools/cdm/status.json to populate the real status.
func handleStatus(cmd Command) []byte {
	return mustMarshal(StatusResponse{
		Type:         ResStatus,
		ID:           cmd.ID,
		CDMAvailable: false,
		CDMVersion:   "",
		L1Only:       false,
		CaptureReady: true,
		Version:      VERSION,
	})
}

// handleEcho is a test-only command that returns the message back.
func handleEcho(cmd Command) []byte {
	var data map[string]string
	if len(cmd.Data) > 0 {
		_ = json.Unmarshal(cmd.Data, &data)
	}
	message := ""
	if data != nil {
		message = data["message"]
	}
	return mustMarshal(EchoResponse{
		Type:    ResEcho,
		ID:      cmd.ID,
		Message: message,
	})
}

// handleCDPCommand receives a CDP command from the Python host relay.
// In the scaffold, we acknowledge receipt and return a placeholder result.
// The full implementation will send this to chrome.debugger via the extension.
func handleCDPCommand(cmd Command) []byte {
	// Parse the CDP command data for validation
	var data CDPCommandData
	if len(cmd.Data) > 0 {
		if err := json.Unmarshal(cmd.Data, &data); err != nil {
			return mustMarshal(ErrorResponse{
				Type:  ResError,
				ID:    cmd.ID,
				Error: fmt.Sprintf("invalid cdpCommand data: %v", err),
			})
		}
	}

	// Return acknowledgment — CDP commands are async and will receive
	// their results via the relay chain (extension → Python → Go).
	return mustMarshal(CDPResult{
		Type: ResCDPResult,
		ID:   cmd.ID,
	})
}

// handleStop gracefully shuts down the binary.
func handleStop(cmd Command) []byte {
	// Signal the main loop to exit by setting a global flag.
	// The response is written, then main() checks this flag and exits.
	stopRequested = true
	return mustMarshal(Response{
		Type: ResDone,
		ID:   cmd.ID,
	})
}

// mustMarshal serialises v to JSON or panics (should never happen in practice).
func mustMarshal(v any) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("failed to marshal response: %v", err))
	}
	return data
}
