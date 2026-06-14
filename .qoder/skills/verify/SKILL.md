---
name: verify
description: Build and run the full test suite. Use after making changes to confirm everything still passes. Handles the "must rebuild before extension tests" requirement automatically.
---

Run the full verification pipeline for Qwin Video Downloader.

## Steps

1. **Build** the extension for all browser targets (chromium, firefox, yandex):

   ```powershell
   npm run build
   ```

2. **Run all tests** (native-host Python unittest, extension JS checks, and build validation):

   ```powershell
   npm test
   ```

3. If any test fails, read the failing test file and the source it tests to diagnose the issue. Fix the source code (not the test) unless the test itself is wrong.

4. Re-run `npm test` after fixes until the full suite passes.

## Notes

- The build step is required — extension tests load files from `dist/`, not `src/`.
- To run only native-host tests (no build needed): `npm run test:native`
- To run a single extension test: `node tests\extension\test_<name>.js` (after building)
- To run a single native-host test: `python -m unittest tests.native-host.test_<name>`
