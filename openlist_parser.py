#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Any


API_URL = "https://ru.openlist.wiki/api.php"
ORIGIN = "https://ru.openlist.wiki"
REFERER = f"{ORIGIN}/{urllib.parse.quote('Открытый_список:Заглавная_страница')}"
SOURCE_KEY = "openList"
SOURCE_LABEL = "Открытый список"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)
DEFAULT_ACCEPT_LANGUAGE = "ru,en-US;q=0.9,en;q=0.8"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def openlist_search_text(query: dict[str, Any]) -> str:
    return " ".join(
        str(part).strip()
        for part in (
            query.get("last_name"),
            query.get("first_name"),
            query.get("middle_name"),
        )
        if str(part or "").strip()
    )


def openlist_payload(query: dict[str, Any], size: int) -> dict[str, Any]:
    return {
        "action": "opensearch",
        "format": "json",
        "formatversion": "2",
        "search": openlist_search_text(query),
        "namespace": "0",
        "limit": str(size),
        "suggest": "true",
    }


def search_openlist_once(
    query: dict[str, Any],
    *,
    size: int,
    timeout: float,
    user_agent: str,
    accept_language: str,
    verify_tls: bool = True,
) -> dict[str, Any]:
    return search_openlist_once_with_tls_fallback(
        query=query,
        size=size,
        timeout=timeout,
        user_agent=user_agent,
        accept_language=accept_language,
        verify_tls=verify_tls,
    )


def search_openlist_once_with_tls_fallback(
    query: dict[str, Any],
    *,
    size: int,
    timeout: float,
    user_agent: str,
    accept_language: str,
    verify_tls: bool,
) -> dict[str, Any]:
    primary_error: urllib.error.URLError | None = None
    try:
        return search_openlist_raw(
            query=query,
            size=size,
            timeout=timeout,
            user_agent=user_agent,
            accept_language=accept_language,
            verify_tls=verify_tls,
        )
    except urllib.error.URLError as exc:
        primary_error = exc
        if verify_tls and is_tls_verification_error(exc):
            try:
                return search_openlist_raw(
                    query=query,
                    size=size,
                    timeout=timeout,
                    user_agent=user_agent,
                    accept_language=accept_language,
                    verify_tls=False,
                )
            except urllib.error.URLError:
                pass

    if primary_error is None:
        primary_error = urllib.error.URLError("Unknown network error")

    params = openlist_payload(query, size=size)
    result = base_result(query, params, utc_now())
    result.update(
        {
            "status": "network_error",
            "status_code": None,
            "completed_at": utc_now(),
            "error": str(primary_error.reason),
        }
    )
    return result


def search_openlist_raw(
    query: dict[str, Any],
    *,
    size: int,
    timeout: float,
    user_agent: str,
    accept_language: str,
    verify_tls: bool,
) -> dict[str, Any]:
    params = openlist_payload(query, size=size)
    url = f"{API_URL}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": accept_language,
            "DNT": "1",
            "Referer": REFERER,
            "User-Agent": user_agent,
            "X-Requested-With": "XMLHttpRequest",
        },
        method="GET",
    )

    started_at = utc_now()
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=tls_context(verify_tls)) as response:
            body = response.read().decode("utf-8", errors="replace")
            parsed_response = parse_json_or_text(body)
            normalized = normalize_opensearch_response(parsed_response)
            status, error = classify_openlist_response(normalized)
            result = base_result(query, params, started_at)
            result.update(
                {
                    "status": status,
                    "status_code": response.status,
                    "completed_at": utc_now(),
                    "response": normalized,
                }
            )
            if error:
                result["error"] = error
            if not verify_tls:
                result["tlsFallbackUsed"] = True
            return result
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        result = base_result(query, params, started_at)
        result.update(
            {
                "status": "http_error",
                "status_code": exc.code,
                "completed_at": utc_now(),
                "error": parse_json_or_text(body),
            }
        )
        if not verify_tls:
            result["tlsFallbackUsed"] = True
        return result
    except urllib.error.URLError:
        raise


def base_result(query: dict[str, Any], params: dict[str, Any], started_at: str) -> dict[str, Any]:
    return {
        "source": SOURCE_KEY,
        "source_label": SOURCE_LABEL,
        "query_key": f"{query['query_key']}|{SOURCE_KEY}",
        "person_id": query.get("person_id"),
        "display_name": query.get("display_name"),
        "query": query,
        "request": {
            "url": API_URL,
            "parameters": params,
        },
        "started_at": started_at,
    }


def tls_context(verify: bool) -> ssl.SSLContext | None:
    return None if verify else ssl._create_unverified_context()


def is_tls_verification_error(error: urllib.error.URLError) -> bool:
    reason = getattr(error, "reason", None)
    if isinstance(reason, ssl.SSLCertVerificationError):
        return True
    if isinstance(reason, ssl.SSLError):
        return "CERTIFICATE_VERIFY_FAILED" in str(reason).upper()
    return "CERTIFICATE_VERIFY_FAILED" in str(reason).upper()


def parse_json_or_text(body: str) -> Any:
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return body


def normalize_opensearch_response(response: Any) -> Any:
    if not isinstance(response, list) or len(response) < 4:
        return response

    search = response[0]
    titles = response[1] if isinstance(response[1], list) else []
    descriptions = response[2] if isinstance(response[2], list) else []
    urls = response[3] if isinstance(response[3], list) else []
    max_len = max(len(titles), len(descriptions), len(urls))
    items = []
    for index in range(max_len):
        title = value_at(titles, index)
        description = value_at(descriptions, index)
        url = value_at(urls, index)
        if not title and not url:
            continue
        items.append(
            {
                "source": SOURCE_KEY,
                "source_label": SOURCE_LABEL,
                "title": title,
                "description": description,
                "url": url,
            }
        )

    return {
        "status": "success",
        "search": search,
        "data": items,
        "metadata": {"total": len(items)},
        "raw": response,
    }


def value_at(values: list[Any], index: int) -> str:
    if index >= len(values):
        return ""
    value = values[index]
    return "" if value is None else str(value)


def classify_openlist_response(response: Any) -> tuple[str, str | None]:
    if isinstance(response, dict) and isinstance(response.get("data"), list):
        return "ok", None
    if isinstance(response, str):
        return "unexpected_response", f"OpenList returned text instead of JSON: {response[:220]}"
    return "unexpected_response", f"OpenList returned unsupported response type: {type(response).__name__}"


def compact_text(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).split()).strip()


def birth_year_from_date(value: Any) -> str:
    text = compact_text(value)
    if not text:
        return ""
    parts = text.split("-")
    return parts[0] if parts and parts[0].isdigit() else ""


def build_app_query_key(
    person_id: str,
    last_name: str,
    first_name: str,
    middle_name: str,
    birth_year: str,
    birth_place: str,
) -> str:
    digest = hashlib.sha1(
        "|".join([last_name, first_name, middle_name, birth_year, birth_place]).encode("utf-8")
    ).hexdigest()[:12]
    return f"app-{person_id}-{digest}"


def app_queries_from_people(people: dict[str, Any], person_ids: list[str]) -> list[dict[str, Any]]:
    queries: list[dict[str, Any]] = []
    for person_id in person_ids:
        person = people.get(person_id)
        if not isinstance(person, dict):
            continue
        last_name = compact_text(person.get("lastName"))
        first_name = compact_text(person.get("name"))
        middle_name = compact_text(person.get("middleName"))
        if not last_name or not first_name:
            continue

        birth_year = birth_year_from_date(person.get("birthDate"))
        birth_place = compact_text(person.get("birthPlace"))
        display_name = " ".join(part for part in [last_name, first_name, middle_name] if part).strip()
        query_key = build_app_query_key(person_id, last_name, first_name, middle_name, birth_year, birth_place)
        queries.append(
            {
                "query_key": query_key,
                "person_id": person_id,
                "display_name": display_name,
                "last_name": last_name,
                "first_name": first_name,
                "middle_name": middle_name,
                "birth_year": birth_year,
                "birth_place": birth_place,
            }
        )
    return queries


def tokenize(value: str) -> list[str]:
    return [token for token in compact_text(value).lower().split(" ") if token]


def app_similarity_score(query: dict[str, Any], title: str) -> float:
    query_name = " ".join(
        part
        for part in [
            compact_text(query.get("last_name")),
            compact_text(query.get("first_name")),
            compact_text(query.get("middle_name")),
        ]
        if part
    ).strip()
    if not query_name:
        return 0.0
    ratio = SequenceMatcher(None, query_name.lower(), compact_text(title).lower()).ratio() * 100
    query_tokens = set(tokenize(query_name))
    title_tokens = set(tokenize(title))
    token_bonus = 0.0
    if query_tokens:
        token_bonus = (len(query_tokens & title_tokens) / len(query_tokens)) * 20.0
    return min(100.0, ratio + token_bonus)


def app_records_from_response(query: dict[str, Any], response: Any, max_records: int) -> list[dict[str, Any]]:
    if not isinstance(response, dict):
        return []
    items = response.get("data")
    if not isinstance(items, list):
        return []

    records: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        title = compact_text(item.get("title"))
        description = compact_text(item.get("description"))
        url = compact_text(item.get("url"))
        if not title and not description and not url:
            continue
        records.append(
            {
                "source": SOURCE_KEY,
                "sourceLabel": SOURCE_LABEL,
                "title": title or query.get("display_name") or "Запись",
                "information": description,
                "url": url,
                "birthDate": "",
                "birthPlace": "",
                "score": app_similarity_score(query, title or description),
            }
        )

    records.sort(key=lambda record: record.get("score", 0), reverse=True)
    return records[: max(1, max_records)]


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

    max_records = max(1, int(payload.get("maxRecordsPerPerson", 5)))
    timeout = float(payload.get("timeout", 20))
    verify_tls = not bool(payload.get("insecureTls", False))
    user_agent = str(payload.get("userAgent") or DEFAULT_USER_AGENT)
    accept_language = str(payload.get("acceptLanguage") or DEFAULT_ACCEPT_LANGUAGE)

    queries = app_queries_from_people(people, person_ids)
    if not queries:
        return {
            "source": SOURCE_KEY,
            "sourceLabel": SOURCE_LABEL,
            "matches": [],
            "matchedDataIds": [],
            "processedPersonIds": [],
            "errors": [],
        }

    matches: list[dict[str, Any]] = []
    matched_ids: list[str] = []
    errors: list[dict[str, Any]] = []
    processed_ids: list[str] = []

    for query in queries:
        person_id = str(query["person_id"])
        processed_ids.append(person_id)
        raw_result = search_openlist_once(
            query,
            size=max(10, max_records * 2),
            timeout=timeout,
            user_agent=user_agent,
            accept_language=accept_language,
            verify_tls=verify_tls,
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
            continue

        records = app_records_from_response(query, raw_result.get("response"), max_records=max_records)
        if not records:
            continue

        match_payload = {
            "data_id": person_id,
            "source": SOURCE_KEY,
            "sourceLabel": SOURCE_LABEL,
            "score": records[0].get("score"),
            "person": {
                "lastName": compact_text(query.get("last_name")),
                "name": compact_text(query.get("first_name")),
                "middleName": compact_text(query.get("middle_name")),
                "birthDate": "",
                "birthPlace": compact_text(query.get("birth_place")),
                "information": records[0].get("information", ""),
            },
            "records": records,
            "searchedAt": utc_now(),
        }
        if raw_result.get("tlsFallbackUsed"):
            match_payload["tlsFallbackUsed"] = True
        matches.append(match_payload)
        matched_ids.append(person_id)

    return {
        "source": SOURCE_KEY,
        "sourceLabel": SOURCE_LABEL,
        "matches": matches,
        "matchedDataIds": sorted(set(matched_ids)),
        "processedPersonIds": processed_ids,
        "errors": errors,
    }


if __name__ == "__main__":
    stdin_payload = read_stdin_json_payload()
    if stdin_payload is not None:
        app_result = maybe_run_app_search(stdin_payload)
        if app_result is not None:
            print(json.dumps(app_result, ensure_ascii=False))
            raise SystemExit(0)
    print("openlist_parser.py expects app-search JSON payload on stdin.", file=sys.stderr)
    raise SystemExit(1)