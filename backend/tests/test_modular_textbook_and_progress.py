import json
import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.services import workspace_store as ws
from app.services import build_queue as bq
from app.services.build_queue import DebouncedBuildQueue
from app.services.gemini_service import GeminiService
from app.services.learning_provider import LearningSettingsStore
from app.services.video_transcriber import VideoTranscriberService
from app.services.workspace_store import WorkspaceStore


@pytest.fixture
def context(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "GEMINI_API_KEY", "")
    monkeypatch.setattr(get_settings(), "VERTEX_AI_PROJECT", None)
    monkeypatch.setattr(get_settings(), "VERTEX_AI_LOCATION", "global")
    monkeypatch.setattr(get_settings(), "MOODLE_MOCK_MODE", False)
    monkeypatch.setattr(get_settings(), "WORKSPACE_DB_PATH", str(tmp_path / "workspace.db"))
    store = WorkspaceStore(str(tmp_path / "workspace.db"))
    queue = DebouncedBuildQueue()
    monkeypatch.setattr(ws, "_store_instance", store)
    monkeypatch.setattr(bq, "_build_queue", queue)
    yield TestClient(app), store
    queue.cancel_all()


def install_key(store: WorkspaceStore, owner_id: str, key: str = "valid-test-key"):
    LearningSettingsStore(store.db_path).save(owner_id, key, "gemini-2.5-flash")


def test_http_youtube_caption_extraction_prefers_manual_and_preserves_timestamps(monkeypatch):
    tracks = [
        {"languageCode": "uk", "kind": "asr", "baseUrl": "https://captions.example/asr"},
        {"languageCode": "uk", "baseUrl": "https://captions.example/manual"},
    ]
    watch_html = f'<html><script>var ytInitialPlayerResponse = {{"captions": {{"playerCaptionsTracklistRenderer": {{"captionTracks": {json.dumps(tracks)}}}}}}};</script></html>'
    json3_payload = {
        "events": [
            {"tStartMs": 15000, "dDurationMs": 4000, "segs": [{"utf8": "Умовна "}, {"utf8": "ймовірність &amp; базові аксіоми."}]},
            {"tStartMs": 220000, "dDurationMs": 5000, "segs": [{"utf8": "Формула Баєса дозволяє оновити гіпотезу."}]},
        ]
    }

    def fake_get(self, url, **kwargs):
        req = httpx.Request("GET", str(url))
        if "watch?v=" in str(url):
            return httpx.Response(200, text=watch_html, request=req)
        if "captions.example/manual" in str(url):
            return httpx.Response(200, json=json3_payload, request=req)
        return httpx.Response(404, request=req)

    monkeypatch.setattr(httpx.Client, "get", fake_get)
    res = VideoTranscriberService._fetch_youtube_captions_http("HZGCoVF3YvM")
    assert res is not None
    assert res["source"] == "youtube_captions"
    assert res["language"] == "uk"
    assert len(res["segments"]) == 2
    assert res["segments"][0]["start_seconds"] == 15.0
    assert res["segments"][0]["timestamp"] == "00:15"
    assert "Умовна ймовірність & базові аксіоми." in res["full_text"]
    assert "Формула Баєса дозволяє оновити гіпотезу." in res["full_text"]
    ts_text = VideoTranscriberService.format_timestamped_transcript(res["segments"])
    assert "[00:15]" in ts_text
    assert "[03:40]" in ts_text


def test_youtube_transcript_concepts_expand_into_modules_and_summary(context, monkeypatch):
    client, store = context

    def fake_transcript(youtube_url, preferred_languages=None):
        return {
            "success": True,
            "video_id": "HZGCoVF3YvM",
            "language": "uk",
            "source": "youtube_captions",
            "full_text": "Розбираємо умовну ймовірність і формулу Баєса.",
            "segments": [
                {"text": "Спершу визначимо умовну ймовірність події A за умови B.", "start_seconds": 15.0, "duration": 20.0},
                {"text": "Далі виведемо формулу Баєса через повну ймовірність.", "start_seconds": 220.0, "duration": 30.0},
            ],
        }

    monkeypatch.setattr(VideoTranscriberService, "get_youtube_transcript", classmethod(lambda cls, *a, **kw: fake_transcript(*a, **kw)))

    create_res = client.post("/api/workspace/courses/create-text", json={
        "title": "Ймовірність і статистика",
        "topic_title": "Теорема Баєса",
        "youtube_url": "https://www.youtube.com/watch?v=HZGCoVF3YvM",
        "content_text": "Відеолекція з умовних ймовірностей.",
        "tools_config": {"mermaid_diagrams": False, "visual_cards": False},
    })
    assert create_res.status_code == 200
    course_id = create_res.json()["course_id"]
    bundle = client.get(f"/api/workspace/courses/{course_id}").json()
    install_key(store, bundle["course"]["owner_id"])

    async def fake_gemini(self, prompt, **kwargs):
        if "СУБТИТРИ ВІДЕО" in prompt:
            return json.dumps({
                "video_summary": "Повний розбір умовної ймовірності та теореми Баєса.",
                "concepts": [
                    {
                        "concept_title": "Умовна ймовірність",
                        "start_seconds": 15,
                        "end_seconds": 219,
                        "timecode": "00:15",
                        "summary": "Означення $P(A|B) = P(A \\cap B) / P(B)$.",
                        "explanation_markdown": "Детальне виведення умовної ймовірності.",
                    },
                    {
                        "concept_title": "Формула Баєса",
                        "start_seconds": 220,
                        "end_seconds": 480,
                        "timecode": "03:40",
                        "summary": "Оновлення апостеріорної ймовірності.",
                        "explanation_markdown": "Повний доказ формули Баєса та приклад.",
                    },
                ],
            })
        if "multiple-choice" in prompt:
            return json.dumps([{
                "question": "Що оновлює теорема Баєса?",
                "options": ["Апріорну ймовірність", "Тільки дисперсію"],
                "correct_index": 0,
                "explanation": "Теорема Баєса обчислює апостеріорну ймовірність з апріорної.",
            }])
        if "flashcards" in prompt:
            return json.dumps([{"front": "Формула Баєса", "back": "P(H|E) = P(E|H)P(H)/P(E)"}])
        if '"topic_summary"' in prompt:
            return json.dumps({"topic_summary": "Самері: вивчаємо умовну ймовірність та формулу Баєса на прикладах."})
        return json.dumps({
            "short_description": "Розбір концепту з відеолекції з таймкодами.",
            "explanation_markdown": "## Детальний модуль\n\nЗараз розбираємо концепт з відео за посиланням з таймкодом.",
            "key_takeaways": ["Визначення", "Приклад"],
            "module_quizzes": [{
                "question": "Яка умова необхідна для P(A|B)?",
                "options": ["P(B) > 0", "P(A) = 0", "A = B", "Незалежність"],
                "correct_index": 0,
                "explanation": "Ділити на нуль не можна, тому P(B) > 0.",
            }],
            "tutor_question": "Поясніть геометричний та логічний зміст умовної ймовірності.",
            "tutor_expected_answer": "Умовна ймовірність звужує простір елементарних подій до події B і визначає частку сприятливих результатів у ньому.",
        })

    monkeypatch.setattr(GeminiService, "generate_content", fake_gemini)

    topic_index = bundle["topic_mixes"][0]["topic_index"]
    prep = client.post(f"/api/workspace/courses/{course_id}/topics/{topic_index}/prepare-learning")
    assert prep.status_code == 200
    updated_bundle = client.get(f"/api/workspace/courses/{course_id}").json()
    mix = updated_bundle["topic_mixes"][0]

    assert mix["topic_summary"]
    assert "Розбір концепту з відеолекції" in mix["topic_summary"]
    assert len(mix["book_sections"]) >= 2
    first_sec = mix["book_sections"][0]
    assert first_sec["module_id"]
    assert first_sec["video_concepts"][0]["youtube_url"] == "https://www.youtube.com/watch?v=HZGCoVF3YvM&t=15s"
    assert first_sec["video_concepts"][0]["timecode"] == "00:15"
    assert len(first_sec["module_quizzes"]) == 1
    assert first_sec["tutor_question"]
    assert first_sec["tutor_expected_answer"]


def test_module_xp_quiz_mistakes_tutor_gate_and_dashboard_isolation(context, monkeypatch):
    client, store = context
    res = client.post("/api/workspace/courses/create-text", json={
        "title": "Алгебра",
        "topic_title": "Матриці та визначники",
        "content_text": "Матриця — прямокутна таблиця чисел. Визначник квадратної матриці 2x2 дорівнює ad - bc.",
        "tools_config": {"mermaid_diagrams": False, "visual_cards": False},
    })
    assert res.status_code == 200
    course_id = res.json()["course_id"]
    bundle = client.get(f"/api/workspace/courses/{course_id}").json()
    mix = bundle["topic_mixes"][0]
    topic_index = mix["topic_index"]
    sec = mix["book_sections"][0]
    module_id = sec.get("module_id") or sec.get("chunk_id") or "sec-0"

    # 1. Watch video concept -> +5 XP once, idempotent repeat
    w1 = client.post(
        f"/api/workspace/courses/{course_id}/topics/{topic_index}/modules/{module_id}/video-watch",
        json={"concept_id": "vc-0", "concept_title": "Базове означення", "youtube_url": "https://youtu.be/abc?t=10s"},
    )
    assert w1.status_code == 200
    assert w1.json()["bonus_awarded"] == 5
    w2 = client.post(
        f"/api/workspace/courses/{course_id}/topics/{topic_index}/modules/{module_id}/video-watch",
        json={"concept_id": "vc-0", "concept_title": "Базове означення", "youtube_url": "https://youtu.be/abc?t=10s"},
    )
    assert w2.status_code == 200
    assert w2.json()["bonus_awarded"] == 0
    assert w2.json()["learning_progress"]["total_xp"] == 5

    # 2. Submit wrong quiz answer -> logs mistake, quizzes_passed=False
    q_wrong = client.post(
        f"/api/workspace/courses/{course_id}/topics/{topic_index}/modules/{module_id}/quiz-submit",
        json={
            "answers": [{
                "question": "Чому дорівнює det [[a,b],[c,d]]?",
                "options": ["ad - bc", "ac - bd"],
                "chosen_index": 1,
                "correct_index": 0,
                "explanation": "Правильна формула: ad - bc.",
            }]
        },
    )
    assert q_wrong.status_code == 200
    assert q_wrong.json()["quizzes_passed"] is False
    prog = q_wrong.json()["learning_progress"]
    assert prog["mistakes_by_topic"][0]["unresolved_count"] == 1

    # Retry quiz correctly -> resolves mistake, quizzes_passed=True
    q_ok = client.post(
        f"/api/workspace/courses/{course_id}/topics/{topic_index}/modules/{module_id}/quiz-submit",
        json={
            "answers": [{
                "question": "Чому дорівнює det [[a,b],[c,d]]?",
                "options": ["ad - bc", "ac - bd"],
                "chosen_index": 0,
                "correct_index": 0,
                "explanation": "Правильна формула: ad - bc.",
            }]
        },
    )
    assert q_ok.status_code == 200
    assert q_ok.json()["quizzes_passed"] is True
    assert q_ok.json()["learning_progress"]["mistakes_by_topic"][0]["unresolved_count"] == 0

    # 3. Tutor check without Gemini key -> explicit 424
    t_no_key = client.post(
        f"/api/workspace/courses/{course_id}/topics/{topic_index}/modules/{module_id}/tutor-check",
        json={"answer_text": "Це якась таблиця"},
    )
    assert t_no_key.status_code == 424

    # Install key and mock low score (< 4/10) -> fail + returns 10/10 expected answer + records mistake
    install_key(store, bundle["course"]["owner_id"])

    async def grade_low(self, prompt, **kwargs):
        return json.dumps({
            "score": 2,
            "feedback": "Не вказано формулу визначника і умову квадратності матриці.",
            "mistakes": [{"mistake": "Пропущено формулу ad - bc", "correction": "Визначник існує лише для квадратних матриць."}],
            "expected_10_of_10": "Квадратна матриця порядку 2 має визначник det(A) = ad - bc, який характеризує оборотність перетворення.",
        })

    monkeypatch.setattr(GeminiService, "generate_content", grade_low)
    t_low = client.post(
        f"/api/workspace/courses/{course_id}/topics/{topic_index}/modules/{module_id}/tutor-check",
        json={"answer_text": "Ну це типу табличка чисел"},
    )
    assert t_low.status_code == 200
    t_low_data = t_low.json()
    assert t_low_data["score"] == 2
    assert t_low_data["passed"] is False
    assert "det(A) = ad - bc" in t_low_data["expected_10_of_10"]
    assert t_low_data["learning_progress"]["topics"][0]["modules_completed"] == 0
    assert t_low_data["learning_progress"]["mistakes_by_topic"][0]["unresolved_count"] == 1

    # Mock passing score (>= 4/10, and >= 8 resolves prior tutor mistakes) -> module completed!
    async def grade_pass(self, prompt, **kwargs):
        return json.dumps({
            "score": 9,
            "feedback": "Відмінне розуміння, головні властивості та формулу вказано точно.",
            "mistakes": [],
            "expected_10_of_10": "Повна 10/10 відповідь із геометричною інтерпретацією площі.",
        })

    monkeypatch.setattr(GeminiService, "generate_content", grade_pass)
    t_pass = client.post(
        f"/api/workspace/courses/{course_id}/topics/{topic_index}/modules/{module_id}/tutor-check",
        json={"answer_text": "Визначник квадратної матриці 2x2 дорівнює ad - bc і показує, чи матриця оборотна."},
    )
    assert t_pass.status_code == 200
    t_pass_data = t_pass.json()
    assert t_pass_data["passed"] is True
    assert t_pass_data["module_completed"] is True
    tp = t_pass_data["learning_progress"]["topics"][0]
    assert tp["modules_completed"] == 1
    assert 90 <= tp["score_percent"] <= 100
    assert t_pass_data["learning_progress"]["mistakes_by_topic"][0]["unresolved_count"] == 0

    # Isolation check: a fresh guest user cannot access this course's progress (404)
    other_client = TestClient(app)
    iso = other_client.get(f"/api/workspace/courses/{course_id}/learning-progress")
    assert iso.status_code == 404


def test_expert_video_analyst_structures_textbook_with_analogies_critique_and_html_urls(context, monkeypatch):
    client, store = context
    from app.models.mix import ExtensionModuleItem, ExtensionSectionPayload
    from app.services.mix_generator import extract_text_from_upload

    # 1. HTML extractor preserves embedded YouTube URLs instead of stripping <a href>/<iframe src>
    html_bytes = (
        b'<html><body><p>Lecture page</p>'
        b'<iframe src="https://www.youtube.com/embed/aircAruvnKk"></iframe></body></html>'
    )
    extracted_html = extract_text_from_upload("lecture.html", html_bytes)
    assert "https://www.youtube.com/watch?v=aircAruvnKk" in extracted_html

    # 2. Extension sync section filter preserves mod.url YouTube links
    sec_payload = ExtensionSectionPayload(
        section_index=1,
        title="Neural Networks",
        modules=[
            ExtensionModuleItem(
                module_id=77,
                name="Video Lecture",
                modname="url",
                url="https://youtu.be/aircAruvnKk",
            )
        ],
    )
    serialized, _, _, sec_chunks = store._filter_and_serialize_section(sec_payload)
    assert "https://www.youtube.com/watch?v=aircAruvnKk" in serialized
    assert "https://www.youtube.com/watch?v=aircAruvnKk" in sec_chunks[0]["content_text"]

    # 3. Full Expert Video Analyst pipeline flows into textbook structure when YouTube link is pasted in text
    def fake_transcript(youtube_url, preferred_languages=None):
        return {
            "success": True,
            "video_id": "aircAruvnKk",
            "language": "en",
            "source": "youtube_captions",
            "full_text": "Perceptrons compute weighted sums and pass them through activations. Backpropagation updates weights.",
            "segments": [
                {"text": "A neuron takes inputs and multiplies by weights.", "start_seconds": 12.0, "duration": 10.0},
                {"text": "Backpropagation propagates gradients from output to input.", "start_seconds": 185.0, "duration": 15.0},
            ],
        }

    monkeypatch.setattr(VideoTranscriberService, "get_youtube_transcript", classmethod(lambda cls, *a, **kw: fake_transcript(*a, **kw)))

    # Connect Gemini before creating text course so immediate textbook build uses Expert Video Analyst
    guest_res = client.post("/api/workspace/courses/create-text", json={
        "title": "Deep Learning",
        "topic_title": "Intro",
        "content_text": "Placeholder intro notes for owner setup.",
        "tools_config": {"mermaid_diagrams": False, "visual_cards": False},
    })
    assert guest_res.status_code == 200
    owner_id = client.get(f"/api/workspace/courses/{guest_res.json()['course_id']}").json()["course"]["owner_id"]
    install_key(store, owner_id)

    async def fake_expert_gemini(self, prompt, **kwargs):
        if "СУБТИТРИ ВІДЕО" in prompt:
            assert "1-2 clear everyday analogies" in prompt
            assert "critical analysis" in prompt.lower()
            return json.dumps({
                "video_summary": "Пояснення перцептрона та градієнтного навчання.",
                "core_message": "Нейронні мережі навчаються шляхом налаштування ваг за градієнтом похибки.",
                "structured_summary": "Лекція розбирає структуру нейрона та алгоритм зворотного поширення похибки на прикладі розпізнавання цифр.",
                "concepts": [
                    {
                        "concept_title": "Перцептрон і ваги",
                        "start_seconds": 12,
                        "end_seconds": 180,
                        "timecode": "00:12",
                        "summary": "Зважена сума входів та функція активації.",
                        "analogies": [
                            "Як журі конкурсу: кожен суддя має різну вагу голосу перед фінальним рішенням."
                        ],
                        "explanation_markdown": "Формально вихід нейрона задається як $\\sigma(w \\cdot x + b)$.",
                    },
                    {
                        "concept_title": "Зворотне поширення похибки",
                        "start_seconds": 185,
                        "end_seconds": 420,
                        "timecode": "03:05",
                        "summary": "Правило ланцюга для оновлення параметрів.",
                        "analogies": [
                            "Як налаштування рецепту страви: визначаємо, який інгредієнт зіпсував смак, і коригуємо його пропорцію."
                        ],
                        "explanation_markdown": "Градієнт обчислюється через похідну складеної функції.",
                    },
                ],
                "critical_analysis": {
                    "pros_and_cons": "Плюс: універсальна апроксимація; мінус: потреба у великих даних.",
                    "perspectives": "Освітній погляд: чудова візуальна інтуїція; практичний: потребує GPU для великих моделей.",
                    "public_trends": "Фундаментальна тема сучасного AI.",
                    "evidence_facts": "Емпірично підтверджено на датасеті MNIST (784 входи -> 10 класів).",
                },
                "actionable_framework": "1. Ініціалізувати ваги.\n2. Прямий прохід.\n3. Порахувати втрати.\n4. Оновити ваги.",
                "memory_aids": "Якір: Прямо -> Похибка -> Назад (П-П-Н).",
                "final_verdict": "Оцінка інформативності: 9.5/10 — обов'язковий фундамент перед трансформерами.",
            })
        if "multiple-choice" in prompt:
            return json.dumps([{
                "question": "Що робить backpropagation?",
                "options": ["Оновлює ваги за градієнтом", "Видаляє дані"],
                "correct_index": 0,
                "explanation": "Метод передає градієнт похибки назад мережею.",
            }])
        if "flashcards" in prompt:
            return json.dumps([{"front": "Перцептрон", "back": "w*x + b через активацію"}])
        return json.dumps({
            "short_description": "Розділ підручника з аналогіями, критичним аналізом і таймкодами.",
            "explanation_markdown": "## Модуль підручника\n\nПовне пояснення з аналогією та критичним аналізом.",
            "key_takeaways": ["Ваги", "Градієнт"],
            "module_quizzes": [{
                "question": "Навіщо потрібне правило ланцюга?",
                "options": ["Для обчислення градієнтів по шарах", "Для завантаження файлів"],
                "correct_index": 0,
                "explanation": "Правило ланцюга дозволяє знайти похідну втрат по кожній вазі.",
            }],
            "tutor_question": "Поясніть інтуїцію ваг нейрона через аналогію.",
            "tutor_expected_answer": "Ваги визначають вплив кожного вхідного сигналу, подібно до ваги голосу суддів.",
        })

    monkeypatch.setattr(GeminiService, "generate_content", fake_expert_gemini)

    yt_course_res = client.post("/api/workspace/courses/create-text", json={
        "title": "Нейронні мережі",
        "topic_title": "Основи нейромереж",
        "content_text": "Подивись цю лекцію: https://www.youtube.com/watch?v=aircAruvnKk",
        "tools_config": {"mermaid_diagrams": False, "visual_cards": False},
    })
    assert yt_course_res.status_code == 200
    yt_cid = yt_course_res.json()["course_id"]
    bundle = client.get(f"/api/workspace/courses/{yt_cid}").json()
    mix = bundle["topic_mixes"][0]

    # 2 concept modules + 1 synthesis module ("Критичний аналіз, практичний фреймворк і мнемоніка")
    assert len(mix["book_sections"]) == 3
    headings = [s["heading"] for s in mix["book_sections"]]
    assert "Перцептрон і ваги" in headings
    assert "Зворотне поширення похибки" in headings
    assert any("Критичний аналіз" in h for h in headings)
    assert mix["book_sections"][0]["video_concepts"][0]["youtube_url"] == "https://www.youtube.com/watch?v=aircAruvnKk&t=12s"
    assert bundle["topic_mixes"][0]["materials"][0]["has_transcript"] is True

