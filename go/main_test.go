package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// buildBinary compiles qwin-capture and returns the path to the binary.
func buildBinary(t *testing.T) string {
	t.Helper()

	// Determine the output binary name
	binName := "qwin-capture"
	if runtime.GOOS == "windows" {
		binName += ".exe"
	}

	binPath := filepath.Join(t.TempDir(), binName)

	// Get the source directory (where main.go lives)
	srcDir := "."
	cmd := exec.Command("go", "build", "-o", binPath, srcDir)
	cmd.Dir = filepath.Dir(".")
	cmd.Stderr = os.Stderr
	require.NoError(t, cmd.Run(), "go build should succeed")
	return binPath
}

// readMessage reads one JSON message with native messaging framing from the reader.
func readMessage(t *testing.T, data []byte, offset int) ([]byte, int) {
	t.Helper()
	if offset+4 > len(data) {
		return nil, offset
	}
	length := int(binary.LittleEndian.Uint32(data[offset : offset+4]))
	offset += 4
	if offset+length > len(data) {
		return nil, offset
	}
	payload := data[offset : offset+length]
	offset += length
	return payload, offset
}

// ─── Tracer bullet test ─────────────────────────────────────────────────────
//
// This test proves the IPC protocol works end-to-end:
//   1. Build the Go binary
//   2. Start it as a subprocess
//   3. Send an "echo" command via stdin with native messaging framing
//   4. Read the response from stdout
//   5. Verify the response matches the expected format

func Test_EchoCommand_ReturnsExpectedResponse(t *testing.T) {
	binPath := buildBinary(t)

	// Start the binary
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

	// Send an "echo" command with native messaging framing
	echoCmd := map[string]any{
		"type": "echo",
		"id":   "test-1",
		"data": map[string]string{
			"message": "hello from test",
		},
	}
	cmdData, _ := json.Marshal(echoCmd)
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(cmdData)))
	stdin.Write(header)
	stdin.Write(cmdData)
	stdin.Close()

	// Read the response
	outBuf := new(bytes.Buffer)
	_, _ = outBuf.ReadFrom(stdout)
	outData := outBuf.Bytes()

	require.GreaterOrEqual(t, len(outData), 4, "should have at least a 4-byte header")

	payload, _ := readMessage(t, outData, 0)
	require.NotNil(t, payload, "should parse one complete message")

	var response EchoResponse
	err = json.Unmarshal(payload, &response)
	require.NoError(t, err, "response should be valid JSON")

	assert.Equal(t, "echo", response.Type)
	assert.Equal(t, "test-1", response.ID)
	assert.Equal(t, "hello from test", response.Message)

	_ = cmd.Wait()
}

// ─── Status command test ────────────────────────────────────────────────────

func Test_StatusCommand_ReturnsCaptureReady(t *testing.T) {
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

	// Send a "status" command
	statusCmd := map[string]any{
		"type": "status",
		"id":   "test-status-1",
	}
	cmdData, _ := json.Marshal(statusCmd)
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(cmdData)))
	stdin.Write(header)
	stdin.Write(cmdData)
	stdin.Close()

	// Read the response
	outBuf := new(bytes.Buffer)
	_, _ = outBuf.ReadFrom(stdout)
	outData := outBuf.Bytes()

	require.GreaterOrEqual(t, len(outData), 4)

	payload, _ := readMessage(t, outData, 0)
	require.NotNil(t, payload)

	var response StatusResponse
	err = json.Unmarshal(payload, &response)
	require.NoError(t, err)

	assert.Equal(t, "cdmStatus", response.Type)
	assert.Equal(t, "test-status-1", response.ID)
	assert.False(t, response.CDMAvailable, "CDM should not be available in scaffold")
	assert.True(t, response.CaptureReady, "capture should be ready")
	assert.Equal(t, VERSION, response.Version)

	_ = cmd.Wait()
}

// ─── --version flag test ────────────────────────────────────────────────────

func Test_VersionFlag_PrintsVersion(t *testing.T) {
	binPath := buildBinary(t)

	cmd := exec.Command(binPath, "--version")
	out, err := cmd.Output()
	require.NoError(t, err)

	assert.Contains(t, string(out), VERSION)
	assert.Contains(t, string(out), runtime.GOOS)
}

// ─── Unknown command test ───────────────────────────────────────────────────

func Test_UnknownCommand_ReturnsError(t *testing.T) {
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

	unknownCmd := map[string]any{
		"type": "nonexistent",
		"id":   "test-err-1",
	}
	cmdData, _ := json.Marshal(unknownCmd)
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(cmdData)))
	stdin.Write(header)
	stdin.Write(cmdData)
	stdin.Close()

	outBuf := new(bytes.Buffer)
	_, _ = outBuf.ReadFrom(stdout)
	outData := outBuf.Bytes()

	require.GreaterOrEqual(t, len(outData), 4)

	payload, _ := readMessage(t, outData, 0)
	require.NotNil(t, payload)

	var response ErrorResponse
	err = json.Unmarshal(payload, &response)
	require.NoError(t, err)

	assert.Equal(t, "error", response.Type)
	assert.Equal(t, "test-err-1", response.ID)
	assert.Contains(t, response.Error, "unknown command type")

	_ = cmd.Wait()
}

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

// ─── Stop command test ──────────────────────────────────────────────────────

func Test_StopCommand_ExitsGracefully(t *testing.T) {
	binPath := buildBinary(t)

	cmd := exec.Command(binPath)
	stdin, err := cmd.StdinPipe()
	require.NoError(t, err)
	stdout, err := cmd.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, cmd.Start())

	// Send a "stop" command
	stopCmd := map[string]any{
		"type": "stop",
		"id":   "test-stop-1",
	}
	cmdData, _ := json.Marshal(stopCmd)
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(cmdData)))
	stdin.Write(header)
	stdin.Write(cmdData)
	stdin.Close()

	// Read the "done" response
	outBuf := new(bytes.Buffer)
	_, _ = outBuf.ReadFrom(stdout)
	outData := outBuf.Bytes()

	require.GreaterOrEqual(t, len(outData), 4)

	payload, _ := readMessage(t, outData, 0)
	require.NotNil(t, payload)

	var response Response
	err = json.Unmarshal(payload, &response)
	require.NoError(t, err)

	assert.Equal(t, "done", response.Type)
	assert.Equal(t, "test-stop-1", response.ID)

	// Process should exit on its own after stop
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()
	select {
	case err := <-done:
		assert.NoError(t, err, "process should exit cleanly")
	case <-time.After(3 * time.Second):
		t.Fatal("process did not exit after stop command")
	}
}

// ─── CDM Init Command Test ─────────────────────────────────────────────────
//
// Verifies the cdmInit command: responds with ok=false when CDM path doesn't exist.

func Test_CDMInitCommand_WithMissingPath_ReturnsError(t *testing.T) {
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

	// Send cdmInit with a non-existent path
	initCmd := map[string]any{
		"type": CmdCDMInit,
		"id":   "test-cdm-init-1",
		"data": map[string]string{
			"cdmPath": "C:\\nonexistent\\cdm\\path",
		},
	}
	cmdData, _ := json.Marshal(initCmd)
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(cmdData)))
	stdin.Write(header)
	stdin.Write(cmdData)
	stdin.Close()

	outBuf := new(bytes.Buffer)
	_, _ = outBuf.ReadFrom(stdout)
	outData := outBuf.Bytes()

	require.GreaterOrEqual(t, len(outData), 4)

	payload, _ := readMessage(t, outData, 0)
	require.NotNil(t, payload)

	var response CDMInitResponse
	err = json.Unmarshal(payload, &response)
	require.NoError(t, err)

	assert.Equal(t, ResCDMInit, response.Type)
	assert.Equal(t, "test-cdm-init-1", response.ID)
	assert.False(t, response.Ok, "CDM init should fail with non-existent path")
	assert.Contains(t, response.Error, "not found")

	_ = cmd.Wait()
}

func Test_CDMInitCommand_EmptyPath_ReturnsError(t *testing.T) {
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

	initCmd := map[string]any{
		"type": CmdCDMInit,
		"id":   "test-cdm-init-2",
		"data": map[string]string{
			"cdmPath": "",
		},
	}
	cmdData, _ := json.Marshal(initCmd)
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(cmdData)))
	stdin.Write(header)
	stdin.Write(cmdData)
	stdin.Close()

	outBuf := new(bytes.Buffer)
	_, _ = outBuf.ReadFrom(stdout)
	outData := outBuf.Bytes()

	require.GreaterOrEqual(t, len(outData), 4)

	payload, _ := readMessage(t, outData, 0)
	require.NotNil(t, payload)

	var response CDMInitResponse
	err = json.Unmarshal(payload, &response)
	require.NoError(t, err)

	assert.Equal(t, ResCDMInit, response.Type)
	assert.Equal(t, "test-cdm-init-2", response.ID)
	assert.False(t, response.Ok)
	assert.Contains(t, response.Error, "cdmPath")

	_ = cmd.Wait()
}

// ─── ExtractKeys Command Test ───────────────────────────────────────────────
//
// Tests the extractKeys command with a valid license response that contains key material.
// Uses a synthetic protobuf-encoded license response.

func Test_ExtractKeysCommand_WithValidLicenseResponse_ReturnsKeys(t *testing.T) {
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

	// Build a synthetic protobuf license response containing one LicenseKey:
	//   LicenseKey {
	//     id = 16 bytes (KID)
	//     type = 1 (SW_SECURE_CRYPTO)
	//     key = 16 bytes
	//   }
	//
	// Protobuf encoding:
	//   field 1 (bytes id): tag=0x0a, length=16, 16 bytes
	//   field 2 (varint type): tag=0x10, value=1
	//   field 3 (bytes key): tag=0x1a, length=16, 16 bytes

	kid := make([]byte, 16)
	for i := range kid {
		kid[i] = byte(i)
	}
	keyMaterial := make([]byte, 16)
	for i := range keyMaterial {
		keyMaterial[i] = byte(0xFF - i)
	}

	var responseData []byte
	responseData = append(responseData, 0x0a)                         // field 1, wire 2 (bytes)
	responseData = append(responseData, 16)                            // length = 16
	responseData = append(responseData, kid...)                        // KID
	responseData = append(responseData, 0x10)         // field 2, wire 0 (varint)
	responseData = appendVarint(responseData, 1)     // type = SW_SECURE_CRYPTO
	responseData = append(responseData, 0x1a)         // field 3, wire 2 (bytes)
	responseData = append(responseData, 16)                            // length = 16
	responseData = append(responseData, keyMaterial...)                // key

	responseB64 := base64.StdEncoding.EncodeToString(responseData)

	// Send extractKeys command
	extractCmd := map[string]any{
		"type": CmdExtractKeys,
		"id":   "test-extract-1",
		"data": map[string]any{
			"sessionId":    "test-session-1",
			"responseB64":  responseB64,
			"challengeB64": "",
			"initDataB64":  "",
		},
	}
	cmdData, _ := json.Marshal(extractCmd)
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(cmdData)))
	stdin.Write(header)
	stdin.Write(cmdData)
	stdin.Close()

	outBuf := new(bytes.Buffer)
	_, _ = outBuf.ReadFrom(stdout)
	outData := outBuf.Bytes()

	require.GreaterOrEqual(t, len(outData), 4)

	payload, _ := readMessage(t, outData, 0)
	require.NotNil(t, payload)

	var response KeysExtractedResponse
	err = json.Unmarshal(payload, &response)
	require.NoError(t, err)

	assert.Equal(t, ResKeysExtracted, response.Type)
	assert.Equal(t, "test-extract-1", response.ID)
	assert.True(t, response.Ok, "key extraction should succeed for valid license response")
	assert.Equal(t, "test-session-1", response.SessionID)
	require.Len(t, response.Keys, 1, "should extract exactly 1 key")
	assert.NotEmpty(t, response.Keys[0].KeyIDB64)
	assert.NotEmpty(t, response.Keys[0].KeyB64)
	assert.Equal(t, "CENC", response.Keys[0].Type)

	_ = cmd.Wait()
}

func Test_ExtractKeysCommand_MissingResponseB64_ReturnsError(t *testing.T) {
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

	extractCmd := map[string]any{
		"type": CmdExtractKeys,
		"id":   "test-extract-err",
		"data": map[string]any{
			"sessionId":    "test-session",
			"responseB64":  "",
		},
	}
	cmdData, _ := json.Marshal(extractCmd)
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(cmdData)))
	stdin.Write(header)
	stdin.Write(cmdData)
	stdin.Close()

	outBuf := new(bytes.Buffer)
	_, _ = outBuf.ReadFrom(stdout)
	outData := outBuf.Bytes()

	require.GreaterOrEqual(t, len(outData), 4)

	payload, _ := readMessage(t, outData, 0)
	require.NotNil(t, payload)

	var response KeysExtractedResponse
	err = json.Unmarshal(payload, &response)
	require.NoError(t, err)

	assert.Equal(t, ResKeysExtracted, response.Type)
	assert.Equal(t, "test-extract-err", response.ID)
	assert.False(t, response.Ok)
	assert.Contains(t, response.Error, "responseB64")

	_ = cmd.Wait()
}

func Test_ExtractKeysCommand_InvalidResponseB64_ReturnsError(t *testing.T) {
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

	extractCmd := map[string]any{
		"type": CmdExtractKeys,
		"id":   "test-extract-err2",
		"data": map[string]any{
			"sessionId":    "test-session",
			"responseB64":  "!!!not-valid-base64!!!",
		},
	}
	cmdData, _ := json.Marshal(extractCmd)
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(cmdData)))
	stdin.Write(header)
	stdin.Write(cmdData)
	stdin.Close()

	outBuf := new(bytes.Buffer)
	_, _ = outBuf.ReadFrom(stdout)
	outData := outBuf.Bytes()

	require.GreaterOrEqual(t, len(outData), 4)

	payload, _ := readMessage(t, outData, 0)
	require.NotNil(t, payload)

	var response KeysExtractedResponse
	err = json.Unmarshal(payload, &response)
	require.NoError(t, err)

	assert.Equal(t, ResKeysExtracted, response.Type)
	assert.Equal(t, "test-extract-err2", response.ID)
	assert.False(t, response.Ok)
	assert.Contains(t, response.Error, "decode")

	_ = cmd.Wait()
}

// ─── DecryptSegments Command Test ───────────────────────────────────────────
//
// Tests the decryptSegments command with synthetic encrypted data.
// Verifies AES-128 CTR decryption and segment output.

func Test_DecryptSegmentsCommand_WithValidKey_DecryptsData(t *testing.T) {
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

	// Create a known plaintext and encrypt it with AES-128 CTR for testing.
	// The raw decryption fallback (non-fMP4) uses a zero IV, so our test
	// must use a zero IV for a round-trip match.
	key := []byte("0123456789abcdef") // 16-byte key
	iv := make([]byte, 16)            // zero IV (matches the decryption fallback)

	plaintext := []byte("Hello, Qwin! This is a test segment for decryption.")

	// Encrypt with AES-128 CTR
	block, err := aes.NewCipher(key)
	require.NoError(t, err)
	encrypted := make([]byte, len(plaintext))
	cs := cipher.NewCTR(block, iv)
	cs.XORKeyStream(encrypted, plaintext)

	keyB64 := base64.StdEncoding.EncodeToString(key)
	dataB64 := base64.StdEncoding.EncodeToString(encrypted)

	// Send decryptSegments command
	decryptCmd := map[string]any{
		"type": CmdDecryptSegments,
		"id":   "test-decrypt-1",
		"data": map[string]any{
			"jobId": "test-job-1",
			"keys": []map[string]string{
				{
					"keyIdB64": "AAAAAAAAAAAAAAAAAAAAAA==", // Dummy KID
					"keyB64":   keyB64,
					"type":     "CENC",
				},
			},
			"segments": []map[string]any{
				{
					"streamId": "video",
					"index":    0,
					"dataB64":  dataB64,
					"mimeType": "video/mp4",
					"isLast":   true,
				},
			},
		},
	}
	cmdData, _ := json.Marshal(decryptCmd)
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(cmdData)))
	stdin.Write(header)
	stdin.Write(cmdData)
	stdin.Close()

	outBuf := new(bytes.Buffer)
	_, _ = outBuf.ReadFrom(stdout)
	outData := outBuf.Bytes()

	require.GreaterOrEqual(t, len(outData), 4)

	payload, _ := readMessage(t, outData, 0)
	require.NotNil(t, payload)

	var response DecryptResponse
	err = json.Unmarshal(payload, &response)
	require.NoError(t, err)

	assert.Equal(t, ResDecryptResult, response.Type)
	assert.Equal(t, "test-decrypt-1", response.ID)
	assert.True(t, response.Ok, "decryption should succeed with valid key")
	assert.Equal(t, "test-job-1", response.JobID)
	assert.Equal(t, 1, response.Decrypted, "should decrypt 1 segment")
	require.Len(t, response.SegmentPaths, 1, "should return 1 file path")

	// Verify the decrypted content matches plaintext
	decryptedPath := response.SegmentPaths[0]
	decryptedData, err := os.ReadFile(decryptedPath)
	require.NoError(t, err, "decrypted file should exist")
	assert.Equal(t, plaintext, decryptedData, "decrypted data should match original plaintext")

	_ = cmd.Wait()
}

func Test_DecryptSegmentsCommand_MissingKeys_ReturnsError(t *testing.T) {
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

	decryptCmd := map[string]any{
		"type": CmdDecryptSegments,
		"id":   "test-decrypt-err",
		"data": map[string]any{
			"jobId":    "test-job",
			"keys":     []map[string]string{},
			"segments": []map[string]any{},
		},
	}
	cmdData, _ := json.Marshal(decryptCmd)
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(cmdData)))
	stdin.Write(header)
	stdin.Write(cmdData)
	stdin.Close()

	outBuf := new(bytes.Buffer)
	_, _ = outBuf.ReadFrom(stdout)
	outData := outBuf.Bytes()

	require.GreaterOrEqual(t, len(outData), 4)

	payload, _ := readMessage(t, outData, 0)
	require.NotNil(t, payload)

	var response DecryptResponse
	err = json.Unmarshal(payload, &response)
	require.NoError(t, err)

	assert.Equal(t, ResDecryptResult, response.Type)
	assert.Equal(t, "test-decrypt-err", response.ID)
	assert.False(t, response.Ok)
	assert.Contains(t, response.Error, "key")

	_ = cmd.Wait()
}

// ─── AssembleSegments Command Tests ─────────────────────────────────────────

func Test_AssembleSegmentsCommand_MissingPaths_ReturnsError(t *testing.T) {
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

	assembleCmd := map[string]any{
		"type": CmdAssembleSegments,
		"id":   "test-assemble-err",
		"data": map[string]any{
			"jobId":      "test-job",
			"filePaths":  []string{},
			"outputPath": "output.mp4",
		},
	}
	cmdData, _ := json.Marshal(assembleCmd)
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(cmdData)))
	stdin.Write(header)
	stdin.Write(cmdData)
	stdin.Close()

	outBuf := new(bytes.Buffer)
	_, _ = outBuf.ReadFrom(stdout)
	outData := outBuf.Bytes()

	require.GreaterOrEqual(t, len(outData), 4)

	payload, _ := readMessage(t, outData, 0)
	require.NotNil(t, payload)

	var response AssembleResponse
	err = json.Unmarshal(payload, &response)
	require.NoError(t, err)

	assert.Equal(t, ResAssembleResult, response.Type)
	assert.Equal(t, "test-assemble-err", response.ID)
	assert.False(t, response.Ok)
	assert.Contains(t, response.Error, "segment file path")

	_ = cmd.Wait()
}

// ─── Unit Tests for parseLicenseResponse ────────────────────────────────────

func TestParseLicenseResponse_WithValidProtobuf_ExtractsKeys(t *testing.T) {
	// Build a protobuf-encoded license response manually
	kid := make([]byte, 16)
	for i := range kid {
		kid[i] = byte(i)
	}
	keyData := make([]byte, 16)
	for i := range keyData {
		keyData[i] = byte(0xFF - i)
	}

	// Encode LicenseKey:
	//   id = kid (16 bytes), tag=1 (0x0a)
	//   type = 1 (SW_SECURE_CRYPTO), tag=2 (0x10)
	//   key = keyData (16 bytes), tag=3 (0x1a)
	var raw []byte
	raw = append(raw, 0x0a)            // field 1, wire 2
	raw = append(raw, 16)              // length
	raw = append(raw, kid...)          // KID
	raw = append(raw, 0x10)            // field 2, wire 0
	raw = appendVarint(raw, 1)         // type=1
	raw = append(raw, 0x1a)            // field 3, wire 2
	raw = append(raw, 16)              // length
	raw = append(raw, keyData...)      // encrypted key

	responseB64 := base64.StdEncoding.EncodeToString(raw)

	keys, err := parseLicenseResponse(responseB64)

	require.NoError(t, err, "should parse valid license response")
	require.Len(t, keys, 1, "should return exactly 1 key")

	assert.Equal(t, kid, keys[0].KeyID, "KID should match")
	assert.Equal(t, 1, keys[0].Type, "type should be SW_SECURE_CRYPTO")
	assert.Equal(t, keyData, keys[0].Key, "key data should match")
}

func TestParseLicenseResponse_WithMultipleKeys_ExtractsAll(t *testing.T) {
	// Build a response with 2 keys
	kid1 := bytes.Repeat([]byte{0x01}, 16)
	key1 := bytes.Repeat([]byte{0x10}, 16)
	kid2 := bytes.Repeat([]byte{0x02}, 16)
	key2 := bytes.Repeat([]byte{0x20}, 16)

	var raw []byte

	// Key 1
	raw = append(raw, 0x0a)
	raw = append(raw, 16)
	raw = append(raw, kid1...)
	raw = append(raw, 0x10)
	raw = appendVarint(raw, 1)
	raw = append(raw, 0x1a)
	raw = append(raw, 16)
	raw = append(raw, key1...)

	// Key 2
	raw = append(raw, 0x0a)
	raw = append(raw, 16)
	raw = append(raw, kid2...)
	raw = append(raw, 0x10)
	raw = appendVarint(raw, 1)
	raw = append(raw, 0x1a)
	raw = append(raw, 16)
	raw = append(raw, key2...)

	responseB64 := base64.StdEncoding.EncodeToString(raw)

	keys, err := parseLicenseResponse(responseB64)

	require.NoError(t, err)
	require.Len(t, keys, 2, "should extract 2 keys")

	assert.Equal(t, kid1, keys[0].KeyID)
	assert.Equal(t, key1, keys[0].Key)
	assert.Equal(t, kid2, keys[1].KeyID)
	assert.Equal(t, key2, keys[1].Key)
}

func TestParseLicenseResponse_InvalidBase64_ReturnsError(t *testing.T) {
	_, err := parseLicenseResponse("!!!not-valid-base64!!!")
	assert.Error(t, err, "invalid base64 should return error")
	assert.Contains(t, err.Error(), "decode")
}

func TestParseLicenseResponse_EmptyData_ReturnsNoKeys(t *testing.T) {
	emptyB64 := base64.StdEncoding.EncodeToString([]byte{})
	keys, err := parseLicenseResponse(emptyB64)

	assert.NoError(t, err, "empty data should not error")
	assert.Len(t, keys, 0, "empty data should yield no keys")
}

// TestParseLicenseResponse_WithHWKey reports the key as HW_SECURE (type=3)
func TestParseLicenseResponse_HardwareKey_ReturnsType3(t *testing.T) {
	kid := bytes.Repeat([]byte{0x03}, 16)
	keyData := bytes.Repeat([]byte{0x30}, 16)

	var raw []byte
	raw = append(raw, 0x0a)
	raw = append(raw, 16)
	raw = append(raw, kid...)
	raw = append(raw, 0x10)
	raw = appendVarint(raw, 3) // HW_SECURE
	raw = append(raw, 0x1a)
	raw = append(raw, 16)
	raw = append(raw, keyData...)

	responseB64 := base64.StdEncoding.EncodeToString(raw)

	keys, err := parseLicenseResponse(responseB64)
	require.NoError(t, err)
	require.Len(t, keys, 1)
	assert.Equal(t, 3, keys[0].Type, "HW_SECURE type should be 3")

	// Verify unwrapKeys detects HW_SECURE
	decryptedKeys, hasHW := unwrapKeys(keys, nil)
	assert.True(t, hasHW, "should detect HW_SECURE keys")
	assert.Len(t, decryptedKeys, 0, "should not return HW keys as decryptable")
}

// appendVarint appends a protobuf varint to the byte slice.
func appendVarint(buf []byte, v int) []byte {
	for v > 0x7f {
		buf = append(buf, byte(v&0x7f|0x80))
		v >>= 7
	}
	buf = append(buf, byte(v))
	return buf
}

// appendResponseVarintExists is already covered by appendVarint
// (no wrapper function needed — tests use appendVarint directly)

// ─── AES-128 CTR Unit Test ─────────────────────────────────────────────────

func TestDecryptAES128CTR_Roundtrip(t *testing.T) {
	key := []byte("0123456789abcdef")
	iv := []byte("1234567890abcdef")

	original := []byte("This is test data that should round-trip through AES-128 CTR mode.")

	// Encrypt (XOR with keystream is both encrypt and decrypt in CTR mode)
	block, err := aes.NewCipher(key)
	require.NoError(t, err)
	encrypted := make([]byte, len(original))
	stream := cipher.NewCTR(block, iv)
	stream.XORKeyStream(encrypted, original)

	// Decrypt
	decrypted, err := decryptAES128CTR(encrypted, key, iv)
	require.NoError(t, err)
	assert.Equal(t, original, decrypted, "decrypted data should match original")
}

func TestDecryptAES128CTR_WrongKey_Fails(t *testing.T) {
	key := []byte("0123456789abcdef")
	wrongKey := []byte("fedcba9876543210")
	iv := []byte("1234567890abcdef")

	plaintext := []byte("Test data with wrong key")

	block, err := aes.NewCipher(key)
	require.NoError(t, err)
	encrypted := make([]byte, len(plaintext))
	stream := cipher.NewCTR(block, iv)
	stream.XORKeyStream(encrypted, plaintext)

	decrypted, err := decryptAES128CTR(encrypted, wrongKey, iv)
	require.NoError(t, err)
	assert.NotEqual(t, plaintext, decrypted, "wrong key should produce garbage")
}

func TestDecryptAES128CTR_InvalidKeyLength(t *testing.T) {
	_, err := decryptAES128CTR([]byte("data"), []byte("short"), make([]byte, 16))
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "must be 16")
}

func TestDecryptAES128CTR_InvalidIVLength(t *testing.T) {
	_, err := decryptAES128CTR([]byte("data"), make([]byte, 16), []byte("short"))
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "IV")
}

// ─── MP4 Box Parser Unit Tests ─────────────────────────────────────────────

func TestParseMP4Boxes_SimpleBox(t *testing.T) {
	// Build a simple ftyp box
	ftypData := []byte("isom")
	boxSize := 8 + len(ftypData)
	var box []byte
	box = binary.BigEndian.AppendUint32(box, uint32(boxSize))
	box = append(box, []byte("ftyp")...)
	box = append(box, ftypData...)

	boxes := parseMP4Boxes(box)
	require.Len(t, boxes, 1)
	assert.Equal(t, "ftyp", boxes[0].Type)
	assert.Equal(t, uint32(boxSize), boxes[0].Size)
}

func TestParseMP4Boxes_ContainerWithChildren(t *testing.T) {
	// Build: moov container with trak container containing an mdat leaf box.
	// Container boxes (moov, trak, etc.) are recursed into and their children
	// are added to the flat list — container boxes themselves are NOT included.
	ftypBox := buildBoxData("ftyp", []byte("isom"))

	// Use a non-container leaf (mdat) inside trak inside moov
	mdatLeaf := buildBoxData("mdat", []byte("some media data"))
	trakBox := buildBoxData("trak", mdatLeaf)      // trak is a container
	moovBox := buildBoxData("moov", trakBox)         // moov is a container

	full := append(ftypBox, moovBox...)

	boxes := parseMP4Boxes(full)

	// Should find: ftyp (non-container) and mdat (leaf child of trak → moov)
	// Container boxes (moov, trak) are NOT in the flat list.
	foundTypes := make([]string, len(boxes))
	for i, b := range boxes {
		foundTypes[i] = b.Type
	}

	assert.Contains(t, foundTypes, "ftyp", "non-container boxes should be in the list")
	assert.Contains(t, foundTypes, "mdat", "leaf children of container boxes should be in the list")
	assert.NotContains(t, foundTypes, "moov", "container boxes should not appear in the flat list")
	assert.NotContains(t, foundTypes, "trak", "nested container boxes should not appear in the flat list")
}

// buildBoxData creates serialized MP4 box bytes.
func buildBoxData(boxType string, payload []byte) []byte {
	size := 8 + len(payload)
	var buf []byte
	buf = binary.BigEndian.AppendUint32(buf, uint32(size))
	buf = append(buf, []byte(boxType)...)
	buf = append(buf, payload...)
	return buf
}

// ─── Status Command After Failed CDM Init Test ────────────────────────────

func Test_StatusCommand_ReportsCDMNotAvailable(t *testing.T) {
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

	// Send status command (CDM not initialized)
	statusCmd := map[string]any{
		"type": "status",
		"id":   "test-status-cdm",
	}
	cmdData, _ := json.Marshal(statusCmd)
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(cmdData)))
	stdin.Write(header)
	stdin.Write(cmdData)
	stdin.Close()

	outBuf := new(bytes.Buffer)
	_, _ = outBuf.ReadFrom(stdout)
	outData := outBuf.Bytes()

	require.GreaterOrEqual(t, len(outData), 4)

	payload, _ := readMessage(t, outData, 0)
	require.NotNil(t, payload)

	var response StatusResponse
	err = json.Unmarshal(payload, &response)
	require.NoError(t, err)

	assert.Equal(t, ResStatus, response.Type)
	assert.Equal(t, "test-status-cdm", response.ID)
	assert.False(t, response.CDMAvailable, "CDM should not be available when not initialized")
	assert.Empty(t, response.CDMVersion, "CDM version should be empty")
	assert.True(t, response.CaptureReady, "capture should still be ready")

	_ = cmd.Wait()
}
