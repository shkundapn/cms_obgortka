import asyncio
import json
import logging
import os
import random
import re
import time
from typing import Any, Dict, List, Optional, Tuple
import weakref
import httpx

from app.config import get_settings
from app.services.learning_provider import current_provider, LearningProviderError, provider_http_error

logger = logging.getLogger("gemini_service")

_VERTEX_TOKEN_CACHE: Dict[str, Any] = {"token": None, "expires_at": 0.0}
_GEMINI_SEMAPHORES: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = weakref.WeakKeyDictionary()


def _get_gemini_semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    sem = _GEMINI_SEMAPHORES.get(loop)
    if sem is None:
        sem = asyncio.Semaphore(2)
        _GEMINI_SEMAPHORES[loop] = sem
    return sem


def _retry_delay_seconds(resp: Optional[httpx.Response], retry_index: int) -> float:
    base_delays = (1.0, 2.5, 5.0)
    default_delay = base_delays[min(retry_index, len(base_delays) - 1)] + random.uniform(0.05, 0.35)
    if resp is None:
        return default_delay
    raw_after = (resp.headers.get("Retry-After") or "").strip()
    if raw_after:
        try:
            parsed = float(raw_after)
            if 0 < parsed <= 15.0:
                return parsed
        except ValueError:
            pass
    return default_delay


def _parse_gemini_json(raw_text: str) -> Any:
    """Parse JSON from Gemini output, repairing markdown fences and unescaped LaTeX backslashes."""
    if not raw_text:
        return None
    clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw_text.strip(), flags=re.MULTILINE).strip()
    if not clean:
        return None
    candidates = [clean]
    first_brace, last_brace = clean.find("{"), clean.rfind("}")
    first_bracket, last_bracket = clean.find("["), clean.rfind("]")
    if first_brace != -1 and last_brace > first_brace:
        candidates.append(clean[first_brace : last_brace + 1])
    if first_bracket != -1 and last_bracket > first_bracket:
        candidates.append(clean[first_bracket : last_bracket + 1])

    for cand in candidates:
        repaired = re.sub(
            r"\\(frac|beta|binom|begin|bar|bold|theta|text|textbf|textit|times|tau|to|top|nabla|neq|ne|nu|notin|norm|right|rightarrow|rho|mathbb|mathcal|mathrm)\b",
            r"\\\\\1",
            cand,
        )
        repaired = re.sub(r'\\(?![/\"\\bfnrt]|u[0-9a-fA-F]{4})', r"\\\\", repaired)
        for attempt_str in (repaired, cand):
            try:
                return json.loads(attempt_str)
            except Exception:
                pass
    return None


class GeminiService:
    """
    Client for Google Gemini API (AI Studio API key or Google Cloud Vertex AI).
    Provides structured syllabus parsing, educational textbook synthesis,
    practice quiz generation, flashcards, and Mermaid concept maps.
    """

    BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"

    def __init__(self, api_key: Optional[str] = None, model: Optional[str] = None):
        settings = get_settings()
        provider = current_provider.get()
        explicit_key = (api_key or "").strip()
        personal_key = provider.api_key.strip() if provider and provider.source == "personal" and provider.api_key else ""
        if explicit_key:
            self.api_key = explicit_key
            self.vertex_project = ""
        elif personal_key:
            self.api_key = personal_key
            self.vertex_project = ""
        elif (settings.VERTEX_AI_PROJECT or "").strip():
            self.api_key = ""
            self.vertex_project = settings.VERTEX_AI_PROJECT.strip()
        else:
            self.api_key = ((provider.api_key if provider else None) or settings.GEMINI_API_KEY or "").strip()
            self.vertex_project = ""
        self.vertex_location = (settings.VERTEX_AI_LOCATION or "global").strip() or "global"
        self.model = model or (provider.model if provider else None) or settings.GEMINI_MODEL or "gemini-2.0-flash"
        self.strict = bool(provider and provider.strict)

    @property
    def is_available(self) -> bool:
        return bool(self.api_key or self.vertex_project)

    async def _get_vertex_token(self, force_refresh: bool = False) -> Optional[str]:
        env_token = (os.getenv("VERTEX_AI_ACCESS_TOKEN") or "").strip()
        if env_token:
            return env_token
        now = time.monotonic()
        if not force_refresh and _VERTEX_TOKEN_CACHE["token"] and _VERTEX_TOKEN_CACHE["expires_at"] > now:
            return _VERTEX_TOKEN_CACHE["token"]
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                res = await client.get(
                    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
                    headers={"Metadata-Flavor": "Google"},
                )
            if res.status_code != 200:
                logger.warning("Vertex metadata token request returned HTTP %s", res.status_code)
                return None
            payload = res.json()
            tok = (payload.get("access_token") or "").strip()
            if not tok:
                return None
            ttl = max(60, int(payload.get("expires_in", 3600)) - 60)
            _VERTEX_TOKEN_CACHE["token"] = tok
            _VERTEX_TOKEN_CACHE["expires_at"] = now + ttl
            return tok
        except Exception as exc:
            logger.warning("Vertex metadata token error (%s)", type(exc).__name__)
            return None

    async def generate_content(
        self,
        prompt: str = "",
        system_instruction: Optional[str] = None,
        json_mode: bool = False,
        temperature: float = 0.2,
        timeout: float = 30.0,
        extra_parts: Optional[List[Dict[str, Any]]] = None,
        parts: Optional[List[Dict[str, Any]]] = None,
        raise_on_error: bool = False,
    ) -> Optional[str]:
        """Send prompt to Gemini API (Vertex AI or AI Studio) and return raw response text."""
        if not self.is_available:
            return None

        req_parts: List[Dict[str, Any]] = list(extra_parts or parts or [])
        if prompt:
            req_parts.append({"text": prompt})
        if not req_parts:
            return None
        payload: Dict[str, Any] = {
            "contents": [
                {
                    "role": "user",
                    "parts": req_parts,
                }
            ],
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": 16384,
            },
        }

        if system_instruction:
            payload["systemInstruction"] = {
                "parts": [{"text": system_instruction}]
            }

        if json_mode:
            payload["generationConfig"]["responseMimeType"] = "application/json"

        should_raise = self.strict or raise_on_error
        provider_kind = "vertex" if self.vertex_project else "studio"
        try:
            async with _get_gemini_semaphore():
                resp = None
                token_refreshed = False
                rate_retries = 0
                max_rate_retries = 3
                vertex_fallbacks = [
                    (self.vertex_location, self.model),
                    ("global", "gemini-2.5-flash"),
                    ("us-central1", "gemini-2.5-flash"),
                    ("us-central1", "gemini-2.0-flash"),
                ]
                vertex_fb_idx = 0
                while True:
                    if self.vertex_project:
                        loc, mdl = vertex_fallbacks[min(vertex_fb_idx, len(vertex_fallbacks) - 1)]
                        host = (
                            "aiplatform.googleapis.com"
                            if loc == "global"
                            else f"{loc}-aiplatform.googleapis.com"
                        )
                        url = (
                            f"https://{host}/v1/projects/{self.vertex_project}/locations/"
                            f"{loc}/publishers/google/models/{mdl}:generateContent"
                        )
                        tok = await self._get_vertex_token(force_refresh=token_refreshed)
                        if not tok:
                            if should_raise:
                                raise LearningProviderError("Не вдалося отримати токен Vertex AI на сервері.")
                            return None
                        headers = {
                            "Content-Type": "application/json",
                            "Authorization": f"Bearer {tok}",
                            "X-Goog-User-Project": self.vertex_project,
                        }
                    else:
                        url = f"{self.BASE_URL}/{self.model}:generateContent"
                        headers = {"Content-Type": "application/json", "x-goog-api-key": self.api_key}

                    async with httpx.AsyncClient(timeout=timeout) as client:
                        resp = await client.post(url, json=payload, headers=headers)

                    if self.vertex_project and resp.status_code == 401 and not token_refreshed:
                        _VERTEX_TOKEN_CACHE["token"] = None
                        token_refreshed = True
                        continue

                    if self.vertex_project and resp.status_code == 404 and vertex_fb_idx + 1 < len(vertex_fallbacks):
                        vertex_fb_idx += 1
                        next_loc, next_mdl = vertex_fallbacks[vertex_fb_idx]
                        logger.warning(
                            "Vertex AI model %s not found (404); falling back to %s (%s)",
                            self.model,
                            next_mdl,
                            next_loc,
                        )
                        continue

                    if resp.status_code in (429, 503) and rate_retries < max_rate_retries:
                        delay = _retry_delay_seconds(resp, rate_retries)
                        rate_retries += 1
                        logger.warning(
                            "Gemini API (%s, model=%s) returned HTTP %s; retrying in %.2fs (attempt %d/%d)",
                            provider_kind,
                            self.model,
                            resp.status_code,
                            delay,
                            rate_retries,
                            max_rate_retries,
                        )
                        await asyncio.sleep(delay)
                        continue
                    break

            if resp is None or resp.status_code != 200:
                code = resp.status_code if resp is not None else 502
                safe_detail = ""
                if resp is not None:
                    try:
                        err_obj = (resp.json() or {}).get("error") or {}
                        safe_detail = str(err_obj.get("message") or err_obj.get("status") or "").strip()
                    except Exception:
                        safe_detail = ""
                    if self.api_key and self.api_key in safe_detail:
                        safe_detail = safe_detail.replace(self.api_key, "[redacted]")
                    safe_detail = safe_detail[:160]
                logger.warning("Gemini API (%s, model=%s) returned HTTP %s%s", provider_kind, self.model, code, f": {safe_detail}" if safe_detail else "")
                if should_raise:
                    raise provider_http_error(code, source=provider_kind, detail=safe_detail if code == 400 else "")
                return None

            data = resp.json()
            candidates = data.get("candidates", [])
            if candidates:
                resp_parts = candidates[0].get("content", {}).get("parts", [])
                non_thought = [part.get("text", "") for part in resp_parts if not part.get("thought") and part.get("text")]
                if non_thought:
                    return "\n".join(non_thought)
                finish_reason = candidates[0].get("finishReason")
                if finish_reason:
                    logger.warning("Gemini returned empty parts with finishReason=%s", finish_reason)
                    if should_raise:
                        raise LearningProviderError(f"Gemini не зміг згенерувати матеріал ({finish_reason}).", 422)
            elif data.get("promptFeedback", {}).get("blockReason"):
                block_reason = data["promptFeedback"]["blockReason"]
                logger.warning("Gemini blocked prompt with blockReason=%s", block_reason)
                if should_raise:
                    raise LearningProviderError(f"Gemini заблокував запит ({block_reason}).", 422)
            if should_raise:
                raise LearningProviderError("Gemini не повернув навчальний матеріал. Спробуй ще раз.")
            return None
        except LearningProviderError:
            raise
        except Exception as exc:
            logger.warning("Error calling Gemini API (%s)", type(exc).__name__)
            if should_raise:
                if isinstance(exc, httpx.TimeoutException):
                    raise LearningProviderError("Gemini занадто довго обробляє запит. Спробуй ще раз.") from None
                raise LearningProviderError("Не вдалося отримати матеріали від Gemini. Спробуй ще раз.") from None
            return None

    async def structure_syllabus_to_topics(
        self,
        course_title: str,
        sections: Optional[List[Dict[str, Any]]] = None,
        custom_syllabus_text: Optional[str] = None,
        target_score: int = 85,
    ) -> Optional[List[Dict[str, Any]]]:
        """
        Use Gemini 2.0 Flash to analyze course materials/syllabus and produce
        a structured weekly progression of topics with distinctive keywords.
        """
        if not self.is_available:
            return None

        sections_desc = []
        if sections:
            for s in sections:
                s_name = s.get("name", "Section")
                mod_names = [m.get("name", "") for m in s.get("modules", []) if m.get("name")]
                sections_desc.append(f"- Section: '{s_name}'. Items: {', '.join(mod_names[:6])}")
        
        input_context = (
            f"Course Title: {course_title}\n"
            f"Target Score: {target_score}%\n\n"
            f"Moodle Sections:\n" + "\n".join(sections_desc) + "\n\n"
        )
        if custom_syllabus_text:
            input_context += f"Custom Syllabus / Notes:\n{custom_syllabus_text[:4000]}\n"

        prompt = f"""
Analyze the course curriculum materials below and organize them into a clean, chronological sequence of weekly study topics based on their TRUE ACADEMIC CONCEPTS.

CRITICAL ARCHITECTURAL RULES:
1. STRICTLY AVOID ADMINISTRATIVE CONTAINER LABELS as topic titles or concepts!
   Phrases such as "Topic 4", "Reading for topic 4", "Quiz 4", "Self-test", "Seminar 4", "Week 4", "Тема 4", "Colloquium", "Midterm exam" are NOT academic concepts.
   Instead, identify the actual subject taught inside each topic (e.g. if Topic 4 contains "Reading for topic 4" and "Discrete random variables", the true topic is "Дискретні випадкові величини (Discrete Random Variables)").
2. For each topic, extract the real substantive educational concepts (e.g. for "Expectation": Expected Value, Variance, Probability Distribution, Linearity of Expectation).
3. In `keywords`, include ONLY substantive domain/scientific terms (e.g. "discrete random variables", "pmf", "cumulative distribution", "expectation", "variance").
   NEVER include administrative words in keywords (NO: "topic", "reading", "quiz", "self-test", "seminar", "week", "тиждень", "тема", "колоквіум", "екзамен").
4. Filter out standalone exams or assessments ("Colloquium", "Midterm exam") from being standalone study topics; structure topics strictly by conceptual learning progression.

For each topic, provide:
1. topic_index: integer starting from 1 (Week 1, Week 2, etc.)
2. title: concise, descriptive topic title in Ukrainian (e.g. "Тиждень 4: Дискретні випадкові величини")
3. summary: 2-3 sentences overview in Ukrainian
4. key_concepts: list of 4-6 main educational concepts
5. keywords: list of 8-15 distinctive keywords and terms (both in Ukrainian and English, lowercase) used to automatically match lectures, files, and assignments to this topic
6. difficulty: "Basic", "Intermediate", or "Advanced"
7. estimated_hours: realistic study hours (2-8)
8. suggested_focus: key learning outcome to achieve the target score ({target_score}%)

Return ONLY a JSON array with this schema:
[
  {{
    "topic_index": 1,
    "title": "Тиждень 1: ...",
    "summary": "...",
    "key_concepts": ["концепт 1", "концепт 2"],
    "keywords": ["термін", "keyword", "alg", ...],
    "difficulty": "Basic",
    "estimated_hours": 3,
    "suggested_focus": "..."
  }}
]

Course Data:
{input_context}
"""
        res = await self.generate_content(
            prompt,
            system_instruction="You are an expert university curriculum architect. Output valid JSON array only.",
            json_mode=True,
            temperature=0.2,
        )
        if not res:
            return None

        try:
            clean_json = re.sub(r"^```(?:json)?\s*|\s*```$", "", res.strip(), flags=re.MULTILINE)
            parsed = json.loads(clean_json)
            if isinstance(parsed, list) and len(parsed) > 0:
                return parsed
        except Exception as exc:
            logger.warning(f"Failed to parse Gemini syllabus response: {exc}")

        return None

    async def generate_book_section_content(
        self,
        title: str,
        content_text: str,
        keywords: Optional[List[str]] = None,
        course_title: str = "",
        topic_title: str = "",
        video_concepts: Optional[List[Dict[str, Any]]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Synthesize deep, structured textbook module markdown, video references, quizzes, and tutor prompt with Gemini."""
        if not self.is_available:
            return None

        kw_str = ", ".join(keywords or [])
        context_lines = []
        if course_title:
            context_lines.append(f'Course: "{course_title}"')
        if topic_title and topic_title.strip() != title.strip():
            context_lines.append(f'Topic: "{topic_title}"')
        context_block = ("\n".join(context_lines) + "\n") if context_lines else ""

        vc_block = ""
        if video_concepts:
            vc_lines = [
                f"- [{vc.get('timecode', '00:00')}] {vc.get('concept_title', '')} ({vc.get('youtube_url', '')}): {vc.get('summary', '')}"
                for vc in video_concepts[:8]
            ]
            vc_block = "\nVideo lecture concepts with timestamps:\n" + "\n".join(vc_lines) + "\n"

        prompt = f"""
You are an expert university professor writing a comprehensive, exhaustive textbook module in Ukrainian:
{context_block}Module title: "{title}"
Ingested source material:
{content_text[:24000]}
{vc_block}
Keywords: {kw_str}

Grounding rules:
- Stay strictly within the academic domain of the Course and Topic above.
- Never drift into unrelated disciplines or treat Moodle activity names as course concepts to meta-explain.
- Use ALL relevant material from the source text and video transcript/analysis — do not summarize superficially; provide a deep, richly explained textbook module.
- Use valid LaTeX ($...$ inline and $$...$$ display) for mathematical notation, formulas, and derivations.
- If video concepts with timestamps are listed above, explicitly weave into the prose where we analyze each concept and invite the student to watch the exact YouTube timestamp link (`[MM:SS](youtube_url)`).
- When the source includes YouTube video analysis or transcripts, structure the textbook chapter so it preserves and deepens:
  1. Core message, formal definitions, supporting arguments, and concrete data/examples from the video.
  2. 1-2 clear, relatable everyday analogies per major concept to make abstract ideas intuitive.
  3. Critical analysis (pros & cons, educational/ethical/practical perspectives, general reception/trends, and science/data-backed facts where applicable).
  4. A customizable step-by-step actionable framework (when relevant to the topic).
  5. Memory aids (mnemonics or mental anchors) and key takeaway metric/verdict.

Please generate a comprehensive textbook module in Ukrainian covering:
1. "short_description": 1-2 sentence overview of what this module covers.
2. "explanation_markdown": Very thorough, in-depth Markdown chapter (800-1800 words when source allows) with clear subsections: formal definitions, intuition & everyday analogies, mathematical/conceptual derivations, supporting arguments & worked step-by-step examples, edge cases / critical analysis (pros & cons, perspectives), actionable framework (when relevant), memory aids/mnemonics, and practical applications.
3. "key_takeaways": 4-6 crisp takeaways.
4. "module_quizzes": 2-3 conceptual self-check items (4 options each, correct_index 0..3, explanation) testing this specific module.
5. "tutor_question": 1 probing conceptual open question for the AI Tutor check of this module (student must score >= 4/10).
6. "tutor_expected_answer": Exemplary, complete 10/10 model answer to tutor_question grounded in this module.

Return ONLY a JSON object:
{{
  "short_description": "...",
  "explanation_markdown": "## {title}\\n\\n...",
  "key_takeaways": ["Point 1", "Point 2", "Point 3", "Point 4"],
  "module_quizzes": [
    {{
      "question": "...",
      "options": ["A", "B", "C", "D"],
      "correct_index": 0,
      "explanation": "..."
    }}
  ],
  "tutor_question": "...",
  "tutor_expected_answer": "..."
}}
"""
        res = await self.generate_content(
            prompt,
            system_instruction="You write comprehensive, deep university textbook modules in Ukrainian strictly grounded in the course subject and video transcripts. Return JSON only.",
            json_mode=True,
            temperature=0.25,
            timeout=90.0,
        )
        if not res:
            return None

        parsed = _parse_gemini_json(res)
        if isinstance(parsed, list) and parsed and isinstance(parsed[0], dict):
            parsed = parsed[0]
        if isinstance(parsed, dict):
            if not parsed.get("explanation_markdown"):
                for alt_key in ("explanation", "markdown", "content_markdown", "content", "text", "chapter"):
                    val = parsed.get(alt_key)
                    if isinstance(val, str) and val.strip():
                        parsed["explanation_markdown"] = val.strip()
                        break
            elif isinstance(parsed.get("explanation_markdown"), list):
                parsed["explanation_markdown"] = "\n\n".join(str(x) for x in parsed["explanation_markdown"] if x)
            if parsed.get("explanation_markdown"):
                return parsed
        logger.warning("Gemini generate_book_section_content returned unparseable JSON (len=%d)", len(res))
        return None

    async def generate_practice_quizzes(
        self,
        title: str,
        key_points: List[str],
        num_questions: int = 3,
        course_title: str = "",
        content_text: str = "",
    ) -> Optional[List[Dict[str, Any]]]:
        """Generate high-yield conceptual practice questions with Gemini."""
        if not self.is_available:
            return None

        points_str = "\n".join(f"- {p}" for p in key_points)
        course_line = f'Course: "{course_title}"\n' if course_title else ""
        source_block = f'\nSource material excerpt:\n{content_text[:3500]}\n' if content_text else ""
        prompt = f"""
Generate {num_questions} multiple-choice conceptual practice questions for university students on:
{course_line}Topic: "{title}"
Key points covered:
{points_str}{source_block}

Requirements:
- Stay strictly inside the academic subject of {course_title or title} and test actual domain knowledge, formulas, theorems, or problem-solving for "{title}".
- NEVER ask trivia or meta-questions about Moodle logistics or course components (such as what Reading folders, Seminars, Quizzes, Self-tests, or Extra/bonus activities are for).
- NEVER drift into unrelated subjects outside the course.
- Each question must test understanding, not trivia.
- Exactly 4 options per question.
- Distinct, realistic distractors.
- correct_index: 0, 1, 2, or 3.
- explanation: clear rationale why the correct answer is right and why distractors are wrong.
- Language: Ukrainian.

Return ONLY a JSON array:
[
  {{
    "question": "...",
    "options": ["A", "B", "C", "D"],
    "correct_index": 0,
    "explanation": "..."
  }}
]
"""
        res = await self.generate_content(
            prompt,
            system_instruction="You are an exam designer creating conceptual subject-matter quizzes in Ukrainian. Never write questions about Moodle navigation or unrelated subjects. Return JSON only.",
            json_mode=True,
            temperature=0.3,
        )
        if not res:
            return None

        data = _parse_gemini_json(res)
        if isinstance(data, dict):
            data = (
                data.get("questions")
                or data.get("quizzes")
                or data.get("items")
                or next((v for v in data.values() if isinstance(v, list)), None)
            )
        if isinstance(data, list):
            return data
        logger.warning("Gemini generate_practice_quizzes returned unparseable JSON (len=%d)", len(res))
        return None

    async def generate_flashcards(
        self,
        title: str,
        key_points: List[str],
        num_cards: int = 4,
        course_title: str = "",
    ) -> Optional[List[Dict[str, str]]]:
        """Generate spaced-repetition flashcards with Gemini."""
        if not self.is_available:
            return None

        points_str = "\n".join(f"- {p}" for p in key_points)
        course_line = f'Course: "{course_title}"\n' if course_title else ""
        prompt = f"""
Generate {num_cards} spaced-repetition flashcards for:
{course_line}Topic: "{title}"
Key concepts:
{points_str}

Requirements:
- Every card must belong strictly to the academic subject of {course_title or title} — topic "{title}" (core definitions, formulas, theorems, or domain principles).
- Ignore any generic study-advice phrases or unrelated subjects.
- Never create cards about Moodle structure (seminars, bonus tasks, reading folders).
- "front": short prompt, term, or question
- "back": clear, memorable definition, formula, or principle
- "tag": short topic tag (e.g. "{title[:20]}")
- Language: Ukrainian.

Return ONLY a JSON array:
[
  {{
    "front": "...",
    "back": "...",
    "tag": "..."
  }}
]
"""
        res = await self.generate_content(
            prompt,
            system_instruction="You create subject-matter flashcards in Ukrainian strictly grounded in the given course and topic. Return JSON array of flashcards only.",
            json_mode=True,
            temperature=0.3,
        )
        if not res:
            return None

        data = _parse_gemini_json(res)
        if isinstance(data, dict):
            data = (
                data.get("flashcards")
                or data.get("cards")
                or data.get("items")
                or next((v for v in data.values() if isinstance(v, list)), None)
            )
        if isinstance(data, list):
            return data
        logger.warning("Gemini generate_flashcards returned unparseable JSON (len=%d)", len(res))
        return None

    async def generate_mermaid_diagram(
        self,
        title: str,
        key_points: List[str],
        course_title: str = "",
    ) -> Optional[str]:
        """Generate valid Mermaid flowchart TD code with Gemini."""
        if not self.is_available:
            return None

        points_str = "\n".join(f"- {p}" for p in key_points[:6])
        course_line = f' in course "{course_title}"' if course_title else ""
        prompt = f"""
Generate clean, valid Mermaid.js flowchart diagram code (flowchart TD) illustrating the relationships between key domain concepts in topic "{title}"{course_line}.
Concepts:
{points_str}

Rules:
- Start with `flowchart TD`
- Use sanitized node IDs without special characters (e.g. A["Concept Name"])
- Wrap all labels in double quotes inside square brackets
- Keep labels under 35 characters
- Max 8 nodes
- Output ONLY the raw Mermaid diagram text (no markdown fences, no backticks).
"""
        res = await self.generate_content(
            prompt,
            system_instruction="Output valid Mermaid.js diagram code only without markdown formatting.",
            temperature=0.2,
        )
        if not res:
            return None

        clean = re.sub(r"^```(?:mermaid)?\s*|\s*```$", "", res.strip(), flags=re.MULTILINE).strip()
        if clean.startswith("flowchart") or clean.startswith("graph"):
            return clean
        m = re.search(r"((?:flowchart|graph)\s+(?:TD|TB|LR|RL|BT)\b[\s\S]*)", clean)
        if m:
            return m.group(1).strip()
        return None

    _EXPERT_VIDEO_ANALYST_INSTRUCTIONS = (
        "You are an expert video analyst. Perform all of the following steps thoroughly in Ukrainian:\n"
        "1. Access and accurately transcribe/index the full video content with key timestamps [MM:SS] or [HH:MM:SS].\n"
        "2. Deeply analyze the video to identify the core message, main concepts, supporting arguments, and any data or examples presented.\n"
        "3. Extract the essential knowledge points and organize them into a concise, structured summary (300-600 words).\n"
        "4. For each major point/concept, explain it using 1-2 clear everyday analogies to make complex ideas relatable.\n"
        "5. Provide a critical analysis: pros and cons, different perspectives (educational, ethical, practical), public opinions/general trends, and science/data-backed facts where applicable.\n"
        "6. Include a customizable step-by-step actionable framework derived from the content (when relevant).\n"
        "7. End with memory aids (mnemonics or mental anchors for retention) plus a final verdict or key takeaway metric (e.g., efficiency/applicability score)."
    )

    @staticmethod
    def _normalize_youtube_analysis(
        data: Dict[str, Any], video_id: str, include_full_notes: bool = False
    ) -> Dict[str, Any]:
        """Normalize structured Expert Video Analyst JSON into canonical concept & textbook-ready fields."""
        concepts: List[Dict[str, Any]] = []
        for idx, c in enumerate(data.get("concepts") or []):
            if not isinstance(c, dict) or not c.get("concept_title"):
                continue
            start_s = max(0, int(float(c.get("start_seconds") or 0)))
            end_s_raw = c.get("end_seconds")
            end_s = int(float(end_s_raw)) if end_s_raw is not None else None
            m, s = divmod(start_s, 60)
            h, m = divmod(m, 60)
            tc = str(c.get("timecode") or (f"{h:02d}:{m:02d}:{s:02d}" if h > 0 else f"{m:02d}:{s:02d}")).strip()
            analogies = [str(a).strip() for a in (c.get("analogies") or []) if str(a).strip()][:2]
            exp_md = str(c.get("explanation_markdown") or "").strip()
            if analogies and "аналог" not in exp_md.lower():
                analogy_md = "\n".join(f"- {a}" for a in analogies)
                exp_md = f"{exp_md}\n\n#### Аналогії з повсякденного життя\n{analogy_md}".strip()
            concepts.append({
                "id": f"yt-{video_id}-{start_s}-{idx}",
                "concept_title": str(c["concept_title"]).strip(),
                "start_seconds": start_s,
                "end_seconds": end_s,
                "timecode": tc,
                "youtube_url": f"https://www.youtube.com/watch?v={video_id}&t={start_s}s",
                "summary": str(c.get("summary") or "").strip(),
                "analogies": analogies,
                "explanation_markdown": exp_md,
            })

        critical = data.get("critical_analysis")
        if isinstance(critical, dict):
            crit_parts = []
            label_map = (
                ("pros_and_cons", "Переваги та недоліки"),
                ("perspectives", "Освітній, етичний та практичний погляди"),
                ("public_trends", "Суспільне сприйняття та тренди"),
                ("evidence_facts", "Науково та емпірично підтверджені факти"),
            )
            for key, label in label_map:
                val = critical.get(key)
                if isinstance(val, list):
                    val_str = "\n".join(f"- {str(v).strip()}" for v in val if str(v).strip())
                else:
                    val_str = str(val or "").strip()
                if val_str:
                    crit_parts.append(f"#### {label}\n{val_str}")
            critical_md = "\n\n".join(crit_parts)
        else:
            critical_md = str(critical or "").strip()

        fw_raw = data.get("actionable_framework")
        if isinstance(fw_raw, list):
            framework_md = "\n".join(f"{i}. {str(step).strip()}" for i, step in enumerate(fw_raw, 1) if str(step).strip())
        else:
            framework_md = str(fw_raw or "").strip()

        mem_raw = data.get("memory_aids")
        if isinstance(mem_raw, list):
            memory_md = "\n".join(f"- {str(m).strip()}" for m in mem_raw if str(m).strip())
        else:
            memory_md = str(mem_raw or "").strip()

        core_message = str(data.get("core_message") or "").strip()
        structured_summary = str(data.get("structured_summary") or "").strip()
        final_verdict = str(data.get("final_verdict") or "").strip()
        video_summary = str(data.get("video_summary") or core_message or structured_summary[:300]).strip()

        result: Dict[str, Any] = {
            "video_summary": video_summary,
            "core_message": core_message,
            "structured_summary": structured_summary,
            "critical_analysis": critical_md,
            "actionable_framework": framework_md,
            "memory_aids": memory_md,
            "final_verdict": final_verdict,
            "concepts": concepts,
        }
        if include_full_notes:
            result["full_notes"] = str(data.get("full_notes") or "").strip()
        return result

    async def summarize_youtube_video(
        self,
        youtube_url: str,
        title: str = "",
        course_title: str = "",
        raise_on_error: bool = False,
    ) -> Optional[str]:
        """Extract expert video analysis and structured lecture notes from a YouTube URL natively via Gemini fileData."""
        if not self.is_available:
            return None
        from app.services.video_transcriber import VideoTranscriberService
        norm = VideoTranscriberService.normalize_youtube_url(youtube_url)
        if not norm:
            return None

        ctx = []
        if course_title:
            ctx.append(f'Course: "{course_title}"')
        if title:
            ctx.append(f'Material/Topic: "{title}"')
        ctx_line = ("\n".join(ctx) + "\n") if ctx else ""
        prompt = (
            f"{ctx_line}"
            f"{self._EXPERT_VIDEO_ANALYST_INSTRUCTIONS}\n\n"
            "Write the full analysis in Ukrainian using clean Markdown with LaTeX ($...$ / $$...$$) where appropriate. "
            "Include only content grounded in the video."
        )
        try:
            return await self.generate_content(
                prompt,
                system_instruction="You are an expert video analyst extracting accurate timestamped lecture notes, analogies, critical analysis, actionable frameworks, and memory aids in Ukrainian.",
                temperature=0.2,
                timeout=120.0,
                extra_parts=[{"fileData": {"fileUri": norm, "mimeType": "video/mp4"}}],
            )
        except LearningProviderError as exc:
            if raise_on_error:
                raise
            logger.warning("Gemini YouTube video extraction failed for %s (%s)", norm, getattr(exc, "message", exc))
            return None
        except Exception as exc:
            logger.warning("Unexpected YouTube Gemini extraction error (%s)", type(exc).__name__)
            return None

    async def structure_youtube_concepts(
        self,
        youtube_url: str,
        video_id: str,
        timestamped_transcript: str,
        title: str = "",
        course_title: str = "",
        raise_on_error: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """Analyze full timestamped YouTube subtitles into an Expert Video Analyst dossier + chronological concept blocks."""
        if not self.is_available or not timestamped_transcript.strip():
            return None

        ctx = []
        if course_title:
            ctx.append(f'Курс: "{course_title}"')
        if title:
            ctx.append(f'Тема/матеріал: "{title}"')
        ctx_line = ("\n".join(ctx) + "\n") if ctx else ""

        prompt = f"""{ctx_line}{self._EXPERT_VIDEO_ANALYST_INSTRUCTIONS}

Нижче наведено повні субтитри відеолекції ({youtube_url}) з точними таймкодами [MM:SS] або [HH:MM:SS].
Проаналізуй УВЕСЬ зміст відео без втрати матеріалу, виокреми головну ідею, підтримуючі аргументи, дані/приклади, розбий на логічні хронологічні концепти (для підручника) з 1-2 повсякденними аналогіями на кожен ключовий пункт, додай критичний аналіз, покроковий практичний фреймворк, мнемонічні якорі та фінальний вердикт/метрику.

СУБТИТРИ ВІДЕО:
{timestamped_transcript[:42000]}

Поверни строго JSON-об'єкт такого формату:
{{
  "video_summary": "Короткий підсумок усього відео (2-3 речення українською).",
  "core_message": "Головний меседж / центральна теза відео (1-2 речення).",
  "structured_summary": "Структуроване резюме ключових знань, аргументів і прикладів з відео (300-600 слів українською).",
  "concepts": [
    {{
      "concept_title": "Чітка назва концепту (українською)",
      "start_seconds": 120,
      "end_seconds": 360,
      "timecode": "02:00",
      "summary": "Стисла суть концепту з відео (2 речення).",
      "analogies": [
        "Аналогія 1: порівняння складної ідеї з буденною ситуацією.",
        "Аналогія 2: ще один наочний приклад з життя."
      ],
      "explanation_markdown": "Детальне академічне пояснення цього концепту на основі слів лектора: означення, формули у LaTeX ($...$ / $$...$$), підтримуючі аргументи, дані/приклади з відео та 1-2 зрозумілі аналогії."
    }}
  ],
  "critical_analysis": {{
    "pros_and_cons": "Сильні сторони, обмеження та компроміси підходу/концепцій у відео.",
    "perspectives": "Освітній, етичний та практичний погляди.",
    "public_trends": "Суспільне сприйняття / загальні тренди в галузі.",
    "evidence_facts": "Науково чи емпірично підтверджені факти (якщо застосовно)."
  }},
  "actionable_framework": "Налаштовуваний покроковий практичний фреймворк застосування матеріалу (Markdown список кроків).",
  "memory_aids": "Мнемонічні прийоми, асоціативні якорі або формули для запам'ятовування.",
  "final_verdict": "Фінальний вердикт та метрика цінності/ефективності засвоєння (наприклад, індекс практичної користі та головний висновок)."
}}
"""
        try:
            res = await self.generate_content(
                prompt,
                system_instruction="You are an expert video analyst. Analyze full timestamped lecture transcripts into structured concepts with analogies, critical analysis, actionable frameworks, memory aids, and textbook-ready explanations in Ukrainian. Output valid JSON only.",
                json_mode=True,
                temperature=0.2,
                timeout=60.0,
                raise_on_error=raise_on_error,
            )
            if not res:
                return None
            clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", res.strip(), flags=re.MULTILINE)
            try:
                data = json.loads(clean)
            except Exception:
                plain = res.strip()
                return {
                    "video_summary": plain[:300],
                    "full_notes": plain,
                    "concepts": [],
                }
            if not isinstance(data, dict):
                return None
            return self._normalize_youtube_analysis(data, video_id, include_full_notes=False)
        except LearningProviderError:
            if raise_on_error:
                raise
            return None
        except Exception as exc:
            logger.warning("Failed to structure YouTube concepts (%s)", type(exc).__name__)
            return None

    async def summarize_youtube_video_structured(
        self,
        youtube_url: str,
        video_id: str,
        title: str = "",
        course_title: str = "",
        raise_on_error: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """When captions are unavailable, use Gemini native video understanding to run the Expert Video Analyst workflow."""
        if not self.is_available:
            return None
        from app.services.video_transcriber import VideoTranscriberService
        norm = VideoTranscriberService.normalize_youtube_url(youtube_url)
        if not norm:
            return None

        ctx = []
        if course_title:
            ctx.append(f'Курс: "{course_title}"')
        if title:
            ctx.append(f'Тема: "{title}"')
        ctx_line = ("\n".join(ctx) + "\n") if ctx else ""

        prompt = (
            f"{ctx_line}"
            f"{self._EXPERT_VIDEO_ANALYST_INSTRUCTIONS}\n\n"
            "Уважно переглянь та прослухай це навчальне відео повністю, зафіксуй точний транскрипт/конспект із таймкодами "
            "та розбий матеріал на хронологічні концепти для побудови підручника.\n\n"
            "Поверни строго JSON:\n"
            "{\n"
            '  "video_summary": "Короткий огляд відео (2-3 речення)",\n'
            '  "core_message": "Головний меседж / центральна теза відео",\n'
            '  "structured_summary": "Структуроване резюме ключових знань (300-600 слів українською)",\n'
            '  "full_notes": "Повний транскрипт/конспект із ключовими таймкодами [MM:SS], формулами (LaTeX), аргументами, даними та прикладами з відео",\n'
            '  "concepts": [\n'
            "    {\n"
            '      "concept_title": "Назва концепту",\n'
            '      "start_seconds": 0,\n'
            '      "end_seconds": 180,\n'
            '      "timecode": "00:00",\n'
            '      "summary": "Суть концепту",\n'
            '      "analogies": ["Аналогія 1 з повсякденного життя", "Аналогія 2"],\n'
            '      "explanation_markdown": "Детальне пояснення цього концепту з відео, аргументи, приклади та 1-2 аналогії"\n'
            "    }\n"
            "  ],\n"
            '  "critical_analysis": {\n'
            '    "pros_and_cons": "Плюси та мінуси",\n'
            '    "perspectives": "Освітній, етичний і практичний погляди",\n'
            '    "public_trends": "Суспільне сприйняття / загальні тренди",\n'
            '    "evidence_facts": "Науково та емпірично підтверджені факти"\n'
            "  },\n"
            '  "actionable_framework": "Покроковий налаштовуваний практичний фреймворк",\n'
            '  "memory_aids": "Мнемоніки та ментальні якорі",\n'
            '  "final_verdict": "Фінальний вердикт та метрика ефективності/користі"\n'
            "}"
        )
        try:
            res = await self.generate_content(
                prompt,
                system_instruction="You watch educational videos as an expert video analyst and output complete timestamped transcriptions, concept structures, analogies, critical analysis, actionable frameworks, and memory aids in Ukrainian JSON.",
                json_mode=True,
                temperature=0.2,
                timeout=120.0,
                extra_parts=[{"fileData": {"fileUri": norm, "mimeType": "video/mp4"}}],
                raise_on_error=raise_on_error,
            )
            if not res:
                return None
            clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", res.strip(), flags=re.MULTILINE)
            try:
                data = json.loads(clean)
            except Exception:
                plain = res.strip()
                return {
                    "video_summary": plain[:300],
                    "full_notes": plain,
                    "concepts": [],
                }
            if not isinstance(data, dict):
                return None
            return self._normalize_youtube_analysis(data, video_id, include_full_notes=True)
        except LearningProviderError:
            if raise_on_error:
                raise
            return None
        except Exception as exc:
            logger.warning("Structured YouTube Gemini extraction failed (%s)", type(exc).__name__)
            return None

    async def generate_topic_summary(
        self,
        topic_title: str,
        context_text: str,
        course_title: str = "",
    ) -> Optional[str]:
        """Generate a concise 2-4 sentence summary of the topic in Ukrainian."""
        if not self.is_available or not context_text.strip():
            return None
        prompt = (
            f'Курс: "{course_title}"\nТема: "{topic_title}"\n\n'
            f"Матеріали теми:\n{context_text[:10000]}\n\n"
            "Напиши коротке, змістовне самері (2–4 речення українською), яке пояснює суть цієї теми та ключові поняття. "
            'Поверни JSON: {"topic_summary": "..."}'
        )
        try:
            res = await self.generate_content(
                prompt,
                system_instruction="You summarize university course topics concisely in Ukrainian. Return JSON only.",
                json_mode=True,
                temperature=0.2,
                timeout=30.0,
            )
            if not res:
                return None
            clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", res.strip(), flags=re.MULTILINE)
            parsed = json.loads(clean)
            if isinstance(parsed, dict) and parsed.get("topic_summary"):
                return str(parsed["topic_summary"]).strip()
        except Exception:
            return None
        return None

    async def evaluate_module_tutor_answer(
        self,
        module_title: str,
        module_content: str,
        tutor_question: str,
        expected_10_answer: str,
        student_answer: str = "",
        audio_bytes: Optional[bytes] = None,
        audio_mime: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Grade a student's module comprehension answer from 0 to 10 (pass >= 4/10) and provide the 10/10 model answer."""
        if not self.is_available:
            return None
        import base64

        has_audio = bool(audio_bytes and len(audio_bytes) >= 250)
        parts: List[Dict[str, Any]] = []
        if has_audio and audio_bytes is not None:
            clean_mime = (audio_mime or "audio/webm").split(";")[0].strip().lower()
            if clean_mime == "audio/x-m4a":
                clean_mime = "audio/mp4"
            parts.append({"inlineData": {"mimeType": clean_mime, "data": base64.b64encode(audio_bytes).decode("ascii")}})

        ans_block = (
            f'Відповідь студента (текст / транскрипт): "{student_answer.strip()}"'
            if student_answer.strip()
            else "Прослухай аудіовідповідь студента вище та розшифруй її."
        )

        prompt = f"""Оціни відповідь студента на запитання AI-тютора за модулем підручника «{module_title}».

ПИТАННЯ AI-ТЮТОРА:
{tutor_question}

ЕТАЛОННИЙ ОРІЄНТИР (для 10/10):
{expected_10_answer}

МАТЕРІАЛ МОДУЛЯ:
{module_content[:8000]}

{ans_block}

ПРАВИЛА ОЦІНЮВАННЯ:
1. Постав чесну цілочисельну оцінку від 0 до 10 (`score`). Мінімальний прохідний бал — 4/10 (`passed: score >= 4`).
2. Якщо студент відповів неправильно, поверхнево або набрав < 10/10 — чітко вкажи кожну помилку чи прогалину і обов'язково сформулюй повну, ідеальну очікувану відповідь для 10/10 (`expected_10_of_10`).
3. Поверни строго JSON:
{{
  "score": 7,
  "passed": true,
  "user_transcript": "Що сказав/написав студент",
  "feedback": "Детальний розбір відповіді українською: що правильно, а що потрібно виправити.",
  "mistakes": [
    {{
      "mistake": "Конкретна помилка або неточність студента",
      "correction": "Як правильно за матеріалом модуля"
    }}
  ],
  "expected_10_of_10": "Чітка зразкова відповідь на 10/10 за цим модулем."
}}
"""
        parts.append({"text": prompt})
        res = await self.generate_content(
            prompt="",
            extra_parts=parts,
            system_instruction="You are an encouraging yet rigorous AI university tutor grading student comprehension on a 0-10 scale in Ukrainian. Return JSON only.",
            json_mode=True,
            temperature=0.2,
            timeout=45.0,
            raise_on_error=True,
        )
        if not res:
            return None
        clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", res.strip(), flags=re.MULTILINE)
        data = json.loads(clean)
        if not isinstance(data, dict):
            return None
        score = max(0, min(10, int(data.get("score") if data.get("score") is not None else 0)))
        mistakes_out = []
        for item in data.get("mistakes") or []:
            if isinstance(item, dict):
                m_txt = str(item.get("mistake") or item.get("said") or "").strip()
                c_txt = str(item.get("correction") or "").strip()
                if m_txt or c_txt:
                    mistakes_out.append({"mistake": m_txt, "correction": c_txt})
            elif str(item).strip():
                mistakes_out.append({"mistake": str(item).strip(), "correction": ""})

        return {
            "score": score,
            "passed": score >= 4,
            "user_transcript": str(data.get("user_transcript") or student_answer).strip(),
            "feedback": str(data.get("feedback") or "").strip(),
            "mistakes": mistakes_out,
            "expected_10_of_10": str(data.get("expected_10_of_10") or expected_10_answer).strip(),
        }
