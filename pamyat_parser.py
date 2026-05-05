#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import random
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from gedcom_parser import build_tree, default_gedcom_path, parse_gedcom


API_URL = "https://pamyat-naroda.ru/entrypoint/api/"
ORIGIN = "https://pamyat-naroda.ru"
DEFAULT_CONFIG_PATH = Path("pamyat_config.json")
DEFAULT_RESULTS_PATH = Path("pamyat_results.jsonl")
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
)
DEFAULT_ACCEPT_LANGUAGE = "ru,en-US;q=0.9,en;q=0.8"

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
        if "Servicepipe anti-bot challenge" not in previous_error:
            raise
        ensure_chrome_devtools_fallback_available()
        return SearchConfig(
            cookie="",
            csrf_token="",
            user_agent=user_agent,
            accept_language=accept_language,
            source="chrome_devtools",
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
) -> SearchConfig:
    script_path = Path(__file__).with_name("pamyat_chrome_bootstrap.mjs")
    if not script_path.exists():
        raise ValueError(f"Chrome bootstrap helper not found: {script_path}")

    command = [
        "node",
        str(script_path),
        "--url",
        referer_for_query(first_query),
        "--accept-language",
        accept_language,
        "--timeout-ms",
        str(max(int(timeout * 1000), 15000)),
    ]
    try:
        completed = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=max(timeout + 20.0, 40.0),
        )
    except FileNotFoundError as exc:
        raise ValueError("Node.js is required for the Chrome DevTools bootstrap fallback.") from exc
    except subprocess.TimeoutExpired as exc:
        raise ValueError("Chrome DevTools bootstrap timed out before the page exposed cookies and CSRF token.") from exc
    except subprocess.CalledProcessError as exc:
        message = exc.stderr.strip() or exc.stdout.strip() or "Unknown Chrome DevTools bootstrap error."
        raise ValueError(message) from exc

    payload = parse_chrome_bootstrap_output(completed.stdout)
    return SearchConfig(
        cookie=payload["cookie"],
        csrf_token=payload["csrf_token"],
        user_agent=payload.get("user_agent") or user_agent,
        accept_language=payload.get("accept_language") or accept_language,
        source=payload.get("source") or "chrome_devtools",
    )


def ensure_chrome_devtools_fallback_available() -> None:
    script_path = Path(__file__).with_name("pamyat_chrome_bootstrap.mjs")
    if not script_path.exists():
        raise ValueError(f"Chrome bootstrap helper not found: {script_path}")
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
            "The app will try a visible Chrome DevTools fallback first. "
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
) -> dict[str, Any]:
    if config.source == "chrome_devtools":
        return search_once_via_chrome(config, query, page=page, size=size, timeout=timeout)

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


def search_once_via_chrome(
    config: SearchConfig,
    query: dict[str, Any],
    *,
    page: int,
    size: int,
    timeout: float,
) -> dict[str, Any]:
    payload = pamyat_payload(query, page=page, size=size)
    encoded_payload = base64.b64encode(json.dumps(payload, ensure_ascii=False).encode("utf-8")).decode("ascii")
    command = [
        "node",
        str(Path(__file__).with_name("pamyat_chrome_bootstrap.mjs")),
        "--url",
        referer_for_query(query),
        "--accept-language",
        config.accept_language,
        "--timeout-ms",
        str(max(int(timeout * 1000), 15000)),
        "--search-payload-base64",
        encoded_payload,
    ]

    started_at = utc_now()
    try:
        completed = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=max(timeout + 20.0, 40.0),
        )
        browser_result = parse_chrome_search_output(completed.stdout)
        parsed_response = parse_json_or_text(browser_result["body"])
        status, error = classify_search_response(parsed_response)
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
        }
        if error:
            result["error"] = error
        return result
    except FileNotFoundError as exc:
        error_message = f"Node.js is required for the Chrome DevTools search fallback: {exc}"
    except subprocess.TimeoutExpired:
        error_message = "Chrome DevTools search fallback timed out."
    except subprocess.CalledProcessError as exc:
        error_message = exc.stderr.strip() or exc.stdout.strip() or "Unknown Chrome DevTools search fallback error."

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

    print(
        f"Executing {len(limited_queries)} query/queries with {config.source} auth and delay {args.delay}+0..{args.jitter}s. "
        f"Results: {args.results}"
    )
    for index, query in enumerate(limited_queries, start=1):
        result = run_with_retries(config, query, args)
        append_result(args.results, result)
        print(
            f"{index}/{len(limited_queries)} {result['status']} {result.get('status_code')}: "
            f"{query_label(query)}{result_short_summary(result)}"
        )

        if result.get("status_code") == 429:
            print("Portal returned HTTP 429. Stopping this run to avoid spam.", file=sys.stderr)
            return 1

        if index < len(limited_queries):
            wait_between_requests(args.delay, args.jitter)

    return 0


def run_with_retries(config: SearchConfig, query: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    attempt = 0
    while True:
        result = search_once(
            config,
            query,
            page=args.page,
            size=args.size,
            timeout=args.timeout,
            verify_tls=not args.insecure_tls,
        )
        status_code = result.get("status_code")
        if status_code not in {429, 500, 502, 503, 504} or attempt >= args.max_retries:
            if attempt:
                result["attempts"] = attempt + 1
            return result

        attempt += 1
        retry_delay = max(args.delay, 30.0) * attempt
        print(
            f"Retryable status {status_code} for {query_label(query)}; sleeping {retry_delay:.0f}s.",
            file=sys.stderr,
        )
        time.sleep(retry_delay)


if __name__ == "__main__":
    raise SystemExit(main())