import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.services import workspace_store as ws
from app.services import build_queue as bq
from app.services.build_queue import DebouncedBuildQueue
from app.services.workspace_store import WorkspaceStore


@pytest.fixture
def context(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "GEMINI_API_KEY", "")
    monkeypatch.setattr(get_settings(), "VERTEX_AI_PROJECT", None)
    monkeypatch.setattr(get_settings(), "MOODLE_MOCK_MODE", False)
    monkeypatch.setattr(get_settings(), "WORKSPACE_DB_PATH", str(tmp_path / "workspace.db"))
    store = WorkspaceStore(str(tmp_path / "workspace.db"))
    queue = DebouncedBuildQueue()
    monkeypatch.setattr(ws, "_store_instance", store)
    monkeypatch.setattr(bq, "_build_queue", queue)
    yield TestClient(app), store
    queue.cancel_all()


def test_anki_settings_learned_definitions_and_varying_intervals(context):
    client, _ = context
    c1 = client.post("/api/workspace/courses/create-text", json={
        "title": "Математичний аналіз",
        "topic_title": "Границі",
        "content_text": "Границя функції показує поведінку f(x) при прямуванні x до a. Неперервність означає рівність границі значенню функції.",
        "tools_config": {"mermaid_diagrams": False, "visual_cards": False, "flashcards": True},
    }).json()["course_id"]

    # Add two explicit definitions (one marked as learned, another custom learned)
    add1 = client.post("/api/workspace/anki/cards", json={
        "front": "Означення границі за Коші",
        "back": "Для кожного epsilon > 0 існує delta > 0...",
        "course_id": c1,
        "is_learned": True,
    })
    assert add1.status_code == 200
    card1_key = add1.json()["card_key"]

    add2 = client.post("/api/workspace/anki/cards/learned", json={
        "learned": True,
        "course_id": c1,
        "topic_index": 1,
        "topic_title": "Границі",
        "front": "Неперервність функції",
        "back": "lim_{x->a} f(x) = f(a)",
    })
    assert add2.status_code == 200
    card2_key = add2.json()["card_key"]

    # Session includes learned definitions in queue & stats
    sess = client.get("/api/workspace/anki/session")
    assert sess.status_code == 200
    s_data = sess.json()
    assert s_data["stats"]["learned_count"] == 2
    queue_keys = {c["card_key"] for c in s_data["queue"]}
    assert card1_key in queue_keys
    assert card2_key in queue_keys

    # Varying intervals by knowledge rating:
    # 'again' schedules in minutes (again_minutes = 15)
    # 'easy' schedules in days (easy_days = 6 * multiplier)
    upd = client.put("/api/workspace/anki/settings", json={
        "daily_limit": 15,
        "course_ids": [c1],
        "include_learned": True,
        "include_new": False,
        "again_minutes": 15,
        "hard_minutes": 360,
        "good_days": 2.0,
        "easy_days": 6.0,
        "interval_multiplier": 1.0,
    })
    assert upd.status_code == 200
    assert upd.json()["settings"]["daily_limit"] == 15
    assert upd.json()["settings"]["include_new"] is False
    # Only the 2 learned cards remain in the deck when include_new=False
    assert upd.json()["stats"]["deck_size"] == 2

    # Review card 1 as 'again' (not confident) -> very short interval (~15 min)
    r_again = client.post("/api/workspace/anki/cards/review", json={
        "card_key": card1_key,
        "rating": "again",
    })
    assert r_again.status_code == 200
    again_days = r_again.json()["interval_days"]
    assert again_days < 0.05  # ~15 minutes

    # Review card 2 as 'easy' (knows very well) -> long interval (~6 days)
    r_easy = client.post("/api/workspace/anki/cards/review", json={
        "card_key": card2_key,
        "rating": "easy",
    })
    assert r_easy.status_code == 200
    easy_days = r_easy.json()["interval_days"]
    assert easy_days >= 6.0
    assert easy_days > again_days * 100

    # Scheduled future cards are no longer due right now
    after = r_easy.json()["session"]
    assert after["stats"]["due_now"] == 0
    assert after["stats"]["reviewed_today"] >= 2
    assert after["stats"]["next_due_in"]

    # Out-of-schedule practice still lets user review them
    cram = client.get("/api/workspace/anki/session?practice_all=true").json()
    assert len(cram["queue"]) == 2

    # Toggle include_learned=False hides learned definitions
    hide_learned = client.put("/api/workspace/anki/settings", json={
        "daily_limit": 15,
        "course_ids": [c1],
        "include_learned": False,
        "include_new": False,
    }).json()
    assert hide_learned["stats"]["deck_size"] == 0

    # Isolation: another guest user has empty Anki deck
    other = TestClient(app)
    other_sess = other.get("/api/workspace/anki/session").json()
    assert other_sess["stats"]["learned_count"] == 0
    assert other_sess["queue"] == []
