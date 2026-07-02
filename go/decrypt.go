package main

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
)

// ─── AES-128 CTR Decryption ────────────────────────────────────────────────

// decryptAES128CTR decrypts data using AES-128 in CTR mode with the given key and IV.
// key must be 16 bytes (AES-128).
// iv must be 16 bytes (CTR nonce + counter).
func decryptAES128CTR(data, key, iv []byte) ([]byte, error) {
	if len(key) != 16 {
		return nil, fmt.Errorf("AES-128 key must be 16 bytes, got %d", len(key))
	}
	if len(iv) != 16 {
		return nil, fmt.Errorf("CTR IV must be 16 bytes, got %d", len(iv))
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("failed to create AES cipher: %w", err)
	}

	decrypted := make([]byte, len(data))
	stream := cipher.NewCTR(block, iv)
	stream.XORKeyStream(decrypted, data)

	return decrypted, nil
}

// ─── Decrypt Pipeline ───────────────────────────────────────────────────────

// decryptSegment decrypts a single encrypted segment with the given keys.
// Returns the decrypted segment bytes.
func decryptSegment(segmentData []byte, keys []DecryptionKey) ([]byte, error) {
	// Build key lookup map: KID_base64 → key_base64
	keyMap := make(map[string]string)
	for _, k := range keys {
		if k.KeyIDB64 != "" && k.KeyB64 != "" {
			keyMap[k.KeyIDB64] = k.KeyB64
		}
	}

	// Parse MP4 boxes to find encrypted content
	boxes := parseMP4Boxes(segmentData)

	// Find moof and mdat boxes
	var moofBox, mdatBox *MP4Box
	for i, box := range boxes {
		switch box.Type {
		case "moof":
			moofBox = &boxes[i]
		case "mdat":
			mdatBox = &boxes[i]
		}
	}

	if moofBox != nil && mdatBox != nil {
		// Fragmented MP4 (fMP4)
		decryptedSamples, err := extractEncryptedSamples(moofBox.Data, mdatBox.Data, keyMap)
		if err != nil {
			return nil, fmt.Errorf("fMP4 decrypt failed: %w", err)
		}

		// Reconstruct: keep everything up to mdat, replace mdat with decrypted data
		if len(decryptedSamples) > 0 {
			result := make([]byte, 0, len(segmentData))
			// Keep everything before mdat
			result = append(result, segmentData[:mdatBox.Offset]...)

			// Write replacement mdat header
			decryptedLen := 0
			for _, s := range decryptedSamples {
				decryptedLen += len(s)
			}

			// Write new mdat box header
			mdatSize := 8 + decryptedLen // 8 byte header + data
			var mdatHeader [8]byte
			binary.BigEndian.PutUint32(mdatHeader[:4], uint32(mdatSize))
			copy(mdatHeader[4:8], []byte("mdat"))
			result = append(result, mdatHeader[:8]...)

			// Write decrypted sample data
			for _, s := range decryptedSamples {
				result = append(result, s...)
			}

			// Append everything after mdat
			mdatEnd := mdatBox.Offset + int(mdatBox.Size)
			if mdatEnd < len(segmentData) {
				result = append(result, segmentData[mdatEnd:]...)
			}

			return result, nil
		}
	}

	// Try decrypting the entire segment as raw encrypted data
	// (For simple test vectors or segments without fMP4 structure)
	if len(keys) > 0 && keys[0].KeyB64 != "" {
		keyBytes, err := base64.StdEncoding.DecodeString(keys[0].KeyB64)
		if err != nil {
			return nil, fmt.Errorf("failed to decode key: %w", err)
		}
		if len(keyBytes) != 16 {
			return nil, fmt.Errorf("key must be 16 bytes, got %d", len(keyBytes))
		}

		iv := make([]byte, 16)
		return decryptAES128CTR(segmentData, keyBytes, iv)
	}

	return nil, fmt.Errorf("no decryption key available for segment")
}

// decryptSegmentFromBase64 decodes a base64-encoded segment and decrypts it.
func decryptSegmentFromBase64(segmentB64 string, keys []DecryptionKey) ([]byte, error) {
	data, err := base64.StdEncoding.DecodeString(segmentB64)
	if err != nil {
		// Try URL-safe base64
		data, err = base64.URLEncoding.DecodeString(segmentB64)
		if err != nil {
			return nil, fmt.Errorf("failed to decode segment data: %w", err)
		}
	}
	return decryptSegment(data, keys)
}

// decryptAllSegments decrypts multiple segments and saves them to an output directory.
// Returns the paths of the decrypted segment files.
func decryptAllSegments(segments []EncryptedSegment, keys []DecryptionKey, outputDir string) ([]string, error) {
	if outputDir == "" {
		outputDir = os.TempDir()
	}
	outputDir = filepath.Join(outputDir, "qwin-decrypted")
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create output directory: %w", err)
	}

	var paths []string
	for _, seg := range segments {
		decrypted, err := decryptSegmentFromBase64(seg.DataB64, keys)
		if err != nil {
			return paths, fmt.Errorf("failed to decrypt segment %d (%s): %w", seg.Index, seg.StreamID, err)
		}

		filename := fmt.Sprintf("%s_%06d.decrypted", seg.StreamID, seg.Index)
		filePath := filepath.Join(outputDir, filename)
		if err := os.WriteFile(filePath, decrypted, 0644); err != nil {
			return paths, fmt.Errorf("failed to write decrypted segment %d: %w", seg.Index, err)
		}
		paths = append(paths, filePath)
	}

	return paths, nil
}

// assembleDecryptedSegments takes decrypted segment files and combines them
// into a single output file (MP4), preserving the init segment (moov) first.
func assembleDecryptedSegments(segmentPaths []string, outputPath string) error {
	outFile, err := os.Create(outputPath)
	if err != nil {
		return fmt.Errorf("failed to create output file: %w", err)
	}
	defer outFile.Close()

	for _, path := range segmentPaths {
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("failed to read segment %s: %w", path, err)
		}
		if _, err := outFile.Write(data); err != nil {
			return fmt.Errorf("failed to write segment %s: %w", path, err)
		}
	}

	return nil
}
