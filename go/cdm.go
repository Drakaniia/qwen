package main

import (
	"crypto/aes"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// ─── CDM Provider Interface ────────────────────────────────────────────────

// CDMProvider defines the interface for Widevine CDM operations.
// Implementations can back this with the actual widevinecdm.dll binary
// or use a software-based key extraction approach.
type CDMProvider interface {
	// Init initializes the CDM from the given path.
	// Returns the CDM version, whether it's L1-only, and any error.
	Init(cdmDir string) (version string, l1Only bool, err error)

	// ExtractKeys processes a license response and returns decryption keys.
	// sessionID: opaque session identifier from the license exchange.
	// responseB64: base64-encoded license response body.
	// challengeB64: optional base64-encoded license challenge (POST body).
	// initDataB64: optional base64-encoded PSSH init data.
	// Returns extracted keys.
	ExtractKeys(sessionID, responseB64, challengeB64, initDataB64 string) ([]DecryptionKey, bool, error)

	// IsAvailable returns true if the CDM is initialized and ready.
	IsAvailable() bool

	// Version returns the CDM version string.
	Version() string

	// IsL1Only returns true if this CDM only supports hardware-backed L1.
	IsL1Only() bool
}

// ─── CDM State ──────────────────────────────────────────────────────────────

// cdmState holds the global CDM provider state.
var (
	globalCDM   CDMProvider
	cdmMu       sync.RWMutex
	cdmInitOnce sync.Once
)

// ─── Widevine License Parsing ───────────────────────────────────────────────

// Widevine license responses use a custom protobuf format.
// The key material is embedded in the SignedLicense message.
//
// License response structure (simplified):
//
//	SignedLicense {
//	  provider_session_token: bytes    // Session token
//	  key: []LicenseKey {              // One or more content keys
//	    id: bytes                       // Key ID (KID), 16 bytes
//	    type: enum                      // SW_SECURE_CRYPTO=1, SW_SECURE_DECODE=2, HW_SECURE=3
//	    key: bytes                      // Encrypted key (16 bytes for AES-128)
//	    iv: bytes                       // Optional IV
//	    permissions: LicensePermissions
//	  }
//	}
//
// We parse this to extract KIDs and encrypted keys.
// The keys are wrapped (encrypted with the session key derived from the
// CDM's private key). For L3, the session key can be derived.

// LicenseKey represents a single decryption key from a license response.
type LicenseKey struct {
	KeyID []byte // KID (16 bytes)
	Type  int    // 1=SW_SECURE_CRYPTO, 2=SW_SECURE_DECODE, 3=HW_SECURE
	Key   []byte // Encrypted key (16 bytes for AES-128)
	IV    []byte // Optional IV
}

// parseLicenseResponse extracts license keys from a base64-encoded license response.
// This handles the common SignedLicense protobuf structure manually
// without requiring the full protobuf library or CDM binary.
//
// The response typically contains:
//   - A SignedLicense message wrapping LicenseKey entries
//   - Each LicenseKey has id (KID), type, and encrypted key bytes
//
// For L3, the keys can be unwrapped using the session key derived from
// the CDM's device private key. For L1, keys remain hardware-wrapped.
func parseLicenseResponse(responseB64 string) ([]LicenseKey, error) {
	raw, err := base64.StdEncoding.DecodeString(responseB64)
	if err != nil {
		// Try URL-safe base64
		raw, err = base64.URLEncoding.DecodeString(responseB64)
		if err != nil {
			return nil, fmt.Errorf("failed to decode license response base64: %w", err)
		}
	}

	// Parse the protobuf-like structure to extract LicenseKey entries.
	// The outer message is a SignedLicense containing repeated LicenseKey.
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
// It looks for the pattern: field_tag(1, bytes) + length + 16-byte KID followed by
// field_tag(2, varint) + type_value + field_tag(3, bytes) + length + 16-byte key.
//
// This is a simplified parser that handles the most common Widevine response format.
// A full protobuf decoder would be needed for edge cases.
func extractLicenseKeys(data []byte) []LicenseKey {
	var keys []LicenseKey

	// Scan through the data looking for LicenseKey patterns.
	// LicenseKey protobuf definition:
	//   message LicenseKey {
	//     optional bytes id = 1;       // KID, 16 bytes
	//     optional LicenseType type = 2; // enum
	//     optional bytes key = 3;       // 16 bytes
	//     optional bytes iv = 4;        // optional
	//   }
	//
	// Wire types: 0=varint, 1=64-bit, 2=length-delimited, 5=32-bit
	// Field 1 (bytes): tag=0x0a (00001010), wire=2
	// Field 2 (enum/varint): tag=0x10 (00010000), wire=0
	// Field 3 (bytes): tag=0x1a (00011010), wire=2
	// Field 4 (bytes): tag=0x22 (00100010), wire=2

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
// For L3, the keys are encrypted with a session key that can be derived.
// This uses AES-128 ECB decryption on each wrapped key with the session key.
//
// In a full implementation, the session key would be derived from the CDM's
// device private key using ECC (Elliptic Curve) key agreement. For the
// scaffold, we attempt direct decryption with an empty/known session key
// for testing purposes, and report L1-only if the keys are HW_SECURE type.
func unwrapKeys(keys []LicenseKey, sessionKey []byte) ([]DecryptionKey, bool) {
	result := make([]DecryptionKey, 0, len(keys))
	hasHardwareKeys := false

	for _, lk := range keys {
		if lk.Type == 3 { // HW_SECURE
			hasHardwareKeys = true
			continue
		}

		if len(lk.Key) != 16 {
			// Key not standard length — skip
			continue
		}

		dk := DecryptionKey{
			KeyIDB64: base64.StdEncoding.EncodeToString(lk.KeyID),
		}

		if len(sessionKey) == 16 {
			// Attempt to unwrap with session key (AES-128 ECB)
			block, err := aes.NewCipher(sessionKey)
			if err == nil {
				decrypted := make([]byte, 16)
				block.Decrypt(decrypted, lk.Key)
				dk.KeyB64 = base64.StdEncoding.EncodeToString(decrypted)
			} else {
				// Fall back to using the wrapped key directly
				dk.KeyB64 = base64.StdEncoding.EncodeToString(lk.Key)
			}
		} else {
			// No session key — pass through wrapped key
			dk.KeyB64 = base64.StdEncoding.EncodeToString(lk.Key)
		}

		dk.Type = "CENC"
		result = append(result, dk)
	}

	return result, hasHardwareKeys
}

// ─── Default CDM Provider ──────────────────────────────────────────────────

// defaultCDMProvider is the built-in CDM provider that parses license responses
// directly. It handles L3 key extraction when the keys are not hardware-wrapped.
// For L1 content, it reports l1Only=true so the pipeline falls through to recording.
type defaultCDMProvider struct {
	available bool
	version   string
	l1Only    bool
	cdmDir    string
}

func newDefaultCDMProvider() *defaultCDMProvider {
	return &defaultCDMProvider{}
}

func (p *defaultCDMProvider) Init(cdmDir string) (string, bool, error) {
	p.cdmDir = cdmDir

	// Check if the CDM directory has a widevinecdm.dll
	dllPath := filepath.Join(cdmDir, "widevinecdm.dll")
	if _, err := os.Stat(dllPath); err == nil {
		// CDM binary exists — attempt to load it and check L1/L3 status.
		// In a full implementation, we'd load the DLL and call into it.
		// For the scaffold, we detect it and report as L3-capable.
		version := detectCDMVersion(cdmDir)
		if version != "" {
			p.available = true
			p.version = version
			p.l1Only = false // Assume L3 until proven otherwise
			return version, false, nil
		}
	}

	// CDM not found — provider is not available
	p.available = false
	return "", false, fmt.Errorf("Widevine CDM not found at %s", cdmDir)
}

func (p *defaultCDMProvider) ExtractKeys(sessionID, responseB64, challengeB64, initDataB64 string) ([]DecryptionKey, bool, error) {
	if !p.available {
		return nil, false, fmt.Errorf("CDM not initialized")
	}

	// Parse the license response to extract wrapped keys
	licenseKeys, err := parseLicenseResponse(responseB64)
	if err != nil {
		return nil, false, fmt.Errorf("failed to parse license response: %w", err)
	}

	if len(licenseKeys) == 0 {
		return nil, false, fmt.Errorf("no license keys found in response")
	}

	// Derive session key from challenge/init data (scaffold: use empty)
	// In production, this would use the CDM's device private key.
	sessionKey := deriveSessionKey(challengeB64, initDataB64)

	// Unwrap keys using session key
	keys, hasHW := unwrapKeys(licenseKeys, sessionKey)

	if hasHW && len(keys) == 0 {
		// Only hardware keys found — L1-only
		return nil, true, fmt.Errorf("content uses hardware-backed Widevine L1 keys")
	}

	return keys, hasHW, nil
}

func (p *defaultCDMProvider) IsAvailable() bool {
	return p.available
}

func (p *defaultCDMProvider) Version() string {
	return p.version
}

func (p *defaultCDMProvider) IsL1Only() bool {
	return p.l1Only
}

// detectCDMVersion reads the CDM version from the manifest or DLL.
func detectCDMVersion(cdmDir string) string {
	// Try manifest.json first (Chrome-style CDM bundle)
	manifestPath := filepath.Join(cdmDir, "manifest.json")
	if data, err := os.ReadFile(manifestPath); err == nil {
		// Simple version extraction from JSON
		version := extractVersionFromManifest(string(data))
		if version != "" {
			return version
		}
	}

	// Try version.txt
	versionPath := filepath.Join(cdmDir, "version.txt")
	if data, err := os.ReadFile(versionPath); err == nil {
		v := string(data)
		if len(v) > 0 && len(v) < 100 {
			return v
		}
	}

	// Try reading the DLL to find the version string
	dllPath := filepath.Join(cdmDir, "widevinecdm.dll")
	if data, err := os.ReadFile(dllPath); err == nil {
		version := extractVersionFromDLL(data)
		if version != "" {
			return version
		}
	}

	return ""
}

// extractVersionFromManifest extracts the version from a CDM manifest.json.
func extractVersionFromManifest(json string) string {
	// Look for "version": "X.Y.Z.W" pattern
	const prefix = `"version":`
	idx := indexAfter(json, prefix)
	if idx < 0 {
		return ""
	}
	// Find the quoted value
	start := -1
	end := -1
	for i := idx; i < len(json); i++ {
		if json[i] == '"' {
			if start < 0 {
				start = i + 1
			} else {
				end = i
				break
			}
		}
	}
	if start >= 0 && end > start {
		return json[start:end]
	}
	return ""
}

// indexAfter finds the first occurrence of s in data and returns the index
// immediately after the match, or -1 if not found.
func indexAfter(data, s string) int {
	idx := indexOf(data, s)
	if idx < 0 {
		return -1
	}
	return idx + len(s)
}

// indexOf finds the first occurrence of s in data.
func indexOf(data, s string) int {
	if len(s) == 0 {
		return 0
	}
	for i := 0; i <= len(data)-len(s); i++ {
		if data[i:i+len(s)] == s {
			return i
		}
	}
	return -1
}

// extractVersionFromDLL scans the DLL binary for a version string pattern.
func extractVersionFromDLL(data []byte) string {
	// Look for patterns like "4.10.2710.0" in the binary
	// Version strings in Widevine CDM DLLs typically start at 4.x
	pattern := []byte("4.")
	for i := 0; i < len(data)-len(pattern); i++ {
		if data[i] == pattern[0] && data[i+1] == pattern[1] {
			// Check if this looks like a version string (digit.digit.digit.digit)
			end := i + 2
			for end < len(data) && (isDigit(data[end]) || data[end] == '.') {
				end++
			}
			if end-i >= 5 { // At least "4.x.y"
				parts := 0
				for j := i; j < end; j++ {
					if data[j] == '.' {
						parts++
					}
				}
				if parts >= 2 { // At least 3 parts: "4.10.2710"
					return string(data[i:end])
				}
			}
			break
		}
	}
	return ""
}

func isDigit(b byte) bool {
	return b >= '0' && b <= '9'
}

// deriveSessionKey derives the session key from the license challenge and init data.
//
// In a production implementation, this would:
//  1. Parse the server's ephemeral public key from the license response
//  2. Use ECDH with the device private key (from CDM) to derive a shared secret
//  3. HKDF-SHA256(shared_secret, salt, info) → 16-byte AES session key
//
// For the scaffold, we return nil, which means wrapped keys in the license
// response are passed through without unwrapping. This is sufficient for testing
// the pipeline structure. When a real CDM is initialized, the session key
// derivation would be handled by the CDM provider itself.
func deriveSessionKey(challengeB64, initDataB64 string) []byte {
	return nil
}

// ─── Global CDM Functions ───────────────────────────────────────────────────

// initCDM initializes the global CDM from the given CDM directory path.
// Can be called multiple times safely (subsequent calls update the CDM path).
func initCDM(cdmDir string) (string, bool, error) {
	cdmMu.Lock()
	defer cdmMu.Unlock()

	provider := newDefaultCDMProvider()
	version, l1Only, err := provider.Init(cdmDir)
	if err != nil {
		globalCDM = nil
		return "", false, err
	}

	globalCDM = provider
	return version, l1Only, nil
}

// getCDM returns the current CDM provider, or nil if not initialized.
func getCDM() CDMProvider {
	cdmMu.RLock()
	defer cdmMu.RUnlock()
	return globalCDM
}

// cdmAvailable returns true if a CDM provider is initialized.
func cdmAvailable() bool {
	cdm := getCDM()
	return cdm != nil && cdm.IsAvailable()
}

// cdmVersion returns the initialized CDM version.
func cdmVersion() string {
	cdm := getCDM()
	if cdm != nil {
		return cdm.Version()
	}
	return ""
}

// cdmL1Only returns true if the CDM only supports L1 (hardware).
func cdmL1Only() bool {
	cdm := getCDM()
	if cdm != nil {
		return cdm.IsL1Only()
	}
	return false
}

// extractKeysFromResponse processes a license response through the CDM
// and returns the extracted decryption keys.
func extractKeysFromResponse(sessionID, responseB64, challengeB64, initDataB64 string) ([]DecryptionKey, bool, error) {
	cdm := getCDM()
	if cdm == nil {
		// No CDM provider — try direct parsing without key unwrapping
		licenseKeys, err := parseLicenseResponse(responseB64)
		if err != nil {
			return nil, false, fmt.Errorf("CDM not initialized and license parsing failed: %w", err)
		}
		if len(licenseKeys) == 0 {
			return nil, false, fmt.Errorf("no license keys found (CDM not initialized)")
		}
		keys, hasHW := unwrapKeys(licenseKeys, nil)
		return keys, hasHW, nil
	}

	return cdm.ExtractKeys(sessionID, responseB64, challengeB64, initDataB64)
}
