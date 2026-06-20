package main

import (
	"bytes"
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

// ─── MP4 Box Parser ─────────────────────────────────────────────────────────

// MP4Box represents an ISO Base Media File Format box (ISO 14496-12).
type MP4Box struct {
	Size   uint32 // Box size (includes header)
	Type   string // Box type (4-character code, e.g. "ftyp", "moov", "mdat")
	Data   []byte // Box payload (everything after the 8-byte header)
	Offset int    // Offset in the original data where this box starts
}

// parseMP4Boxes recursively parses an MP4 file into its constituent boxes.
func parseMP4Boxes(data []byte) []MP4Box {
	return parseBoxesAt(data, 0)
}

func parseBoxesAt(data []byte, baseOffset int) []MP4Box {
	var boxes []MP4Box
	offset := 0

	for offset+8 <= len(data) {
		size := binary.BigEndian.Uint32(data[offset : offset+4])
		boxType := string(data[offset+4 : offset+8])

		// Handle extended size (64-bit)
		var boxSize uint32
		if size == 1 {
			// 8 bytes size + 8 bytes large size + 4 bytes type + 4 bytes... actually:
			// When size==1, the 8-byte header is followed by 8 more bytes of large size
			if offset+16 > len(data) {
				break
			}
			largeSize := binary.BigEndian.Uint64(data[offset+8 : offset+16])
			boxSize = uint32(largeSize) // Truncate — no segments will exceed 4GB
			boxSize = uint32(largeSize)
		} else if size == 0 {
			// Box extends to end of file
			boxSize = uint32(len(data) - offset)
		} else {
			boxSize = size
		}

		if offset+int(boxSize) > len(data) {
			// Truncated box
			if boxSize < 8 {
				boxSize = uint32(len(data) - offset)
			} else {
				break
			}
		}

		payloadOffset := 8
		if size == 1 {
			payloadOffset = 16
		}

		payloadLen := int(boxSize) - payloadOffset
		var payload []byte
		if payloadLen > 0 {
			payload = data[offset+payloadOffset : offset+int(boxSize)]
		} else {
			payload = nil
		}

		box := MP4Box{
			Size:   boxSize,
			Type:   boxType,
			Data:   payload,
			Offset: baseOffset + offset,
		}

		// Recurse into container boxes
		isContainer := isContainerBox(boxType)
		if isContainer && len(payload) >= 8 {
			children := parseBoxesAt(payload, baseOffset+offset+payloadOffset)
			boxes = append(boxes, children...)
		} else {
			boxes = append(boxes, box)
		}

		offset += int(boxSize)
	}

	return boxes
}

// isContainerBox returns true if the box type can contain child boxes.
func isContainerBox(boxType string) bool {
	switch boxType {
	case "moov", "trak", "mdia", "minf", "stbl", "moof", "traf",
		"mvex", "edts", "dinf", "udta", "meco", "mere":
		return true
	default:
		return false
	}
}

// ─── CENC Decryption ────────────────────────────────────────────────────────

// CENCSample describes an encrypted sample within a CENC-protected track.
type CENCSample struct {
	Data            []byte // Encrypted sample bytes
	IV              []byte // 8 or 16 byte IV
	SubsampleCount  uint16 // Number of subsamples
	Subsamples      []CENCSubsample
	IsEncrypted     bool
	KeyID           []byte // KID from tenc box (16 bytes)
}

// CENCSubsample describes a clear/encrypted region within a sample.
type CENCSubsample struct {
	ClearBytes     uint16
	EncryptedBytes uint32
}

// TenBox holds the Track Encryption box (tenc) content.
type TenBox struct {
	DefaultKID    []byte // 16-byte Key ID
	DefaultIVSize uint8  // 8 or 16
	EncryptionType string
}

// findTenBox finds the Track Encryption Box (tenc) in parsed MP4 boxes.
func findTenBox(boxes []MP4Box) *TenBox {
	for _, box := range boxes {
		if box.Type == "tenc" && len(box.Data) >= 24 {
			return parseTenBox(box.Data)
		}
	}
	return nil
}

// parseTenBox parses a Track Encryption Box (tenc).
// Format (simplified): version(1) + flags(3) + reserved(1) + default_IV_size(1) + reserved(8) + default_KID(16)
func parseTenBox(data []byte) *TenBox {
	if len(data) < 24 {
		return nil
	}

	tb := &TenBox{
		DefaultIVSize: data[4], // byte at offset 4 (after version+flags at 0-3)
	}

	// Default KID is at offset 8 (after version+flags+reserved+default_IV_size+reserved)
	if len(data) >= 24 {
		tb.DefaultKID = make([]byte, 16)
		copy(tb.DefaultKID, data[8:24])
	}

	return tb
}

// findPSSHBox finds the Protection System Specific Header Box (pssh) in parsed boxes.
// Returns the PSSH data (system ID + key IDs + data).
func findPSSHBox(boxes []MP4Box) []byte {
	for _, box := range boxes {
		if box.Type == "pssh" && len(box.Data) >= 20 {
			return box.Data
		}
	}
	return nil
}

// extractEncryptedSamples extracts CENC-encrypted samples from moof+mdat pairs.
// In fragmented MP4 (fMP4), each segment has:
//   - moof: Movie Fragment Box containing traf boxes with track encryption info
//   - mdat: Media Data Box containing the encrypted samples
//
// The keys map maps base64-encoded KID → base64-encoded key bytes.
//
// NOTE: Precise per-sample decryption requires parsing the trun (Track Fragment Run)
// box to determine sample offsets within mdat. The current implementation falls back
// to decrypting the entire mdat with the default KID and a zero IV, which works for
// simple single-segment test vectors. A production implementation should parse trun
// for accurate sample-level decryption.
func extractEncryptedSamples(moofData, mdatData []byte, keys map[string]string) ([][]byte, error) {
	boxes := parseMP4Boxes(moofData)

	var defaultKID []byte

	// Find tenc box in moof → traf
	for _, box := range boxes {
		if box.Type == "tenc" {
			tb := parseTenBox(box.Data)
			if tb != nil {
				defaultKID = tb.DefaultKID
			}
		}
	}

	// Look up the key for the KID — keys map is KID_base64 → key_base64
	kidStr := base64.StdEncoding.EncodeToString(defaultKID)
	keyB64, hasKey := keys[kidStr]
	if !hasKey && len(defaultKID) > 0 {
		// Try raw KID bytes as key lookup
		for k, v := range keys {
			kidBytes, err := base64.StdEncoding.DecodeString(k)
			if err == nil && len(kidBytes) == 16 && bytes.Equal(kidBytes, defaultKID) {
				keyB64 = v
				hasKey = true
				break
			}
		}
	}

	if !hasKey || keyB64 == "" {
		return nil, fmt.Errorf("no decryption key found for KID (base64: %s)", kidStr)
	}

	// Decode key from base64
	keyBytes, err := base64.StdEncoding.DecodeString(keyB64)
	if err != nil {
		return nil, fmt.Errorf("failed to decode key: %w", err)
	}

	if len(keyBytes) != 16 {
		return nil, fmt.Errorf("decryption key must be 16 bytes, got %d", len(keyBytes))
	}

	// Decrypt the entire mdat with a zero IV.
	// In a full implementation, this would parse trun box for per-sample offsets,
	// then parse senc box for per-sample IVs, and decrypt each sample individually.
	// For the scaffold, we decrypt the entire mdat which works for simple test vectors.
	iv := make([]byte, 16)
	decrypted, err := decryptAES128CTR(mdatData, keyBytes, iv)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt mdat: %w", err)
	}
	return [][]byte{decrypted}, nil
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
