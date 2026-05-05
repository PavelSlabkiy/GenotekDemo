#!/usr/bin/env python3
from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any


API_URL = "https://gwar.mil.ru/gt_data/?builder=Heroes"
ORIGIN = "https://gwar.mil.ru"
HEROES_URL = f"{ORIGIN}/heroes/"
SOURCE_KEY = "gwar"
SOURCE_LABEL = "Герои Великой войны"

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
            }
        )
        return result
    except urllib.error.URLError as exc:
        result = base_result(query, payload, started_at)
        result.update(
            {
                "status": "network_error",
                "status_code": None,
                "completed_at": utc_now(),
                "error": str(exc.reason),
            }
        )
        return result


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


def parse_json_or_text(body: str) -> Any:
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return body


def text_value(value: Any) -> str:
    return "" if value is None else str(value).strip()