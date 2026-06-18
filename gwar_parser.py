#!/usr/bin/env python3
from __future__ import annotations

# Парсер «Героев великой войны» возвращает архивные совпадения в формате приложения.

import hashlib
import json
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

from date_utils import normalize_partial_date
from parser_runtime import RESULT_BLOCKED, ParserRuntime, RuntimeOptions
from smart_matching import SmartMatching


API_URL = "https://gwar.mil.ru/gt_data/?builder=Heroes"
ORIGIN = "https://gwar.mil.ru"
HEROES_URL = f"{ORIGIN}/heroes/"
SOURCE_KEY = "gwar"
SOURCE_LABEL = "Герои великой войны"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)
DEFAULT_ACCEPT_LANGUAGE = "ru,en-US;q=0.9,en;q=0.8"
SMART_MATCHING_SCORER = SmartMatching({}, {})

ENTITIES = [
    "chelovek_donesenie",
    "chelovek_gospital",
    "chelovek_zahoronenie",
    "chelovek_plen",
    "chelovek_nagrazhdenie",
    "chelovek_predstavlenie",
    "chelovek_nagradnaya_kartochka",
    "commander",
    "person",
    "chelovek_posluzhnoi_spisok",
    "chelovek_uchetnaya_kartochka",
]

TYPES = [
    "awd_nagrady",
    "awd_kart",
    "potery_doneseniya_o_poteryah",
    "potery_gospitali",
    "potery_spiski_zahoroneniy",
    "potery_voennoplen",
    "frc_list",
    "cmd_commander",
    "prs_person",
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def gwar_payload(query: dict[str, Any], *, page: int, size: int) -> dict[str, Any]:
    page_number = max(int(page), 1)
    page_size = max(int(size), 1)
    birth_date = text_value(query.get("birth_date_from"))
    return {
        "indices": ["gwar"],
        "entities": ENTITIES,
        "queryFields": {
            "ids": "",
            "last_name": text_value(query.get("last_name")),
            "first_name": text_value(query.get("first_name")),
            "middle_name": text_value(query.get("middle_name")),
            "birth_place": text_value(query.get("birth_place")),
            "birth_place_gubernia": "",
            "birth_place_uezd": "",
            "birth_place_volost": "",
            "location": "",
            "birth_date": birth_date,
            "rank": "",
            "data_vibitiya": "",
            "event_name": "",
            "event_id": "",
            "military_unit_name": "",
            "event_place": "",
            "lazaret_name": "",
            "camp_name": "",
            "date_death": "",
            "award_name": "",
            "nomer_dokumenta": "",
            "data_dokumenta": "",
            "data_i_mesto_priziva": "",
            "archive_short": "",
            "nomer_fonda": "",
            "nomer_opisi": "",
            "nomer_dela": "",
            "date_birth": birth_date,
            "data_vibitiya_end": "",
        },
        "filterFields": {},
        "from": (page_number - 1) * page_size,
        "size": str(page_size),
        "builderType": "Heroes",
    }


def search_gwar_once(
    query: dict[str, Any],
    *,
    page: int,
    size: int,
    timeout: float,
    user_agent: str,
    accept_language: str,
    verify_tls: bool = True,
) -> dict[str, Any]:
    return search_gwar_once_with_tls_fallback(
        query=query,
        page=page,
        size=size,
        timeout=timeout,
        user_agent=user_agent,
        accept_language=accept_language,
        verify_tls=verify_tls,
    )


def search_gwar_once_with_tls_fallback(
    query: dict[str, Any],
    *,
    page: int,
    size: int,
    timeout: float,
    user_agent: str,
    accept_language: str,
    verify_tls: bool,
) -> dict[str, Any]:
    primary_error: urllib.error.URLError | None = None
    try:
        return search_gwar_raw(
            query=query,
            page=page,
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
                return search_gwar_raw(
                    query=query,
                    page=page,
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

    payload = gwar_payload(query, page=page, size=size)
    result = base_result(query, payload, utc_now())
    result.update(
        {
            "status": "network_error",
            "status_code": None,
            "completed_at": utc_now(),
            "error": str(primary_error.reason),
        }
    )
    return result


def search_gwar_raw(
    query: dict[str, Any],
    *,
    page: int,
    size: int,
    timeout: float,
    user_agent: str,
    accept_language: str,
    verify_tls: bool,
) -> dict[str, Any]:
    payload = gwar_payload(query, page=page, size=size)
    started_at = utc_now()
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": accept_language,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "DNT": "1",
            "Origin": ORIGIN,
            "Referer": referer_for_query(query, page=page),
            "User-Agent": user_agent,
            "X-Requested-With": "XMLHttpRequest",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout, context=tls_context(verify_tls)) as response:
            body = response.read().decode("utf-8", errors="replace")
            parsed_response = parse_json_or_text(body)
            normalized = normalize_gwar_response(parsed_response)
            status, error = classify_gwar_response(normalized)
            result = base_result(query, payload, started_at)
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
        result = base_result(query, payload, started_at)
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


def base_result(query: dict[str, Any], payload: dict[str, Any], started_at: str) -> dict[str, Any]:
    return {
        "source": SOURCE_KEY,
        "source_label": SOURCE_LABEL,
        "query_key": f"{query['query_key']}|{SOURCE_KEY}",
        "person_id": query.get("person_id"),
        "display_name": query.get("display_name"),
        "query": query,
        "request": {
            "url": API_URL,
            "method": "POST",
            "payload": payload,
        },
        "started_at": started_at,
    }


def referer_for_query(query: dict[str, Any], *, page: int) -> str:
    params = {
        "last_name": text_value(query.get("last_name")),
        "first_name": text_value(query.get("first_name")),
        "middle_name": text_value(query.get("middle_name")),
        "birth_place_gubernia": "",
        "birth_place_uezd": "",
        "birth_place_volost": "",
        "birth_place": text_value(query.get("birth_place")),
        "location": "",
        "gmap-selection": "",
        "award_tag": "on",
        "dead_tag": "on",
        "frc_tag": "on",
        "commander_tag": "on",
        "prs_tag": "on",
        "rank": "",
        "military_unit_name": "",
        "data_vibitiya": "",
        "data_vibitiya_end": "",
        "ids": "",
        "event_name": "",
        "data_i_mesto_priziva": "",
        "event_place": "",
        "lazaret_name": "",
        "camp_name": "",
        "date_death": "",
        "nomer_dokumenta": "",
        "data_dokumenta": "",
        "fund": "",
        "inventory": "",
        "file": "",
        "awd_nagrady": "on",
        "awd_kart": "on",
        "potery_doneseniya_o_poteryah": "on",
        "potery_gospitali": "on",
        "potery_spiski_zahoroneniy": "on",
        "potery_voennoplen": "on",
        "frc_list": "on",
        "cmd_commander": "on",
        "prs_person": "on",
        "index_all": "on",
        "index_gwar": "on",
        "groups": "awd:ptr:frc:cmd:prs",
        "types": ":".join(TYPES),
        "page": str(max(int(page), 1)),
    }
    return f"{HEROES_URL}?{urllib.parse.urlencode(params)}"


def normalize_gwar_response(response: Any) -> Any:
    if not isinstance(response, dict) or not isinstance(response.get("hits"), dict):
        return response

    hits = response["hits"].get("hits")
    items = []
    if isinstance(hits, list):
        for hit in hits:
            if not isinstance(hit, dict):
                continue
            item = dict(hit)
            item["source"] = SOURCE_KEY
            item["source_label"] = SOURCE_LABEL
            url = detail_url_for_hit(item)
            if url:
                item["url"] = url
            items.append(item)

    return {
        "status": "success",
        "data": items,
        "metadata": {
            "total": total_hits(response),
            "took": response.get("took"),
            "timed_out": response.get("timed_out"),
            "status": response.get("status"),
        },
        "raw": response,
    }


def detail_url_for_hit(hit: dict[str, Any]) -> str:
    hit_type = text_value(hit.get("_type") or hit.get("__type"))
    hit_id = text_value(hit.get("_id") or hit.get("id"))
    if not hit_type or not hit_id:
        return ""
    return f"{HEROES_URL}{urllib.parse.quote(hit_type + hit_id)}/"


def total_hits(response: dict[str, Any]) -> int:
    total = response.get("hits", {}).get("total")
    if isinstance(total, dict):
        total = total.get("value")
    number = int(total) if str(total).isdigit() else None
    if number is not None:
        return number
    hits = response.get("hits", {}).get("hits")
    return len(hits) if isinstance(hits, list) else 0


def classify_gwar_response(response: Any) -> tuple[str, str | None]:
    if isinstance(response, dict) and isinstance(response.get("data"), list):
        return "ok", None
    if isinstance(response, str):
        return "unexpected_response", f"GWAR returned text instead of JSON: {response[:220]}"
    return "unexpected_response", f"GWAR returned unsupported response type: {type(response).__name__}"


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


def text_value(value: Any) -> str:
    return "" if value is None else str(value).strip()


def compact_text(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).split()).strip()


def birth_year_from_date(value: Any) -> str:
    text = compact_text(value)
    if not text:
        return ""
    match = re.search(r"(18|19|20)\d{2}", text)
    return match.group(0) if match else ""


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
    birth_date_from: str,
    birth_place: str,
) -> str:
    digest = hashlib.sha1(
        "|".join([last_name, first_name, middle_name, birth_date_from, birth_place]).encode("utf-8")
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

        birth_date = normalize_partial_date(person.get("birthDate")) if birth_date_enabled else ""
        birth_date_from = birth_year_from_date(birth_date) if birth_date_enabled else ""
        birth_place = compact_text(person.get("birthPlace")) if birth_place_enabled else ""
        if not any((last_name, first_name, middle_name, birth_date_from, birth_place)):
            continue
        display_name = " ".join(part for part in [last_name, first_name, middle_name] if part).strip()
        if not display_name:
            display_name = compact_text(person.get("id")) or person_id
        query_key = build_app_query_key(
            person_id,
            last_name,
            first_name,
            middle_name,
            birth_date_from,
            birth_place,
        )
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


def source_field(source: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = source.get(key)
        if value is None:
            continue
        text = compact_text(value)
        if text:
            return text
    return ""


def source_name(source: dict[str, Any]) -> tuple[str, str, str]:
    return (
        source_field(source, "last_name", "family_name", "surname", "fio_last"),
        source_field(source, "first_name", "name", "fio_name"),
        source_field(source, "middle_name", "patronymic", "fio_middle"),
    )


def app_similarity_score(query: dict[str, Any], source: dict[str, Any]) -> float:
    source_last, source_first, source_middle = source_name(source)
    query_person = {
        "lastName": compact_text(query.get("last_name")),
        "name": compact_text(query.get("first_name")),
        "middleName": compact_text(query.get("middle_name")),
        "birthDate": normalize_partial_date(query.get("birth_date")) or birth_year_from_date(query.get("birth_date_from")),
        "birthPlace": compact_text(query.get("birth_place")),
    }
    source_person = {
        "lastName": source_last,
        "name": source_first,
        "middleName": source_middle,
        "birthDate": normalize_partial_date(source_field(source, "date_birth", "birth_date")) or birth_year_from_date(source_field(source, "date_birth", "birth_date")),
        "birthPlace": source_field(source, "birth_place", "birth_location", "location"),
    }
    return SMART_MATCHING_SCORER.compare_idx2idx(query_person, source_person)


def app_record_title(source: dict[str, Any], fallback: str) -> str:
    last_name, first_name, middle_name = source_name(source)
    full_name = " ".join(part for part in (last_name, first_name, middle_name) if part).strip()
    if full_name:
        return full_name
    return source_field(source, "title", "name", "description") or fallback


def app_record_information(source: dict[str, Any]) -> str:
    parts = [
        source_field(source, "rank"),
        source_field(source, "event_name"),
        source_field(source, "military_unit_name"),
        source_field(source, "archive_short"),
        source_field(source, "nomer_dokumenta"),
    ]
    return " | ".join(part for part in parts if part)


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
        source = item.get("_source") if isinstance(item.get("_source"), dict) else item
        if not isinstance(source, dict):
            continue

        title = app_record_title(source, query.get("display_name") or "Запись")
        birth_date = source_field(source, "date_birth", "birth_date")
        birth_place = source_field(source, "birth_place", "birth_location", "location")
        information = app_record_information(source)
        url = compact_text(item.get("url"))
        score = app_similarity_score(query, source)

        if not title and not information and not url:
            continue

        records.append(
            {
                "source": SOURCE_KEY,
                "sourceLabel": SOURCE_LABEL,
                "title": title,
                "information": information,
                "url": url,
                "birthDate": normalize_partial_date(birth_date) or birth_date,
                "birthPlace": birth_place,
                "score": round(score, 2),
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
            default_request_delay_sec=1.25,
            default_request_jitter_sec=0.5,
            default_min_rate_interval_sec=1.25,
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
            request_fn=lambda attempt, query=query: search_gwar_once(
                query,
                page=1,
                size=max(10, max_records * 3),
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
                "birthDate": normalize_partial_date(query.get("birth_date")) or compact_text(query.get("birth_date_from")),
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
    print("gwar_parser.py expects app-search JSON payload on stdin.", file=sys.stderr)
    raise SystemExit(1)
