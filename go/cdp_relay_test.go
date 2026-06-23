package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"os/exec"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ─── CDP relay command test ────────────────────────────────────────────────
//
// This test verifies the CDP relay flow:
//   1. Send a "cdp_relay" command to Go via stdin
//   2. Go writes a "cdpRelayForward" message to stdout
//   3. We (simulating Python) read the forward, then write a "cdpRelayInput"
//      result back to Go's stdin
//   4. Go reads the result and returns it as the response

func Test_CDPRelayCommand_ReturnsRelayedResult(t *testing.T) {
	binPath := buildBinary(t)

	cmd := exec.Command(binPath)
	stdin, err := cmd.StdinPipe()
	require.NoError(t, err)
	stdout, err := cmd.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, cmd.Start())
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	// Step 1: Send a "cdp_relay" command with method and tabId
	relayCmd := map[string]any{
		"type": "cdp_relay",
		"id":   "test-relay-1",
		"data": map[string]any{
			"tabId":  42,
			"method": "Network.enable",
			"params": map[string]any{},
		},
	}
	cmdData, _ := json.Marshal(relayCmd)
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(cmdData)))
	stdin.Write(header)
	stdin.Write(cmdData)

	// Step 2: Read the cdpRelayForward message from stdout
	outHeader := make([]byte, 4)
	_, err = io.ReadFull(stdout, outHeader)
	require.NoError(t, err)
	forwardLen := int(binary.LittleEndian.Uint32(outHeader))
	forwardPayload := make([]byte, forwardLen)
	_, err = io.ReadFull(stdout, forwardPayload)
	require.NoError(t, err)

	var forwardMsg map[string]any
	err = json.Unmarshal(forwardPayload, &forwardMsg)
	require.NoError(t, err)

	assert.Equal(t, "cdpRelayForward", forwardMsg["type"])
	forwardID := forwardMsg["id"].(string)
	assert.Contains(t, forwardID, "relay_")

	forwardData := forwardMsg["data"].(map[string]any)
	assert.Equal(t, float64(42), forwardData["tabId"])
	assert.Equal(t, "Network.enable", forwardData["method"])

	// Step 3: Send the relay result back via stdin (simulating Python)
	resultPayload := map[string]any{
		"id": forwardID,
		"result": map[string]any{
			"success": true,
		},
		"error": "",
	}
	resultData, _ := json.Marshal(resultPayload)
	resultHeader := make([]byte, 4)
	binary.LittleEndian.PutUint32(resultHeader, uint32(len(resultData)))
	stdin.Write(resultHeader)
	stdin.Write(resultData)
	stdin.Close()

	// Step 4: Read the CDP result response from stdout
	respHeader := make([]byte, 4)
	_, err = io.ReadFull(stdout, respHeader)
	require.NoError(t, err)
	respLen := int(binary.LittleEndian.Uint32(respHeader))
	respPayload := make([]byte, respLen)
	_, err = io.ReadFull(stdout, respPayload)
	require.NoError(t, err)

	var response CDPResult
	err = json.Unmarshal(respPayload, &response)
	require.NoError(t, err)

	assert.Equal(t, "cdpResult", response.Type)
	assert.Equal(t, "test-relay-1", response.ID)
	assert.True(t, response.Ok, "relay should report ok=true")
	require.NotNil(t, response.Result)

	var resultMap map[string]any
	err = json.Unmarshal(response.Result, &resultMap)
	require.NoError(t, err)
	assert.True(t, resultMap["success"].(bool))

	_ = cmd.Wait()
}

func Test_CDPRelayCommand_MissingTabId_ReturnsError(t *testing.T) {
	binPath := buildBinary(t)

	cmd := exec.Command(binPath)
	stdin, err := cmd.StdinPipe()
	require.NoError(t, err)
	stdout, err := cmd.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, cmd.Start())
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	// Send a "cdp_relay" command with missing tabId
	relayCmd := map[string]any{
		"type": "cdp_relay",
		"id":   "test-relay-err",
		"data": map[string]any{
			"tabId":  0,
			"method": "Network.enable",
		},
	}
	cmdData, _ := json.Marshal(relayCmd)
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(cmdData)))
	stdin.Write(header)
	stdin.Write(cmdData)
	stdin.Close()

	// Read the error response
	outBuf := new(bytes.Buffer)
	_, _ = outBuf.ReadFrom(stdout)
	outData := outBuf.Bytes()

	require.GreaterOrEqual(t, len(outData), 4)

	payload, _ := readMessage(t, outData, 0)
	require.NotNil(t, payload)

	var errorResp ErrorResponse
	err = json.Unmarshal(payload, &errorResp)
	require.NoError(t, err)

	assert.Equal(t, "error", errorResp.Type)
	assert.Equal(t, "test-relay-err", errorResp.ID)
	assert.Contains(t, errorResp.Error, "requires tabId and method")

	_ = cmd.Wait()
}

func Test_CDPRelayCommand_WithErrorResult(t *testing.T) {
	binPath := buildBinary(t)

	cmd := exec.Command(binPath)
	stdin, err := cmd.StdinPipe()
	require.NoError(t, err)
	stdout, err := cmd.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, cmd.Start())
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	// Send a "cdp_relay" command
	relayCmd := map[string]any{
		"type": "cdp_relay",
		"id":   "test-relay-err2",
		"data": map[string]any{
			"tabId":  42,
			"method": "Invalid.method",
		},
	}
	cmdData, _ := json.Marshal(relayCmd)
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(cmdData)))
	stdin.Write(header)
	stdin.Write(cmdData)

	// Read the forward from stdout
	outHeader := make([]byte, 4)
	_, err = io.ReadFull(stdout, outHeader)
	require.NoError(t, err)
	forwardLen := int(binary.LittleEndian.Uint32(outHeader))
	forwardPayload := make([]byte, forwardLen)
	_, err = io.ReadFull(stdout, forwardPayload)
	require.NoError(t, err)

	var forwardMsg map[string]any
	err = json.Unmarshal(forwardPayload, &forwardMsg)
	require.NoError(t, err)
	forwardID := forwardMsg["id"].(string)

	// Send back an error result
	errorPayload := map[string]any{
		"id":    forwardID,
		"error": "Invalid CDP method: Invalid.method",
	}
	errorData, _ := json.Marshal(errorPayload)
	errHeader := make([]byte, 4)
	binary.LittleEndian.PutUint32(errHeader, uint32(len(errorData)))
	stdin.Write(errHeader)
	stdin.Write(errorData)
	stdin.Close()

	// Read the response
	respHeader := make([]byte, 4)
	_, err = io.ReadFull(stdout, respHeader)
	require.NoError(t, err)
	respLen := int(binary.LittleEndian.Uint32(respHeader))
	respPayload := make([]byte, respLen)
	_, err = io.ReadFull(stdout, respPayload)
	require.NoError(t, err)

	var response CDPResult
	err = json.Unmarshal(respPayload, &response)
	require.NoError(t, err)

	assert.Equal(t, "cdpResult", response.Type)
	assert.Equal(t, "test-relay-err2", response.ID)
	assert.False(t, response.Ok, "relay should report ok=false for error")
	assert.Contains(t, response.Error, "Invalid CDP method")

	_ = cmd.Wait()
}
