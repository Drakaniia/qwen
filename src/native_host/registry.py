"""Decorator-based handler registry for native messaging requests (spec D5).

Adding a message type means writing one decorated function. `host.handle_message`
is a lookup + call and is never edited again.

`register_handler` takes optional bound keyword arguments so one underlying
function can serve several message types with different constants
(`action="pause"` vs `"resume"`, `reveal=False` vs `True`). Stack the decorator
once per message type; each registration wraps the same function with its own
bound arguments.
"""

from collections.abc import Callable
from typing import Any

HANDLERS: dict[str, Callable[[Any], Any]] = {}


def register_handler(message_type: str, **bound: Any) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Register `fn` as the handler for `message_type`, with `bound` injected as keyword arguments."""

    def decorator(fn):
        HANDLERS[message_type] = lambda message: fn(message, **bound)
        return fn

    return decorator
