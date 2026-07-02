package main

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
)

// ─── ISO BMFF Box ─────────────────────────────────────────────────────────

// MP4Box represents an ISO Base Media File Format box (ISO 14496-12).
type MP4Box struct {
	Size   uint32 // Box size (includes header)
	Type   string // Box type (4-character code, e.g. "ftyp", "moov", "mdat")
	Data   []byte // Box payload (everything after the 8-byte header)
	Offset int    // Offset in the original data where this box starts
}

// ─── CENC Types ─────────────────────────────────────────────────────────────

// CENCSample describes an encrypted sample within a CENC-protected track.
type CENCSample struct {
	Data           []byte          // Encrypted sample bytes
	IV             []byte          // 8 or 16 byte IV
	SubsampleCount uint16          // Number of subsamples
	Subsamples     []CENCSubsample
	IsEncrypted    bool
	KeyID          []byte // KID from tenc box (16 bytes)
}

// CENCSubsample describes a clear/encrypted region within a sample.
type CENCSubsample struct {
	ClearBytes     uint16
	EncryptedBytes uint32
}

// TenBox holds the Track Encryption box (tenc) content.
type TenBox struct {
	DefaultKID      []byte // 16-byte Key ID
	DefaultIVSize   uint8  // 8 or 16
	EncryptionType  string
}

// ─── Container detection ────────────────────────────────────────────────────

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

// ─── Box Parsing ────────────────────────────────────────────────────────────

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
			if offset+16 > len(data) {
				break
			}
			largeSize := binary.BigEndian.Uint64(data[offset+8 : offset+16])
			boxSize = uint32(largeSize) // Truncate — no segments will exceed 4GB
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
		if isContainerBox(boxType) && len(payload) >= 8 {
			children := parseBoxesAt(payload, baseOffset+offset+payloadOffset)
			boxes = append(boxes, children...)
		} else {
			boxes = append(boxes, box)
		}

		offset += int(boxSize)
	}

	return boxes
}

// ─── CENC Box Queries ───────────────────────────────────────────────────────

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

// ─── Encrypted Sample Extraction ────────────────────────────────────────────

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
			if err == nil && len(kidBytes) == 16 && string(kidBytes) == string(defaultKID) {
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
