import unittest
from datetime import date

from date_utils import normalize_partial_date, partial_date_range
from smart_matching import SmartMatching


class PartialDateTests(unittest.TestCase):
    def test_normalizes_supported_display_and_storage_formats(self):
        cases = {
            "1920": "1920",
            "05.1920": "1920-05",
            "5.1920": "1920-05",
            "15.05.1920": "1920-05-15",
            "1920-05": "1920-05",
            "1920-05-15": "1920-05-15",
            "__.__.1920": "1920",
            "__.05.1920": "1920-05",
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(normalize_partial_date(value), expected)

    def test_rejects_invalid_dates(self):
        for value in ("13.1920", "31.02.1920", "1920-02-31", "20.1920.01"):
            with self.subTest(value=value):
                self.assertEqual(normalize_partial_date(value), "")

    def test_month_range_uses_actual_last_day(self):
        self.assertEqual(
            partial_date_range("02.1920"),
            (date(1920, 2, 1), date(1920, 2, 29)),
        )

    def test_smart_matching_compares_all_partial_date_formats(self):
        scorer = SmartMatching({}, {})
        base = {
            "lastName": "Иванов",
            "name": "Иван",
            "middleName": "Иванович",
            "birthPlace": "Москва",
        }

        for left, right in (
            ("1920", "15.05.1920"),
            ("05.1920", "1920-05-15"),
            ("15.05.1920", "1920-05-15"),
        ):
            with self.subTest(left=left, right=right):
                self.assertEqual(
                    scorer.compare_idx2idx(
                        {**base, "birthDate": left},
                        {**base, "birthDate": right},
                    ),
                    100,
                )


if __name__ == "__main__":
    unittest.main()
