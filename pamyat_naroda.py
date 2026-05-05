import requests
import json
import sys
from datetime import datetime
from bs4 import BeautifulSoup
from smart_matching import SmartMatching

DEBUG_LOG_PATH = "/Users/pavelslabkiy/Projects/Genotek/.cursor/debug-10f686.log"

def emit_debug_log(hypothesis_id, location, message, data=None, run_id="pre-fix"):
    payload = {
        "sessionId": "10f686",
        "runId": run_id,
        "hypothesisId": hypothesis_id,
        "location": location,
        "message": message,
        "data": data or {},
        "timestamp": int(datetime.utcnow().timestamp() * 1000),
    }
    with open(DEBUG_LOG_PATH, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, ensure_ascii=False) + "\n")

class PamyatNarodaParser:

    def __init__(self, init_session: bool = True, trashhold: int = 90):
        self.init_session = init_session
        self.session = None
        if self.init_session:
            self.session = self.setup_session()
        self.trashhold = trashhold
        # Initialize SmartMatching for score comparison (with empty data/db, we only use compare_idx2idx)
        self.sm = SmartMatching(data='{"people":{}}', database='{"tree_id":{}}', trashhold=trashhold)

    def setup_session(self):
        '''
        Инициализируем сессию, получаем токен и куки
        '''
        # region agent log
        emit_debug_log("H2", "pamyat_naroda.py:setup_session:start", "Starting session bootstrap", {})
        # endregion
        session = requests.Session()
        url_search_page = "https://pamyat-naroda.ru/heroes/"
        response = session.get(url_search_page)
        response.raise_for_status()

        soup = BeautifulSoup(response.text, "html.parser")
        csrf_input = soup.find("input", {"name": "csrf"})
        csrf_token = csrf_input["value"] if csrf_input else None

        if not csrf_token:
            # region agent log
            emit_debug_log("H2", "pamyat_naroda.py:setup_session:csrf", "CSRF token missing on search page", {"status_code": response.status_code})
            # endregion
            raise Exception("Не удалось получить CSRF токен")

        session.headers.update({
            "accept": "application/json",
            "content-type": "application/json",
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
            "origin": "https://pamyat-naroda.ru",
            "referer": url_search_page,
            "x-csrf-token": csrf_token
        })
        return session

    def get_response(self, lastName, name, middleName, birthPlace, birthDate):
        '''
        Отправляем запрос по заданным данным
        '''
        if not self.session:
            raise Exception("Сессия не инициализирована")

        body = {
            "entrypoint": "heroes/search",
            "parameters": {
                "query": {
                    "last_name": lastName,
                    "first_name": name,
                    "middle_name": middleName,
                    "birth_place": birthPlace,
                    "birth_date_from": birthDate
                },
                "page": 1,
                "size": 10,
                "options": {"person": True}
            }
        }
        response = self.session.post("https://pamyat-naroda.ru/entrypoint/api/", json=body)
        response.raise_for_status()
        return response.json()

    def parse_response(self, lastName, name, middleName, birthPlace, birthDate):
        try:
            response = self.get_response(lastName, name, middleName, birthPlace, birthDate)
            data = response.get('data', [])

            if not data:
                return None
            person = data[0]['_source']
            person = {
                'lastName': (person.get('last_name') or ""),
                'name': (person.get('first_name') or ""),
                'middleName': (person.get('middle_name') or ""),
                'birthDate': (person.get('date_birth') or ""),
                'birthPlace': (person.get('place_birth') or ""),
                'information': person.get('short_desc')}

            normalized_person = {}
            for key in person.keys():
                if isinstance(person[key], list):
                    normalized_person[key] = person[key][0]
                else:
                    normalized_person[key] = person[key]
            if normalized_person.get('birthDate'):
                normalized_person['birthDate'] = normalized_person['birthDate'].replace('__.','')

            return normalized_person
        except Exception as e:
            return None

    def summarize_information(self, information):
        try:
            response = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": "Bearer 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",
                    "Content-Type": "application/json"
                },
                json={
                    "model": "meta-llama/llama-3.3-70b-instruct:free",
                    "messages": [
                        {
                            "role": "system",
                            "content": "Ты — модель, преобразующая формальные записи в короткие человеческие фразы."
                        },
                        {
                            "role": "user",
                            "content": f"Преобразуй формальную запись в короткую человеческую фразу на русском: {information}"
                        }
                    ]
                },
                timeout=15  # чтобы не зависать бесконечно
            )

            # Если сервер вернул ошибку
            response.raise_for_status()

            data = response.json()

            # Безопасно достаём ответ модели
            return (
                data.get("choices", [{}])[0]
                    .get("message", {})
                    .get("content", information)
            )

        except requests.exceptions.RequestException as e:
            # Ошибки сети, таймауты, проблемы с DNS и т.п.
            print(f"[summarize_information] Request error: {e}")
            return information

        except Exception as e:
            # Любые другие сбои, чтобы код не падал
            print(f"[summarize_information] Unexpected error: {e}")
            return information

    def archive_search(self, data):
        result = {"matches": [], "matchedDataIds": []}

        data_json = json.loads(data) if isinstance(data, str) else data

        # Filter people who don't have information yet
        filtered_people = {
            pid: person
            for pid, person in data_json["people"].items()
            if person.get("information") in (None, "")
        }

        if not filtered_people:
            return result

        for idx, person in filtered_people.items():
            query = {
                'lastName': person.get('lastName', ''),
                'name': person.get('name', ''),
                'middleName': person.get('middleName', ''),
                'birthPlace': person.get('birthPlace', ''),
                'birthDate': person.get('birthDate', '')
            }

            answer = self.parse_response(**query)

            if answer is None:
                continue

            score = self.sm.compare_idx2idx(query, answer)

            if score > self.trashhold and answer.get("information"):
                answer["information"] = self.summarize_information(answer["information"])
                result['matches'].append({
                    "data_id": idx,
                    "score": score,
                    "person": answer
                })
                result['matchedDataIds'].append(idx)

        return result


# ------------------------------------------------------------------------------
# CLI
# ------------------------------------------------------------------------------
if __name__ == "__main__":
    payload = sys.stdin.read()
    # region agent log
    emit_debug_log("H3", "pamyat_naroda.py:main:stdin", "Received stdin payload", {"payloadLength": len(payload or "")})
    # endregion
    if not payload:
        print(json.dumps({"matches": [], "matchedDataIds": []}))
        sys.exit(0)

    try:
        obj = json.loads(payload)
        data = obj.get("data")
        # region agent log
        emit_debug_log("H3", "pamyat_naroda.py:main:json", "Parsed stdin JSON", {"hasDataField": "data" in obj, "dataType": type(data).__name__})
        # endregion
        
        PN = PamyatNarodaParser(init_session=True, trashhold=90)
        # region agent log
        emit_debug_log("H2_H3", "pamyat_naroda.py:main:parser_init", "Parser initialized", {"sessionInitialized": PN.session is not None})
        # endregion
        result = PN.archive_search(data)
        # region agent log
        emit_debug_log("H4", "pamyat_naroda.py:main:result", "Archive search completed", {"matches": len(result.get("matches", [])), "matchedDataIds": len(result.get("matchedDataIds", []))})
        # endregion
        
        print(json.dumps(result))
    except Exception as e:
        # region agent log
        emit_debug_log("H2_H3_H4", "pamyat_naroda.py:main:exception", "Unhandled exception in main", {"errorType": type(e).__name__, "error": str(e)})
        # endregion
        print(json.dumps({"matches": [], "matchedDataIds": [], "error": str(e)}))
        sys.exit(1)