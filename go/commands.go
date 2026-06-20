package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

// stdinReader is a shared buffered reader for stdin used by the relay handler.
var stdinReader *bufio.Reader

// handleCommand routes an incoming command to the appropriate handler.
func handleCommand(cmd Command) []byte {
	switch cmd.Type {
	case CmdStatus:
		return handleStatus(cmd)
	case CmdEcho:
		return handleEcho(cmd)
	case CmdCDPCommand:
		return handleCDPCommand(cmd)
	case CmdCDPRelay:
		return handleCDPRelay(cmd)
	case CmdStop:
		return handleStop(cmd)
	case CmdCDMInit:
		return handleCDMInit(cmd)
	case CmdExtractKeys:
		return handleExtractKeys(cmd)
	case CmdDecryptSegments:
		return handleDecryptSegments(cmd)
	case CmdAssembleSegments:
		return handleAssembleSegments(cmd)
	default:
		return mustMarshal(ErrorResponse{
			Type:  ResError,
			ID:    cmd.ID,
			Error: fmt.Sprintf("unknown command type: %s", cmd.Type),
		})
	}
}

// handleStatus returns the current status of the capture binary.
// Reports real CDM availability based on initialization state.
func handleStatus(cmd Command) []byte {
	return mustMarshal(StatusResponse{
		Type:         ResStatus,
		ID:           cmd.ID,
		CDMAvailable: cdmAvailable(),
		CDMVersion:   cdmVersion(),
		L1Only:       cdmL1Only(),
		CaptureReady: true,
		Version:      VERSION,
	})
}

// handleCDMInit initializes the Widevine CDM from a given path.
// Receives the CDM directory path and attempts to load the CDM.
func handleCDMInit(cmd Command) []byte {
	var data CDMInitData
	if len(cmd.Data) > 0 {
		if err := json.Unmarshal(cmd.Data, &data); err != nil {
			return mustMarshal(CDMInitResponse{
				Type:  ResCDMInit,
				ID:    cmd.ID,
				Ok:    false,
				Error: fmt.Sprintf("invalid cdmInit data: %v", err),
			})
		}
	}

	if data.CDMPath == "" {
		return mustMarshal(CDMInitResponse{
			Type:  ResCDMInit,
			ID:    cmd.ID,
			Ok:    false,
			Error: "cdmPath is required",
		})
	}

	version, l1Only, err := initCDM(data.CDMPath)
	if err != nil {
		return mustMarshal(CDMInitResponse{
			Type:  ResCDMInit,
			ID:    cmd.ID,
			Ok:    false,
			Error: err.Error(),
		})
	}

	return mustMarshal(CDMInitResponse{
		Type:       ResCDMInit,
		ID:         cmd.ID,
		Ok:         true,
		CDMVersion: version,
		L1Only:     l1Only,
		CDMPath:    data.CDMPath,
	})
}

// handleExtractKeys processes a Widevine license response and extracts decryption keys.
// Receives the license response (base64) and optional challenge/init data.
func handleExtractKeys(cmd Command) []byte {
	var data ExtractKeysData
	if len(cmd.Data) > 0 {
		if err := json.Unmarshal(cmd.Data, &data); err != nil {
			return mustMarshal(KeysExtractedResponse{
				Type:  ResKeysExtracted,
				ID:    cmd.ID,
				Ok:    false,
				Error: fmt.Sprintf("invalid extractKeys data: %v", err),
			})
		}
	}

	if data.ResponseB64 == "" {
		return mustMarshal(KeysExtractedResponse{
			Type:  ResKeysExtracted,
			ID:    cmd.ID,
			Ok:    false,
			Error: "responseB64 is required",
		})
	}

	keys, l1Only, err := extractKeysFromResponse(data.SessionID, data.ResponseB64, data.ChallengeB64, data.InitDataB64)
	if err != nil {
		return mustMarshal(KeysExtractedResponse{
			Type:      ResKeysExtracted,
			ID:        cmd.ID,
			Ok:        false,
			SessionID: data.SessionID,
			L1Only:    l1Only,
			Error:     err.Error(),
		})
	}

	return mustMarshal(KeysExtractedResponse{
		Type:      ResKeysExtracted,
		ID:        cmd.ID,
		Ok:        true,
		SessionID: data.SessionID,
		Keys:      keys,
		L1Only:    l1Only,
	})
}

// handleDecryptSegments decrypts encrypted media segments using provided keys.
func handleDecryptSegments(cmd Command) []byte {
	var data DecryptSegmentsData
	if len(cmd.Data) > 0 {
		if err := json.Unmarshal(cmd.Data, &data); err != nil {
			return mustMarshal(DecryptResponse{
				Type:  ResDecryptResult,
				ID:    cmd.ID,
				Ok:    false,
				Error: fmt.Sprintf("invalid decryptSegments data: %v", err),
			})
		}
	}

	if len(data.Keys) == 0 {
		return mustMarshal(DecryptResponse{
			Type:  ResDecryptResult,
			ID:    cmd.ID,
			Ok:    false,
			Error: "at least one decryption key is required",
		})
	}

	if len(data.Segments) == 0 {
		return mustMarshal(DecryptResponse{
			Type:  ResDecryptResult,
			ID:    cmd.ID,
			Ok:    false,
			Error: "at least one segment is required",
		})
	}

	paths, err := decryptAllSegments(data.Segments, data.Keys, data.OutputDir)
	if err != nil {
		return mustMarshal(DecryptResponse{
			Type:  ResDecryptResult,
			ID:    cmd.ID,
			Ok:    false,
			JobID: data.JobID,
			Error: err.Error(),
		})
	}

	return mustMarshal(DecryptResponse{
		Type:         ResDecryptResult,
		ID:           cmd.ID,
		Ok:           true,
		JobID:        data.JobID,
		Decrypted:    len(paths),
		SegmentPaths: paths,
	})
}

// handleAssembleSegments assembles decrypted segments into a single output file.
func handleAssembleSegments(cmd Command) []byte {
	var data AssembleSegmentsData
	if len(cmd.Data) > 0 {
		if err := json.Unmarshal(cmd.Data, &data); err != nil {
			return mustMarshal(AssembleResponse{
				Type:  ResAssembleResult,
				ID:    cmd.ID,
				Ok:    false,
				Error: fmt.Sprintf("invalid assembleSegments data: %v", err),
			})
		}
	}

	if len(data.FilePaths) == 0 {
		return mustMarshal(AssembleResponse{
			Type:  ResAssembleResult,
			ID:    cmd.ID,
			Ok:    false,
			Error: "at least one segment file path is required",
		})
	}

	if data.OutputPath == "" {
		data.OutputPath = "output.mp4"
	}

	if err := assembleDecryptedSegments(data.FilePaths, data.OutputPath); err != nil {
		return mustMarshal(AssembleResponse{
			Type:  ResAssembleResult,
			ID:    cmd.ID,
			Ok:    false,
			JobID: data.JobID,
			Error: err.Error(),
		})
	}

	return mustMarshal(AssembleResponse{
		Type:     ResAssembleResult,
		ID:       cmd.ID,
		Ok:       true,
		JobID:    data.JobID,
		FilePath: data.OutputPath,
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

// handleCDPCommand receives a synchronous CDP command from the Python host.
// The current implementation acknowledges receipt, since CDP commands are
// forwarded through the relay chain and results arrive asynchronously
// via cdp_relay.
func handleCDPCommand(cmd Command) []byte {
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

	return mustMarshal(CDPResult{
		Type: ResCDPResult,
		ID:   cmd.ID,
	})
}

// handleCDPRelay receives a "cdp_relay" command from the Python host.
// Flow:
//  1. Parse the CDP command from the payload
//  2. Write a CDP forward message to stdout (Go → Python → Extension → chrome.debugger)
//  3. Wait for the result to come back via stdin (Python sends cdpRelayInput)
//  4. Return the result as the response
//
// This is a blocking operation — the binary processes the relay synchronously
// so the Python host gets a clean request-response cycle.
func handleCDPRelay(cmd Command) []byte {
	var data CDPRelayData
	if len(cmd.Data) > 0 {
		if err := json.Unmarshal(cmd.Data, &data); err != nil {
			return mustMarshal(ErrorResponse{
				Type:  ResError,
				ID:    cmd.ID,
				Error: fmt.Sprintf("invalid cdp_relay data: %v", err),
			})
		}
	}

	if data.TabID == 0 || data.Method == "" {
		return mustMarshal(ErrorResponse{
			Type:  ResError,
			ID:    cmd.ID,
			Error: "cdp_relay requires tabId and method",
		})
	}

	forwardID := fmt.Sprintf("relay_%s", cmd.ID)

	// Write the CDP forward message to stdout.
	// Python's background reader catches this, forwards to the extension,
	// and sends the result back via stdin as a cdpRelayInput message.
	forward := CDPForwardMessage{
		Type: ResCDPForward,
		ID:   forwardID,
		Data: CDPCommandData{
			TabID:  data.TabID,
			Method: data.Method,
			Params: data.Params,
		},
	}
	forwardData := mustMarshal(forward)
	writeMessage(forwardData)

	// Wait for the result to come back on stdin.
	// Read messages from stdin until we find one with matching relay ID.
	timeout := time.After(30 * time.Second)
	for {
		// Peek at what's coming next without consuming bytes (bufio allows this)
		_, err := stdinReader.Peek(1)
		if err != nil {
			return mustMarshal(CDPResult{
				Type:  ResCDPResult,
				ID:    cmd.ID,
				Ok:    false,
				Error: fmt.Sprintf("stdin read error while waiting for relay result: %v", err),
			})
		}

		// Read the next message from stdin
		header := make([]byte, 4)
		if _, err := io.ReadFull(stdinReader, header); err != nil {
			return mustMarshal(CDPResult{
				Type:  ResCDPResult,
				ID:    cmd.ID,
				Ok:    false,
				Error: fmt.Sprintf("failed to read relay result header: %v", err),
			})
		}

		length := binary.LittleEndian.Uint32(header)
		if length > 64*1024*1024 {
			writeError("read", "relay result message too large")
			continue
		}

		payload := make([]byte, length)
		if _, err := io.ReadFull(stdinReader, payload); err != nil {
			return mustMarshal(CDPResult{
				Type:  ResCDPResult,
				ID:    cmd.ID,
				Ok:    false,
				Error: fmt.Sprintf("failed to read relay result payload: %v", err),
			})
		}

		// Try to parse as a relay result
		var relayResult CDPRelayResult
		if err := json.Unmarshal(payload, &relayResult); err != nil {
			writeError("parse", fmt.Sprintf("invalid relay result JSON: %v", err))
			continue
		}

		// Check if this result matches our relay command
		if relayResult.ID == forwardID {
			// Found the matching result — return it
			var resultPayload json.RawMessage
			if relayResult.Result != nil {
				resultPayload = relayResult.Result
			}
			return mustMarshal(CDPResult{
				Type:   ResCDPResult,
				ID:     cmd.ID,
				Ok:     relayResult.Error == "",
				Result: resultPayload,
				Error:  relayResult.Error,
			})
		}

		// Non-matching message — write error about receiving unexpected message
		// This shouldn't happen in normal flow since Python only sends results back
		writeError("relay", fmt.Sprintf("received unexpected message while waiting for relay result (id=%s)", relayResult.ID))

		select {
		case <-timeout:
			return mustMarshal(CDPResult{
				Type:  ResCDPResult,
				ID:    cmd.ID,
				Ok:    false,
				Error: fmt.Sprintf("CDP relay timed out waiting for result after 30s"),
			})
		default:
			// Continue waiting
		}
	}
}

// handleStop gracefully shuts down the binary.
func handleStop(cmd Command) []byte {
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
