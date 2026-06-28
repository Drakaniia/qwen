package main

import (
	"fmt"
	"sync"
)

// ─── CDM State ──────────────────────────────────────────────────────────────

var (
	globalCDM   CDMProvider
	cdmMu       sync.RWMutex
	cdmInitOnce sync.Once
)

// ─── Global CDM Functions ───────────────────────────────────────────────────

// initCDM initializes the global CDM from the given CDM directory path.
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
