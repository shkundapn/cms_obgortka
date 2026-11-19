import html as _html
import json
import logging
import re
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse
import httpx

logger = logging.getLogger("video_transcriber")

try:
    from youtube_transcript_api import YouTubeTranscriptApi
    YOUTUBE_TRANSCRIPT_AVAILABLE = True
except ImportError:
    YouTubeTranscriptApi = None  # type: ignore
    YOUTUBE_TRANSCRIPT_AVAILABLE = False


class VideoTranscriberService:
    """
    Zero-token video & audio transcription service.
    Extracts subtitles and transcripts from YouTube, WebVTT, and SRT tracks
    without sending tokens to LLMs (completely free, offline/direct HTTP).
    """

    @staticmethod
    def extract_youtube_video_id(url: str) -> Optional[str]:
        """Extract video ID from various YouTube URL formats."""
        if not url:
            return None
        parsed = urlparse(url)
        hostname = (parsed.hostname or "").lower()

        if "youtube.com" in hostname:
            if parsed.path == "/watch":
                qs = parse_qs(parsed.query)
                return qs.get("v", [None])[0]
            elif parsed.path.startswith(("/embed/", "/v/", "/shorts/")):
                parts = parsed.path.strip("/").split("/")
                if len(parts) >= 2:
                    return parts[1]
        elif "youtu.be" in hostname:
            path = parsed.path.strip("/")
            if path:
                return path.split("/")[0]

        # Regex fallback
        match = re.search(r"(?:v=|\/embed\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})", url)
        if match:
            return match.group(1)
        return None

    @classmethod
    def normalize_youtube_url(cls, url: str) -> Optional[str]:
        """Return canonical https://www.youtube.com/watch?v=<id> or None if invalid."""
        vid = cls.extract_youtube_video_id((url or "").strip())
        return f"https://www.youtube.com/watch?v={vid}" if vid else None

    @classmethod
    def extract_youtube_urls_from_text(cls, text: str, limit: int = 5) -> List[str]:
        """Extract unique canonical YouTube URLs from raw text, Markdown, or HTML attributes."""
        if not text:
            return []
        candidates = re.findall(
            r"https?://(?:www\.|m\.)?(?:youtube\.com/(?:watch\?[^\s\"'<>)]+|embed/[^\s\"'<>/?)]+|shorts/[^\s\"'<>/?)]+|v/[^\s\"'<>/?)]+)|youtu\.be/[^\s\"'<>/?)]+)",
            text,
            flags=re.IGNORECASE,
        )
        urls: List[str] = []
        seen = set()
        for raw in candidates:
            norm = cls.normalize_youtube_url(raw.rstrip(".,;:)"))
            if norm and norm not in seen:
                seen.add(norm)
                urls.append(norm)
                if len(urls) >= limit:
                    break
        return urls

    @staticmethod
    def format_timestamp(seconds: float) -> str:
        total = max(0, int(seconds or 0))
        m, s = divmod(total, 60)
        h, m = divmod(m, 60)
        return f"{h:02d}:{m:02d}:{s:02d}" if h > 0 else f"{m:02d}:{s:02d}"

    @classmethod
    def _fetch_youtube_captions_http(
        cls,
        video_id: str,
        preferred_languages: Optional[List[str]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Direct HTTP watch-page captionTracks extractor fallback when youtube-transcript-api fails."""
        languages = preferred_languages or ["uk", "en", "pl", "de", "fr", "es", "ru"]
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Accept-Language": "uk,en-US;q=0.9,en;q=0.8",
        }
        try:
            with httpx.Client(timeout=15.0, follow_redirects=True, headers=headers) as client:
                watch_resp = client.get(f"https://www.youtube.com/watch?v={video_id}")
                if watch_resp.status_code != 200:
                    return None
                page = watch_resp.text
                match = re.search(r'"captionTracks"\s*:\s*(\[.*?\])', page)
                if not match:
                    return None
                tracks = json.loads(match.group(1))
                if not isinstance(tracks, list) or not tracks:
                    return None

                def track_rank(tr: Dict[str, Any]) -> tuple:
                    code = (tr.get("languageCode") or "").lower()
                    is_asr = tr.get("kind") == "asr"
                    lang_idx = next((i for i, p in enumerate(languages) if code.startswith(p.lower())), len(languages) + 1)
                    return (lang_idx, 1 if is_asr else 0, code)

                best = min(tracks, key=track_rank)
                base_url = best.get("baseUrl")
                if not base_url:
                    return None

                # Prefer json3 lossless timed events; fallback to raw XML
                sep = "&" if "?" in base_url else "?"
                cap_resp = client.get(f"{base_url}{sep}fmt=json3")
                segments: List[Dict[str, Any]] = []
                full_parts: List[str] = []

                if cap_resp.status_code == 200 and cap_resp.text.strip().startswith("{"):
                    payload = cap_resp.json()
                    for ev in payload.get("events", []):
                        segs = ev.get("segs") or []
                        txt = _html.unescape("".join(s.get("utf8", "") for s in segs)).replace("\n", " ").strip()
                        if not txt:
                            continue
                        start_sec = float(ev.get("tStartMs", 0)) / 1000.0
                        dur_sec = float(ev.get("dDurationMs", 0)) / 1000.0
                        segments.append({
                            "timestamp": cls.format_timestamp(start_sec),
                            "start_seconds": start_sec,
                            "duration": dur_sec,
                            "text": txt,
                        })
                        full_parts.append(txt)
                else:
                    xml_resp = client.get(base_url)
                    if xml_resp.status_code == 200:
                        for m in re.finditer(r'<text[^>]*start="([^"]+)"[^>]*>(.*?)</text>', xml_resp.text, flags=re.DOTALL):
                            start_sec = float(m.group(1) or 0.0)
                            txt = _html.unescape(re.sub(r"<[^>]+>", " ", m.group(2))).replace("\n", " ").strip()
                            if not txt:
                                continue
                            segments.append({
                                "timestamp": cls.format_timestamp(start_sec),
                                "start_seconds": start_sec,
                                "text": txt,
                            })
                            full_parts.append(txt)

                if not segments:
                    return None

                return {
                    "source": "youtube_captions",
                    "video_id": video_id,
                    "language": best.get("languageCode") or "uk",
                    "is_generated": best.get("kind") == "asr",
                    "full_text": " ".join(full_parts),
                    "segments": segments,
                    "token_cost": 0,
                }
        except Exception as exc:
            logger.debug("Direct HTTP caption fallback failed for %s: %s", video_id, exc)
            return None

    @classmethod
    def get_youtube_transcript(
        cls,
        url: str,
        preferred_languages: Optional[List[str]] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Fetch full lossless YouTube transcript with timestamps (0 tokens).
        Uses youtube_transcript_api first (manual > auto) and falls back to watch-page timedtext JSON3/XML.
        """
        video_id = cls.extract_youtube_video_id(url)
        if not video_id:
            return None

        languages = preferred_languages or ["uk", "en", "pl", "de", "fr", "es", "ru"]

        if YOUTUBE_TRANSCRIPT_AVAILABLE and YouTubeTranscriptApi is not None:
            try:
                transcript_list = YouTubeTranscriptApi().list(video_id)
                transcript = None
                try:
                    transcript = transcript_list.find_manually_created_transcript(languages)
                except Exception:
                    try:
                        transcript = transcript_list.find_transcript(languages)
                    except Exception:
                        for t in transcript_list:
                            transcript = t
                            break

                if transcript:
                    fetched = transcript.fetch()
                    full_text_parts = []
                    segments = []
                    for entry in fetched:
                        raw_txt = entry.get("text", "") if isinstance(entry, dict) else entry.text
                        text_line = _html.unescape(str(raw_txt or "")).replace("\n", " ").strip()
                        start_sec = float(entry.get("start", 0.0) if isinstance(entry, dict) else entry.start)
                        dur_sec = float(entry.get("duration", 0.0) if isinstance(entry, dict) else getattr(entry, "duration", 0.0))
                        if text_line:
                            full_text_parts.append(text_line)
                            segments.append({
                                "timestamp": cls.format_timestamp(start_sec),
                                "start_seconds": start_sec,
                                "duration": dur_sec,
                                "text": text_line,
                            })

                    if segments:
                        return {
                            "source": "youtube_captions",
                            "video_id": video_id,
                            "language": transcript.language_code,
                            "is_generated": transcript.is_generated,
                            "full_text": " ".join(full_text_parts),
                            "segments": segments,
                            "token_cost": 0,
                        }
            except Exception as exc:
                logger.info(f"YouTubeTranscriptApi fallback for {video_id}: {exc}")

        return cls._fetch_youtube_captions_http(video_id, preferred_languages=languages)

    @classmethod
    def format_timestamped_transcript(cls, segments: List[Dict[str, Any]], max_chars: int = 45000) -> str:
        """Render segments into clean timestamped blocks [MM:SS] ... without losing chronological context."""
        if not segments:
            return ""
        lines: List[str] = []
        bucket_start: Optional[float] = None
        bucket_words: List[str] = []

        for seg in segments:
            txt = (seg.get("text") or "").strip()
            if not txt:
                continue
            start_s = float(seg.get("start_seconds") or 0.0)
            if bucket_start is not None and (start_s - bucket_start >= 25.0 or sum(len(w) for w in bucket_words) >= 350):
                lines.append(f"[{cls.format_timestamp(bucket_start)}] {' '.join(bucket_words)}")
                bucket_start = None
                bucket_words = []
            if bucket_start is None:
                bucket_start = start_s
            bucket_words.append(txt)

        if bucket_start is not None and bucket_words:
            lines.append(f"[{cls.format_timestamp(bucket_start)}] {' '.join(bucket_words)}")

        joined = "\n".join(lines)
        return joined[:max_chars]

    @classmethod
    def group_segments_into_concepts(
        cls,
        segments: List[Dict[str, Any]],
        video_id: str,
        target_chunks: int = 4,
    ) -> List[Dict[str, Any]]:
        """Deterministic timestamped concept grouping fallback when AI structuring isn't run."""
        if not segments or not video_id:
            return []
        step = max(1, len(segments) // max(1, target_chunks))
        concepts: List[Dict[str, Any]] = []
        for idx in range(0, len(segments), step):
            chunk = segments[idx: idx + step]
            if not chunk:
                continue
            start_s = int(float(chunk[0].get("start_seconds") or 0))
            end_s = int(float(chunk[-1].get("start_seconds") or start_s) + 15)
            tc = cls.format_timestamp(start_s)
            snippet = " ".join((c.get("text") or "").strip() for c in chunk[:6]).strip()
            concepts.append({
                "id": f"yt-{video_id}-{start_s}",
                "concept_title": f"Фрагмент лекції ({tc})",
                "timecode": tc,
                "start_seconds": start_s,
                "end_seconds": end_s,
                "youtube_url": f"https://www.youtube.com/watch?v={video_id}&t={start_s}s",
                "summary": snippet[:280],
                "explanation_markdown": " ".join((c.get("text") or "").strip() for c in chunk),
            })
            if len(concepts) >= target_chunks + 2:
                break
        return concepts

    @staticmethod
    def parse_vtt_or_srt(sub_text: str) -> Dict[str, Any]:
        """
        Parse raw WebVTT or SRT subtitle text into plain text and timestamped segments.
        Cost: 0 tokens!
        """
        if not sub_text or not sub_text.strip():
            return {"full_text": "", "segments": [], "token_cost": 0}

        lines = sub_text.splitlines()
        segments = []
        full_text_parts = []

        current_timestamp = ""
        current_text_lines = []

        # Matches VTT/SRT timestamp lines like "00:01:20.000 --> 00:01:24.000" or "01:20 --> 01:24"
        ts_pattern = re.compile(r"(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)")

        for line in lines:
            trimmed = line.strip()
            if not trimmed or trimmed == "WEBVTT" or trimmed.startswith("NOTE"):
                continue

            # Check if this is a sequence number in SRT
            if trimmed.isdigit():
                continue

            match = ts_pattern.search(trimmed)
            if match:
                if current_timestamp and current_text_lines:
                    seg_text = " ".join(current_text_lines).strip()
                    if seg_text:
                        segments.append({"timestamp": current_timestamp, "text": seg_text})
                        full_text_parts.append(seg_text)
                    current_text_lines = []
                current_timestamp = match.group(1).split(".")[0].split(",")[0]
            else:
                # Remove inline formatting tags like <v ...>, <b>, <i>, <c.color>
                clean_line = re.sub(r"<[^>]+>", "", trimmed)
                if clean_line:
                    current_text_lines.append(clean_line)

        if current_timestamp and current_text_lines:
            seg_text = " ".join(current_text_lines).strip()
            if seg_text:
                segments.append({"timestamp": current_timestamp, "text": seg_text})
                full_text_parts.append(seg_text)

        return {
            "source": "subtitles",
            "full_text": " ".join(full_text_parts),
            "segments": segments,
            "token_cost": 0,
        }

    @classmethod
    def transcribe_video_module(cls, module_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        High-level helper to transcribe any video module with 0 tokens.
        Checks url for YouTube, then checks attached files for .vtt or .srt.
        """
        url = module_data.get("url") or ""
        # 1. Check YouTube
        if cls.extract_youtube_video_id(url):
            res = cls.get_youtube_transcript(url)
            if res:
                return res

        # 2. Check files for .vtt or .srt
        files = module_data.get("files") or []
        for f in files:
            fn = (f.get("filename") or f.get("name") or "").lower()
            if fn.endswith((".vtt", ".srt")):
                content = f.get("content") or ""
                if content:
                    parsed = cls.parse_vtt_or_srt(content)
                    if parsed.get("full_text"):
                        return parsed

        return None
