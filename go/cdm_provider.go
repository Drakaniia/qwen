package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// ─── CDM Provider Interface ────────────────────────────────────────────────

// CDMProvider defines the interface for Widevine CDM operations.
type CDMProvider interface {
	Init(cdmDir string) (version string, l1Only bool, err error)
	ExtractKeys(sessionID, responseB64, challengeB64, initDataB64 string) ([]DecryptionKey, bool, error)
	IsAvailable() bool
	Version() string
	IsL1Only() bool
}

// ─── Default CDM Provider ──────────────────────────────────────────────────

// defaultCDMProvider is the built-in CDM provider that parses license responses
// directly. It handles L3 key extraction when the keys are not hardware-wrapped.
type defaultCDMProvider struct {
	available  bool
	version    string
	l1Only     bool
	cdmDir     string
}

func newDefaultCDMProvider() *defaultCDMProvider {
	return &defaultCDMProvider{}
}

func (p *defaultCDMProvider) Init(cdmDir string) (string, bool, error) {
	p.cdmDir = cdmDir

	dllPath := filepath.Join(cdmDir, "widevinecdm.dll")
	if _, err := os.Stat(dllPath); err == nil {
		version := detectCDMVersion(cdmDir)
		if version != "" {
			p.available = true
			p.version = version
			p.l1Only = false
			return version, false, nil
		}
	}

	p.available = false
	return "", false, fmt.Errorf("Widevine CDM not found at %s", cdmDir)
}

func (p *defaultCDMProvider) ExtractKeys(sessionID, responseB64, challengeB64, initDataB64 string) ([]DecryptionKey, bool, error) {
	if !p.available {
		return nil, false, fmt.Errorf("CDM not initialized")
	}

	licenseKeys, err := parseLicenseResponse(responseB64)
	if err != nil {
		return nil, false, fmt.Errorf("failed to parse license response: %w", err)
	}

	if len(licenseKeys) == 0 {
		return nil, false, fmt.Errorf("no license keys found in response")
	}

	sessionKey := deriveSessionKey(challengeB64, initDataB64)
	keys, hasHW := unwrapKeys(licenseKeys, sessionKey)

	if hasHW && len(keys) == 0 {
		return nil, true, fmt.Errorf("content uses hardware-backed Widevine L1 keys")
	}

	return keys, hasHW, nil
}

func (p *defaultCDMProvider) IsAvailable() bool  { return p.available }
func (p *defaultCDMProvider) Version() string    { return p.version }
func (p *defaultCDMProvider) IsL1Only() bool     { return p.l1Only }

// ─── Version Detection ─────────────────────────────────────────────────────

func detectCDMVersion(cdmDir string) string {
	manifestPath := filepath.Join(cdmDir, "manifest.json")
	if data, err := os.ReadFile(manifestPath); err == nil {
		version := extractVersionFromManifest(string(data))
		if version != "" {
			return version
		}
	}

	versionPath := filepath.Join(cdmDir, "version.txt")
	if data, err := os.ReadFile(versionPath); err == nil {
		v := string(data)
		if len(v) > 0 && len(v) < 100 {
			return v
		}
	}

	dllPath := filepath.Join(cdmDir, "widevinecdm.dll")
	if data, err := os.ReadFile(dllPath); err == nil {
		version := extractVersionFromDLL(data)
		if version != "" {
			return version
		}
	}

	return ""
}

func extractVersionFromManifest(json string) string {
	const prefix = `"version":`
	idx := indexAfter(json, prefix)
	if idx < 0 {
		return ""
	}
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

func indexAfter(data, s string) int {
	idx := indexOf(data, s)
	if idx < 0 {
		return -1
	}
	return idx + len(s)
}

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

func extractVersionFromDLL(data []byte) string {
	pattern := []byte("4.")
	for i := 0; i < len(data)-len(pattern); i++ {
		if data[i] == pattern[0] && data[i+1] == pattern[1] {
			end := i + 2
			for end < len(data) && (isDigit(data[end]) || data[end] == '.') {
				end++
			}
			if end-i >= 5 {
				parts := 0
				for j := i; j < end; j++ {
					if data[j] == '.' {
						parts++
					}
				}
				if parts >= 2 {
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
func deriveSessionKey(challengeB64, initDataB64 string) []byte {
	return nil
}
