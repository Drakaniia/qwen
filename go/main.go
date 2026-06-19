package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
)

// stopRequested is set by the "stop" command handler to signal a graceful exit.
var stopRequested bool

func main() {
	// Handle --version flag
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Printf("qwin-capture %s %s/%s\n", VERSION, runtime.GOOS, runtime.GOARCH)
		os.Exit(0)
	}

	// Read JSON messages from stdin using native messaging framing
	// (4-byte little-endian length prefix + UTF-8 JSON payload).
	stdin := bufio.NewReader(os.Stdin)

	for {
		// Read 4-byte length prefix
		header := make([]byte, 4)
		if _, err := io.ReadFull(stdin, header); err != nil {
			if err == io.EOF {
				os.Exit(0)
			}
			writeError("read", fmt.Sprintf("failed to read length prefix: %v", err))
			os.Exit(1)
		}

		length := binary.LittleEndian.Uint32(header)
		if length > 64*1024*1024 { // 64 MB max
			writeError("read", "message too large")
			continue
		}

		// Read the JSON payload
		payload := make([]byte, length)
		if _, err := io.ReadFull(stdin, payload); err != nil {
			writeError("read", fmt.Sprintf("failed to read message payload: %v", err))
			continue
		}

		// Parse the command
		var cmd Command
		if err := json.Unmarshal(payload, &cmd); err != nil {
			writeError("parse", fmt.Sprintf("invalid JSON: %v", err))
			continue
		}

		// Dispatch and write response
		response := handleCommand(cmd)
		if response != nil {
			writeMessage(response)
		}

		if stopRequested {
			os.Exit(0)
		}
	}
}

// writeMessage writes a JSON message to stdout with native messaging framing.
func writeMessage(data []byte) {
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(data)))

	out := os.Stdout
	_, _ = out.Write(header)
	_, _ = out.Write(data)
}

// writeError writes an error message to stderr.
func writeError(context, msg string) {
	_, _ = fmt.Fprintf(os.Stderr, "[qwin-capture] %s error: %s\n", context, msg)
}
