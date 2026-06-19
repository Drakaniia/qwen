package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
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
