"""Shared path setup for native_host tests.

Adds src/native_host/ and all its subdirectories to sys.path so that
flat imports work after the Phase 3 structural refactoring moved files
into subdirectories.

Import this at the top of any test file that imports from native_host:
    from path_setup import *
"""

import sys
from pathlib import Path

# Resolve native_host directory
ROOT_DIR = Path(__file__).resolve().parents[2]
NATIVE_HOST_DIR = ROOT_DIR / "src" / "native_host"

# Add native_host to sys.path
native_host_str = str(NATIVE_HOST_DIR)
if native_host_str not in sys.path:
    sys.path.insert(0, native_host_str)

# Add all subdirectories (including nested) to sys.path so flat imports still work
for _root, _dirs, _files in NATIVE_HOST_DIR.walk():
    if _root.name == "__pycache__" or _root.name.startswith("_"):
        continue
    _path = str(_root)
    if _path not in sys.path:
        sys.path.insert(0, _path)
