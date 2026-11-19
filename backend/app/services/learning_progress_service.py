"""Per-module learning verification, YouTube concept watch bonuses, topic scoring, and structured mistake tracking."""
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException

from app.services.course_structure import build_course_map
from app.services.gemini_service import GeminiService
from app.services.learning_provider import LearningProviderError


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_tables(store: Any) -> None:
    with store._connect() as conn:
        store._create_tables(conn)


def _section_module_id(sec: Any, idx: int) -> str:
    if isinstance(sec, dict):
        return str(sec.get("module_id") or sec.get("chunk_id") or f"sec-{idx}")
    return str(getattr(sec, "module_id", None) or getattr(sec, "chunk_id", None) or f"sec-{idx}")


def _section_dict(sec: Any) -> Dict[str, Any]:
    if hasattr(sec, "model_dump"):
        return sec.model_dump(mode="json")
    return dict(sec)


def resolve_module_context(
    store: Any,
    owner_id: str,
    course_id: int,
    topic_index: int,
    module_id: str,
) -> Dict[str, Any]:
    bundle = store.get_course_bundle(course_id, owner_id)
    if not bundle:
        raise HTTPException(status_code=404, detail="Курс не знайдено.")

    mix = next((m for m in (bundle.get("topic_mixes") or []) if m.topic_index == topic_index), None)
    course_map = build_course_map(bundle) or {}
    nodes = course_map.get("nodes") or []
    node = next((n for n in nodes if n.get("topic_index") == topic_index), None)

    sections: List[Dict[str, Any]] = []
    if mix and mix.book_sections:
        sections = [_section_dict(s) for s in mix.book_sections]
    elif node and node.get("book_sections"):
        sections = [dict(s) for s in node["book_sections"]]

    target_sec = None
    for idx, sec in enumerate(sections):
        if _section_module_id(sec, idx) == module_id or str(sec.get("chunk_id") or "") == module_id:
            target_sec = sec
            break

    if not target_sec and sections:
        # Fallback match by numeric index suffix
        target_sec = next((s for i, s in enumerate(sections) if f"sec-{i}" == module_id), None)

    if not target_sec:
        raise HTTPException(status_code=404, detail="Модуль підручника не знайдено.")

    topic_title = (mix.title if mix else None) or (node.get("title") if node else None) or f"Тема {topic_index}"
    heading = str(target_sec.get("heading") or topic_title)
    content = str(target_sec.get("explanation_markdown") or "")
    takeaways = target_sec.get("key_takeaways") or []
    if takeaways:
        content += "\n\nКлючові тези:\n" + "\n".join(f"- {t}" for t in takeaways)

    tutor_q = str(target_sec.get("tutor_question") or "").strip()
    if not tutor_q:
        tutor_q = f"Поясніть своїми словами головну ідею, визначення та практичне значення розділу «{heading}»."

    tutor_expected = str(target_sec.get("tutor_expected_answer") or "").strip()
    if not tutor_expected:
        tutor_expected = (
            f"Повна відповідь на 10/10 повинна розкривати: " + "; ".join(str(t) for t in takeaways[:4])
            if takeaways
            else f"Чітке визначення основних понять розділу «{heading}», умови застосування та приклади."
        )

    return {
        "topic_index": topic_index,
        "topic_title": topic_title,
        "module_id": module_id,
        "module_title": heading,
        "module_content": content,
        "tutor_question": tutor_q,
        "tutor_expected_answer": tutor_expected,
        "module_quizzes": target_sec.get("module_quizzes") or [],
    }


def _compute_module_completed(quizzes_passed: int, tutor_passed: int) -> int:
    return 1 if (quizzes_passed and tutor_passed) else 0


def record_video_concept_watch(
    store: Any,
    owner_id: str,
    course_id: int,
    topic_index: int,
    module_id: str,
    concept_id: str,
    concept_title: str = "",
    youtube_url: str = "",
) -> Dict[str, Any]:
    _ensure_tables(store)
    cid = str(concept_id or youtube_url or "concept").strip()
    now = _utc_iso()

    with store._connect() as conn:
        row = conn.execute(
            """
            SELECT * FROM module_progress
            WHERE owner_id = ? AND course_id = ? AND topic_index = ? AND module_id = ?
            """,
            (owner_id, course_id, topic_index, module_id),
        ).fetchone()

        watched: List[str] = json.loads(row["watched_concepts_json"]) if row else []
        bonus_awarded = 0
        if cid and cid not in watched:
            watched.append(cid)
            bonus_awarded = 5

        total_bonus = (int(row["video_bonus_points"]) if row else 0) + bonus_awarded
        quizzes_passed = int(row["quizzes_passed"]) if row else 0
        quizzes_correct = int(row["quizzes_correct"]) if row else 0
        quizzes_total = int(row["quizzes_total"]) if row else 0
        tutor_passed = int(row["tutor_passed"]) if row else 0
        completed = _compute_module_completed(quizzes_passed, tutor_passed)

        conn.execute(
            """
            INSERT INTO module_progress (
                owner_id, course_id, topic_index, module_id,
                watched_concepts_json, video_bonus_points,
                quizzes_passed, quizzes_correct, quizzes_total,
                tutor_score, tutor_passed, tutor_answer, tutor_feedback, tutor_expected_10,
                completed, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(owner_id, course_id, topic_index, module_id) DO UPDATE SET
                watched_concepts_json = excluded.watched_concepts_json,
                video_bonus_points = excluded.video_bonus_points,
                updated_at = excluded.updated_at
            """,
            (
                owner_id, course_id, topic_index, module_id,
                json.dumps(watched, ensure_ascii=False), total_bonus,
                quizzes_passed, quizzes_correct, quizzes_total,
                row["tutor_score"] if row else None, tutor_passed,
                row["tutor_answer"] if row else None,
                row["tutor_feedback"] if row else None,
                row["tutor_expected_10"] if row else None,
                completed, now,
            ),
        )

    progress = get_course_learning_progress(store, owner_id, course_id)
    return {
        "success": True,
        "module_id": module_id,
        "concept_id": cid,
        "bonus_awarded": bonus_awarded,
        "video_bonus_points": total_bonus,
        "watched_concepts": watched,
        "message": (
            f"+{bonus_awarded} XP бонус за перегляд концепту «{concept_title or cid}»!"
            if bonus_awarded
            else "Цей відеоконцепт уже переглянуто (бонус збережено)."
        ),
        "learning_progress": progress,
    }


def record_module_quiz_submission(
    store: Any,
    owner_id: str,
    course_id: int,
    topic_index: int,
    module_id: str,
    answers: List[Dict[str, Any]],
) -> Dict[str, Any]:
    _ensure_tables(store)
    ctx = resolve_module_context(store, owner_id, course_id, topic_index, module_id)
    if not answers:
        raise HTTPException(status_code=422, detail="Надайте відповіді хоча б на одне запитання тесту.")

    now = _utc_iso()
    correct_count = 0
    total_count = len(answers)
    results: List[Dict[str, Any]] = []

    with store._connect() as conn:
        for ans in answers:
            q_text = str(ans.get("question") or "").strip()
            options = [str(o) for o in (ans.get("options") or [])]
            chosen = int(ans.get("chosen_index", -1))
            correct = int(ans.get("correct_index", 0))
            explanation = str(ans.get("explanation") or "").strip()
            is_ok = (chosen == correct)
            if is_ok:
                correct_count += 1
                conn.execute(
                    """
                    UPDATE topic_mistakes SET resolved = 1
                    WHERE owner_id = ? AND course_id = ? AND topic_index = ? AND module_id = ? AND source_type = 'quiz' AND question_text = ?
                    """,
                    (owner_id, course_id, topic_index, module_id, q_text),
                )
            else:
                user_ans_txt = options[chosen] if 0 <= chosen < len(options) else f"Варіант #{chosen + 1}"
                exp_ans_txt = options[correct] if 0 <= correct < len(options) else f"Варіант #{correct + 1}"
                conn.execute(
                    """
                    INSERT INTO topic_mistakes (
                        mistake_id, owner_id, course_id, topic_index, topic_title,
                        module_id, module_title, source_type, question_text,
                        user_answer, expected_answer, explanation, score, resolved, created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'quiz', ?, ?, ?, ?, 0, 0, ?)
                    """,
                    (
                        f"mk-{uuid.uuid4().hex[:12]}",
                        owner_id, course_id, topic_index, ctx["topic_title"],
                        module_id, ctx["module_title"], q_text,
                        user_ans_txt, exp_ans_txt, explanation, now,
                    ),
                )
            results.append({
                "question": q_text,
                "is_correct": is_ok,
                "chosen_index": chosen,
                "correct_index": correct,
                "explanation": explanation,
            })

        quizzes_passed = 1 if (correct_count * 10 >= total_count * 6) else 0
        row = conn.execute(
            """
            SELECT * FROM module_progress
            WHERE owner_id = ? AND course_id = ? AND topic_index = ? AND module_id = ?
            """,
            (owner_id, course_id, topic_index, module_id),
        ).fetchone()

        prev_passed = int(row["quizzes_passed"]) if row else 0
        final_q_passed = max(prev_passed, quizzes_passed)
        tutor_passed = int(row["tutor_passed"]) if row else 0
        completed = _compute_module_completed(final_q_passed, tutor_passed)

        conn.execute(
            """
            INSERT INTO module_progress (
                owner_id, course_id, topic_index, module_id,
                watched_concepts_json, video_bonus_points,
                quizzes_passed, quizzes_correct, quizzes_total,
                tutor_score, tutor_passed, tutor_answer, tutor_feedback, tutor_expected_10,
                completed, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(owner_id, course_id, topic_index, module_id) DO UPDATE SET
                quizzes_passed = excluded.quizzes_passed,
                quizzes_correct = excluded.quizzes_correct,
                quizzes_total = excluded.quizzes_total,
                completed = excluded.completed,
                updated_at = excluded.updated_at
            """,
            (
                owner_id, course_id, topic_index, module_id,
                row["watched_concepts_json"] if row else "[]",
                int(row["video_bonus_points"]) if row else 0,
                final_q_passed, correct_count, total_count,
                row["tutor_score"] if row else None, tutor_passed,
                row["tutor_answer"] if row else None,
                row["tutor_feedback"] if row else None,
                row["tutor_expected_10"] if row else None,
                completed, now,
            ),
        )

    progress = get_course_learning_progress(store, owner_id, course_id)
    return {
        "success": True,
        "module_id": module_id,
        "correct_count": correct_count,
        "total_count": total_count,
        "quizzes_passed": bool(final_q_passed),
        "module_completed": bool(completed),
        "results": results,
        "learning_progress": progress,
    }


async def evaluate_module_tutor(
    store: Any,
    owner_id: str,
    course_id: int,
    topic_index: int,
    module_id: str,
    answer_text: str = "",
    audio_bytes: Optional[bytes] = None,
    audio_mime: Optional[str] = None,
) -> Dict[str, Any]:
    _ensure_tables(store)
    ctx = resolve_module_context(store, owner_id, course_id, topic_index, module_id)
    has_audio = bool(audio_bytes and len(audio_bytes) >= 250)
    if not answer_text.strip() and not has_audio:
        raise HTTPException(status_code=422, detail="Введи або надиктуй відповідь на питання AI-тютора.")

    gemini = GeminiService()
    if not gemini.is_available:
        raise LearningProviderError("Підключи Gemini API key, щоб AI-тютор перевірив відповідь.", 424)

    eval_res = await gemini.evaluate_module_tutor_answer(
        module_title=ctx["module_title"],
        module_content=ctx["module_content"],
        tutor_question=ctx["tutor_question"],
        expected_10_answer=ctx["tutor_expected_answer"],
        student_answer=answer_text,
        audio_bytes=audio_bytes,
        audio_mime=audio_mime,
    )
    if not eval_res:
        raise LearningProviderError("AI-тютор зараз не повернув оцінку. Спробуй ще раз.")

    score = int(eval_res["score"])
    passed = score >= 4
    now = _utc_iso()
    mistakes = eval_res.get("mistakes") or []
    expected_10 = eval_res.get("expected_10_of_10") or ctx["tutor_expected_answer"]
    user_transcript = eval_res.get("user_transcript") or answer_text.strip()

    with store._connect() as conn:
        row = conn.execute(
            """
            SELECT * FROM module_progress
            WHERE owner_id = ? AND course_id = ? AND topic_index = ? AND module_id = ?
            """,
            (owner_id, course_id, topic_index, module_id),
        ).fetchone()

        quizzes_passed = int(row["quizzes_passed"]) if row else 0
        prev_tutor_passed = int(row["tutor_passed"]) if row else 0
        final_tutor_passed = 1 if (passed or prev_tutor_passed) else 0
        prev_score = row["tutor_score"] if row else None
        best_score = max(int(prev_score), score) if prev_score is not None else score
        completed = _compute_module_completed(quizzes_passed, final_tutor_passed)

        conn.execute(
            """
            INSERT INTO module_progress (
                owner_id, course_id, topic_index, module_id,
                watched_concepts_json, video_bonus_points,
                quizzes_passed, quizzes_correct, quizzes_total,
                tutor_score, tutor_passed, tutor_answer, tutor_feedback, tutor_expected_10,
                completed, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(owner_id, course_id, topic_index, module_id) DO UPDATE SET
                tutor_score = excluded.tutor_score,
                tutor_passed = excluded.tutor_passed,
                tutor_answer = excluded.tutor_answer,
                tutor_feedback = excluded.tutor_feedback,
                tutor_expected_10 = excluded.tutor_expected_10,
                completed = excluded.completed,
                updated_at = excluded.updated_at
            """,
            (
                owner_id, course_id, topic_index, module_id,
                row["watched_concepts_json"] if row else "[]",
                int(row["video_bonus_points"]) if row else 0,
                quizzes_passed,
                int(row["quizzes_correct"]) if row else 0,
                int(row["quizzes_total"]) if row else 0,
                best_score, final_tutor_passed,
                user_transcript, eval_res.get("feedback"), expected_10,
                completed, now,
            ),
        )

        # Save structured mistakes on imperfect or failed tutor answer
        if not passed or mistakes:
            if mistakes:
                for mk in mistakes:
                    conn.execute(
                        """
                        INSERT INTO topic_mistakes (
                            mistake_id, owner_id, course_id, topic_index, topic_title,
                            module_id, module_title, source_type, question_text,
                            user_answer, expected_answer, explanation, score, resolved, created_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'ai_tutor', ?, ?, ?, ?, ?, 0, ?)
                        """,
                        (
                            f"mk-{uuid.uuid4().hex[:12]}",
                            owner_id, course_id, topic_index, ctx["topic_title"],
                            module_id, ctx["module_title"], ctx["tutor_question"],
                            mk.get("mistake") or user_transcript,
                            expected_10,
                            mk.get("correction") or eval_res.get("feedback") or "",
                            score, now,
                        ),
                    )
            else:
                conn.execute(
                    """
                    INSERT INTO topic_mistakes (
                        mistake_id, owner_id, course_id, topic_index, topic_title,
                        module_id, module_title, source_type, question_text,
                        user_answer, expected_answer, explanation, score, resolved, created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'ai_tutor', ?, ?, ?, ?, ?, 0, ?)
                    """,
                    (
                        f"mk-{uuid.uuid4().hex[:12]}",
                        owner_id, course_id, topic_index, ctx["topic_title"],
                        module_id, ctx["module_title"], ctx["tutor_question"],
                        user_transcript, expected_10, eval_res.get("feedback") or "",
                        score, now,
                    ),
                )
        elif score >= 8:
            conn.execute(
                """
                UPDATE topic_mistakes SET resolved = 1
                WHERE owner_id = ? AND course_id = ? AND topic_index = ? AND module_id = ? AND source_type = 'ai_tutor'
                """,
                (owner_id, course_id, topic_index, module_id),
            )

    progress = get_course_learning_progress(store, owner_id, course_id)
    return {
        "success": True,
        "module_id": module_id,
        "score": score,
        "passed": passed,
        "min_required": 4,
        "user_transcript": user_transcript,
        "feedback": eval_res.get("feedback") or "",
        "mistakes": mistakes,
        "expected_10_of_10": expected_10,
        "module_completed": bool(completed),
        "learning_progress": progress,
    }


def get_course_learning_progress(
    store: Any,
    owner_id: str,
    course_id: int,
) -> Dict[str, Any]:
    """Compute real topic completion scores, short summaries, module statuses, XP bonuses, and structured mistakes."""
    _ensure_tables(store)
    bundle = store.get_course_bundle(course_id, owner_id)
    if not bundle:
        raise HTTPException(status_code=404, detail="Курс не знайдено.")

    with store._connect() as conn:
        prog_rows = conn.execute(
            "SELECT * FROM module_progress WHERE owner_id = ? AND course_id = ?",
            (owner_id, course_id),
        ).fetchall()
        mistake_rows = conn.execute(
            "SELECT * FROM topic_mistakes WHERE owner_id = ? AND course_id = ? ORDER BY created_at DESC",
            (owner_id, course_id),
        ).fetchall()

    prog_map: Dict[tuple, sqlite3.Row] = {
        (int(r["topic_index"]), str(r["module_id"])): r for r in prog_rows
    }

    mistakes_by_topic: Dict[int, List[Dict[str, Any]]] = {}
    for r in mistake_rows:
        t_idx = int(r["topic_index"])
        mistakes_by_topic.setdefault(t_idx, []).append({
            "mistake_id": r["mistake_id"],
            "topic_index": t_idx,
            "topic_title": r["topic_title"],
            "module_id": r["module_id"],
            "module_title": r["module_title"],
            "source_type": r["source_type"],
            "question_text": r["question_text"],
            "user_answer": r["user_answer"],
            "expected_answer": r["expected_answer"],
            "explanation": r["explanation"],
            "score": r["score"],
            "resolved": bool(r["resolved"]),
            "created_at": r["created_at"],
        })

    topics_out: List[Dict[str, Any]] = []
    total_xp = 0
    topic_scores_for_avg: List[int] = []

    for mix in bundle.get("topic_mixes") or []:
        t_idx = int(mix.topic_index)
        sections = mix.book_sections or []
        modules_out: List[Dict[str, Any]] = []
        module_score_sum = 0.0
        topic_xp = 0
        watched_count = 0
        total_concepts = 0
        modules_completed = 0

        for idx, sec in enumerate(sections):
            mid = _section_module_id(sec, idx)
            p = prog_map.get((t_idx, mid))
            watched = json.loads(p["watched_concepts_json"]) if p else []
            v_bonus = int(p["video_bonus_points"]) if p else 0
            q_passed = bool(p["quizzes_passed"]) if p else False
            q_correct = int(p["quizzes_correct"]) if p else 0
            q_total = int(p["quizzes_total"]) if p else 0
            t_score = p["tutor_score"] if p else None
            t_passed = bool(p["tutor_passed"]) if p else False
            completed = bool(p["completed"]) if p else False

            if completed:
                modules_completed += 1
            watched_count += len(watched)
            total_concepts += len(getattr(sec, "video_concepts", None) or [])
            topic_xp += v_bonus + (10 if completed else 0)

            # Module contribution to topic score (0..100 scale per module):
            # 40 pts for quizzes + 60 pts for AI tutor + up to 10 pts video watch bonus (capped at 100)
            q_ratio = (q_correct / q_total) if q_total > 0 else (1.0 if q_passed else 0.0)
            q_pts = 40.0 * q_ratio
            t_pts = 60.0 * (min(10, max(0, int(t_score))) / 10.0) if t_score is not None else 0.0
            m_score = min(100.0, q_pts + t_pts + min(10.0, float(v_bonus)))
            module_score_sum += m_score

            modules_out.append({
                "module_id": mid,
                "heading": sec.heading,
                "watched_concepts": watched,
                "video_bonus_points": v_bonus,
                "quizzes_passed": q_passed,
                "quizzes_correct": q_correct,
                "quizzes_total": q_total,
                "tutor_score": t_score,
                "tutor_passed": t_passed,
                "tutor_feedback": p["tutor_feedback"] if p else None,
                "tutor_expected_10": p["tutor_expected_10"] if p else None,
                "completed": completed,
                "module_score_percent": round(m_score),
            })

        total_xp += topic_xp
        t_mistakes = mistakes_by_topic.get(t_idx, [])
        unresolved_mistakes = [m for m in t_mistakes if not m["resolved"]]
        t_score_pct = round(module_score_sum / len(sections)) if sections else None
        if t_score_pct is not None:
            topic_scores_for_avg.append(t_score_pct)

        summary_txt = getattr(mix, "topic_summary", None)
        if not summary_txt and sections:
            takeaways = [tk for sec in sections for tk in (sec.key_takeaways or [])][:3]
            if takeaways:
                summary_txt = " ".join(takeaways)

        topics_out.append({
            "topic_index": t_idx,
            "mix_id": mix.mix_id,
            "topic_title": mix.title,
            "topic_summary": summary_txt or "",
            "score_percent": t_score_pct,
            "xp_earned": topic_xp,
            "modules_total": len(sections),
            "modules_completed": modules_completed,
            "watched_concepts_count": watched_count,
            "total_concepts_count": total_concepts,
            "mistakes_count": len(unresolved_mistakes),
            "mistakes": t_mistakes,
            "modules": modules_out,
        })

    overall_score = round(sum(topic_scores_for_avg) / len(topic_scores_for_avg)) if topic_scores_for_avg else None
    structured_mistakes = [
        {
            "topic_index": t["topic_index"],
            "topic_title": t["topic_title"],
            "unresolved_count": t["mistakes_count"],
            "mistakes": t["mistakes"],
        }
        for t in topics_out
        if t["mistakes"]
    ]

    return {
        "course_id": course_id,
        "total_xp": total_xp,
        "overall_score_percent": overall_score,
        "topics": topics_out,
        "mistakes_by_topic": structured_mistakes,
    }
