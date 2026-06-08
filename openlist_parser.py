#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from difflib import SequenceMatcher
from html.parser import HTMLParser
from typing import Any

from parser_runtime import RESULT_BLOCKED, ParserRuntime, RuntimeOptions


API_URL = "https://ru.openlist.wiki/api.php"
ORIGIN = "https://ru.openlist.wiki"
OL_SEARCH_URL = f"{ORIGIN}/{urllib.parse.quote('Служебная:OlSearch')}"
REFERER = f"{ORIGIN}/{urllib.parse.quote('Открытый_список:Заглавная_страница')}"
SOURCE_KEY = "openList"
SOURCE_LABEL = "Открытый список"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)
DEFAULT_ACCEPT_LANGUAGE = "ru,en-US;q=0.9,en;q=0.8"
NETWORK_EXCEPTIONS = (urllib.error.URLError, TimeoutError, socket.timeout)


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
                "retry_after": exc.headers.get("Retry-After"),
                "response_headers": dict(exc.headers.items()),
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


class OpenListTableHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._inside_table = False
        self._table_div_depth = 0
        self._inside_row = False
        self._inside_cell = False
        self._current_cell_index = -1
        self._current_row: dict[str, str] | None = None
        self._rows: list[dict[str, str]] = []
        self._capture_link_text = False
        self._capture_link_href = ""

    @property
    def rows(self) -> list[dict[str, str]]:
        return self._rows

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = dict(attrs)
        if tag == "div" and attrs_dict.get("id") == "OlSearch-results-table":
            self._inside_table = True
            self._table_div_depth = 1
            return
        if self._inside_table and tag == "div":
            self._table_div_depth += 1
        if not self._inside_table:
            return
        if tag == "tr":
            self._inside_row = True
            self._current_row = {
                "title": "",
                "url": "",
                "birthDate": "",
                "birthPlace": "",
            }
            self._current_cell_index = -1
            return
        if not self._inside_row:
            return
        if tag == "td":
            self._inside_cell = True
            self._current_cell_index += 1
            return
        if tag == "a" and self._inside_cell and self._current_cell_index == 0:
            self._capture_link_text = True
            self._capture_link_href = attrs_dict.get("href") or ""
            if self._current_row is not None and self._capture_link_href:
                self._current_row["url"] = urllib.parse.urljoin(ORIGIN, self._capture_link_href)

    def handle_endtag(self, tag: str) -> None:
        if tag == "div" and self._inside_table:
            self._table_div_depth -= 1
            if self._table_div_depth <= 0:
                self._inside_table = False
                self._table_div_depth = 0
            return
        if not self._inside_table:
            return
        if tag == "a":
            self._capture_link_text = False
            return
        if tag == "td":
            self._inside_cell = False
            return
        if tag == "tr" and self._inside_row:
            self._inside_row = False
            if self._current_row is None:
                return
            row = {
                "title": compact_text(self._current_row.get("title")),
                "url": compact_text(self._current_row.get("url")),
                "birthDate": compact_text(self._current_row.get("birthDate")),
                "birthPlace": compact_text(self._current_row.get("birthPlace")),
            }
            if row["title"] or row["url"]:
                self._rows.append(row)
            self._current_row = None
            self._current_cell_index = -1

    def handle_data(self, data: str) -> None:
        if not self._inside_table or not self._inside_row or self._current_row is None:
            return
        text = compact_text(data)
        if not text:
            return
        if self._capture_link_text and self._current_cell_index == 0:
            self._current_row["title"] = f"{self._current_row.get('title', '')} {text}".strip()
            return
        if self._current_cell_index == 1:
            self._current_row["birthDate"] = f"{self._current_row.get('birthDate', '')} {text}".strip()
            return
        if self._current_cell_index == 2:
            self._current_row["birthPlace"] = f"{self._current_row.get('birthPlace', '')} {text}".strip()


def parse_openlist_table_rows(html: str) -> list[dict[str, str]]:
    parser = OpenListTableHTMLParser()
    parser.feed(html)
    parser.close()
    return parser.rows


def openlist_table_payload(query: dict[str, Any]) -> dict[str, str]:
    fio = openlist_search_text(query)
    return {
        "olsearch-name": fio,
        "olsearch-run": "1",
        "olsearch-advform": "1",
        "printable": "yes",
    }


def fetch_openlist_table_rows(
    query: dict[str, Any],
    *,
    timeout: float,
    user_agent: str,
    accept_language: str,
    verify_tls: bool,
) -> list[dict[str, str]]:
    return fetch_openlist_table_rows_with_tls_fallback(
        query=query,
        timeout=timeout,
        user_agent=user_agent,
        accept_language=accept_language,
        verify_tls=verify_tls,
    )


def fetch_openlist_table_rows_with_tls_fallback(
    query: dict[str, Any],
    *,
    timeout: float,
    user_agent: str,
    accept_language: str,
    verify_tls: bool,
) -> list[dict[str, str]]:
    try:
        return fetch_openlist_table_rows_raw(
            query=query,
            timeout=timeout,
            user_agent=user_agent,
            accept_language=accept_language,
            verify_tls=verify_tls,
        )
    except NETWORK_EXCEPTIONS as exc:
        if verify_tls and is_tls_verification_error(exc):
            try:
                return fetch_openlist_table_rows_raw(
                    query=query,
                    timeout=timeout,
                    user_agent=user_agent,
                    accept_language=accept_language,
                    verify_tls=False,
                )
            except NETWORK_EXCEPTIONS:
                return []
        return []


def fetch_openlist_table_rows_raw(
    query: dict[str, Any],
    *,
    timeout: float,
    user_agent: str,
    accept_language: str,
    verify_tls: bool,
) -> list[dict[str, str]]:
    params = urllib.parse.urlencode(openlist_table_payload(query))
    url = f"{OL_SEARCH_URL}?{params}"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": accept_language,
            "DNT": "1",
            "Referer": REFERER,
            "User-Agent": user_agent,
        },
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=timeout, context=tls_context(verify_tls)) as response:
        body = response.read().decode("utf-8", errors="replace")
    return parse_openlist_table_rows(body)


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


def normalize_search_criteria(raw: Any) -> dict[str, bool]:
    criteria = raw if isinstance(raw, dict) else {}
    return {
        "fullName": criteria.get("fullName") is not False,
        "birthDate": criteria.get("birthDate") is not False,
        "birthPlace": criteria.get("birthPlace") is not False,
    }


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

        birth_year = birth_year_from_date(person.get("birthDate")) if birth_date_enabled else ""
        birth_place = compact_text(person.get("birthPlace")) if birth_place_enabled else ""
        if not any((last_name, first_name, middle_name, birth_year, birth_place)):
            continue
        display_name = " ".join(part for part in [last_name, first_name, middle_name] if part).strip()
        if not display_name:
            display_name = compact_text(person.get("id")) or person_id
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
                "search_criteria": search_criteria,
            }
        )
    return queries


def tokenize(value: str) -> list[str]:
    return [token for token in compact_text(value).lower().split(" ") if token]


def app_similarity_score(query: dict[str, Any], title: str) -> float:
    search_criteria = normalize_search_criteria(query.get("search_criteria"))
    weighted_scores: list[tuple[float, float]] = []

    query_name = " ".join(
        part
        for part in [
            compact_text(query.get("last_name")),
            compact_text(query.get("first_name")),
            compact_text(query.get("middle_name")),
        ]
        if part
    ).strip()
    title_text = compact_text(title).lower()
    title_tokens = set(tokenize(title))

    if search_criteria.get("fullName") and query_name:
        ratio = SequenceMatcher(None, query_name.lower(), title_text).ratio() * 100
        query_tokens = set(tokenize(query_name))
        token_bonus = 0.0
        if query_tokens:
            token_bonus = (len(query_tokens & title_tokens) / len(query_tokens)) * 20.0
        weighted_scores.append((min(100.0, ratio + token_bonus), 0.7))

    if search_criteria.get("birthDate"):
        query_year = birth_year_from_date(query.get("birth_year"))
        birth_score = 0.0
        if query_year:
            birth_score = 100.0 if query_year in title_text else 0.0
        weighted_scores.append((birth_score, 0.2))

    if search_criteria.get("birthPlace"):
        query_place = compact_text(query.get("birth_place")).lower()
        place_score = 0.0
        if query_place:
            place_score = SequenceMatcher(None, query_place, title_text).ratio() * 100.0
        weighted_scores.append((place_score, 0.1))

    if not weighted_scores:
        return 0.0
    total_weight = sum(weight for _, weight in weighted_scores)
    return sum(score * weight for score, weight in weighted_scores) / total_weight


def split_fio(value: str) -> tuple[str, str, str]:
    parts = compact_text(value).split(" ")
    last_name = parts[0] if len(parts) > 0 else ""
    first_name = parts[1] if len(parts) > 1 else ""
    middle_name = " ".join(parts[2:]).strip() if len(parts) > 2 else ""
    return last_name, first_name, middle_name


def app_records_from_response(
    query: dict[str, Any],
    response: Any,
    max_records: int,
    table_rows: list[dict[str, str]] | None = None,
) -> list[dict[str, Any]]:
    table_rows = table_rows or []
    if not isinstance(response, dict):
        response_items: list[dict[str, Any]] = []
    else:
        response_items = response.get("data") if isinstance(response.get("data"), list) else []

    description_by_url: dict[str, str] = {}
    description_by_title: dict[str, str] = {}
    for item in response_items:
        if not isinstance(item, dict):
            continue
        title = compact_text(item.get("title"))
        description = compact_text(item.get("description"))
        url = compact_text(item.get("url"))
        if url and description and url not in description_by_url:
            description_by_url[url] = description
        if title and description and title not in description_by_title:
            description_by_title[title] = description

    if table_rows:
        records: list[dict[str, Any]] = []
        for row in table_rows:
            if not isinstance(row, dict):
                continue
            title = compact_text(row.get("title"))
            url = compact_text(row.get("url"))
            birth_date = compact_text(row.get("birthDate"))
            birth_place = compact_text(row.get("birthPlace"))
            if not title and not url:
                continue
            information = (
                description_by_url.get(url)
                or description_by_title.get(title)
                or ""
            )
            records.append(
                {
                    "source": SOURCE_KEY,
                    "sourceLabel": SOURCE_LABEL,
                    "title": title or query.get("display_name") or "Запись",
                    "information": information,
                    "url": url,
                    "birthDate": birth_date,
                    "birthPlace": birth_place,
                    "score": app_similarity_score(query, title),
                }
            )
        records.sort(key=lambda record: record.get("score", 0), reverse=True)
        return records[: max(1, max_records)]

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
    runtime = ParserRuntime(
        RuntimeOptions.from_payload(
            payload,
            source=SOURCE_KEY,
            default_request_delay_sec=1.0,
            default_request_jitter_sec=0.35,
            default_min_rate_interval_sec=1.0,
        )
    )

    search_criteria = normalize_search_criteria(payload.get("searchCriteria"))
    queries = app_queries_from_people(people, person_ids, search_criteria)
    if not queries:
        return {
            "source": SOURCE_KEY,
            "sourceLabel": SOURCE_LABEL,
            "matches": [],
            "matchedDataIds": [],
            "processedPersonIds": [],
            "errors": [],
            "metrics": runtime.summary(),
        }

    matches: list[dict[str, Any]] = []
    matched_ids: list[str] = []
    errors: list[dict[str, Any]] = []
    processed_ids: list[str] = []

    for query in queries:
        person_id = str(query["person_id"])
        processed_ids.append(person_id)
        raw_result = runtime.run_query(
            query=query,
            url=API_URL,
            query_key=f"{query['query_key']}|{SOURCE_KEY}",
            request_fn=lambda attempt, query=query: search_openlist_once(
                query,
                size=max(10, max_records * 2),
                timeout=timeout,
                user_agent=user_agent,
                accept_language=accept_language,
                verify_tls=verify_tls,
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

        table_rows: list[dict[str, str]] = []
        try:
            table_rows = fetch_openlist_table_rows(
                query,
                timeout=timeout,
                user_agent=user_agent,
                accept_language=accept_language,
                verify_tls=verify_tls,
            )
        except NETWORK_EXCEPTIONS:
            table_rows = []

        records = app_records_from_response(
            query,
            raw_result.get("response"),
            max_records=max_records,
            table_rows=table_rows,
        )
        if not records:
            continue
        top_record = records[0]
        top_last_name, top_first_name, top_middle_name = split_fio(top_record.get("title", ""))

        match_payload = {
            "data_id": person_id,
            "source": SOURCE_KEY,
            "sourceLabel": SOURCE_LABEL,
            "score": top_record.get("score"),
            "person": {
                "lastName": top_last_name or compact_text(query.get("last_name")),
                "name": top_first_name or compact_text(query.get("first_name")),
                "middleName": top_middle_name or compact_text(query.get("middle_name")),
                "birthDate": compact_text(top_record.get("birthDate")),
                "birthPlace": compact_text(top_record.get("birthPlace")),
                "information": top_record.get("information", ""),
            },
            "records": records,
            "searchedAt": utc_now(),
        }
        if raw_result.get("tlsFallbackUsed"):
            match_payload["tlsFallbackUsed"] = True
        matches.append(match_payload)
        matched_ids.append(person_id)

    runtime.log_summary()
    return {
        "source": SOURCE_KEY,
        "sourceLabel": SOURCE_LABEL,
        "matches": matches,
        "matchedDataIds": sorted(set(matched_ids)),
        "processedPersonIds": processed_ids,
        "errors": errors,
        "metrics": runtime.summary(),
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
