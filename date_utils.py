import calendar
from datetime import date
import re
from typing import Any


_YEAR_RE = re.compile(r"^(?P<year>\d{4})$")
_ISO_MONTH_RE = re.compile(r"^(?P<year>\d{4})-(?P<month>\d{1,2})$")
_ISO_DATE_RE = re.compile(r"^(?P<year>\d{4})-(?P<month>\d{1,2})-(?P<day>\d{1,2})$")
_RU_MONTH_RE = re.compile(r"^(?P<month>\d{1,2})\.(?P<year>\d{4})$")
_RU_DATE_RE = re.compile(r"^(?P<day>\d{1,2})\.(?P<month>\d{1,2})\.(?P<year>\d{4})$")
_UNKNOWN_DAY_RE = re.compile(r"^(?:__|00)\.(?P<month>\d{1,2})\.(?P<year>\d{4})$")
_UNKNOWN_MONTH_DAY_RE = re.compile(r"^(?:__|00)\.(?:__|00)\.(?P<year>\d{4})$")


def normalize_partial_date(value: Any) -> str:
    """Return YYYY, YYYY-MM or YYYY-MM-DD for a supported partial date."""
    if value is None:
        return ""

    text = " ".join(str(value).strip().split())
    if not text:
        return ""

    match = _YEAR_RE.fullmatch(text) or _UNKNOWN_MONTH_DAY_RE.fullmatch(text)
    if match:
        return f"{int(match.group('year')):04d}"

    match = _ISO_MONTH_RE.fullmatch(text) or _RU_MONTH_RE.fullmatch(text) or _UNKNOWN_DAY_RE.fullmatch(text)
    if match:
        year = int(match.group("year"))
        month = int(match.group("month"))
        if 1 <= month <= 12:
            return f"{year:04d}-{month:02d}"
        return ""

    match = _ISO_DATE_RE.fullmatch(text) or _RU_DATE_RE.fullmatch(text)
    if match:
        year = int(match.group("year"))
        month = int(match.group("month"))
        day = int(match.group("day"))
        try:
            date(year, month, day)
        except ValueError:
            return ""
        return f"{year:04d}-{month:02d}-{day:02d}"

    return ""


def partial_date_range(value: Any) -> tuple[date, date] | None:
    normalized = normalize_partial_date(value)
    if not normalized:
        return None

    parts = [int(part) for part in normalized.split("-")]
    year = parts[0]
    if len(parts) == 1:
        return date(year, 1, 1), date(year, 12, 31)

    month = parts[1]
    if len(parts) == 2:
        return date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])

    exact = date(year, month, parts[2])
    return exact, exact


def birth_year_from_partial_date(value: Any) -> int | None:
    normalized = normalize_partial_date(value)
    return int(normalized[:4]) if normalized else None
