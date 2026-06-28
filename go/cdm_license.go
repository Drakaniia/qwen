package main

import (
	"crypto/aes"
	"encoding/base64"
	"fmt"
)

// ─── Widevine License Parsing ───────────────────────────────────────────────

// LicenseKey represents a single decryption key from a license response.
type LicenseKey struct {
	KeyID []byte // KID (16 bytes)
	Type  int    // 1=SW_SECURE_CRYPTO, 2=SW_SECURE_DECODE, 3=HW_SECURE
	Key   []byte // Encrypted key (16 bytes for AES-128)
	IV    []byte // Optional IV
}

// parseLicenseResponse extracts license keys from a base64-encoded license response.
func parseLicenseResponse(responseB64 string) ([]LicenseKey, error) {
	raw, err := base64.StdEncoding.DecodeString(responseB64)
	if err != nil {
		// Try URL-safe base64
		raw, err = base64.URLEncoding.DecodeString(responseB64)
		if err != nil {
			return nil, fmt.Errorf("failed to decode license response base64: %w", err)
		}
	}

	keys := extractLicenseKeys(raw)
	if len(keys) == 0 {
		// Try parsing from different offsets (some responses have wrapper headers)
		for offset := 1; offset < len(raw)-32 && offset < 64; offset++ {
			keys = extractLicenseKeys(raw[offset:])
			if len(keys) > 0 {
				break
			}
		}
	}

	return keys, nil
}

// extractLicenseKeys does a heuristic parse of protobuf-encoded LicenseKey messages.
func extractLicenseKeys(data []byte) []LicenseKey {
	var keys []LicenseKey

	i := 0
	for i < len(data)-32 {
		// Look for field 1 (id/KID): tag 0x0a
		if data[i] != 0x0a {
			i++
			continue
		}
		i++

		// Read KID length (varint)
		kidLen, n := readVarint(data[i:])
		if n == 0 || kidLen != 16 || i+n+16 > len(data) {
			i++
			continue
		}
		i += n
		kid := data[i : i+16]
		i += kidLen

		// Next should be field 2 (type): tag 0x10
		if i >= len(data) || data[i] != 0x10 {
			continue
		}
		i++

		// Read type (varint)
		typeVal, n := readVarint(data[i:])
		if n == 0 {
			continue
		}
		i += n

		// Next should be field 3 (key): tag 0x1a
		if i >= len(data) || data[i] != 0x1a {
			continue
		}
		i++

		// Read key length (varint)
		keyLen, n := readVarint(data[i:])
		if n == 0 || i+n+keyLen > len(data) {
			continue
		}
		i += n
		keyData := data[i : i+keyLen]
		i += keyLen

		lk := LicenseKey{
			KeyID: cloneBytes(kid),
			Type:  typeVal,
			Key:   cloneBytes(keyData),
		}

		// Optional field 4 (iv): tag 0x22
		if i+1 < len(data) && data[i] == 0x22 {
			i++
			ivLen, n := readVarint(data[i:])
			if n > 0 && i+n+ivLen <= len(data) {
				i += n
				lk.IV = cloneBytes(data[i : i+ivLen])
				i += ivLen
			}
		}

		keys = append(keys, lk)
	}

	return keys
}

// readVarint decodes a protobuf varint from data.
// Returns (value, bytesConsumed). Returns (0, 0) on failure.
func readVarint(data []byte) (int, int) {
	var result int
	var shift uint
	for i, b := range data {
		if i > 9 {
			return 0, 0 // varint too long
		}
		result |= int(b&0x7f) << shift
		if b&0x80 == 0 {
			return result, i + 1
		}
		shift += 7
	}
	return 0, 0
}

// cloneBytes returns a copy of the byte slice.
func cloneBytes(b []byte) []byte {
	c := make([]byte, len(b))
	copy(c, b)
	return c
}

// ─── Key Unwrapping ─────────────────────────────────────────────────────────

// unwrapKeys attempts to decrypt wrapped keys from a license response.
func unwrapKeys(keys []LicenseKey, sessionKey []byte) ([]DecryptionKey, bool) {
	result := make([]DecryptionKey, 0, len(keys))
	hasHardwareKeys := false

	for _, lk := range keys {
		if lk.Type == 3 { // HW_SECURE
			hasHardwareKeys = true
			continue
		}

		if len(lk.Key) != 16 {
			continue
		}

		dk := DecryptionKey{
			KeyIDB64: base64.StdEncoding.EncodeToString(lk.KeyID),
		}

		if len(sessionKey) == 16 {
			block, err := aes.NewCipher(sessionKey)
			if err == nil {
				decrypted := make([]byte, 16)
				block.Decrypt(decrypted, lk.Key)
				dk.KeyB64 = base64.StdEncoding.EncodeToString(decrypted)
			} else {
				dk.KeyB64 = base64.StdEncoding.EncodeToString(lk.Key)
			}
		} else {
			dk.KeyB64 = base64.StdEncoding.EncodeToString(lk.Key)
		}

		dk.Type = "CENC"
		result = append(result, dk)
	}

	return result, hasHardwareKeys
}
