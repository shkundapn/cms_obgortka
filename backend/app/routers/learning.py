"""Connect a personal learning provider and prepare one topic deliberately."""
import asyncio
from datetime import datetime, timezone
import json

from typing import Any, Dict, List, Literal, Optional
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from app.core.security import WorkspaceOwner, get_workspace_owner
from app.models.mix import RawTopicSnapshot
from app.services.academic_cache import schedule_background_task
from app.services.anki_service import (
    create_custom_anki_card,
    get_anki_session,
    review_anki_card,
    save_anki_settings,
    set_card_learned,
)
from app.services.course_structure import build_course_map
from app.services.learning_progress_service import (
    evaluate_module_tutor,
    get_course_learning_progress,
    record_module_quiz_submission,
    record_video_concept_watch,
)
from app.services.learning_provider import LearningProviderError, LearningSettingsStore, learning_provider_scope, validate_gemini_key
from app.services.mix_generator import split_text_into_semantic_chunks
from app.services.oral_defense_service import MAX_AUDIO_BYTES, evaluate_oral_answer, generate_oral_question, last_oral_attempt
from app.services.topic_flashcards import add_manual_flashcard, expand_topic_flashcards, flashcard_session, review_flashcard
from app.services.topic_quizzes import QuizQuestionInput, add_manual_question, expand_topic_quiz, quiz_catalog
from app.services.workspace_store import get_workspace_store

router = APIRouter(prefix="/api/workspace", tags=["Learning"])


class KeyRequest(BaseModel):
    api_key: SecretStr


# The paper course is a separate namespace for the prototype's three reading topics.
OralCourse = int | Literal["paper"]


class PaperReading(BaseModel):
    course_title: str = Field(min_length=1, max_length=160)
    topic_title: str = Field(min_length=1, max_length=160)
    lecture_context: str = Field(min_length=25, max_length=18000)


def oral_course_id(course: OralCourse) -> int:
    if course == "paper":
        return -1
    if course < 0:
        raise HTTPException(404, "Курс не знайдено.")
    return course


class OralQuestionRequest(BaseModel):
    reading: Optional[PaperReading] = None
    node_id: Optional[str] = None
    previous_questions: List[str] = Field(default_factory=list)
    difficulty: str = "standard"


def private_response(response):
    response.headers["Cache-Control"] = "no-store"


def same_origin(request):
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
        raise HTTPException(403, "Відкрий налаштування безпосередньо у Hustle.")


@router.get("/learning/settings")
async def learning_settings(response: Response, owner: WorkspaceOwner = Depends(get_workspace_owner)):
    private_response(response)
    return LearningSettingsStore(get_workspace_store().db_path).status(owner.owner_id)


@router.put("/learning/settings")
async def connect_learning(req: KeyRequest, request: Request, response: Response, owner: WorkspaceOwner = Depends(get_workspace_owner)):
    same_origin(request)
    private_response(response)
    key = req.api_key.get_secret_value().strip()
    model = await validate_gemini_key(key)
    settings = LearningSettingsStore(get_workspace_store().db_path)
    settings.save(owner.owner_id, key, model)
    return settings.status(owner.owner_id)


@router.delete("/learning/settings")
async def reset_learning_key(request: Request, response: Response, owner: WorkspaceOwner = Depends(get_workspace_owner)):
    same_origin(request)
    private_response(response)
    settings = LearningSettingsStore(get_workspace_store().db_path)
    settings.delete(owner.owner_id)
    return settings.status(owner.owner_id)


def _archive_mix_version(conn, owner_id: str, mix) -> None:
    conn.execute("""CREATE TABLE IF NOT EXISTS learning_topic_versions (
        owner_id TEXT NOT NULL, mix_id TEXT NOT NULL, saved_at TEXT NOT NULL,
        mix_json TEXT NOT NULL, PRIMARY KEY(owner_id, mix_id, saved_at))""")
    conn.execute("INSERT INTO learning_topic_versions VALUES (?, ?, ?, ?)",
                 (owner_id, mix.mix_id, datetime.now(timezone.utc).isoformat(), mix.model_dump_json()))


async def prepare_topic(store, owner_id, course_id, topic_index, provider):
    bundle = store.get_course_bundle(course_id, owner_id)
    if not bundle:
        raise HTTPException(404, "Курс не знайдено.")
    previous = next((mix for mix in bundle["topic_mixes"] if mix.topic_index == topic_index), None)
    if not previous:
        raise HTTPException(404, "Додай матеріали до цієї теми.")
    with store._connect() as conn:
        row = conn.execute("SELECT * FROM topic_snapshots WHERE owner_id=? AND course_id=? AND topic_index=?",
                           (owner_id, course_id, topic_index)).fetchone()
    if not row or row["safety_status"] == "restricted_exam" or not row["content_text"].strip():
        raise HTTPException(422, "У темі ще немає навчального тексту. Додай лекцію або конспект.")
    snapshot = RawTopicSnapshot(**{key: row[key] for key in (
        "source_id", "course_id", "authority", "title", "content_text", "source_type", "source_hash", "safety_status", "visibility")})
    chunks = store._load_topic_chunks(owner_id, course_id, topic_index)
    if not chunks:
        chunks = [{**chunk, "module_hash": chunk["content_hash"], "safety_status": snapshot.safety_status}
                  for chunk in split_text_into_semantic_chunks(snapshot.title, snapshot.content_text)]
    tools = previous.tools_enabled.model_copy(update={"interactive_book": True, "flashcards": True, "practice_quizzes": True})
    with learning_provider_scope(provider):
        chunks, enriched_text = await store.enrich_chunks_with_youtube(
            chunks,
            snapshot_text=snapshot.content_text,
            course_title=bundle["course"].title,
            topic_title=snapshot.title,
        )
        prepared_snapshot = (
            snapshot.model_copy(update={"content_text": enriched_text})
            if enriched_text and enriched_text != snapshot.content_text
            else snapshot
        )
        mix, _, _ = await store._build_topic_mix_cached(
            snapshot=prepared_snapshot, tools=tools, topic_index=topic_index, chunks=chunks,
            existing_notes=previous.user_notes, version=previous.version + 1,
            stable_mix_id=previous.mix_id, materials=previous.materials,
            course_title=bundle["course"].title)
    # Preserve the previous generated version before replacing its current view.
    with store._connect() as conn:
        _archive_mix_version(conn, owner_id, previous)
    # Do not accept an obsolete generation if the source changed during the API call.
    current = store.get_course_bundle(course_id, owner_id)
    latest = next((item for item in current["topic_mixes"] if item.mix_id == previous.mix_id), None) if current else None
    if not latest or latest.source_hash != previous.source_hash:
        raise HTTPException(409, "Матеріали теми змінилися. Онови сторінку та підготуй тему ще раз.")
    mix.has_upstream_update = latest.has_upstream_update
    mix.dirty_chunk_ids = latest.dirty_chunk_ids
    store._save_topic_mix(mix, owner_id)
    course_tools = bundle["tools_config"].copy()
    course_tools.update(interactive_book=True, flashcards=True, practice_quizzes=True)
    from app.models.mix import CourseToolsConfig
    store.update_tools_config(course_id, CourseToolsConfig.model_validate(course_tools), owner_id)
    store._set_exam_mix_stale(owner_id, course_id, True)
    fresh = store.get_course_bundle(course_id, owner_id)
    return {"success": True, "mix_id": mix.mix_id, "course_map": build_course_map(fresh)}


@router.post("/courses/{course_id}/topics/{topic_index}/prepare-learning")
async def prepare_learning(course_id: int, topic_index: int, request: Request, owner: WorkspaceOwner = Depends(get_workspace_owner)):
    same_origin(request)
    store = get_workspace_store()
    provider = LearningSettingsStore(store.db_path).get(owner.owner_id)
    if not provider:
        raise LearningProviderError("Підключи Gemini API key, щоб підготувати тему.", 424)
    task = schedule_background_task(prepare_topic(store, owner.owner_id, course_id, topic_index, provider),
                                    dedup_key=("prepare-learning", owner.owner_id, course_id, topic_index))
    return await asyncio.shield(task)


class FlashcardReviewRequest(BaseModel):
    card_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    rating: Literal["again", "hard", "good", "easy"]


class FlashcardInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    front: str = Field(min_length=5, max_length=400)
    back: str = Field(min_length=1, max_length=900)


@router.get("/courses/{course_id}/flashcards")
async def get_course_flashcards(
    course_id: int,
    response: Response,
    topic_index: Optional[int] = None,
    practice_all: bool = False,
    owner: WorkspaceOwner = Depends(get_workspace_owner),
):
    private_response(response)
    return flashcard_session(get_workspace_store(), owner.owner_id, course_id, topic_index, practice_all)


@router.post("/courses/{course_id}/topics/{topic_index}/flashcards")
async def add_topic_flashcards(
    course_id: int,
    topic_index: int,
    request: Request,
    response: Response,
    owner: WorkspaceOwner = Depends(get_workspace_owner),
):
    same_origin(request)
    private_response(response)
    task = schedule_background_task(
        expand_topic_flashcards(get_workspace_store(), owner.owner_id, course_id, topic_index),
        dedup_key=("topic-flashcards", owner.owner_id, course_id, topic_index),
    )
    return await asyncio.shield(task)


@router.post("/courses/{course_id}/topics/{topic_index}/flashcards/review")
async def rate_flashcard(
    course_id: int,
    topic_index: int,
    req: FlashcardReviewRequest,
    request: Request,
    response: Response,
    owner: WorkspaceOwner = Depends(get_workspace_owner),
):
    same_origin(request)
    private_response(response)
    return review_flashcard(get_workspace_store(), owner.owner_id, course_id, topic_index, req.card_id, req.rating)


@router.post("/courses/{course_id}/topics/{topic_index}/flashcards/manual")
async def create_manual_flashcard(
    course_id: int,
    topic_index: int,
    req: FlashcardInput,
    request: Request,
    response: Response,
    owner: WorkspaceOwner = Depends(get_workspace_owner),
):
    same_origin(request)
    private_response(response)
    return add_manual_flashcard(get_workspace_store(), owner.owner_id, course_id, topic_index, req.front, req.back)


@router.get("/courses/{course_id}/quizzes")
async def get_course_quizzes(
    course_id: int,
    response: Response,
    topic_index: Optional[int] = None,
    owner: WorkspaceOwner = Depends(get_workspace_owner),
):
    private_response(response)
    return quiz_catalog(get_workspace_store(), owner.owner_id, course_id, topic_index)


@router.post("/courses/{course_id}/topics/{topic_index}/quizzes")
async def generate_topic_quiz(
    course_id: int,
    topic_index: int,
    request: Request,
    response: Response,
    owner: WorkspaceOwner = Depends(get_workspace_owner),
):
    same_origin(request)
    private_response(response)
    task = schedule_background_task(
        expand_topic_quiz(get_workspace_store(), owner.owner_id, course_id, topic_index),
        dedup_key=("topic-quizzes", owner.owner_id, course_id, topic_index),
    )
    return await asyncio.shield(task)


@router.post("/courses/{course_id}/topics/{topic_index}/quizzes/manual")
async def create_manual_question(
    course_id: int,
    topic_index: int,
    req: QuizQuestionInput,
    request: Request,
    response: Response,
    owner: WorkspaceOwner = Depends(get_workspace_owner),
):
    same_origin(request)
    private_response(response)
    return add_manual_question(get_workspace_store(), owner.owner_id, course_id, topic_index, req)


@router.delete("/courses/{course_id}/topics/{topic_index}/generated")
async def clear_topic_generated(course_id: int, topic_index: int, request: Request, owner: WorkspaceOwner = Depends(get_workspace_owner)):
    """Clear generated book sections, quizzes, and flashcards for one topic while keeping notes and sources."""
    same_origin(request)
    store = get_workspace_store()
    bundle = store.get_course_bundle(course_id, owner.owner_id)
    if not bundle:
        raise HTTPException(404, "Курс не знайдено.")
    previous = next((mix for mix in bundle["topic_mixes"] if mix.topic_index == topic_index), None)
    if not previous:
        raise HTTPException(404, "Тему не знайдено.")
    with store._connect() as conn:
        _archive_mix_version(conn, owner.owner_id, previous)
    cleared = previous.model_copy(
        update={
            "book_sections": [],
            "quizzes": [],
            "flashcards": [],
            "dirty_chunk_ids": [],
            "version": previous.version + 1,
            "updated_at": datetime.now(timezone.utc),
        }
    )
    store._save_topic_mix(cleared, owner.owner_id)
    store._set_exam_mix_stale(owner.owner_id, course_id, True)
    fresh = store.get_course_bundle(course_id, owner.owner_id)
    return {"success": True, "mix_id": cleared.mix_id, "course_map": build_course_map(fresh)}


@router.delete("/courses/{course_id}/generated")
async def clear_course_generated(course_id: int, request: Request, owner: WorkspaceOwner = Depends(get_workspace_owner)):
    """Clear generated AI study content across all topics in a course while preserving notes, sources, and history."""
    same_origin(request)
    store = get_workspace_store()
    bundle = store.get_course_bundle(course_id, owner.owner_id)
    if not bundle:
        raise HTTPException(404, "Курс не знайдено.")
    now = datetime.now(timezone.utc)
    cleared_count = 0
    with store._connect() as conn:
        for previous in bundle["topic_mixes"]:
            if previous.book_sections or previous.quizzes or previous.flashcards:
                _archive_mix_version(conn, owner.owner_id, previous)
                cleared_count += 1
        conn.execute("DELETE FROM exam_mixes WHERE owner_id = ? AND course_id = ?", (owner.owner_id, course_id))
    for previous in bundle["topic_mixes"]:
        if previous.book_sections or previous.quizzes or previous.flashcards:
            cleared = previous.model_copy(
                update={
                    "book_sections": [],
                    "quizzes": [],
                    "flashcards": [],
                    "dirty_chunk_ids": [],
                    "version": previous.version + 1,
                    "updated_at": now,
                }
            )
            store._save_topic_mix(cleared, owner.owner_id)
    store._set_exam_mix_stale(owner.owner_id, course_id, False)
    fresh = store.get_course_bundle(course_id, owner.owner_id)
    return {"success": True, "cleared_topics": cleared_count, "course_map": build_course_map(fresh)}


@router.post("/courses/{course_id}/topics/{topic_index}/oral-defense/question")
async def oral_defense_question(
    course_id: OralCourse,
    topic_index: int,
    req: OralQuestionRequest,
    request: Request,
    response: Response,
    owner: WorkspaceOwner = Depends(get_workspace_owner),
):
    same_origin(request)
    private_response(response)
    store = get_workspace_store()
    provider = LearningSettingsStore(store.db_path).get(owner.owner_id)
    if not provider:
        raise LearningProviderError("Підключи Gemini API key, щоб розпочати усний захист.", 424)
    with learning_provider_scope(provider):
        reading = None
        if course_id == "paper":
            if req.reading is None or topic_index not in (1, 2, 3):
                raise HTTPException(422, "Обери тему з навчальними матеріалами.")
            reading = {**req.reading.model_dump(), "source_names": [req.reading.topic_title]}
        return await generate_oral_question(
            store=store,
            owner_id=owner.owner_id,
            course_id=oral_course_id(course_id),
            topic_index=topic_index,
            node_id=req.node_id,
            previous_questions=req.previous_questions,
            difficulty=req.difficulty,
            reading=reading,
        )


@router.post("/courses/{course_id}/topics/{topic_index}/oral-defense/evaluate")
async def oral_defense_evaluate(
    course_id: OralCourse,
    topic_index: int,
    request: Request,
    response: Response,
    question_id: str = Form(...),
    transcript: Optional[str] = Form(None),
    audio: Optional[UploadFile] = File(None),
    owner: WorkspaceOwner = Depends(get_workspace_owner),
):
    same_origin(request)
    private_response(response)
    store = get_workspace_store()
    provider = LearningSettingsStore(store.db_path).get(owner.owner_id)
    if not provider:
        raise LearningProviderError("Підключи Gemini API key, щоб перевірити відповідь.", 424)

    audio_bytes: Optional[bytes] = None
    audio_mime: Optional[str] = None
    if audio is not None:
        audio_bytes = await audio.read(MAX_AUDIO_BYTES + 1)
        if len(audio_bytes) > MAX_AUDIO_BYTES:
            raise HTTPException(413, "Аудіозапис завеликий (максимум 15 МБ).")
        audio_mime = audio.content_type

    with learning_provider_scope(provider):
        return await evaluate_oral_answer(
            store=store,
            owner_id=owner.owner_id,
            course_id=oral_course_id(course_id),
            topic_index=topic_index,
            question_id=question_id,
            audio_bytes=audio_bytes,
            audio_mime=audio_mime,
            transcript=transcript,
        )


@router.get("/courses/{course_id}/topics/{topic_index}/oral-defense/latest")
async def latest_oral_defense(course_id: OralCourse, topic_index: int, response: Response,
                              node_id: Optional[str] = None, owner: WorkspaceOwner = Depends(get_workspace_owner)):
    private_response(response)
    return {"attempt": last_oral_attempt(get_workspace_store().db_path, owner.owner_id,
                                         oral_course_id(course_id), topic_index, node_id)}


class VideoWatchRequest(BaseModel):
    concept_id: str
    concept_title: str = ""
    youtube_url: str = ""


class ModuleQuizSubmitRequest(BaseModel):
    answers: List[Dict[str, Any]] = Field(default_factory=list)


@router.get("/courses/{course_id}/learning-progress")
async def course_learning_progress(
    course_id: int,
    response: Response,
    owner: WorkspaceOwner = Depends(get_workspace_owner),
):
    private_response(response)
    return get_course_learning_progress(get_workspace_store(), owner.owner_id, course_id)


@router.post("/courses/{course_id}/topics/{topic_index}/modules/{module_id}/video-watch")
async def module_video_watch(
    course_id: int,
    topic_index: int,
    module_id: str,
    req: VideoWatchRequest,
    request: Request,
    response: Response,
    owner: WorkspaceOwner = Depends(get_workspace_owner),
):
    same_origin(request)
    private_response(response)
    return record_video_concept_watch(
        store=get_workspace_store(),
        owner_id=owner.owner_id,
        course_id=course_id,
        topic_index=topic_index,
        module_id=module_id,
        concept_id=req.concept_id,
        concept_title=req.concept_title,
        youtube_url=req.youtube_url,
    )


@router.post("/courses/{course_id}/topics/{topic_index}/modules/{module_id}/quiz-submit")
async def module_quiz_submit(
    course_id: int,
    topic_index: int,
    module_id: str,
    req: ModuleQuizSubmitRequest,
    request: Request,
    response: Response,
    owner: WorkspaceOwner = Depends(get_workspace_owner),
):
    same_origin(request)
    private_response(response)
    return record_module_quiz_submission(
        store=get_workspace_store(),
        owner_id=owner.owner_id,
        course_id=course_id,
        topic_index=topic_index,
        module_id=module_id,
        answers=req.answers,
    )


@router.post("/courses/{course_id}/topics/{topic_index}/modules/{module_id}/tutor-check")
async def module_tutor_check(
    course_id: int,
    topic_index: int,
    module_id: str,
    request: Request,
    response: Response,
    owner: WorkspaceOwner = Depends(get_workspace_owner),
):
    same_origin(request)
    private_response(response)
    store = get_workspace_store()
    provider = LearningSettingsStore(store.db_path).get(owner.owner_id)
    if not provider:
        raise LearningProviderError("Підключи Gemini API key, щоб AI-тютор перевірив відповідь.", 424)

    answer_text = ""
    audio_bytes: Optional[bytes] = None
    audio_mime: Optional[str] = None
    content_type = (request.headers.get("content-type") or "").lower()
    if "multipart/form-data" in content_type:
        form = await request.form()
        answer_text = str(form.get("answer_text") or "")
        audio_file = form.get("audio")
        if audio_file is not None and hasattr(audio_file, "read"):
            audio_bytes = await audio_file.read(MAX_AUDIO_BYTES + 1)
            if len(audio_bytes) > MAX_AUDIO_BYTES:
                raise HTTPException(413, "Аудіозапис завеликий (максимум 15 МБ).")
            audio_mime = getattr(audio_file, "content_type", None)
    else:
        try:
            body = await request.json()
            answer_text = str((body or {}).get("answer_text") or "")
        except Exception:
            answer_text = ""

    with learning_provider_scope(provider):
        return await evaluate_module_tutor(
            store=store,
            owner_id=owner.owner_id,
            course_id=course_id,
            topic_index=topic_index,
            module_id=module_id,
            answer_text=answer_text,
            audio_bytes=audio_bytes,
            audio_mime=audio_mime,
        )


class AnkiSettingsUpdateRequest(BaseModel):
    daily_limit: int = Field(default=20, ge=1, le=500)
    course_ids: List[int] = Field(default_factory=list)
    include_learned: bool = True
    include_new: bool = True
    again_minutes: int = Field(default=10, ge=1, le=1440)
    hard_minutes: int = Field(default=720, ge=5, le=2880)
    good_days: float = Field(default=1.0, ge=0.1, le=60.0)
    easy_days: float = Field(default=4.0, ge=0.5, le=120.0)
    interval_multiplier: float = Field(default=1.0, ge=0.25, le=3.0)
    target_retention: float = Field(default=0.90, ge=0.80, le=0.98)
    daily_minutes: int = Field(default=20, ge=5, le=240)
    avg_seconds_per_card: float = Field(default=18.0, ge=5.0, le=120.0)
    new_cards_limit: int = Field(default=15, ge=0, le=100)
    maximum_interval: int = Field(default=365, ge=1, le=36500)
    learning_steps: List[int] = Field(default_factory=lambda: [1, 10])
    relearning_steps: List[int] = Field(default_factory=lambda: [10])
    fsrs_weights: List[float] = Field(default_factory=list)


class AnkiReviewRequest(BaseModel):
    card_key: str = Field(min_length=1, max_length=200)
    rating: Literal["again", "hard", "good", "easy"]
    interval_days: Optional[float] = Field(default=None, ge=0.0, le=36500.0)
    next_review_at: Optional[str] = Field(default=None, max_length=80)
    card_state: Optional[Literal["new", "learning", "review", "relearning"]] = None
    repetitions: Optional[int] = Field(default=None, ge=0, le=100000)
    lapses: Optional[int] = Field(default=None, ge=0, le=100000)
    ease_factor: Optional[float] = Field(default=None, ge=1.0, le=5.0)
    fsrs_state: Optional[Dict[str, Any]] = None
    review_duration_ms: Optional[int] = Field(default=None, ge=0, le=600000)


class AnkiLearnedRequest(BaseModel):
    learned: bool = True
    card_key: Optional[str] = Field(default=None, max_length=200)
    course_id: int = 0
    topic_index: int = 0
    course_title: str = Field(default="", max_length=200)
    topic_title: str = Field(default="", max_length=200)
    front: str = Field(default="", max_length=2000)
    back: str = Field(default="", max_length=4000)
    source_citation: Optional[str] = Field(default=None, max_length=400)


class AnkiCustomCardRequest(BaseModel):
    front: str = Field(min_length=1, max_length=2000)
    back: str = Field(min_length=1, max_length=4000)
    course_id: int = 0
    course_title: str = Field(default="", max_length=200)
    topic_title: str = Field(default="", max_length=200)
    is_learned: bool = True


@router.get("/anki/session")
async def anki_session(
    response: Response,
    practice_all: bool = False,
    course_id: Optional[int] = None,
    owner: WorkspaceOwner = Depends(get_workspace_owner),
):
    private_response(response)
    return get_anki_session(get_workspace_store(), owner.owner_id, practice_all=practice_all, course_id=course_id)


@router.put("/anki/settings")
async def update_anki_settings(
    req: AnkiSettingsUpdateRequest,
    request: Request,
    response: Response,
    owner: WorkspaceOwner = Depends(get_workspace_owner),
):
    same_origin(request)
    private_response(response)
    store = get_workspace_store()
    save_anki_settings(store, owner.owner_id, req.model_dump())
    return get_anki_session(store, owner.owner_id)


@router.post("/anki/cards/review")
async def submit_anki_review(
    req: AnkiReviewRequest,
    request: Request,
    response: Response,
    owner: WorkspaceOwner = Depends(get_workspace_owner),
):
    same_origin(request)
    private_response(response)
    override = req.model_dump(exclude={"card_key", "rating"}, exclude_none=True)
    return review_anki_card(get_workspace_store(), owner.owner_id, req.card_key, req.rating, srs_override=override or None)


@router.post("/anki/cards/learned")
async def toggle_anki_learned(
    req: AnkiLearnedRequest,
    request: Request,
    response: Response,
    owner: WorkspaceOwner = Depends(get_workspace_owner),
):
    same_origin(request)
    private_response(response)
    store = get_workspace_store()
    res = set_card_learned(
        store,
        owner.owner_id,
        learned=req.learned,
        card_key=req.card_key,
        course_id=req.course_id,
        topic_index=req.topic_index,
        course_title=req.course_title,
        topic_title=req.topic_title,
        front=req.front,
        back=req.back,
        source_citation=req.source_citation,
    )
    res["session"] = get_anki_session(store, owner.owner_id)
    return res


@router.post("/anki/cards")
async def add_custom_anki_card(
    req: AnkiCustomCardRequest,
    request: Request,
    response: Response,
    owner: WorkspaceOwner = Depends(get_workspace_owner),
):
    same_origin(request)
    private_response(response)
    store = get_workspace_store()
    res = create_custom_anki_card(
        store,
        owner.owner_id,
        front=req.front,
        back=req.back,
        course_id=req.course_id,
        course_title=req.course_title,
        topic_title=req.topic_title,
        is_learned=req.is_learned,
    )
    res["session"] = get_anki_session(store, owner.owner_id)
    return res
