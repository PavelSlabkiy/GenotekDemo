#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import queue
import random
import re
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from date_utils import normalize_partial_date
from parser_runtime import (
    RESULT_BLOCKED,
    ParserRuntime,
    RuntimeOptions,
    blocked_reason_from_value,
    bool_from_payload,
    classify_result,
)
from smart_matching import SmartMatching

try:
    from gedcom_parser import build_tree, default_gedcom_path, parse_gedcom  # type: ignore[import-not-found]
except ImportError:
    build_tree = None
    default_gedcom_path = None
    parse_gedcom = None


API_URL = "https://pamyat-naroda.ru/entrypoint/api/"
ORIGIN = "https://pamyat-naroda.ru"
DEFAULT_CONFIG_PATH = Path("pamyat_config.json")
DEFAULT_RESULTS_PATH = Path("pamyat_results.jsonl")
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
)
DEFAULT_ACCEPT_LANGUAGE = "ru,en-US;q=0.9,en;q=0.8"
APP_SOURCE_KEY = "pamyatNaroda"
APP_SOURCE_LABEL = "Память народа"
SMART_MATCHING_SCORER = SmartMatching({}, {})

EMPTY_ARRAY_FILTERS = {
    "birth_place_ids": [],
    "award_id": [],
    "location": [],
    "exclude_ids": [],
    "exclude_guids": [],
    "kld_source_id": [],
    "kr_source_id": [],
    "division_ids": [],
    "exclude_birthplace_region_ids": [],
}


@dataclass
class SearchConfig:
    cookie: str
    csrf_token: str
    user_agent: str = DEFAULT_USER_AGENT
    accept_language: str = "ru,en-US;q=0.9,en;q=0.8"
    source: str = "config"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_config(path: Path | None, *, required: bool) -> SearchConfig | None:
    path = path or DEFAULT_CONFIG_PATH
    data: dict[str, Any] = {}
    if path:
        if not path.exists():
            if required:
                raise ValueError(f"Config file not found: {path}. Copy pamyat_config.example.json to pamyat_config.json first.")
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON in config file {path}: {exc}") from exc

    cookie = data.get("cookie") or os.environ.get("PAMYAT_COOKIE")
    csrf_token = data.get("csrf_token") or os.environ.get("PAMYAT_CSRF_TOKEN")
    user_agent = data.get("user_agent") or os.environ.get("PAMYAT_USER_AGENT") or DEFAULT_USER_AGENT
    accept_language = data.get("accept_language") or os.environ.get("PAMYAT_ACCEPT_LANGUAGE") or DEFAULT_ACCEPT_LANGUAGE

    missing = []
    if not cookie:
        missing.append("cookie / PAMYAT_COOKIE")
    if not csrf_token:
        missing.append("csrf_token / PAMYAT_CSRF_TOKEN")
    if missing:
        if required:
            raise ValueError(
                "Missing Pamyat Naroda auth values for --execute: "
                + ", ".join(missing)
                + ". Use pamyat_config.example.json as a template."
            )
        return None
    if "..." in cookie or "..." in csrf_token:
        if required:
            raise ValueError("Config still contains placeholder values. Replace cookie and csrf_token with fresh browser values.")
        return None

    return SearchConfig(
        cookie=cookie,
        csrf_token=csrf_token,
        user_agent=user_agent,
        accept_language=accept_language,
        source="config",
    )


def tls_context(verify: bool) -> ssl.SSLContext | None:
    return None if verify else ssl._create_unverified_context()


class ChromeWorkerClient:
    def __init__(
        self,
        *,
        accept_language: str,
        timeout: float,
        chrome_headless: bool = True,
        node_bin: str = "node",
    ) -> None:
        self.accept_language = accept_language
        self.timeout = timeout
        self.chrome_headless = chrome_headless
        self.node_bin = node_bin
        self.script_path = Path(__file__).with_name("pamyat_chrome_worker.mjs")
        self.process: subprocess.Popen[str] | None = None
        self._next_id = 0
        self._stdout_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        self._pending: dict[int, dict[str, Any]] = {}
        self._stderr_lines: list[str] = []

    def start(self) -> None:
        if self.process and self.process.poll() is None:
            return
        if not self.script_path.exists():
            raise ValueError(f"Chrome worker helper not found: {self.script_path}")

        command = [
            self.node_bin,
            str(self.script_path),
            "--accept-language",
            self.accept_language,
            "--timeout-ms",
            str(max(int(self.timeout * 1000), 15000)),
        ]
        if not self.chrome_headless:
            command.append("--chrome-visible")

        try:
            self.process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
        except FileNotFoundError as exc:
            raise ValueError("Node.js is required for the Chrome DevTools fallback.") from exc

        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        self._call_no_restart("ping", {}, timeout=5.0)

    def restart(self) -> None:
        self.close()
        self.start()

    def bootstrap(self, query: dict[str, Any], *, timeout: float) -> dict[str, Any]:
        return self.call(
            "bootstrap",
            {
                "url": referer_for_query(query),
                "timeoutMs": max(int(timeout * 1000), 15000),
            },
            timeout=max(timeout + 20.0, 45.0),
        )

    def refresh(self, query: dict[str, Any], *, timeout: float) -> dict[str, Any]:
        return self.call(
            "refresh",
            {
                "url": referer_for_query(query),
                "timeoutMs": max(int(timeout * 1000), 15000),
            },
            timeout=max(timeout + 20.0, 45.0),
        )

    def search(self, query: dict[str, Any], payload: dict[str, Any], *, timeout: float) -> dict[str, Any]:
        return self.call(
            "search",
            {
                "url": referer_for_query(query),
                "payload": payload,
                "timeoutMs": max(int(timeout * 1000), 15000),
            },
            timeout=max(timeout + 25.0, 50.0),
        )

    def call(self, command: str, params: dict[str, Any], *, timeout: float) -> dict[str, Any]:
        try:
            self.start()
            return self._call_no_restart(command, params, timeout=timeout)
        except Exception:
            if command == "close":
                raise
            self.restart()
            return self._call_no_restart(command, params, timeout=timeout)

    def close(self) -> None:
        process = self.process
        if not process:
            return
        if process.poll() is None:
            try:
                self._call_no_restart("close", {}, timeout=5.0)
            except Exception:
                try:
                    process.terminate()
                    process.wait(timeout=5.0)
                except Exception:
                    process.kill()
        self.process = None

    def _call_no_restart(self, command: str, params: dict[str, Any], *, timeout: float) -> dict[str, Any]:
        process = self.process
        if not process or process.poll() is not None or process.stdin is None:
            raise ValueError(self._worker_error("Chrome worker is not running."))

        self._next_id += 1
        request_id = self._next_id
        process.stdin.write(json.dumps({"id": request_id, "command": command, "params": params}, ensure_ascii=False) + "\n")
        process.stdin.flush()

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pending = self._pending.pop(request_id, None)
            if pending is not None:
                return self._response_payload(pending)
            wait_for = max(0.05, min(0.5, deadline - time.monotonic()))
            try:
                message = self._stdout_queue.get(timeout=wait_for)
            except queue.Empty:
                if process.poll() is not None:
                    raise ValueError(self._worker_error(f"Chrome worker exited with code {process.returncode}."))
                continue
            message_id = message.get("id")
            if message_id == request_id:
                return self._response_payload(message)
            if isinstance(message_id, int):
                self._pending[message_id] = message

        raise TimeoutError(self._worker_error(f"Chrome worker command timed out: {command}."))

    def _response_payload(self, message: dict[str, Any]) -> dict[str, Any]:
        if message.get("ok") is True and isinstance(message.get("result"), dict):
            return message["result"]
        error = message.get("error") or "Unknown Chrome worker error."
        raise ValueError(self._worker_error(str(error)))

    def _read_stdout(self) -> None:
        process = self.process
        stream = process.stdout if process else None
        if stream is None:
            return
        for line in stream:
            text = line.strip()
            if not text:
                continue
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                payload = {"id": None, "ok": False, "error": f"Invalid worker JSON: {text[:240]}"}
            if isinstance(payload, dict):
                self._stdout_queue.put(payload)

    def _read_stderr(self) -> None:
        process = self.process
        stream = process.stderr if process else None
        if stream is None:
            return
        for line in stream:
            text = line.strip()
            if not text:
                continue
            self._stderr_lines.append(text)
            self._stderr_lines = self._stderr_lines[-20:]

    def _worker_error(self, message: str) -> str:
        if not self._stderr_lines:
            return message
        return f"{message} Worker stderr: {' | '.join(self._stderr_lines[-3:])}"


def bootstrap_config(
    first_query: dict[str, Any],
    *,
    user_agent: str,
    accept_language: str,
    timeout: float,
    verify_tls: bool,
) -> SearchConfig:
    try:
        return bootstrap_config_via_http(
            first_query,
            user_agent=user_agent,
            accept_language=accept_language,
            timeout=timeout,
            verify_tls=verify_tls,
        )
    except ValueError as exc:
        previous_error = str(exc)
        try:
            ensure_chrome_devtools_fallback_available()
        except ValueError:
            raise ValueError(previous_error) from exc
        return SearchConfig(
            cookie="",
            csrf_token="",
            user_agent=user_agent,
            accept_language=accept_language,
            source="chrome_pending",
        )


def bootstrap_config_via_http(
    first_query: dict[str, Any],
    *,
    user_agent: str,
    accept_language: str,
    timeout: float,
    verify_tls: bool,
) -> SearchConfig:
    cookie_jar = CookieJar()
    handlers: list[Any] = [urllib.request.HTTPCookieProcessor(cookie_jar)]
    context = tls_context(verify_tls)
    if context:
        handlers.append(urllib.request.HTTPSHandler(context=context))
    opener = urllib.request.build_opener(*handlers)
    request = urllib.request.Request(
        referer_for_query(first_query),
        headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": accept_language,
            "User-Agent": user_agent,
        },
        method="GET",
    )

    try:
        with opener.open(request, timeout=timeout) as response:
            html = response.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:
        raise ValueError(f"Could not bootstrap Pamyat Naroda session: {exc}") from exc

    cookie = cookie_header(cookie_jar)
    csrf_token = extract_csrf_token(html)
    if not csrf_token:
        raise ValueError(describe_bootstrap_failure(html, cookie=cookie))
    if not cookie:
        raise ValueError("Could not collect session cookies from Pamyat Naroda search page.")

    return SearchConfig(
        cookie=cookie,
        csrf_token=csrf_token,
        user_agent=user_agent,
        accept_language=accept_language,
        source="bootstrap",
    )

def bootstrap_config_via_chrome(
    first_query: dict[str, Any],
    *,
    user_agent: str,
    accept_language: str,
    timeout: float,
    chrome_headless: bool = True,
) -> SearchConfig:
    client = ChromeWorkerClient(
        accept_language=accept_language,
        timeout=timeout,
        chrome_headless=chrome_headless,
    )
    try:
        payload = client.bootstrap(first_query, timeout=timeout)
        return SearchConfig(
            cookie=payload["cookie"],
            csrf_token=payload["csrf_token"],
            user_agent=payload.get("user_agent") or user_agent,
            accept_language=payload.get("accept_language") or accept_language,
            source=payload.get("source") or "chrome_devtools",
        )
    finally:
        client.close()


def ensure_chrome_devtools_fallback_available() -> None:
    script_path = Path(__file__).with_name("pamyat_chrome_worker.mjs")
    if not script_path.exists():
        raise ValueError(f"Chrome worker helper not found: {script_path}")
    try:
        subprocess.run(
            ["node", "--version"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10.0,
        )
    except FileNotFoundError as exc:
        raise ValueError("Node.js is required for the Chrome DevTools fallback.") from exc
    except subprocess.CalledProcessError as exc:
        raise ValueError(f"Could not start Node.js for the Chrome DevTools fallback: {exc}") from exc


def parse_chrome_bootstrap_output(output: str) -> dict[str, Any]:
    try:
        payload = json.loads(output.strip())
    except json.JSONDecodeError as exc:
        raise ValueError(f"Chrome DevTools bootstrap returned invalid JSON: {output.strip()[:240]}") from exc

    cookie = payload.get("cookie")
    csrf_token = payload.get("csrf_token")
    if not cookie or not csrf_token:
        raise ValueError("Chrome DevTools bootstrap did not return both cookie and csrf_token.")
    return payload


def extract_csrf_token(html: str) -> str | None:
    match = re_search_csrf(html, "heroes-filter")
    if match:
        return match

    match = re_search_csrf(html, None)
    return match


def is_servicepipe_challenge(html: str) -> bool:
    lower = html.casefold()
    return (
        "servicepipe.ru/static/checkjs" in lower
        or "servicepipe.ru/static/jsrsasign-all-min.js" in lower
        or "get_cookie_spsn" in lower
        or "get_cookie_spid" in lower
        or 'id="id_captcha_frame_div"' in lower
    )


def describe_bootstrap_failure(html: str, *, cookie: str) -> str:
    if is_servicepipe_challenge(html):
        return (
            "Pamyat Naroda returned a Servicepipe anti-bot challenge instead of the search page, "
            "so direct Python bootstrap is blocked. "
            "The app will try a background headless Chrome DevTools fallback first. "
            f"If that also fails, fill {DEFAULT_CONFIG_PATH} with a fresh browser Cookie header and csrf_token."
        )

    preview = response_preview(html)
    if not cookie:
        return f"Could not find CSRF token on Pamyat Naroda search page. Response preview: {preview}"
    return f"Could not find CSRF token on Pamyat Naroda search page even though session cookies were collected. Response preview: {preview}"


def re_search_csrf(html: str, form_id: str | None) -> str | None:
    import re

    source = html
    if form_id:
        form_match = re.search(rf'<form[^>]+id="{re.escape(form_id)}"[\s\S]*?</form>', html)
        if form_match:
            source = form_match.group(0)

    match = re.search(r'<input[^>]+name="csrf"[^>]+value="([^"]+)"', source)
    if match:
        return match.group(1)

    match = re.search(r'<input[^>]+value="([^"]+)"[^>]+name="csrf"', source)
    return match.group(1) if match else None


def cookie_header(cookie_jar: CookieJar) -> str:
    return "; ".join(f"{cookie.name}={cookie.value}" for cookie in cookie_jar)


def load_tree(gedcom_path: Path | None) -> dict[str, Any]:
    if build_tree is None or parse_gedcom is None or default_gedcom_path is None:
        raise ValueError("GEDCOM parser helpers are unavailable in this environment.")
    path = gedcom_path or default_gedcom_path()
    if path is None:
        raise ValueError("Provide a GEDCOM path, or run in a directory with exactly one .ged file.")
    return build_tree(parse_gedcom(path))


def is_wartime_candidate(person: dict[str, Any], birth_year_from: int, birth_year_to: int) -> bool:
    birth_year = person.get("pamyat_naroda", {}).get("birth_year")
    if birth_year is None:
        return False
    return birth_year_from <= int(birth_year) <= birth_year_to


def iter_queries(
    tree: dict[str, Any],
    *,
    scope: str,
    birth_year_from: int,
    birth_year_to: int,
    person_id: str | None,
    person_name: str | None,
) -> Iterable[dict[str, Any]]:
    for person in tree["people"]:
        if person_id and person.get("id") != person_id:
            continue
        if person_name and not person_matches_name(person, person_name):
            continue
        if scope == "wartime" and not is_wartime_candidate(person, birth_year_from, birth_year_to):
            continue

        for query in person.get("pamyat_naroda", {}).get("queries", []):
            if not query.get("last_name") or not query.get("first_name"):
                continue
            yield query


def person_matches_name(person: dict[str, Any], name: str) -> bool:
    needle = normalize_lookup(name)
    if not needle:
        return False

    candidates = {
        person.get("display_name") or "",
        " ".join(part for part in (person.get("surname"), person.get("given_name")) if part),
        " ".join(part for part in (person.get("married_name"), person.get("given_name")) if part),
    }
    for query in person.get("pamyat_naroda", {}).get("queries", []):
        candidates.add(" ".join(part for part in (query.get("last_name"), query.get("first_name"), query.get("middle_name")) if part))
        candidates.add(" ".join(part for part in (query.get("first_name"), query.get("middle_name"), query.get("last_name")) if part))

    return any(normalize_lookup(candidate) == needle for candidate in candidates if candidate)


def normalize_lookup(value: str) -> str:
    return " ".join(value.replace("ё", "е").replace("Ё", "Е").casefold().split())


def pamyat_payload(query: dict[str, Any], page: int, size: int) -> dict[str, Any]:
    api_query: dict[str, Any] = {
        "last_name": query.get("last_name") or "",
        "first_name": query.get("first_name") or "",
        "middle_name": query.get("middle_name") or "",
        "birth_date_from": query.get("birth_date_from") or "",
        **EMPTY_ARRAY_FILTERS,
    }
    return {
        "entrypoint": "heroes/search",
        "parameters": {
            "query": api_query,
            "page": page,
            "size": size,
            "options": {"person": True},
        },
    }


def referer_for_query(query: dict[str, Any]) -> str:
    params = {
        "adv_search": "y",
        "last_name": query.get("last_name") or "",
        "first_name": query.get("first_name") or "",
        "middle_name": query.get("middle_name") or "",
        "date_birth_from": query.get("birth_date_from") or "",
    }
    return f"{ORIGIN}/heroes/?{urllib.parse.urlencode(params)}"


def headers_for_query(config: SearchConfig, query: dict[str, Any]) -> dict[str, str]:
    return {
        "Accept": "application/json",
        "Accept-Language": config.accept_language,
        "Connection": "keep-alive",
        "Content-Type": "application/json",
        "Cookie": config.cookie,
        "DNT": "1",
        "Origin": ORIGIN,
        "Referer": referer_for_query(query),
        "User-Agent": config.user_agent,
        "X-Csrf-Token": config.csrf_token,
    }


def search_once(
    config: SearchConfig,
    query: dict[str, Any],
    page: int,
    size: int,
    timeout: float,
    verify_tls: bool,
    chrome_client: ChromeWorkerClient | None = None,
) -> dict[str, Any]:
    if not config.cookie or not config.csrf_token:
        if chrome_client is None:
            return {
                "query_key": query["query_key"],
                "person_id": query.get("person_id"),
                "display_name": query.get("display_name"),
                "query": query,
                "request": pamyat_payload(query, page=page, size=size),
                "auth_source": config.source,
                "status": "error",
                "status_code": None,
                "started_at": utc_now(),
                "completed_at": utc_now(),
                "error": "Chrome worker is required because the HTTP session has no cookie/csrf token.",
            }
        return search_once_via_chrome(config, query, page=page, size=size, timeout=timeout, chrome_client=chrome_client)

    payload = pamyat_payload(query, page=page, size=size)
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers_for_query(config, query),
        method="POST",
    )

    started_at = utc_now()
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=tls_context(verify_tls)) as response:
            body = response.read().decode("utf-8")
            parsed_response = parse_json_or_text(body)
            status, error = classify_search_response(parsed_response)
            result = {
                "query_key": query["query_key"],
                "person_id": query.get("person_id"),
                "display_name": query.get("display_name"),
                "query": query,
                "request": payload,
                "auth_source": config.source,
                "status": status,
                "status_code": response.status,
                "started_at": started_at,
                "completed_at": utc_now(),
                "response": parsed_response,
            }
            if error:
                result["error"] = error
            return {
                **result,
            }
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return {
            "query_key": query["query_key"],
            "person_id": query.get("person_id"),
            "display_name": query.get("display_name"),
            "query": query,
            "request": payload,
            "auth_source": config.source,
            "status": "http_error",
            "status_code": exc.code,
            "started_at": started_at,
            "completed_at": utc_now(),
            "error": parse_json_or_text(body),
            "retry_after": exc.headers.get("Retry-After"),
            "response_headers": dict(exc.headers.items()),
        }
    except urllib.error.URLError as exc:
        return {
            "query_key": query["query_key"],
            "person_id": query.get("person_id"),
            "display_name": query.get("display_name"),
            "query": query,
            "request": payload,
            "auth_source": config.source,
            "status": "network_error",
            "status_code": None,
            "started_at": started_at,
            "completed_at": utc_now(),
            "error": str(exc.reason),
        }


def search_once_with_browser_fallback(
    config: SearchConfig,
    query: dict[str, Any],
    *,
    page: int,
    size: int,
    timeout: float,
    verify_tls: bool,
    chrome_client: ChromeWorkerClient,
) -> dict[str, Any]:
    result = search_once(
        config,
        query,
        page=page,
        size=size,
        timeout=timeout,
        verify_tls=verify_tls,
        chrome_client=chrome_client,
    )
    classification, blocked_reason = classify_result(result)
    if classification != RESULT_BLOCKED or result.get("browserSessionUsed"):
        return result

    chrome_result = search_once_via_chrome(
        config,
        query,
        page=page,
        size=size,
        timeout=timeout,
        chrome_client=chrome_client,
    )
    chrome_result["browserFallbackUsed"] = True
    chrome_result["fallbackReason"] = blocked_reason or result.get("status") or "blocked"
    chrome_result["fallbackStatus"] = result.get("status")
    chrome_result["fallbackStatusCode"] = result.get("status_code")
    return chrome_result


def search_once_via_chrome(
    config: SearchConfig,
    query: dict[str, Any],
    *,
    page: int,
    size: int,
    timeout: float,
    chrome_client: ChromeWorkerClient,
) -> dict[str, Any]:
    payload = pamyat_payload(query, page=page, size=size)

    started_at = utc_now()
    try:
        browser_result = chrome_client.search(query, payload, timeout=timeout)
        update_config_from_chrome_payload(config, browser_result)
        parsed_response = parse_json_or_text(browser_result["body"])
        status, error = classify_search_response(parsed_response)
        browser_refresh_used = False
        if status == "blocked" or browser_result.get("status_code") in {401, 403, 419}:
            refresh_payload = chrome_client.refresh(query, timeout=timeout)
            update_config_from_chrome_payload(config, refresh_payload)
            browser_result = chrome_client.search(query, payload, timeout=timeout)
            update_config_from_chrome_payload(config, browser_result)
            parsed_response = parse_json_or_text(browser_result["body"])
            status, error = classify_search_response(parsed_response)
            browser_refresh_used = True
        result = {
            "query_key": query["query_key"],
            "person_id": query.get("person_id"),
            "display_name": query.get("display_name"),
            "query": query,
            "request": payload,
            "auth_source": config.source,
            "status": status,
            "status_code": browser_result["status_code"],
            "started_at": started_at,
            "completed_at": utc_now(),
            "response": parsed_response,
            "browser_content_type": browser_result.get("content_type"),
            "browserSessionUsed": True,
            "browserRefreshUsed": browser_refresh_used,
            "response_headers": browser_result.get("response_headers") or {},
            "retry_after": (browser_result.get("response_headers") or {}).get("retry-after"),
        }
        if error:
            result["error"] = error
        return result
    except Exception as exc:
        error_message = f"Chrome DevTools search fallback failed: {exc}"

    return {
        "query_key": query["query_key"],
        "person_id": query.get("person_id"),
        "display_name": query.get("display_name"),
        "query": query,
        "request": payload,
        "auth_source": config.source,
        "status": "error",
        "status_code": None,
        "started_at": started_at,
        "completed_at": utc_now(),
        "error": error_message,
    }


def update_config_from_chrome_payload(config: SearchConfig, payload: dict[str, Any]) -> None:
    cookie = payload.get("cookie")
    csrf_token = payload.get("csrf_token")
    if isinstance(cookie, str) and cookie.strip():
        config.cookie = cookie
    if isinstance(csrf_token, str) and csrf_token.strip():
        config.csrf_token = csrf_token
    user_agent = payload.get("user_agent")
    if isinstance(user_agent, str) and user_agent.strip():
        config.user_agent = user_agent
    accept_language = payload.get("accept_language")
    if isinstance(accept_language, str) and accept_language.strip():
        config.accept_language = accept_language
    if payload.get("source"):
        config.source = str(payload.get("source"))


def parse_chrome_search_output(output: str) -> dict[str, Any]:
    payload = parse_chrome_bootstrap_output(output)
    status_code = payload.get("status_code")
    body = payload.get("body")
    if not isinstance(status_code, int) or not isinstance(body, str):
        raise ValueError("Chrome DevTools search fallback did not return both status_code and body.")
    return payload


def parse_json_or_text(body: str) -> Any:
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return body


def classify_search_response(response: Any) -> tuple[str, str | None]:
    blocked_reason = blocked_reason_from_value(response)
    if blocked_reason:
        return "blocked", f"Portal returned anti-bot content: {blocked_reason}"

    if isinstance(response, dict):
        api_status = response.get("status")
        if api_status and api_status != "success":
            return "api_error", f"Portal API returned status: {api_status}"
        if isinstance(response.get("data"), list):
            return "ok", None
        return "unexpected_response", "Portal returned JSON without a data array."

    if isinstance(response, list):
        return "ok", None

    if isinstance(response, str):
        preview = response_preview(response)
        if response.lstrip().lower().startswith(("<!doctype", "<html")):
            return "unexpected_response", f"Portal returned HTML instead of JSON: {preview}"
        return "unexpected_response", f"Portal returned text instead of JSON: {preview}"

    return "unexpected_response", f"Portal returned unsupported response type: {type(response).__name__}"


def response_preview(value: str, limit: int = 220) -> str:
    compact = " ".join(value.split())
    if len(compact) <= limit:
        return compact
    return compact[:limit].rstrip() + "..."


def existing_query_keys(path: Path) -> set[str]:
    if not path.exists():
        return set()

    keys = set()
    with path.open("r", encoding="utf-8") as results:
        for line in results:
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            key = record.get("query_key")
            if key:
                keys.add(key)
    return keys


def append_result(path: Path, result: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as output:
        json.dump(result, output, ensure_ascii=False)
        output.write("\n")


def wait_between_requests(delay: float, jitter: float) -> None:
    if delay <= 0 and jitter <= 0:
        return
    seconds = max(0.0, delay + random.uniform(0, jitter))
    time.sleep(seconds)


def query_label(query: dict[str, Any]) -> str:
    parts = [
        query.get("last_name"),
        query.get("first_name"),
        query.get("middle_name"),
        query.get("birth_date_from"),
    ]
    return " ".join(str(part) for part in parts if part)


def result_short_summary(result: dict[str, Any]) -> str:
    if result.get("status") != "ok":
        return ""

    count = extract_result_count(result.get("response"))
    return f" | results={count}" if count is not None else ""


def extract_result_count(response: Any) -> int | None:
    if isinstance(response, dict):
        for key in ("count", "total", "total_count", "recordsTotal", "filteredTotal"):
            value = response.get(key)
            if isinstance(value, int):
                return value

        metadata = response.get("metadata")
        if isinstance(metadata, dict):
            count = extract_result_count(metadata)
            if count is not None:
                return count

        data = response.get("data")
        if isinstance(data, dict):
            count = extract_result_count(data)
            if count is not None:
                return count
        if isinstance(data, list):
            return len(data)

        result = response.get("result")
        if isinstance(result, dict):
            count = extract_result_count(result)
            if count is not None:
                return count
        if isinstance(result, list):
            return len(result)

        items = response.get("items")
        if isinstance(items, list):
            return len(items)

    if isinstance(response, list):
        return len(response)
    return None


def read_stdin_json_payload() -> dict[str, Any] | None:
    if sys.stdin.isatty():
        return None
    payload = sys.stdin.read().strip()
    if not payload:
        return None
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def maybe_run_app_search(payload: dict[str, Any]) -> dict[str, Any] | None:
    people = payload.get("people")
    if not isinstance(people, dict):
        return None

    person_ids = payload.get("personIds")
    if not isinstance(person_ids, list) or not person_ids:
        person_ids = list(people.keys())
    person_ids = [str(person_id) for person_id in person_ids if str(person_id).strip()]

    max_records = int(payload.get("maxRecordsPerPerson", 5))
    timeout = float(payload.get("timeout", 25))
    verify_tls = not bool(payload.get("insecureTls", False))
    chrome_headless = bool_from_payload(payload, "chromeHeadless", bool_from_payload(payload, "chrome_headless", True))
    runtime = ParserRuntime(
        RuntimeOptions.from_payload(
            payload,
            source=APP_SOURCE_KEY,
            default_request_delay_sec=2.0,
            default_request_jitter_sec=0.75,
            default_min_rate_interval_sec=2.0,
        )
    )

    search_criteria = normalize_search_criteria(payload.get("searchCriteria"))
    queries = app_queries_from_people(people, person_ids, search_criteria)
    if not queries:
        return {
            "source": APP_SOURCE_KEY,
            "sourceLabel": APP_SOURCE_LABEL,
            "matches": [],
            "matchedDataIds": [],
            "processedPersonIds": [],
            "errors": [],
            "metrics": runtime.summary(),
        }

    chrome_client = ChromeWorkerClient(
        accept_language=os.environ.get("PAMYAT_ACCEPT_LANGUAGE") or DEFAULT_ACCEPT_LANGUAGE,
        timeout=timeout,
        chrome_headless=chrome_headless,
    )
    try:
        config = load_config(DEFAULT_CONFIG_PATH, required=False)
        if config is None:
            first_query = queries[0]
            config = bootstrap_config(
                first_query,
                user_agent=os.environ.get("PAMYAT_USER_AGENT") or DEFAULT_USER_AGENT,
                accept_language=os.environ.get("PAMYAT_ACCEPT_LANGUAGE") or DEFAULT_ACCEPT_LANGUAGE,
                timeout=timeout,
                verify_tls=verify_tls,
            )
    except ValueError as exc:
        message = str(exc)
        chrome_client.close()
        runtime.log_summary()
        return {
            "source": APP_SOURCE_KEY,
            "sourceLabel": APP_SOURCE_LABEL,
            "matches": [],
            "matchedDataIds": [],
            "processedPersonIds": [],
            "errors": [{"person_id": None, "message": message}],
            "fatalError": message,
            "metrics": runtime.summary(),
        }

    matches: list[dict[str, Any]] = []
    matched_ids: list[str] = []
    errors: list[dict[str, Any]] = []
    processed_ids: list[str] = []

    try:
        for query in queries:
            person_id = str(query["person_id"])
            processed_ids.append(person_id)
            raw_result = runtime.run_query(
                query=query,
                url=API_URL,
                query_key=query["query_key"],
                request_fn=lambda attempt, query=query: search_once_with_browser_fallback(
                    config,
                    query,
                    page=1,
                    size=max(10, max_records * 2),
                    timeout=timeout,
                    verify_tls=verify_tls,
                    chrome_client=chrome_client,
                ),
            )
            if raw_result.get("status") != "ok":
                errors.append(
                    {
                        "person_id": person_id,
                        "message": f"Search failed with status={raw_result.get('status')}",
                        "status_code": raw_result.get("status_code"),
                        "details": raw_result.get("error"),
                    }
                )
                if raw_result.get("classification") == RESULT_BLOCKED and runtime.options.stop_on_blocked:
                    break
                continue

            documents = app_documents_from_response(query, raw_result.get("response"))
            if not documents:
                continue

            documents = documents[: max(1, max_records)]
            top_document = documents[0]
            match_payload = {
                "data_id": person_id,
                "source": APP_SOURCE_KEY,
                "sourceLabel": APP_SOURCE_LABEL,
                "score": top_document.get("score"),
                "person": {
                    "lastName": top_document.get("lastName", ""),
                    "name": top_document.get("name", ""),
                    "middleName": top_document.get("middleName", ""),
                    "birthDate": top_document.get("birthDate", ""),
                    "birthPlace": top_document.get("birthPlace", ""),
                    "information": top_document.get("information", ""),
                },
                "records": documents,
                "searchedAt": utc_now(),
            }
            if raw_result.get("browserFallbackUsed"):
                match_payload["browserFallbackUsed"] = True
            matches.append(match_payload)
            matched_ids.append(person_id)
    finally:
        chrome_client.close()

    runtime.log_summary()
    return {
        "source": APP_SOURCE_KEY,
        "sourceLabel": APP_SOURCE_LABEL,
        "matches": matches,
        "matchedDataIds": sorted(set(matched_ids)),
        "processedPersonIds": processed_ids,
        "errors": errors,
        "metrics": runtime.summary(),
    }


def normalize_search_criteria(raw: Any) -> dict[str, bool]:
    criteria = raw if isinstance(raw, dict) else {}
    return {
        "fullName": criteria.get("fullName") is not False,
        "birthDate": criteria.get("birthDate") is not False,
        "birthPlace": criteria.get("birthPlace") is not False,
    }


def app_queries_from_people(
    people: dict[str, Any],
    person_ids: list[str],
    search_criteria: dict[str, bool],
) -> list[dict[str, Any]]:
    queries: list[dict[str, Any]] = []
    for person_id in person_ids:
        person = people.get(person_id)
        if not isinstance(person, dict):
            continue
        full_name_enabled = bool(search_criteria.get("fullName"))
        birth_date_enabled = bool(search_criteria.get("birthDate"))
        birth_place_enabled = bool(search_criteria.get("birthPlace"))

        last_name = compact_text(person.get("lastName")) if full_name_enabled else ""
        first_name = compact_text(person.get("name")) if full_name_enabled else ""
        middle_name = compact_text(person.get("middleName")) if full_name_enabled else ""
        if full_name_enabled and (not last_name or not first_name):
            continue

        birth_date = normalize_partial_date(person.get("birthDate")) if birth_date_enabled else ""
        birth_year = birth_year_from_date(birth_date) if birth_date_enabled else None
        birth_date_from = str(birth_year) if birth_year else ""
        birth_place = compact_text(person.get("birthPlace")) if birth_place_enabled else ""
        if not any((last_name, first_name, middle_name, birth_date_from, birth_place)):
            continue
        display_name = " ".join(part for part in [last_name, first_name, middle_name] if part).strip()
        if not display_name:
            display_name = compact_text(person.get("id")) or person_id
        query_key = build_app_query_key(person_id, last_name, first_name, middle_name, birth_date_from, birth_place)
        queries.append(
            {
                "query_key": query_key,
                "person_id": person_id,
                "display_name": display_name,
                "last_name": last_name,
                "first_name": first_name,
                "middle_name": middle_name,
                "birth_date": birth_date,
                "birth_date_from": birth_date_from,
                "birth_place": birth_place,
                "search_criteria": search_criteria,
            }
        )
    return queries


def build_app_query_key(
    person_id: str,
    last_name: str,
    first_name: str,
    middle_name: str,
    birth_date_from: str,
    birth_place: str,
) -> str:
    digest = hashlib.sha1(
        "|".join([last_name, first_name, middle_name, birth_date_from, birth_place]).encode("utf-8")
    ).hexdigest()[:12]
    return f"app-{person_id}-{digest}"


def app_documents_from_response(
    query: dict[str, Any],
    response: Any,
) -> list[dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    for row in response_data_rows(response):
        source = row.get("_source") if isinstance(row, dict) and isinstance(row.get("_source"), dict) else row
        if not isinstance(source, dict):
            continue

        score = app_similarity_score(query, source)

        information = compact_text(source.get("short_desc"))
        birth_date = compact_text(source.get("date_birth"))
        birth_place = compact_text(source.get("place_birth"))
        document = {
            "source": APP_SOURCE_KEY,
            "sourceLabel": APP_SOURCE_LABEL,
            "title": app_result_title(source),
            "lastName": compact_text(source.get("last_name")),
            "name": compact_text(source.get("first_name")),
            "middleName": compact_text(source.get("middle_name")),
            "birthDate": normalize_birth_date_for_app(birth_date),
            "birthPlace": birth_place,
            "information": information,
            "score": round(score, 2),
            "url": app_result_url(source),
        }
        documents.append(document)

    documents.sort(key=lambda item: item.get("score", 0), reverse=True)
    return documents


def response_data_rows(response: Any) -> list[dict[str, Any]]:
    if isinstance(response, dict):
        data = response.get("data")
        if isinstance(data, list):
            return [row for row in data if isinstance(row, dict)]
        return []
    if isinstance(response, list):
        return [row for row in response if isinstance(row, dict)]
    return []


def app_similarity_score(query: dict[str, Any], source: dict[str, Any]) -> float:
    query_person = {
        "lastName": compact_text(query.get("last_name")),
        "name": compact_text(query.get("first_name")),
        "middleName": compact_text(query.get("middle_name")),
        "birthDate": normalize_partial_date(query.get("birth_date")) or str(birth_year_from_date(query.get("birth_date_from")) or ""),
        "birthPlace": compact_text(query.get("birth_place")),
    }
    source_person = {
        "lastName": compact_text(source.get("last_name")),
        "name": compact_text(source.get("first_name")),
        "middleName": compact_text(source.get("middle_name")),
        "birthDate": normalize_partial_date(source.get("date_birth")) or str(birth_year_from_date(source.get("date_birth")) or ""),
        "birthPlace": compact_text(source.get("place_birth")),
    }
    return SMART_MATCHING_SCORER.compare_idx2idx(query_person, source_person)


def app_result_title(source: dict[str, Any]) -> str:
    return " ".join(
        part
        for part in (
            compact_text(source.get("last_name")),
            compact_text(source.get("first_name")),
            compact_text(source.get("middle_name")),
        )
        if part
    ).strip()


def app_result_url(source: dict[str, Any]) -> str:
    guid = compact_text(source.get("guid"))
    if guid:
        return f"{ORIGIN}/heroes/person-hero{guid}/"
    entity_id = compact_text(source.get("id"))
    if entity_id:
        return f"{ORIGIN}/heroes/person-hero{entity_id}/"
    return ""


def normalize_birth_date_for_app(value: str) -> str:
    if not value:
        return ""
    normalized = value.replace("__.", "").replace("__. ", "").strip()
    return normalize_partial_date(value) or normalized


def birth_year_from_date(value: Any) -> int | None:
    text = compact_text(value)
    if not text:
        return None
    match = re.search(r"(18|19|20)\d{2}", text)
    if not match:
        return None
    year = int(match.group(0))
    return year


def compact_text(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).split())


def write_plan(queries: list[dict[str, Any]], output_path: Path | None) -> None:
    output = {"count": len(queries), "queries": queries}
    if output_path:
        output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    else:
        print(json.dumps(output, ensure_ascii=False, indent=2))


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prepare and run cautious Pamyat Naroda searches for people from a GEDCOM tree."
    )
    parser.add_argument("gedcom", nargs="?", type=Path, help="Path to .ged file. Defaults to the only .ged in cwd.")
    parser.add_argument("--execute", action="store_true", help="Actually send requests. Default is dry-run.")
    parser.add_argument("--auth", choices=("auto", "config"), default="auto", help="auto bootstraps a public session if config is missing.")
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG_PATH,
        help=f"JSON file with cookie/csrf_token/user_agent. Defaults to {DEFAULT_CONFIG_PATH}.",
    )
    parser.add_argument("--results", type=Path, default=DEFAULT_RESULTS_PATH, help="JSONL result cache.")
    parser.add_argument("--plan-output", type=Path, help="Write dry-run query plan as JSON.")
    parser.add_argument("--scope", choices=("wartime", "all"), default="wartime", help="wartime limits by birth year.")
    parser.add_argument("--birth-year-from", type=int, default=1870, help="First birth year for --scope wartime.")
    parser.add_argument("--birth-year-to", type=int, default=1930, help="Last birth year for --scope wartime.")
    parser.add_argument("--person-id", help="Search one GEDCOM person id, for example @I1@.")
    parser.add_argument("--person-name", help='Search one person by name, for example "TEST_FIRST TEST_LAST".')
    parser.add_argument("--limit", type=int, default=10, help="Max new queries this run.")
    parser.add_argument("--delay", type=float, default=15.0, help="Base delay between requests in seconds.")
    parser.add_argument("--jitter", type=float, default=5.0, help="Additional random delay in seconds.")
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--size", type=int, default=10)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--max-retries", type=int, default=1, help="Retries for 429/5xx responses.")
    parser.add_argument("--min-rate-interval", type=float, default=None, help="Minimum per-host interval between requests.")
    parser.add_argument("--stop-on-blocked", dest="stop_on_blocked", action="store_true", default=True, help="Stop the run when captcha/challenge/rate-limit is detected.")
    parser.add_argument("--continue-on-blocked", dest="stop_on_blocked", action="store_false", help="Continue after blocked results when the circuit breaker allows it.")
    parser.add_argument("--chrome-visible", action="store_true", help="Opt in to a visible Chrome window for the fallback. Default is headless background Chrome.")
    parser.add_argument("--insecure-tls", action="store_true", help="Disable TLS certificate verification if local Python cannot verify the portal certificate.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        tree = load_tree(args.gedcom)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    all_queries = list(
        iter_queries(
            tree,
            scope=args.scope,
            birth_year_from=args.birth_year_from,
            birth_year_to=args.birth_year_to,
            person_id=args.person_id,
            person_name=args.person_name,
        )
    )

    completed_keys = existing_query_keys(args.results)
    pending_queries = [query for query in all_queries if query["query_key"] not in completed_keys]
    limited_queries = pending_queries[: args.limit] if args.limit > 0 else pending_queries

    if not args.execute:
        write_plan(limited_queries, args.plan_output)
        print(
            f"Dry-run only: {len(limited_queries)} pending queries shown, "
            f"{len(completed_keys)} cached, {len(all_queries)} total in scope.",
            file=sys.stderr,
        )
        return 0

    if not limited_queries:
        print(f"No pending queries. Cached: {len(completed_keys)}, total in scope: {len(all_queries)}.")
        return 0

    try:
        config = load_config(args.config, required=args.auth == "config")
        if config is None:
            config = bootstrap_config(
                limited_queries[0],
                user_agent=os.environ.get("PAMYAT_USER_AGENT") or DEFAULT_USER_AGENT,
                accept_language=os.environ.get("PAMYAT_ACCEPT_LANGUAGE") or DEFAULT_ACCEPT_LANGUAGE,
                timeout=args.timeout,
                verify_tls=not args.insecure_tls,
            )
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    runtime = ParserRuntime(
        RuntimeOptions(
            source=APP_SOURCE_KEY,
            request_delay_sec=max(0.0, args.delay),
            request_jitter_sec=max(0.0, args.jitter),
            max_retries=max(0, args.max_retries),
            min_rate_interval_sec=max(0.0, args.min_rate_interval if args.min_rate_interval is not None else args.delay),
            stop_on_blocked=bool(args.stop_on_blocked),
        )
    )
    chrome_client = ChromeWorkerClient(
        accept_language=config.accept_language,
        timeout=args.timeout,
        chrome_headless=not args.chrome_visible,
    )

    print(
        f"Executing {len(limited_queries)} query/queries with {config.source} auth and delay {args.delay}+0..{args.jitter}s. "
        f"Results: {args.results}"
    )
    exit_code = 0
    try:
        for index, query in enumerate(limited_queries, start=1):
            result = run_with_retries(config, query, args, runtime=runtime, chrome_client=chrome_client)
            append_result(args.results, result)
            print(
                f"{index}/{len(limited_queries)} {result['status']} {result.get('status_code')}: "
                f"{query_label(query)}{result_short_summary(result)}"
            )

            if result.get("classification") == RESULT_BLOCKED and runtime.options.stop_on_blocked:
                print("Portal returned an anti-bot/rate-limit response. Stopping this run to avoid spam.", file=sys.stderr)
                exit_code = 1
                break
    finally:
        chrome_client.close()
        runtime.log_summary()

    return exit_code


def run_with_retries(
    config: SearchConfig,
    query: dict[str, Any],
    args: argparse.Namespace,
    *,
    runtime: ParserRuntime,
    chrome_client: ChromeWorkerClient,
) -> dict[str, Any]:
    return runtime.run_query(
        query=query,
        url=API_URL,
        query_key=query["query_key"],
        request_fn=lambda attempt: search_once_with_browser_fallback(
            config,
            query,
            page=args.page,
            size=args.size,
            timeout=args.timeout,
            verify_tls=not args.insecure_tls,
            chrome_client=chrome_client,
        ),
    )


if __name__ == "__main__":
    stdin_payload = read_stdin_json_payload()
    if stdin_payload is not None:
        app_result = maybe_run_app_search(stdin_payload)
        if app_result is not None:
            print(json.dumps(app_result, ensure_ascii=False))
            raise SystemExit(0 if not app_result.get("fatalError") else 1)

    raise SystemExit(main())
