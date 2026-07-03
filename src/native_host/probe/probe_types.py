"""Data types for parallel reachability probes.

Extracted from probe_runner.py for modularity.
"""

from dataclasses import dataclass, field
from typing import Callable, Optional


@dataclass
class ProbeConfig:
    """Configuration for a single backend probe."""

    backend: str
    label: str
    probe_fn: Callable
    command: list[str]


@dataclass
class ProbeError:
    """Details of a single failed probe."""

    backend: str
    label: str
    error_type: str
    message: str
    status_code: Optional[int] = None
    raw_output: Optional[str] = None
    duration_ms: int = 0


@dataclass
class ProbeResult:
    """Outcome of a parallel probe round."""

    winner: Optional[str]
    command: Optional[list[str]]
    label: Optional[str]
    errors: list[ProbeError] = field(default_factory=list)
    duration_ms: int = 0
