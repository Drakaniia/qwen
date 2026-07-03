import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const __dirname = import.meta.dirname;

// Read the format_list module to check if it uses parallel probes
const formatListSource = fs.readFileSync(path.join(__dirname, "../../../src/native_host/backends/format_list.py"), "utf8");

// Read the download manager to understand the parallel probe implementation
const downloadManagerSource = fs.readFileSync(path.join(__dirname, "../../../src/native_host/download/download_manager.py"), "utf8");

// RED: Test that format_list uses parallel probes
// Currently, format_list goes directly to yt-dlp without parallel probes
// This test should fail because the feature doesn't exist yet

assert.match(
  downloadManagerSource,
  /def _build_probe_configs/,
  "download_manager must have probe config builder for parallel probes"
);

assert.match(
  downloadManagerSource,
  /run_parallel_probes/,
  "download_manager must have parallel probe runner"
);

// The test below should fail because format_list doesn't use parallel probes yet
// After implementation, this should pass
const formatListUsesParallelProbes = formatListSource.includes("run_parallel_probes") &&
  formatListSource.includes("_build_probe_configs_for_formats");

assert.ok(
  formatListUsesParallelProbes,
  "format_list should use parallel probes to detect compatible backends before format enumeration"
);

console.log("test_parallel_probe_in_format_enumeration passed");
