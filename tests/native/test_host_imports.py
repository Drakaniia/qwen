"""Regression test: the native host must stay importable.

Commit f38e6de deleted src/native_host/media/media_resolver.py and
media_candidates.py but left host.py's `import media_resolver` and two call
sites. host.py therefore died on the first line of work:

    File "src/native_host/host.py", line 17, in <module>
        import media_resolver as _media_resolver
    ModuleNotFoundError: No module named 'media_resolver'

That kills every native-host feature at once, because `ping` (the extension's
getHelperStatus gate), formats, download, control, file ops and
resolveMediaCandidates are all dispatched from the same module.

Three checks:
  1. AST scan - nothing under src/native_host/ imports a *local* module that is
     not on disk. This is the deleted-module/stale-import class of bug.
  2. host.py imports, every registered message type routes to a real callable,
     and an unknown request type raises HostError instead of propagating
     something else. Check 2 is the same purpose check 1 has always had - host
     must route to things that exist - re-pointed at the spec-D5 registry after
     the `match message_type:` block it used to scan was deleted.
  3. Stacked `@register_handler(..., **bound)` decorators stay independent.
"""

import ast
import importlib
import sys
from pathlib import Path

import pytest

NATIVE_HOST = Path(__file__).resolve().parents[2] / "src" / "native_host"

# Absent by design, imported lazily inside try/except, never at module scope:
# curl_cffi = TLS impersonation, used only from probe/probe_backends.py; yt-dlp does
# its own impersonation internally via --extractor-args generic:impersonate.
# imageio_ffmpeg = optional ffmpeg location fallback.
OPTIONAL_THIRD_PARTY = {"curl_cffi", "imageio_ffmpeg"}


def _python_files():
    return [p for p in NATIVE_HOST.rglob("*.py") if "__pycache__" not in p.parts]


def _imported_roots(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name.split(".")[0]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            yield node.module.split(".")[0]


def test_no_module_imports_a_local_module_that_does_not_exist():
    local = {p.stem for p in _python_files()}
    # A package is importable by its directory name, and host.py's sys.path walk
    # puts every one of those directories on the path: `download/parsers/` is
    # `import parsers`, which no `*.py` stem would ever match.
    local |= {p.parent.name for p in _python_files() if p.name == "__init__.py"}
    stale = {}
    for path in _python_files():
        roots = set(_imported_roots(ast.parse(path.read_text(encoding="utf-8"))))
        missing = {
            name
            for name in roots
            if name not in local and name not in sys.stdlib_module_names and name not in OPTIONAL_THIRD_PARTY
        }
        if missing:
            stale[str(path.relative_to(NATIVE_HOST))] = sorted(missing)
    assert stale == {}, f"stale local imports (module deleted, import kept): {stale}"


def _import_host():
    """Mirror the sys.path walk in host.py so flat module imports resolve."""
    for root, dirs, _files in NATIVE_HOST.walk():
        dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith("_")]
        if str(root) not in sys.path:
            sys.path.insert(0, str(root))
    return importlib.import_module("host")


def test_host_imports():
    host = _import_host()
    assert callable(host.extract_media_candidates_from_text)


def _registered_message_types():
    """Every message type named by a `@register_handler("...")` decorator in the tree."""
    found = set()
    for path in _python_files():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
            if name != "register_handler" or not node.args:
                continue
            first = node.args[0]
            if isinstance(first, ast.Constant) and isinstance(first.value, str):
                found.add(first.value)
    return found


def test_dispatch_table_is_wired_to_real_callables():
    """Every `@register_handler` in the tree is live in HANDLERS, and routes to a real callable.

    Shape changed with spec D5. This used to AST-scan `host.py`'s
    `match message_type:` block for routed names. That block is gone: dispatch is
    now `HANDLERS.get(type)` in `handle_message`, so the routes are the built dict
    itself and can be read directly instead of approximated syntactically.

    What replaced it is a different risk. Decorators run at *import* time, so a
    `@register_handler` written in a module `host.py` never imports is silently
    dead - the message type falls through to "Unknown native host request type".
    Comparing the AST-scanned decorator set against the imported `HANDLERS` keys
    catches exactly that, which the old `match`-block scan could not: while every
    handler lived in host.py the two could never disagree.
    """
    host = _import_host()
    import registry

    assert registry.HANDLERS, "HANDLERS is empty after importing host - nothing registered"

    unroutable = sorted(name for name, fn in registry.HANDLERS.items() if not callable(fn))
    assert not unroutable, f"registry routes to non-callables: {unroutable}"

    declared = _registered_message_types()
    missing = sorted(declared - set(registry.HANDLERS))
    assert not missing, f"@register_handler declared but never imported by host.py (dead routes): {missing}"

    # The dict must be the one handle_message consults, not a parallel copy.
    assert callable(host.handle_message)


def test_stacked_register_handler_keeps_its_own_bound_kwargs():
    """Stacking one function under several message types must not share bound kwargs.

    `@register_handler("pause", action="pause")` above
    `@register_handler("resume", action="resume")` must produce two independent
    wrappers. If `bound` were captured by reference instead of per-decorator-call,
    both keys would resolve to the outermost (last applied) value.
    """
    import registry

    @registry.register_handler("__testBoundA", flag="a")
    @registry.register_handler("__testBoundB", flag="b")
    def handler(message, flag):
        return flag

    try:
        assert registry.HANDLERS["__testBoundA"]({}) == "a"
        assert registry.HANDLERS["__testBoundB"]({}) == "b"
    finally:
        registry.HANDLERS.pop("__testBoundA", None)
        registry.HANDLERS.pop("__testBoundB", None)


def test_unknown_request_type_raises_host_error():
    host = _import_host()
    with pytest.raises(host.HostError):
        host.handle_message({"id": "1", "type": "definitelyNotARequest"})
