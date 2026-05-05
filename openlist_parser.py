#!/usr/bin/env python3
from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any


API_URL = "https://ru.openlist.wiki/api.php"
ORIGIN = "https://ru.openlist.wiki"
REFERER = f"{ORIGIN}/{urllib.parse.quote('Открытый_список:Заглавная_страница')}"
SOURCE_KEY = "openlist"
SOURCE_LABEL = "Открытый список"


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
        return result
    except urllib.error.URLError as exc:
        result = base_result(query, params, started_at)
        result.update(
            {
                "status": "network_error",
                "status_code": None,
                "completed_at": utc_now(),
                "error": str(exc.reason),
            }
        )
        return result


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