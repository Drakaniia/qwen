package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"os"
	"os/exec"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

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

// ─── AES-128 CTR Unit Tests ─────────────────────────────────────────────────

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
	// are added to the flat list -- container boxes themselves are NOT included.
	ftypBox := buildBoxData("ftyp", []byte("isom"))

	// Use a non-container leaf (mdat) inside trak inside moov
	mdatLeaf := buildBoxData("mdat", []byte("some media data"))
	trakBox := buildBoxData("trak", mdatLeaf)  // trak is a container
	moovBox := buildBoxData("moov", trakBox)   // moov is a container

	full := append(ftypBox, moovBox...)

	boxes := parseMP4Boxes(full)

	// Should find: ftyp (non-container) and mdat (leaf child of trak -> moov)
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
