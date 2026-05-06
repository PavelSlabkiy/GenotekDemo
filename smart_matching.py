from rapidfuzz import fuzz
from datetime import date
import json
import heapq
import sys
import re


class SmartMatching:
    """
    SmartMatching — поиск похожих людей во всех деревьях.

    Поддерживает оба формата:
    1) приложение: {"people": {...}} и {"tree_id": {...}}
    2) example/database: [{...}, {...}] c _id/treeId/relatives/birthdate
    """

    def __init__(self, data, database, trashhold: int = 90, k: int = 5, person_ids=None):
        self.data = data
        self.database = database
        self.trashhold = trashhold
        self.k = k
        self.person_ids = [str(pid) for pid in (person_ids or [])]

    # ----------------------------------------------------------------------
    # Normalization helpers
    # ----------------------------------------------------------------------

    @staticmethod
    def _parse_raw(raw):
        if isinstance(raw, str):
            raw = raw.strip()
            if not raw:
                return {}
            return json.loads(raw)
        return raw if raw is not None else {}

    @staticmethod
    def _oid_to_str(value):
        if value is None:
            return None
        if isinstance(value, dict) and "$oid" in value:
            return str(value["$oid"])
        return str(value)

    @staticmethod
    def _first_string(value):
        if isinstance(value, list):
            return str(value[0]) if value else ""
        if value is None:
            return ""
        return str(value)

    @staticmethod
    def _normalize_gender(value):
        if not value:
            return ""
        val = str(value).strip().lower()
        if val.startswith("f") or val in {"female", "жен", "ж", "woman"}:
            return "female"
        return "male"

    @staticmethod
    def _normalize_is_alive(value):
        if value is None:
            return None
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        sval = str(value).strip().lower()
        if sval in {"0", "false", "no"}:
            return False
        if sval in {"1", "true", "yes"}:
            return True
        return None

    @staticmethod
    def _birthdate_to_string(value):
        if isinstance(value, str):
            return value.strip()
        if not isinstance(value, list) or not value:
            return ""
        item = value[0] or {}
        year = item.get("year")
        month = item.get("month")
        day = item.get("day")
        if not year:
            return ""
        if not month:
            return str(year)
        if not day:
            return f"{int(year):04d}-{int(month):02d}"
        return f"{int(year):04d}-{int(month):02d}-{int(day):02d}"

    def _entry_to_person(self, entry):
        pid = self._oid_to_str(entry.get("_id"))
        if not pid:
            return None, None, None

        person = {
            "id": pid,
            "name": self._first_string(entry.get("name")),
            "lastName": self._first_string(entry.get("surname")),
            "middleName": self._first_string(entry.get("middleName")),
            "gender": self._normalize_gender(entry.get("gender")),
            "fatherId": None,
            "motherId": None,
            "partnerId": None,
            "children": [],
            "isAlive": self._normalize_is_alive(entry.get("liveOrDead")),
            "birthDate": self._birthdate_to_string(entry.get("birthdate")),
            "birthPlace": self._first_string(entry.get("birthplace")),
            "information": entry.get("information", ""),
        }
        return pid, person, entry.get("relatives", [])

    def _resolve_relations(self, people, pending_relatives):
        parent_candidates = {}
        child_candidates = {}
        spouse_candidates = {}

        for person_id, relatives in pending_relatives.items():
            for relative in relatives:
                rel_id = self._oid_to_str((relative or {}).get("id"))
                rel_type = (relative or {}).get("relationType")
                if not rel_id or rel_id not in people:
                    continue
                if rel_type == "parent":
                    parent_candidates.setdefault(person_id, []).append(rel_id)
                elif rel_type == "child":
                    child_candidates.setdefault(person_id, []).append(rel_id)
                elif rel_type == "spouse":
                    spouse_candidates[person_id] = rel_id

        for person_id, parent_ids in parent_candidates.items():
            person = people.get(person_id)
            if not person:
                continue
            for parent_id in list(dict.fromkeys(parent_ids)):
                parent = people.get(parent_id)
                if not parent:
                    continue
                if parent.get("gender") == "male" and not person.get("fatherId"):
                    person["fatherId"] = parent_id
                    continue
                if parent.get("gender") == "female" and not person.get("motherId"):
                    person["motherId"] = parent_id
                    continue
                if not person.get("fatherId"):
                    person["fatherId"] = parent_id
                elif not person.get("motherId"):
                    person["motherId"] = parent_id

        for person_id, child_ids in child_candidates.items():
            person = people.get(person_id)
            if person:
                person["children"] = list(dict.fromkeys(child_ids))

        for person_id, spouse_id in spouse_candidates.items():
            if person_id in people and spouse_id in people:
                people[person_id]["partnerId"] = spouse_id
                if not people[spouse_id].get("partnerId"):
                    people[spouse_id]["partnerId"] = person_id

        for person in people.values():
            if person.get("fatherId") and person["fatherId"] in people:
                father = people[person["fatherId"]]
                father["children"] = list(dict.fromkeys([*father.get("children", []), person["id"]]))
            if person.get("motherId") and person["motherId"] in people:
                mother = people[person["motherId"]]
                mother["children"] = list(dict.fromkeys([*mother.get("children", []), person["id"]]))

    def _entries_to_people(self, entries):
        people = {}
        pending_relatives = {}

        for entry in entries:
            person_id, person, relatives = self._entry_to_person(entry)
            if not person_id:
                continue
            people[person_id] = person
            pending_relatives[person_id] = relatives if isinstance(relatives, list) else []

        self._resolve_relations(people, pending_relatives)
        return people

    def _group_entries_by_tree(self, entries):
        grouped = {}
        for entry in entries:
            tree_id = self._oid_to_str(entry.get("treeId")) or "tree-main"
            grouped.setdefault(tree_id, []).append(entry)
        return grouped

    def _derive_tree_owner(self, entries):
        if not entries:
            return "Unknown"
        owner = None
        for entry in entries:
            if entry.get("patientId"):
                owner = entry
                break
        if owner is None:
            owner = entries[0]
        full_name = [
            self._first_string(owner.get("surname")),
            self._first_string(owner.get("name")),
            self._first_string(owner.get("middleName")),
        ]
        return " ".join([part for part in full_name if part]).strip() or "Unknown"

    def _normalize_data_to_people(self):
        raw = self._parse_raw(self.data)

        if isinstance(raw, dict) and isinstance(raw.get("people"), dict):
            people = {}
            for key, value in raw["people"].items():
                person = dict(value)
                person.setdefault("id", str(key))
                people[str(key)] = person
            return people

        if isinstance(raw, list):
            return self._entries_to_people(raw)

        return {}

    def _normalize_database_to_tree_map(self):
        raw = self._parse_raw(self.database)

        if isinstance(raw, dict) and "tree_id" in raw:
            result = {}
            for tree_id, tree_data in (raw.get("tree_id") or {}).items():
                people = tree_data.get("people", {})
                normalized_people = {}
                for key, value in people.items():
                    person = dict(value)
                    person.setdefault("id", str(key))
                    normalized_people[str(key)] = person
                result[str(tree_id)] = {
                    "tree_owner": tree_data.get("tree_owner", "Unknown"),
                    "people": normalized_people,
                }
            return result

        if isinstance(raw, list):
            grouped = self._group_entries_by_tree(raw)
            result = {}
            for tree_id, entries in grouped.items():
                result[str(tree_id)] = {
                    "tree_owner": self._derive_tree_owner(entries),
                    "people": self._entries_to_people(entries),
                }
            return result

        return {}

    # ----------------------------------------------------------------------

    def compare_idx2idx(self, idx1: dict, idx2: dict) -> float:
        # ---------- helpers (local) ----------

        def normalize_text(s: str) -> str:
            if not s:
                return ""
            s = s.lower()
            s = re.sub(r"[^\w\s]", "", s)
            s = re.sub(r"\s+", " ", s).strip()
            return s

        def text_similarity(a: str, b: str) -> int:
            if not a or not b:
                return 70
            return fuzz.token_sort_ratio(normalize_text(a), normalize_text(b))

        def parse_date_range(d: str):
            if not d:
                return None
            parts = d.split("-")
            try:
                year = int(parts[0])
                if len(parts) == 1:
                    return date(year, 1, 1), date(year, 12, 31)
                month = int(parts[1])
                if len(parts) == 2:
                    return date(year, month, 1), date(year, month, 28)
                day = int(parts[2])
                return date(year, month, day), date(year, month, day)
            except Exception:
                return None

        def date_similarity(d1: str, d2: str) -> int:
            if not d1 or not d2:
                return 50

            r1 = parse_date_range(d1)
            r2 = parse_date_range(d2)

            if not r1 or not r2:
                return 50

            start1, end1 = r1
            start2, end2 = r2

            if start1 <= end2 and start2 <= end1:
                return 100

            if abs(start1.year - start2.year) <= 1:
                return 70

            return 0

        # ---------- new birthPlace similarity ----------

        def place_similarity(str1: str, str2: str) -> int:
            STOP_WORDS = {
                "г", "город", "с", "село", "деревня", "пос", "поселок",
                "рн", "район", "обл", "область", "край",
                "республика", "уезд", "волость"
            }

            def normalize(text: str) -> list[str]:
                if not text:
                    return []

                text = text.lower()
                text = re.sub(r"[^\w\s]", " ", text)
                tokens = text.split()

                seen = set()
                result = []
                for t in tokens:
                    if len(t) <= 2 or t in STOP_WORDS:
                        continue
                    if t not in seen:
                        seen.add(t)
                        result.append(t)
                return result

            def trigrams(s: str) -> set[str]:
                s = f"  {s} "
                return {s[i:i + 3] for i in range(len(s) - 2)}

            def trigram_jaccard(a: str, b: str) -> float:
                ta = trigrams(a)
                tb = trigrams(b)
                if not ta or not tb:
                    return 0.0
                return len(ta & tb) / len(ta | tb)

            tokens1 = normalize(str1)
            tokens2 = normalize(str2)

            if not tokens1 or not tokens2:
                return 50

            if len(tokens1) <= len(tokens2):
                short_tokens, long_tokens = tokens1, tokens2
            else:
                short_tokens, long_tokens = tokens2, tokens1

            long_text = " ".join(long_tokens)

            scores = []
            for token in short_tokens:
                scores.append(trigram_jaccard(token, long_text))

            if not scores:
                return 0

            best = max(scores)
            avg = sum(scores) / len(scores)
            final = best * 0.7 + avg * 0.3

            if final >= 0.75:
                return 100
            if final >= 0.55:
                return 80
            if final >= 0.35:
                return 60
            if final >= 0.2:
                return 40
            return 0

        # ---------- weighted scoring ----------

        score = 0.0
        weight_sum = 0.0

        def add(part_score, weight):
            nonlocal score, weight_sum
            score += part_score * weight
            weight_sum += weight

        # Фамилия
        add(text_similarity(idx1.get("lastName"), idx2.get("lastName")), 0.25)

        # Имя
        add(text_similarity(idx1.get("name"), idx2.get("name")), 0.20)

        # Отчество
        if idx1.get("middleName") or idx2.get("middleName"):
            add(text_similarity(idx1.get("middleName"), idx2.get("middleName")), 0.10)

        # Дата рождения
        add(date_similarity(idx1.get("birthDate"), idx2.get("birthDate")), 0.25)

        # Место рождения (улучшенное сравнение)
        add(place_similarity(idx1.get("birthPlace"), idx2.get("birthPlace")), 0.10)

        # Пол
        if idx1.get("gender") and idx2.get("gender"):
            add(100 if idx1["gender"] == idx2["gender"] else 0, 0.10)

        # Статус жизни
        if idx1.get("isAlive") is not None and idx2.get("isAlive") is not None:
            add(100 if str(idx1["isAlive"]) == str(idx2["isAlive"]) else 0, 0.05)

        if weight_sum == 0:
            return 0.0

        return score / weight_sum

    def get_oldest_generation_idx(self):
        data_json = {"people": self._normalize_data_to_people()}
        oldest_idx = []
        for person_id, person in data_json["people"].items():
            if person.get("fatherId") is None and person.get("motherId") is None:
                oldest_idx.append(person_id)
        return oldest_idx

    # ----------------------------------------------------------------------
    # Поиск совпадений во всех деревьях
    # ----------------------------------------------------------------------
    def parse_json(self):
        data_json = {"people": self._normalize_data_to_people()}
        database_json = {"tree_id": self._normalize_database_to_tree_map()}
        if self.person_ids:
            oldest_idx = [
                person_id
                for person_id in self.person_ids
                if person_id in data_json["people"]
            ]
        else:
            oldest_idx = self.get_oldest_generation_idx()

        scores_dict = {}

        for data_idx in oldest_idx:
            scores_list = []

            for tree_id, tree_data in database_json.get("tree_id", {}).items():
                people = tree_data.get("people", {})

                for db_id, db_person in people.items():

                    score = self.compare_idx2idx(data_json["people"][data_idx], db_person)
                    if score >= self.trashhold:
                        scores_list.append({
                            "data_id": data_idx,
                            "tree_id": tree_id,
                            "tree_owner": tree_data.get("tree_owner"),
                            "database_id": db_id,
                            "score": score
                        })

            if self.k and self.k > 0:
                scores_list = heapq.nlargest(self.k, scores_list, key=lambda x: x["score"])
            scores_dict[data_idx] = scores_list

        return scores_dict

    # Формируем отдельный people-фрагмент для КАЖДОГО совпадения
    # ----------------------------------------------------------------------
    def get_older_generation_idx(self):
        scores_dict = self.parse_json()
        top = [entry for entries in scores_dict.values() for entry in entries]
        database_json = {"tree_id": self._normalize_database_to_tree_map()}

        matchedDataIds = list({t["data_id"] for t in top})

        results = []

        for match in top:
            tree_id = match["tree_id"]
            db_person_id = match["database_id"]

            people = database_json["tree_id"][tree_id]["people"]

            # если по какой-то причине нет — пропускаем
            if db_person_id not in people:
                continue

            # собираем предков именно для этого совпадения
            fragment_people = {}

            def collect_ancestors(pid):
                if pid is None or pid not in people:
                    return
                if pid in fragment_people:
                    return
                person = people[pid]
                fragment_people[pid] = person
                collect_ancestors(person.get("fatherId"))
                collect_ancestors(person.get("motherId"))

            collect_ancestors(db_person_id)

            # добавляем в общий список
            results.append({
                **match,
                "people": fragment_people
            })

        return {
            "matches": results,
            "matchedDataIds": matchedDataIds
        }


# ------------------------------------------------------------------------------
# CLI
# ------------------------------------------------------------------------------
if __name__ == "__main__":
    payload = sys.stdin.read()
    if not payload:
        print(json.dumps({"matches": [], "matchedDataIds": []}))
        sys.exit(0)

    obj = json.loads(payload)
    data = obj.get("data")
    db = obj.get("db")
    person_ids = obj.get("personIds") or []
    threshold = obj.get("scoreThreshold", 90)
    per_person_top_k = obj.get("topKPerPerson", 5)

    SM = SmartMatching(data, db, trashhold=threshold, k=per_person_top_k, person_ids=person_ids)
    out = SM.get_older_generation_idx()

    print(json.dumps(out))
