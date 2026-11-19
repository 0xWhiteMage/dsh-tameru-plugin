"""Tameru worker for the DeepSeek Harness plugin: one JSON request per line in, one JSON reply per line out.

Start it isolated: ``python -I -B -P run_worker.py``. The directory this file lives in is added to ``sys.path`` explicitly, so the
vendored ``tameru`` package imports from the plugin and nothing is picked up from the working directory or the environment.

Protocol (UTF-8, ``\\n``-terminated lines, replies written with ASCII escapes only). Since engine 1.10.0 the field list, the types,
the ranges, the closed enums and the reply body come from the engine's own ``tameru.protocol`` module; this file only owns the
stdin/stdout loop, the size limit, and two plugin-level additions that the engine's schema does not carry:

    {"id": 1, "op": "compress", "protocol": 2, "text": "...", "preset": "dsh-tool-result@1", "redact_secrets": true,
     "anchor_errors": true, "query_parts": {...}, "policy": {"min_confidence": 0.7, ...}}
    {"id": 1, "ok": true, "result": {"text": "...", "fail_open": false, ..., "decision": {"accept": true, "reason": "ok"}}}
    {"id": 2, "op": "version"}  ->  {"id": 2, "ok": true, "result": {"engine_version": "1.10.0", "protocol": 2, "result_schema": 2, "presets": [...]}}
    {"id": 3, "op": "ping"}     ->  {"id": 3, "ok": true, "result": {}}
    {"id": 4, "op": "shutdown"} ->  {"id": 4, "ok": true, "result": {}} and the process exits

* ``query_parts`` (instead of ``query``): the pieces of the question (the tool call, the assistant turn after it, the last and the
  first real user message). The worker builds the one query with the engine's shared ``build_query``.
* ``policy``: what the host accepts (``min_confidence``, ``min_saved_ratio``, ``min_tokens_saved``, ``allow_sanitized``). The reply
  carries ``decision`` from the engine's ``decide()``, with one of its closed reason codes. The host acts on ``accept`` only.
* ``pin_patterns`` are accepted here only as ``{"literal": "..."}``. The engine's static regex check does not catch polynomial
  backtracking (``a*a*a*a*a*b`` passes it and hangs the engine), and this plugin has no use for a regex pin.

Every option that would write to disk (``ccr``, ``log_dir``), reach a network or a model (summary endpoints, ``semantic_tier``) or
load other code does not exist in the engine's schema and is refused as an unknown field. The worker always passes ``ccr=False``.
A request over ``MAX_REQUEST_BYTES`` is answered with an error and discarded. An error reply is a fixed code or an exception type
name: it never contains text from the request. The process ends when stdin reaches end of file, so it never outlives the harness.
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_PART_CHARS = 50_000      # one piece of ``query_parts``
MAX_AFTER_CALLS = 8
QUERY_CHARS = 2000

# the ``policy`` object: field -> accepted type (the engine's ``Policy`` checks the ranges)
POLICY_FIELDS = {"min_confidence": float, "min_saved_ratio": float, "min_tokens_saved": int, "allow_sanitized": bool}


class RequestError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _text(value, name: str) -> str:
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > MAX_PART_CHARS:
        raise RequestError(f"bad_{name}")
    return value


def _call(value, name: str) -> dict:
    """A tool call as ``{"name": str, "arguments": str | object}``, in the engine's flat call shape."""
    if not isinstance(value, dict) or set(value) - {"name", "arguments"}:
        raise RequestError(f"bad_{name}")
    call_name = value.get("name", "")
    if not isinstance(call_name, str) or len(call_name) > 500:
        raise RequestError(f"bad_{name}")
    arguments = value.get("arguments")
    if isinstance(arguments, str):
        if len(arguments) > MAX_PART_CHARS:
            raise RequestError(f"bad_{name}")
    elif arguments is not None and not isinstance(arguments, (dict, list)):
        raise RequestError(f"bad_{name}")
    return {"name": call_name, "arguments": arguments}


def query_from_parts(parts) -> str:
    """The one query for a tool result, from the pieces the host holds. Raises ``RequestError``.

    ``parts``: ``call`` (the tool call that produced the result), ``after`` (``text`` and ``calls`` of the assistant turn that
    followed), ``last_user`` and ``first_user`` (real user messages only: the host leaves scaffolding out). The engine's
    ``build_query`` puts the tool name and its arguments before any user text, so they survive its length cap."""
    from tameru.transcript import build_query

    if not isinstance(parts, dict) or set(parts) - {"call", "after", "last_user", "first_user"}:
        raise RequestError("bad_query_parts")
    first = _text(parts.get("first_user"), "query_parts")
    last = _text(parts.get("last_user"), "query_parts")
    messages: list = []
    if first.strip():
        messages.append({"role": "user", "content": first})
    if last.strip() and last != first:
        messages.append({"role": "user", "content": last})
    call = parts.get("call")
    if call is not None:
        messages.append({"role": "assistant", "tool_calls": [{"id": "tameru-call", **_call(call, "query_parts")}]})
    index = len(messages)
    messages.append({"role": "tool", "tool_call_id": "tameru-call" if call is not None else "", "content": ""})
    after = parts.get("after")
    if after is not None:
        if not isinstance(after, dict) or set(after) - {"text", "calls"}:
            raise RequestError("bad_query_parts")
        calls = after.get("calls") or []
        if not isinstance(calls, list) or len(calls) > MAX_AFTER_CALLS:
            raise RequestError("bad_query_parts")
        messages.append({
            "role": "assistant",
            "content": _text(after.get("text"), "query_parts"),
            "tool_calls": [_call(item, "query_parts") for item in calls],
        })
    return build_query(messages, index, max_chars=QUERY_CHARS)


def _policy(value):
    """The engine's frozen ``Policy`` from the request's ``policy`` object. Raises ``RequestError``."""
    from tameru.decide import Policy

    if not isinstance(value, dict) or set(value) - set(POLICY_FIELDS):
        raise RequestError("bad_policy")
    fields = {}
    for name, kind in POLICY_FIELDS.items():
        if name not in value:
            continue
        item = value[name]
        if kind is bool:
            if not isinstance(item, bool):
                raise RequestError("bad_policy")
        elif isinstance(item, bool) or not isinstance(item, (int, float)):
            raise RequestError("bad_policy")
        try:
            fields[name] = kind(item)
        except (ValueError, OverflowError):
            raise RequestError("bad_policy") from None
    try:
        return Policy(**fields)
    except (ValueError, TypeError):
        raise RequestError("bad_policy") from None


def _literal_pins_only(request: dict) -> None:
    pins = request.get("pin_patterns")
    if pins is not None and (not isinstance(pins, list) or any(not isinstance(item, dict) for item in pins)):
        raise RequestError("bad_pin_patterns")


def _compress(request: dict) -> dict:
    from tameru import protocol
    from tameru.compress_context import compress_context
    from tameru.decide import decide

    request = dict(request)
    parts = request.pop("query_parts", None)
    policy_field = request.pop("policy", None)
    _literal_pins_only(request)
    if parts is not None:
        if "query" in request:
            raise RequestError("query_and_parts")
        request["query"] = query_from_parts(parts)
    policy = _policy(policy_field) if policy_field is not None else None
    try:
        options = protocol.validate_request(request)
    except protocol.ProtocolError as error:
        raise RequestError(error.code) from None
    sanitized = protocol.request_was_sanitized(request)
    result = compress_context(**options)
    reply = protocol.result_to_dict(result, sanitized=sanitized, preset=request.get("preset"))
    if options.get("redact_secrets"):
        # the engine's ``dropped`` locators are read from the ORIGINAL lines, so a credential can sit in one: redact them like the text
        from tameru.compress_context import redact_secrets_in

        reply["dropped"] = [[category, count, redact_secrets_in(where)] for category, count, where in reply["dropped"]]
    if policy is not None:
        decision = decide(result, policy, original=options["context"], sanitized=sanitized)
        reply["decision"] = {"accept": bool(decision.accept), "reason": str(decision.reason), "basis": str(decision.basis or "")[:80]}
    return reply


def _version() -> dict:
    import tameru
    from tameru import protocol

    info = protocol.version_info()
    return {
        **info,
        "engine_version": info["engine"],
        "vendored_from": getattr(tameru, "VENDORED_FROM", None),
        "python": ".".join(str(part) for part in sys.version_info[:3]),
    }


def handle(request: object) -> tuple[object, dict, bool]:
    """(id, reply, stop). Never raises."""
    ident = request.get("id") if isinstance(request, dict) else None
    if not isinstance(ident, (int, str)) or isinstance(ident, bool):
        ident = None
    try:
        if not isinstance(request, dict):
            raise RequestError("bad_request")
        op = request.get("op")
        if op == "compress":
            return ident, {"id": ident, "ok": True, "result": _compress(request)}, False
        if op == "version":
            return ident, {"id": ident, "ok": True, "result": _version()}, False
        if op == "ping":
            return ident, {"id": ident, "ok": True, "result": {}}, False
        if op == "shutdown":
            return ident, {"id": ident, "ok": True, "result": {}}, True
        raise RequestError("unknown_op")
    except RequestError as error:
        return ident, {"id": ident, "ok": False, "error": error.code}, False
    except Exception as error:  # the engine must never take the worker down; the host fails open on an error reply
        return ident, {"id": ident, "ok": False, "error": "engine_error:" + type(error).__name__[:40]}, False


def _write(reply: dict) -> None:
    sys.stdout.buffer.write((json.dumps(reply, ensure_ascii=True, separators=(",", ":")) + "\n").encode("ascii"))
    sys.stdout.buffer.flush()


def main() -> int:
    stdin = sys.stdin.buffer
    while True:
        line = stdin.readline(MAX_REQUEST_BYTES + 1)
        if not line:
            return 0
        if len(line) > MAX_REQUEST_BYTES and not line.endswith(b"\n"):
            while True:                                   # discard the rest of the oversized line
                rest = stdin.readline(1024 * 1024)
                if not rest or rest.endswith(b"\n"):
                    break
            _write({"id": None, "ok": False, "error": "too_large"})
            continue
        try:
            request = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError, MemoryError):
            _write({"id": None, "ok": False, "error": "bad_json"})
            continue
        _ident, reply, stop = handle(request)
        try:
            _write(reply)
        except Exception:   # a reply that cannot be encoded must not end the loop
            _write({"id": _ident if isinstance(_ident, (int, str)) else None, "ok": False, "error": "bad_reply"})
        if stop:
            return 0


if __name__ == "__main__":
    raise SystemExit(main())
