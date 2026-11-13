"""Tameru worker for the DeepSeek Harness plugin: one JSON request per line in, one JSON reply per line out.

Start it isolated: ``python -I -B -P run_worker.py``. The directory this file lives in is added to ``sys.path`` explicitly, so the
vendored ``tameru`` package imports from the plugin and nothing is picked up from the working directory or the environment.

Protocol version 1 (UTF-8, ``\\n``-terminated lines, replies written with ASCII escapes only):

    {"id": 1, "op": "compress", "text": "...", "query": "...", "mode": "adaptive", "budget_ratio": 0.3}
    {"id": 1, "ok": true, "result": {"text": "...", "fail_open": false, ...}}
    {"id": 2, "op": "version"}  ->  {"id": 2, "ok": true, "result": {"engine_version": "1.9.0", ...}}
    {"id": 3, "op": "ping"}     ->  {"id": 3, "ok": true, "result": {}}
    {"id": 4, "op": "shutdown"} ->  {"id": 4, "ok": true, "result": {}} and the process exits

The accepted fields are a short fixed list. Anything else is rejected, in particular every option that would write to disk
(``ccr``, ``log_dir``), reach a network or a model (summary endpoints, ``semantic_tier``, ``strategy``) or load other code. The
worker always passes ``ccr=False`` and ``strategy="extract"``. A request over ``MAX_REQUEST_BYTES`` is answered with an error and
discarded. The process ends when stdin reaches end of file, so it never outlives the harness that started it.
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

PROTOCOL_VERSION = 1
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_REPLY_REASONS = 20

MODES = ("adaptive", "fixed", "compiler", "precision")
# field -> (type check, converter into compress_context's keyword)
_COMPRESS_FIELDS = {"id", "op", "text", "query", "mode", "budget_ratio", "pin_recent", "min_savings_ratio", "derive_query", "citations"}


class RequestError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _clean(text: str) -> tuple[str, bool]:
    """Lone surrogates (valid in JavaScript strings, not encodable as UTF-8) become U+FFFD; the second value says it happened."""
    try:
        text.encode("utf-8")
        return text, False
    except UnicodeEncodeError:
        return "".join("�" if 0xD800 <= ord(c) <= 0xDFFF else c for c in text), True


def _number(value, low: float, high: float, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not (low <= float(value) <= high):
        raise RequestError(f"bad_{name}")
    return float(value)


def _compress(request: dict) -> dict:
    unknown = sorted(set(request) - _COMPRESS_FIELDS)
    if unknown:
        raise RequestError("unknown_field:" + unknown[0][:40])
    text, query = request.get("text"), request.get("query", "")
    if not isinstance(text, str):
        raise RequestError("bad_text")
    if not isinstance(query, str):
        raise RequestError("bad_query")
    text, sanitized_text = _clean(text)
    query, sanitized_query = _clean(query)
    options: dict = {"ccr": False, "strategy": "extract", "citations": False}
    mode = request.get("mode", "adaptive")
    if mode not in MODES:
        raise RequestError("bad_mode")
    options["mode"] = mode
    if "budget_ratio" in request:
        options["budget_ratio"] = _number(request["budget_ratio"], 0.01, 1.0, "budget_ratio")
    if "min_savings_ratio" in request:
        options["min_savings_ratio"] = _number(request["min_savings_ratio"], 0.0, 1.0, "min_savings_ratio")
    if "pin_recent" in request:
        options["pin_recent"] = int(_number(request["pin_recent"], 0, 50, "pin_recent"))
    for flag in ("derive_query", "citations"):
        if flag in request:
            if not isinstance(request[flag], bool):
                raise RequestError(f"bad_{flag}")
            options[flag] = request[flag]
    from tameru.compress_context import compress_context

    result = compress_context(text, query, **options)
    return {
        "text": result.compressed_text,
        "fail_open": bool(result.fail_open),
        "original_tokens": int(result.original_tokens),
        "kept_tokens": int(result.kept_tokens),
        "tokens_saved_pct": float(result.tokens_saved_pct),
        "risk": result.compression_risk,
        "confidence": result.confidence,
        "content_type": result.content_type,
        "reasons": [str(r)[:120] for r in list(result.reasons)[:MAX_REPLY_REASONS]],
        "sanitized": bool(sanitized_text or sanitized_query),
    }


def _version() -> dict:
    import tameru
    from tameru.compress_context import ENGINE_VERSION

    return {
        "engine_version": ENGINE_VERSION,
        "vendored_from": getattr(tameru, "VENDORED_FROM", None),
        "protocol": PROTOCOL_VERSION,
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
        return ident, {"id": ident, "ok": False, "error": "engine_error:" + type(error).__name__}, False


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
        except (UnicodeDecodeError, ValueError):
            _write({"id": None, "ok": False, "error": "bad_json"})
            continue
        _ident, reply, stop = handle(request)
        _write(reply)
        if stop:
            return 0


if __name__ == "__main__":
    raise SystemExit(main())
