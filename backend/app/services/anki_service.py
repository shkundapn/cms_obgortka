import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException


DEFAULT_SETTINGS: Dict[str, Any] = {
    "daily_limit": 20,
    "course_ids": [],
    "include_learned": True,
    "include_new": True,
    "again_minutes": 10,
    "hard_minutes": 720,
    "good_days": 1.0,
    "easy_days": 4.0,
    "interval_multiplier": 1.0,
}

RATING_VALUES = ("again", "hard", "good", "easy")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_iso(dt: Optional[datetime] = None) -> str:
    return (dt or _utc_now()).isoformat()


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def make_card_key(course_id: int, topic_index: int, front: str) -> str:
    norm_front = " ".join(str(front or "").strip().lower().split())
    digest = hashlib.sha256(f"{int(course_id)}:{int(topic_index)}:{norm_front}".encode("utf-8")).hexdigest()[:16]
    return f"anki-{int(course_id)}-{int(topic_index)}-{digest}"


def format_interval_uk(interval_days: float) -> str:
    minutes = max(1, round(float(interval_days) * 1440.0))
    if minutes < 60:
        return f"{minutes} хв"
    hours = round(minutes / 60.0)
    if hours < 24:
        return f"{hours} год"
    days = round(float(interval_days))
    if days < 7:
        return f"{days} д"
    if days < 30:
        weeks = max(1, round(days / 7.0))
        return f"{weeks} тиж"
    months = max(1, round(days / 30.0))
    return f"{months} міс"


def ensure_anki_tables(store: Any) -> None:
    with store._connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS anki_settings (
                owner_id TEXT PRIMARY KEY,
                daily_limit INTEGER NOT NULL DEFAULT 20,
                course_ids_json TEXT NOT NULL DEFAULT '[]',
                include_learned INTEGER NOT NULL DEFAULT 1,
                include_new INTEGER NOT NULL DEFAULT 1,
                again_minutes INTEGER NOT NULL DEFAULT 10,
                hard_minutes INTEGER NOT NULL DEFAULT 720,
                good_days REAL NOT NULL DEFAULT 1.0,
                easy_days REAL NOT NULL DEFAULT 4.0,
                interval_multiplier REAL NOT NULL DEFAULT 1.0,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS anki_cards (
                owner_id TEXT NOT NULL,
                card_key TEXT NOT NULL,
                course_id INTEGER NOT NULL DEFAULT 0,
                course_title TEXT NOT NULL DEFAULT '',
                topic_index INTEGER NOT NULL DEFAULT 0,
                topic_title TEXT NOT NULL DEFAULT '',
                front TEXT NOT NULL,
                back TEXT NOT NULL,
                source_citation TEXT,
                is_learned INTEGER NOT NULL DEFAULT 0,
                is_custom INTEGER NOT NULL DEFAULT 0,
                repetitions INTEGER NOT NULL DEFAULT 0,
                lapses INTEGER NOT NULL DEFAULT 0,
                ease_factor REAL NOT NULL DEFAULT 2.5,
                interval_days REAL NOT NULL DEFAULT 0.0,
                last_rating TEXT,
                last_reviewed_at TEXT,
                next_review_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (owner_id, card_key)
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_anki_cards_owner_due
            ON anki_cards(owner_id, next_review_at, is_learned)
            """
        )


def get_anki_settings(store: Any, owner_id: str) -> Dict[str, Any]:
    ensure_anki_tables(store)
    with store._connect() as conn:
        row = conn.execute(
            "SELECT * FROM anki_settings WHERE owner_id = ?",
            (owner_id,),
        ).fetchone()
    if not row:
        return dict(DEFAULT_SETTINGS)
    try:
        course_ids = [int(c) for c in json.loads(row["course_ids_json"] or "[]")]
    except Exception:
        course_ids = []
    return {
        "daily_limit": max(1, min(100, int(row["daily_limit"]))),
        "course_ids": course_ids,
        "include_learned": bool(row["include_learned"]),
        "include_new": bool(row["include_new"]),
        "again_minutes": max(1, min(1440, int(row["again_minutes"]))),
        "hard_minutes": max(5, min(2880, int(row["hard_minutes"]))),
        "good_days": max(0.1, min(60.0, float(row["good_days"]))),
        "easy_days": max(0.5, min(120.0, float(row["easy_days"]))),
        "interval_multiplier": max(0.25, min(3.0, float(row["interval_multiplier"]))),
    }


def save_anki_settings(store: Any, owner_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    ensure_anki_tables(store)
    current = get_anki_settings(store, owner_id)
    merged = {
        "daily_limit": max(1, min(100, int(payload.get("daily_limit", current["daily_limit"])))),
        "course_ids": sorted({int(c) for c in payload.get("course_ids", current["course_ids"]) if int(c) > 0}),
        "include_learned": bool(payload.get("include_learned", current["include_learned"])),
        "include_new": bool(payload.get("include_new", current["include_new"])),
        "again_minutes": max(1, min(1440, int(payload.get("again_minutes", current["again_minutes"])))),
        "hard_minutes": max(5, min(2880, int(payload.get("hard_minutes", current["hard_minutes"])))),
        "good_days": max(0.1, min(60.0, float(payload.get("good_days", current["good_days"])))),
        "easy_days": max(0.5, min(120.0, float(payload.get("easy_days", current["easy_days"])))),
        "interval_multiplier": max(0.25, min(3.0, float(payload.get("interval_multiplier", current["interval_multiplier"])))),
    }
    now = _utc_iso()
    with store._connect() as conn:
        conn.execute(
            """
            INSERT INTO anki_settings (
                owner_id, daily_limit, course_ids_json, include_learned, include_new,
                again_minutes, hard_minutes, good_days, easy_days, interval_multiplier, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(owner_id) DO UPDATE SET
                daily_limit = excluded.daily_limit,
                course_ids_json = excluded.course_ids_json,
                include_learned = excluded.include_learned,
                include_new = excluded.include_new,
                again_minutes = excluded.again_minutes,
                hard_minutes = excluded.hard_minutes,
                good_days = excluded.good_days,
                easy_days = excluded.easy_days,
                interval_multiplier = excluded.interval_multiplier,
                updated_at = excluded.updated_at
            """,
            (
                owner_id,
                merged["daily_limit"],
                json.dumps(merged["course_ids"]),
                1 if merged["include_learned"] else 0,
                1 if merged["include_new"] else 0,
                merged["again_minutes"],
                merged["hard_minutes"],
                merged["good_days"],
                merged["easy_days"],
                merged["interval_multiplier"],
                now,
            ),
        )
    return merged


def compute_next_schedule(
    card: Dict[str, Any],
    rating: str,
    settings: Dict[str, Any],
    now: Optional[datetime] = None,
) -> Tuple[int, int, float, float, int, datetime]:
    """Compute next (repetitions, lapses, ease_factor, interval_days, is_learned, next_review_at)."""
    if rating not in RATING_VALUES:
        raise HTTPException(status_code=422, detail="Оцінка картки має бути: again, hard, good або easy.")

    now_dt = now or _utc_now()
    reps = int(card.get("repetitions") or 0)
    lapses = int(card.get("lapses") or 0)
    ef = float(card.get("ease_factor") or 2.5)
    prev_interval = float(card.get("interval_days") or 0.0)
    is_learned = int(card.get("is_learned") or 0)

    mult = float(settings.get("interval_multiplier") or 1.0)
    again_days = (float(settings.get("again_minutes") or 10) / 1440.0) * mult
    hard_base_days = (float(settings.get("hard_minutes") or 720) / 1440.0) * mult
    good_base_days = float(settings.get("good_days") or 1.0) * mult
    easy_base_days = float(settings.get("easy_days") or 4.0) * mult

    if rating == "again":
        lapses += 1
        reps = 0
        ef = max(1.3, round(ef - 0.20, 2))
        interval_days = max(1.0 / 1440.0, again_days)
    elif rating == "hard":
        reps = max(1, reps)
        ef = max(1.3, round(ef - 0.15, 2))
        if prev_interval < 0.5 or reps <= 1:
            interval_days = max(1.0 / 1440.0, hard_base_days)
        else:
            interval_days = max(hard_base_days, prev_interval * 1.2 * mult)
    elif rating == "good":
        is_learned = 1
        reps += 1
        if reps == 1:
            interval_days = good_base_days
        elif reps == 2:
            interval_days = max(good_base_days * 2.5, 6.0 * mult)
        else:
            interval_days = max(good_base_days, prev_interval * ef * mult)
    else:  # easy
        is_learned = 1
        reps += 1
        ef = min(3.0, round(ef + 0.15, 2))
        if reps == 1:
            interval_days = max(easy_base_days, good_base_days * 2.0)
        else:
            interval_days = max(easy_base_days, prev_interval * ef * 1.3 * mult)

    next_dt = now_dt + timedelta(days=interval_days)
    return reps, lapses, ef, round(interval_days, 5), is_learned, next_dt


def _interval_previews(card: Dict[str, Any], settings: Dict[str, Any]) -> Dict[str, str]:
    now_dt = _utc_now()
    previews: Dict[str, str] = {}
    for rating in RATING_VALUES:
        _, _, _, interval_days, _, _ = compute_next_schedule(card, rating, settings, now=now_dt)
        previews[rating] = format_interval_uk(interval_days)
    return previews


def sync_course_flashcards(store: Any, owner_id: str) -> List[Dict[str, Any]]:
    """Synchronize flashcards from all courses of owner into anki_cards without losing review schedules."""
    ensure_anki_tables(store)
    now = _utc_iso()
    courses_meta: List[Dict[str, Any]] = []
    seen_keys: set = set()

    courses = store.list_courses(owner_id=owner_id)
    with store._connect() as conn:
        for course in courses:
            bundle = store.get_course_bundle(course.course_id, owner_id=owner_id)
            if not bundle:
                continue
            course_card_count = 0
            for mix in bundle["topic_mixes"]:
                if not getattr(mix, "flashcards", None):
                    continue
                for card in mix.flashcards:
                    front = str(card.front or "").strip()
                    back = str(card.back or "").strip()
                    if not front or not back:
                        continue
                    key = make_card_key(course.course_id, mix.topic_index, front)
                    if key in seen_keys:
                        continue
                    seen_keys.add(key)
                    course_card_count += 1
                    conn.execute(
                        """
                        INSERT INTO anki_cards (
                            owner_id, card_key, course_id, course_title,
                            topic_index, topic_title, front, back, source_citation,
                            is_learned, is_custom, created_at, updated_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
                        ON CONFLICT(owner_id, card_key) DO UPDATE SET
                            course_title = excluded.course_title,
                            topic_title = excluded.topic_title,
                            front = excluded.front,
                            back = excluded.back,
                            source_citation = excluded.source_citation,
                            updated_at = excluded.updated_at
                        """,
                        (
                            owner_id,
                            key,
                            course.course_id,
                            course.title,
                            mix.topic_index,
                            mix.title,
                            front,
                            back,
                            getattr(card, "source_citation", None),
                            now,
                            now,
                        ),
                    )
            courses_meta.append({
                "course_id": course.course_id,
                "title": course.title,
                "cards_count": course_card_count,
            })

    return courses_meta


def set_card_learned(
    store: Any,
    owner_id: str,
    learned: bool,
    card_key: Optional[str] = None,
    course_id: int = 0,
    topic_index: int = 0,
    course_title: str = "",
    topic_title: str = "",
    front: str = "",
    back: str = "",
    source_citation: Optional[str] = None,
) -> Dict[str, Any]:
    ensure_anki_tables(store)
    key = (card_key or "").strip()
    if not key and front.strip():
        key = make_card_key(course_id, topic_index, front)
    if not key:
        raise HTTPException(status_code=422, detail="Не вказано картку або визначення.")

    now = _utc_iso()
    learned_int = 1 if learned else 0

    with store._connect() as conn:
        existing = conn.execute(
            "SELECT * FROM anki_cards WHERE owner_id = ? AND card_key = ?",
            (owner_id, key),
        ).fetchone()
        if not existing:
            if not front.strip() or not back.strip():
                raise HTTPException(status_code=404, detail="Картку не знайдено.")
            # When user explicitly marks a definition as learned for Anki, schedule its first review now so it enters rotation cleanly.
            next_at = now if learned else None
            conn.execute(
                """
                INSERT INTO anki_cards (
                    owner_id, card_key, course_id, course_title,
                    topic_index, topic_title, front, back, source_citation,
                    is_learned, is_custom, next_review_at, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
                """,
                (
                    owner_id,
                    key,
                    int(course_id or 0),
                    course_title,
                    int(topic_index or 0),
                    topic_title,
                    front.strip(),
                    back.strip(),
                    source_citation,
                    learned_int,
                    next_at,
                    now,
                    now,
                ),
            )
        else:
            next_at = existing["next_review_at"]
            if learned and not next_at:
                next_at = now
            conn.execute(
                """
                UPDATE anki_cards
                SET is_learned = ?, next_review_at = ?, updated_at = ?
                WHERE owner_id = ? AND card_key = ?
                """,
                (learned_int, next_at, now, owner_id, key),
            )

    return {"success": True, "card_key": key, "is_learned": bool(learned)}


def create_custom_anki_card(
    store: Any,
    owner_id: str,
    front: str,
    back: str,
    course_id: int = 0,
    course_title: str = "",
    topic_title: str = "",
    is_learned: bool = True,
) -> Dict[str, Any]:
    ensure_anki_tables(store)
    clean_front = front.strip()
    clean_back = back.strip()
    if not clean_front or not clean_back:
        raise HTTPException(status_code=422, detail="Заповни обидві сторони картки (питання/термін і визначення).")

    cid = int(course_id or 0)
    resolved_course_title = course_title.strip()
    if cid > 0 and not resolved_course_title:
        course = next((c for c in store.list_courses(owner_id=owner_id) if c.course_id == cid), None)
        if course:
            resolved_course_title = course.title

    key = f"anki-custom-{uuid.uuid4().hex[:12]}"
    now = _utc_iso()
    conn_next = now if is_learned else None
    with store._connect() as conn:
        conn.execute(
            """
            INSERT INTO anki_cards (
                owner_id, card_key, course_id, course_title,
                topic_index, topic_title, front, back, source_citation,
                is_learned, is_custom, next_review_at, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, 1, ?, ?, ?)
            """,
            (
                owner_id,
                key,
                cid,
                resolved_course_title or "Власні визначення",
                topic_title.strip() or "Особистий набір",
                clean_front,
                clean_back,
                1 if is_learned else 0,
                conn_next,
                now,
                now,
            ),
        )
    return {"success": True, "card_key": key}


def review_anki_card(
    store: Any,
    owner_id: str,
    card_key: str,
    rating: str,
) -> Dict[str, Any]:
    ensure_anki_tables(store)
    if rating not in RATING_VALUES:
        raise HTTPException(status_code=422, detail="Невідома оцінка повторення.")

    settings = get_anki_settings(store, owner_id)
    now_dt = _utc_now()
    now_iso = _utc_iso(now_dt)

    with store._connect() as conn:
        row = conn.execute(
            "SELECT * FROM anki_cards WHERE owner_id = ? AND card_key = ?",
            (owner_id, card_key),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Картку не знайдено.")

        card_dict = dict(row)
        reps, lapses, ef, interval_days, is_learned, next_dt = compute_next_schedule(
            card_dict, rating, settings, now=now_dt
        )
        next_iso = _utc_iso(next_dt)
        conn.execute(
            """
            UPDATE anki_cards
            SET repetitions = ?,
                lapses = ?,
                ease_factor = ?,
                interval_days = ?,
                is_learned = ?,
                last_rating = ?,
                last_reviewed_at = ?,
                next_review_at = ?,
                updated_at = ?
            WHERE owner_id = ? AND card_key = ?
            """,
            (
                reps,
                lapses,
                ef,
                interval_days,
                is_learned,
                rating,
                now_iso,
                next_iso,
                now_iso,
                owner_id,
                card_key,
            ),
        )

    session = get_anki_session(store, owner_id)
    return {
        "success": True,
        "card_key": card_key,
        "rating": rating,
        "interval_days": interval_days,
        "next_review_in": format_interval_uk(interval_days),
        "next_review_at": next_iso,
        "is_learned": bool(is_learned),
        "session": session,
    }


def _serialize_card(row: Dict[str, Any], settings: Dict[str, Any], now_dt: datetime) -> Dict[str, Any]:
    next_dt = _parse_iso(row.get("next_review_at"))
    is_due = next_dt is None or next_dt <= now_dt
    return {
        "card_key": row["card_key"],
        "course_id": int(row["course_id"]),
        "course_title": row["course_title"],
        "topic_index": int(row["topic_index"]),
        "topic_title": row["topic_title"],
        "front": row["front"],
        "back": row["back"],
        "source_citation": row.get("source_citation"),
        "is_learned": bool(row["is_learned"]),
        "is_custom": bool(row.get("is_custom")),
        "repetitions": int(row["repetitions"]),
        "lapses": int(row["lapses"]),
        "ease_factor": float(row["ease_factor"]),
        "interval_days": float(row["interval_days"]),
        "last_rating": row.get("last_rating"),
        "last_reviewed_at": row.get("last_reviewed_at"),
        "next_review_at": row.get("next_review_at"),
        "next_review_in": format_interval_uk((next_dt - now_dt).total_seconds() / 86400.0) if (next_dt and next_dt > now_dt) else "Зараз",
        "is_due": is_due,
        "interval_previews": _interval_previews(row, settings),
    }


def get_anki_session(
    store: Any,
    owner_id: str,
    practice_all: bool = False,
) -> Dict[str, Any]:
    courses_meta = sync_course_flashcards(store, owner_id)
    settings = get_anki_settings(store, owner_id)
    now_dt = _utc_now()
    today_prefix = now_dt.date().isoformat()

    with store._connect() as conn:
        rows = conn.execute(
            "SELECT * FROM anki_cards WHERE owner_id = ? ORDER BY updated_at DESC",
            (owner_id,),
        ).fetchall()

    selected_courses = set(settings["course_ids"])
    all_serialized = [_serialize_card(dict(r), settings, now_dt) for r in rows]

    # Filter by selected courses if user specified any (always include custom course_id=0 if included)
    filtered = [
        c for c in all_serialized
        if not selected_courses or c["course_id"] in selected_courses or (c["is_custom"] and c["course_id"] == 0)
    ]

    # Filter by learned/new flags per settings
    deck = [
        c for c in filtered
        if (c["is_learned"] and settings["include_learned"]) or ((not c["is_learned"]) and settings["include_new"])
    ]

    # Prioritize learned due cards first, then unscheduled learned cards, then new due cards
    due_cards = [c for c in deck if c["is_due"]]
    due_cards.sort(
        key=lambda c: (
            0 if c["is_learned"] else 1,
            c["next_review_at"] or "",
            c["course_id"],
            c["topic_index"],
        )
    )

    if practice_all and not due_cards:
        extra_pool = sorted(
            deck,
            key=lambda c: (0 if c["is_learned"] else 1, c["next_review_at"] or ""),
        )
        queue = extra_pool[: settings["daily_limit"]]
    else:
        queue = due_cards[: settings["daily_limit"]]

    future_dates = sorted(
        [_parse_iso(c["next_review_at"]) for c in deck if not c["is_due"] and _parse_iso(c["next_review_at"]) is not None]
    )
    next_due_dt = future_dates[0] if future_dates else None
    next_due_in = (
        format_interval_uk(max(1.0 / 1440.0, (next_due_dt - now_dt).total_seconds() / 86400.0))
        if next_due_dt
        else None
    )

    reviewed_today = sum(
        1 for c in all_serialized
        if c["last_reviewed_at"] and str(c["last_reviewed_at"]).startswith(today_prefix)
    )
    learned_cards = [c for c in filtered if c["is_learned"]]
    due_learned = sum(1 for c in due_cards if c["is_learned"])
    due_new = sum(1 for c in due_cards if not c["is_learned"])

    return {
        "settings": settings,
        "courses": courses_meta,
        "stats": {
            "total_cards": len(filtered),
            "deck_size": len(deck),
            "learned_count": len(learned_cards),
            "due_now": len(due_cards),
            "due_learned": due_learned,
            "due_new": due_new,
            "reviewed_today": reviewed_today,
            "next_due_at": next_due_dt.isoformat() if next_due_dt else None,
            "next_due_in": next_due_in,
        },
        "practice_all": bool(practice_all),
        "queue": queue,
        "learned_cards": learned_cards[:120],
        "learned_keys": [c["card_key"] for c in all_serialized if c["is_learned"]],
    }
