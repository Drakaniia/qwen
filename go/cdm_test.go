package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"os/exec"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

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
	responseData = append(responseData, 0x10)                          // field 2, wire 0 (varint)
	responseData = appendVarint(responseData, 1)                       // type = SW_SECURE_CRYPTO
	responseData = append(responseData, 0x1a)                          // field 3, wire 2 (bytes)
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
			"sessionId":   "test-session",
			"responseB64": "",
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
			"sessionId":   "test-session",
			"responseB64": "!!!not-valid-base64!!!",
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
