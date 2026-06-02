#!/usr/bin/env python3
from __future__ import annotations

import email.utils
import json
import random
import socket
import sys
import time
import urllib.error
import urllib.parse
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable


RESULT_OK = "ok"
RESULT_RETRYABLE_ERROR = "retryable_error"
RESULT_BLOCKED = "blocked"
RESULT_FATAL_ERROR = "fatal_error"

DEFAULT_RETRY_STATUS_CODES = {429, 500, 502, 503, 504}
NETWORK_STATUSES = {"network_error", "timeout", "url_error"}
BLOCKED_STATUSES = {"blocked", "captcha", "challenge"}

SENSITIVE_KEYS = {"cookie", "csrf", "csrf_token", "x-csrf-token", "authorization"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def int_or_none(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def float_from_payload(payload: dict[str, Any], key: str, default: float, *, minimum: float = 0.0) -> float:
    try:
        value = float(payload.get(key, default))
    except (TypeError, ValueError):
        value = default
    return max(minimum, value)


def int_from_payload(payload: dict[str, Any], key: str, default: int, *, minimum: int = 0) -> int:
    try:
        value = int(payload.get(key, default))
    except (TypeError, ValueError):
        value = default
    return max(minimum, value)


def bool_from_payload(payload: dict[str, Any], key: str, default: bool) -> bool:
    if key not in payload:
        return default
    value = payload.get(key)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().casefold()
        if normalized in {"1", "true", "yes", "y", "on"}:
            return True
        if normalized in {"0", "false", "no", "n", "off"}:
            return False
    return bool(value)


def host_for_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    return parsed.netloc or url


def retry_after_from_result(result: dict[str, Any]) -> float | None:
    candidates = [
        result.get("retry_after"),
        result.get("retryAfter"),
    ]
    headers = result.get("response_headers") or result.get("headers")
    if isinstance(headers, dict):
        for key, value in headers.items():
            if str(key).casefold() == "retry-after":
                candidates.append(value)

    for raw in candidates:
        if raw is None:
            continue
        text = str(raw).strip()
        if not text:
            continue
        try:
            seconds = float(text)
            return max(0.0, seconds)
        except ValueError:
            pass
        try:
            retry_at = email.utils.parsedate_to_datetime(text)
            if retry_at.tzinfo is None:
                retry_at = retry_at.replace(tzinfo=timezone.utc)
            return max(0.0, (retry_at - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError):
            continue
    return None


def mask_secret(value: Any) -> str:
    text = "" if value is None else str(value)
    if len(text) <= 8:
        return "***"
    return f"{text[:4]}...{text[-4:]}"


def mask_sensitive_mapping(mapping: dict[str, Any]) -> dict[str, Any]:
    masked: dict[str, Any] = {}
    for key, value in mapping.items():
        if str(key).casefold() in SENSITIVE_KEYS:
            masked[key] = mask_secret(value)
        elif isinstance(value, dict):
            masked[key] = mask_sensitive_mapping(value)
        else:
            masked[key] = value
    return masked


def log_value(value: Any) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.3f}"
    text = str(value)
    if not text:
        return "-"
    if any(char.isspace() for char in text):
        return json.dumps(text, ensure_ascii=False)
    return text


def structured_log(
    *,
    source: str,
    query_key: str,
    attempt: int,
    status: str,
    status_code: int | None,
    latency_ms: float | None,
    retry_in_sec: float | None,
    blocked_reason: str | None,
    result_status: str | None = None,
) -> None:
    fields = {
        "source": source,
        "query_key": query_key,
        "attempt": attempt,
        "status": status,
        "status_code": status_code,
        "latency_ms": round(latency_ms, 2) if latency_ms is not None else None,
        "retry_in_sec": round(retry_in_sec, 3) if retry_in_sec is not None else None,
        "blocked_reason": blocked_reason,
    }
    if result_status and result_status != status:
        fields["result_status"] = result_status
    print("parser_event " + " ".join(f"{key}={log_value(value)}" for key, value in fields.items()), file=sys.stderr)


def structured_summary_log(source: str, metrics: dict[str, Any]) -> None:
    fields = {"source": source, **metrics}
    print("parser_summary " + " ".join(f"{key}={log_value(value)}" for key, value in fields.items()), file=sys.stderr)


def response_preview(value: str, limit: int = 2000) -> str:
    compact = " ".join(value.split())
    if len(compact) <= limit:
        return compact
    return compact[:limit]


def blocked_reason_from_text(value: str) -> str | None:
    text = response_preview(value).casefold()
    if not text:
        return None
    checks = [
        ("servicepipe_challenge", ("servicepipe.ru/static/checkjs", "servicepipe.ru/static/jsrsasign", "get_cookie_spsn", "get_cookie_spid")),
        ("captcha", ("captcha", "g-recaptcha", "hcaptcha", "id_captcha_frame_div", "подтвердите, что вы не робот")),
        ("cloudflare_challenge", ("cf-chl-", "checking your browser", "cloudflare")),
        ("anti_bot_challenge", ("anti-bot", "antibot", "bot protection", "robot check")),
        ("access_denied", ("access denied", "forbidden", "доступ ограничен")),
    ]
    for reason, needles in checks:
        if any(needle in text for needle in needles):
            return reason
    if text.startswith("<!doctype html") or text.startswith("<html"):
        if "challenge" in text or "провер" in text and "робот" in text:
            return "html_challenge"
    return None


def blocked_reason_from_value(value: Any, *, max_depth: int = 3) -> str | None:
    if max_depth < 0 or value is None:
        return None
    if isinstance(value, str):
        return blocked_reason_from_text(value)
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).casefold() in SENSITIVE_KEYS:
                continue
            reason = blocked_reason_from_value(item, max_depth=max_depth - 1)
            if reason:
                return reason
    if isinstance(value, list):
        for item in value[:8]:
            reason = blocked_reason_from_value(item, max_depth=max_depth - 1)
            if reason:
                return reason
    return None


def classify_result(result: dict[str, Any]) -> tuple[str, str | None]:
    status = str(result.get("status") or "").casefold()
    status_code = int_or_none(result.get("status_code"))
    blocked_reason = result.get("blocked_reason")
    if not blocked_reason:
        blocked_reason = blocked_reason_from_value(result.get("response"))
    if not blocked_reason:
        blocked_reason = blocked_reason_from_value(result.get("error"))

    if status_code == 429:
        return RESULT_BLOCKED, "http_429_rate_limited"
    if status in BLOCKED_STATUSES:
        return RESULT_BLOCKED, blocked_reason or status
    if blocked_reason:
        return RESULT_BLOCKED, str(blocked_reason)
    if status == RESULT_OK:
        return RESULT_OK, None
    if status_code == 0:
        return RESULT_RETRYABLE_ERROR, None
    if status_code in DEFAULT_RETRY_STATUS_CODES:
        return RESULT_RETRYABLE_ERROR, None
    if status in NETWORK_STATUSES:
        return RESULT_RETRYABLE_ERROR, None
    return RESULT_FATAL_ERROR, None


@dataclass
class RetryPolicy:
    max_retries: int = 2
    base_delay_sec: float = 2.0
    jitter_sec: float = 0.5
    backoff_multiplier: float = 2.0
    max_delay_sec: float = 120.0
    retry_status_codes: set[int] = field(default_factory=lambda: set(DEFAULT_RETRY_STATUS_CODES))

    def should_retry(self, result: dict[str, Any], classification: str, retries_done: int) -> bool:
        if retries_done >= self.max_retries:
            return False
        status_code = int_or_none(result.get("status_code"))
        if status_code in self.retry_status_codes:
            return True
        if classification == RESULT_RETRYABLE_ERROR:
            return True
        if classification == RESULT_BLOCKED:
            return True
        return False

    def retry_delay_sec(self, result: dict[str, Any], retry_number: int) -> float:
        retry_after = retry_after_from_result(result)
        if retry_after is not None:
            return min(self.max_delay_sec, retry_after)
        backoff = self.base_delay_sec * (self.backoff_multiplier ** max(0, retry_number - 1))
        jitter = random.uniform(0.0, self.jitter_sec) if self.jitter_sec > 0 else 0.0
        return min(self.max_delay_sec, max(0.0, backoff + jitter))


@dataclass
class RuntimeOptions:
    source: str
    request_delay_sec: float = 1.0
    request_jitter_sec: float = 0.35
    max_retries: int = 2
    min_rate_interval_sec: float = 1.0
    stop_on_blocked: bool = True
    circuit_failure_threshold: int = 4
    circuit_cooldown_sec: float = 90.0
    max_rate_interval_sec: float = 90.0

    @classmethod
    def from_payload(
        cls,
        payload: dict[str, Any],
        *,
        source: str,
        default_request_delay_sec: float = 1.0,
        default_request_jitter_sec: float = 0.35,
        default_min_rate_interval_sec: float = 1.0,
    ) -> RuntimeOptions:
        return cls(
            source=source,
            request_delay_sec=float_from_payload(payload, "requestDelaySec", default_request_delay_sec),
            request_jitter_sec=float_from_payload(payload, "requestJitterSec", default_request_jitter_sec),
            max_retries=int_from_payload(payload, "maxRetries", 2),
            min_rate_interval_sec=float_from_payload(payload, "minRateIntervalSec", default_min_rate_interval_sec),
            stop_on_blocked=bool_from_payload(payload, "stopOnBlocked", True),
        )


@dataclass
class HostRateState:
    interval_sec: float
    next_allowed_at: float = 0.0
    block_streak: int = 0


class RateLimiter:
    def __init__(self, *, base_interval_sec: float, jitter_sec: float = 0.0, max_interval_sec: float = 90.0) -> None:
        self.base_interval_sec = max(0.0, base_interval_sec)
        self.jitter_sec = max(0.0, jitter_sec)
        self.max_interval_sec = max(self.base_interval_sec, max_interval_sec)
        self._hosts: dict[str, HostRateState] = {}

    def _state(self, host: str) -> HostRateState:
        if host not in self._hosts:
            self._hosts[host] = HostRateState(interval_sec=self.base_interval_sec)
        return self._hosts[host]

    def wait(self, host: str) -> float:
        state = self._state(host)
        now = time.monotonic()
        sleep_for = max(0.0, state.next_allowed_at - now)
        if sleep_for > 0:
            time.sleep(sleep_for)
        interval = state.interval_sec + (random.uniform(0.0, self.jitter_sec) if self.jitter_sec > 0 else 0.0)
        state.next_allowed_at = time.monotonic() + interval
        return sleep_for

    def record_result(self, host: str, *, classification: str, status_code: int | None) -> None:
        state = self._state(host)
        if status_code == 429 or classification == RESULT_BLOCKED:
            state.block_streak += 1
            increased = max(self.base_interval_sec, state.interval_sec * 2.0, self.base_interval_sec * (1 + state.block_streak))
            state.interval_sec = min(self.max_interval_sec, increased)
            return
        if classification == RESULT_OK:
            state.block_streak = 0
            if state.interval_sec > self.base_interval_sec:
                state.interval_sec = max(self.base_interval_sec, state.interval_sec * 0.85)


@dataclass
class CircuitState:
    state: str = "closed"
    failures: int = 0
    opened_at: float = 0.0


class CircuitBreaker:
    def __init__(self, *, failure_threshold: int = 4, cooldown_sec: float = 90.0) -> None:
        self.failure_threshold = max(1, failure_threshold)
        self.cooldown_sec = max(1.0, cooldown_sec)
        self._hosts: dict[str, CircuitState] = {}

    def _state(self, host: str) -> CircuitState:
        if host not in self._hosts:
            self._hosts[host] = CircuitState()
        return self._hosts[host]

    def before_request(self, host: str) -> tuple[bool, float]:
        state = self._state(host)
        if state.state != "open":
            return True, 0.0
        elapsed = time.monotonic() - state.opened_at
        if elapsed >= self.cooldown_sec:
            state.state = "half_open"
            return True, 0.0
        return False, self.cooldown_sec - elapsed

    def record_result(self, host: str, classification: str) -> None:
        state = self._state(host)
        if classification == RESULT_OK:
            state.state = "closed"
            state.failures = 0
            return
        if classification not in {RESULT_RETRYABLE_ERROR, RESULT_BLOCKED}:
            return
        state.failures += 1
        if state.state == "half_open" or state.failures >= self.failure_threshold:
            state.state = "open"
            state.opened_at = time.monotonic()


@dataclass
class RuntimeMetrics:
    total: int = 0
    ok: int = 0
    retries: int = 0
    blocked: int = 0
    fatal: int = 0
    retryable_error: int = 0
    latencies_ms: list[float] = field(default_factory=list)

    def record_retry(self) -> None:
        self.retries += 1

    def record_attempt_latency(self, latency_ms: float) -> None:
        self.latencies_ms.append(latency_ms)

    def record_final(self, classification: str) -> None:
        self.total += 1
        if classification == RESULT_OK:
            self.ok += 1
        elif classification == RESULT_BLOCKED:
            self.blocked += 1
        elif classification == RESULT_RETRYABLE_ERROR:
            self.retryable_error += 1
        else:
            self.fatal += 1

    def summary(self) -> dict[str, Any]:
        latencies = sorted(self.latencies_ms)
        avg_latency = sum(latencies) / len(latencies) if latencies else 0.0
        if latencies:
            index = min(len(latencies) - 1, int(len(latencies) * 0.95))
            p95_latency = latencies[index]
        else:
            p95_latency = 0.0
        return {
            "total": self.total,
            "ok": self.ok,
            "retries": self.retries,
            "blocked": self.blocked,
            "fatal": self.fatal,
            "retryable_error": self.retryable_error,
            "avg_latency_ms": round(avg_latency, 2),
            "p95_latency_ms": round(p95_latency, 2),
        }


RequestFn = Callable[[int], dict[str, Any]]


class ParserRuntime:
    def __init__(self, options: RuntimeOptions) -> None:
        self.options = options
        self.retry_policy = RetryPolicy(
            max_retries=options.max_retries,
            base_delay_sec=options.request_delay_sec,
            jitter_sec=options.request_jitter_sec,
        )
        self.rate_limiter = RateLimiter(
            base_interval_sec=options.min_rate_interval_sec,
            jitter_sec=options.request_jitter_sec,
            max_interval_sec=options.max_rate_interval_sec,
        )
        self.circuit_breaker = CircuitBreaker(
            failure_threshold=options.circuit_failure_threshold,
            cooldown_sec=options.circuit_cooldown_sec,
        )
        self.metrics = RuntimeMetrics()

    def run_query(
        self,
        *,
        query: dict[str, Any],
        url: str,
        request_fn: RequestFn,
        query_key: str | None = None,
    ) -> dict[str, Any]:
        host = host_for_url(url)
        key = query_key or str(query.get("query_key") or "-")
        retries_done = 0
        attempt = 1

        while True:
            allowed, remaining = self.circuit_breaker.before_request(host)
            if not allowed:
                result = self._synthetic_result(
                    query,
                    status="circuit_open",
                    classification=RESULT_BLOCKED,
                    blocked_reason="circuit_open",
                    error=f"Circuit breaker is open for {host}; retry after {remaining:.1f}s.",
                )
                self.metrics.record_final(RESULT_BLOCKED)
                structured_log(
                    source=self.options.source,
                    query_key=key,
                    attempt=attempt,
                    status=RESULT_BLOCKED,
                    status_code=None,
                    latency_ms=None,
                    retry_in_sec=round(remaining, 3),
                    blocked_reason="circuit_open",
                    result_status="circuit_open",
                )
                return result

            self.rate_limiter.wait(host)
            started = time.monotonic()
            try:
                result = request_fn(attempt)
            except (urllib.error.URLError, TimeoutError, socket.timeout) as exc:
                result = self._synthetic_result(
                    query,
                    status="network_error",
                    classification=RESULT_RETRYABLE_ERROR,
                    error=str(getattr(exc, "reason", exc)),
                )
            except Exception as exc:  # noqa: BLE001 - parsers should convert unexpected failures into JSON results.
                result = self._synthetic_result(
                    query,
                    status="error",
                    classification=RESULT_FATAL_ERROR,
                    error=str(exc),
                )

            latency_ms = (time.monotonic() - started) * 1000.0
            self.metrics.record_attempt_latency(latency_ms)
            classification, blocked_reason = classify_result(result)
            result["classification"] = classification
            result["runtimeStatus"] = classification
            result["latency_ms"] = round(latency_ms, 2)
            if blocked_reason:
                result["blocked_reason"] = blocked_reason
            if retries_done:
                result["attempts"] = retries_done + 1

            status_code = int_or_none(result.get("status_code"))
            self.rate_limiter.record_result(host, classification=classification, status_code=status_code)
            self.circuit_breaker.record_result(host, classification)

            retry_in_sec: float | None = None
            if self.retry_policy.should_retry(result, classification, retries_done):
                retry_in_sec = self.retry_policy.retry_delay_sec(result, retries_done + 1)

            structured_log(
                source=self.options.source,
                query_key=str(result.get("query_key") or key),
                attempt=attempt,
                status=classification,
                status_code=status_code,
                latency_ms=latency_ms,
                retry_in_sec=retry_in_sec,
                blocked_reason=blocked_reason,
                result_status=str(result.get("status") or ""),
            )

            if retry_in_sec is None:
                self.metrics.record_final(classification)
                return result

            self.metrics.record_retry()
            time.sleep(retry_in_sec)
            retries_done += 1
            attempt += 1

    def summary(self) -> dict[str, Any]:
        return self.metrics.summary()

    def log_summary(self) -> None:
        structured_summary_log(self.options.source, self.summary())

    def _synthetic_result(
        self,
        query: dict[str, Any],
        *,
        status: str,
        classification: str,
        error: str,
        blocked_reason: str | None = None,
    ) -> dict[str, Any]:
        result = {
            "source": self.options.source,
            "query_key": query.get("query_key"),
            "person_id": query.get("person_id"),
            "display_name": query.get("display_name"),
            "query": query,
            "status": status,
            "status_code": None,
            "classification": classification,
            "runtimeStatus": classification,
            "started_at": utc_now(),
            "completed_at": utc_now(),
            "error": error,
        }
        if blocked_reason:
            result["blocked_reason"] = blocked_reason
        return result
