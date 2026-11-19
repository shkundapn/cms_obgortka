from datetime import datetime, timezone
from typing import List, Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from app.core.exceptions import MoodleAuthError, MoodleConnectionError, MoodleException
from app.core.security import get_current_user_session
from app.models.assignment import AssignmentItem, AssignmentListResponse
from app.services.academic_cache import get_academic_cache
from app.services.moodle_client import MoodleClient
from app.services.submission_status import get_submission_states
from app.services.workspace_store import get_workspace_store

router = APIRouter(prefix="/api/assignments", tags=["Assignments"])


def _build_assignment_response(
    raw_items: List[Dict[str, Any]],
    course_id: Optional[int] = None,
) -> AssignmentListResponse:
    assignments_list: List[AssignmentItem] = []
    now_ts = int(datetime.now(timezone.utc).timestamp())
    for a in raw_items:
        c_id = int(a.get("course_id") or 0)
        if course_id is not None and c_id != int(course_id):
            continue
        duedate = a.get("duedate") or 0
        duedate_formatted = a.get("duedate_formatted")
        is_overdue = bool(a.get("is_overdue", False))
        if duedate and int(duedate) > 0:
            if not duedate_formatted:
                dt = datetime.fromtimestamp(int(duedate), tz=timezone.utc)
                duedate_formatted = dt.strftime("%Y-%m-%d %H:%M UTC")
            is_overdue = int(duedate) < now_ts
        assignments_list.append(
            AssignmentItem(
                id=int(a.get("id") or 0),
                cmid=a.get("cmid"),
                course_id=c_id,
                course_name=a.get("course_name", ""),
                name=a.get("name", "Assignment"),
                duedate=int(duedate) if duedate else None,
                duedate_formatted=duedate_formatted,
                intro=a.get("intro"),
                nosubmissions=int(a.get("nosubmissions", 0) or 0),
                submissions_open=bool(a.get("submissions_open", True)),
                is_overdue=is_overdue,
            )
        )
    assignments_list.sort(key=lambda x: x.duedate if x.duedate and x.duedate > 0 else 9999999999)
    return AssignmentListResponse(total=len(assignments_list), assignments=assignments_list)


class BrowserAssignmentsRequest(BaseModel):
    course_id: Optional[int] = None
    assignments: List[Dict[str, Any]]


@router.post("/from-browser", response_model=AssignmentListResponse)
async def save_assignments_from_browser(
    req: BrowserAssignmentsRequest,
    session: Dict[str, Any] = Depends(get_current_user_session),
):
    """Persist assignments fetched inside the user's browser and update the cache."""
    site_url = session.get("site_url") or ""
    user_id = session["user_id"]
    resp = _build_assignment_response(req.assignments, course_id=req.course_id)
    cache = get_academic_cache()
    cache_key = str(req.course_id) if req.course_id is not None else "all"
    cache.set(site_url, user_id, "assignments", resp, key=cache_key, ttl_seconds=300.0)
    get_workspace_store().save_assignments(
        site_url,
        user_id,
        [item.model_dump() for item in resp.assignments],
        course_id=req.course_id,
    )
    return resp


@router.get("/submission-status")
async def get_assignment_submission_status(
    assignment_ids: List[int] = Query(default=[], max_length=24),
    session: Dict[str, Any] = Depends(get_current_user_session),
):
    client = MoodleClient(base_url=session.get("site_url"))
    return {"statuses": await get_submission_states(client, session, [i for i in assignment_ids if i > 0])}


@router.get("", response_model=AssignmentListResponse)
async def get_my_assignments(
    course_id: Optional[int] = None,
    refresh: bool = Query(default=False),
    session: Dict[str, Any] = Depends(get_current_user_session),
):
    """
    Fetch assignments across all enrolled courses or for a specific course (per-user TTL cached).
    """
    site_url = session.get("site_url")
    user_id = session["user_id"]
    cache = get_academic_cache()
    cache_key = str(course_id) if course_id is not None else "all"

    if not refresh:
        cached = cache.get(site_url, user_id, "assignments", cache_key)
        if cached is not None:
            return cached
        # If global assignments were recently fetched/prefetched, slice without extra Moodle call
        if course_id is not None:
            cached_all = cache.get(site_url, user_id, "assignments", "all")
            if cached_all is not None and cached_all.assignments:
                filtered = [a for a in cached_all.assignments if int(a.course_id) == int(course_id)]
                if filtered:
                    resp = AssignmentListResponse(total=len(filtered), assignments=filtered)
                    cache.set(site_url, user_id, "assignments", resp, key=cache_key, ttl_seconds=300.0)
                    return resp

    client = MoodleClient(base_url=site_url)
    token = session["moodle_token"]
    auth_type = session.get("auth_type", "token")
    sesskey = session.get("sesskey")

    try:
        # Determine course IDs (reusing cached courses when possible)
        if course_id:
            course_ids = [course_id]
        else:
            courses = None if refresh else cache.get(site_url, user_id, "courses")
            if courses is None:
                courses = await client.get_user_courses(
                    token=token,
                    user_id=user_id,
                    auth_type=auth_type,
                    sesskey=sesskey,
                )
                cache.set(site_url, user_id, "courses", courses, ttl_seconds=300.0)
            course_ids = [c["id"] for c in courses]

        raw_data = await client.get_assignments(
            token=token,
            course_ids=course_ids,
            auth_type=auth_type,
            sesskey=sesskey,
        )
    except MoodleAuthError as exc:
        if exc.error_code == "upstream_blocked":
            if not refresh:
                saved = get_workspace_store().load_assignments(site_url or "", user_id, course_id=course_id)
                if saved is not None:
                    return _build_assignment_response(saved, course_id=course_id)
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=exc.message)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=exc.message or "Moodle session expired.",
        )
    except MoodleConnectionError as exc:
        if not refresh:
            saved = get_workspace_store().load_assignments(site_url or "", user_id, course_id=course_id)
            if saved is not None:
                return _build_assignment_response(saved, course_id=course_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=exc.message or "Could not reach Moodle.",
        )
    except MoodleException as exc:
        if not refresh:
            saved = get_workspace_store().load_assignments(site_url or "", user_id, course_id=course_id)
            if saved is not None:
                return _build_assignment_response(saved, course_id=course_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Moodle error fetching assignments: {exc.message}",
        )

    assignments_list = []
    now_ts = int(datetime.now(timezone.utc).timestamp())

    for c in raw_data.get("courses", []):
        c_id = int(c["id"])
        if course_id is not None and c_id != int(course_id):
            continue
        c_name = c.get("fullname", "")
        for a in c.get("assignments", []):
            duedate = a.get("duedate", 0)
            duedate_formatted = None
            is_overdue = False

            if duedate and duedate > 0:
                dt = datetime.fromtimestamp(duedate, tz=timezone.utc)
                duedate_formatted = dt.strftime("%Y-%m-%d %H:%M UTC")
                if duedate < now_ts:
                    is_overdue = True

            assignments_list.append(
                AssignmentItem(
                    id=a["id"],
                    cmid=a.get("cmid"),
                    course_id=c_id,
                    course_name=c_name,
                    name=a.get("name", "Assignment"),
                    duedate=duedate,
                    duedate_formatted=duedate_formatted,
                    intro=a.get("intro"),
                    nosubmissions=a.get("nosubmissions", 0),
                    submissions_open=a.get("submissions_open", True),
                    is_overdue=is_overdue,
                )
            )

    # Sort assignments by due date (upcoming first)
    assignments_list.sort(key=lambda x: x.duedate if x.duedate and x.duedate > 0 else 9999999999)

    resp = AssignmentListResponse(
        total=len(assignments_list),
        assignments=assignments_list,
    )
    cache.set(site_url, user_id, "assignments", resp, key=cache_key, ttl_seconds=300.0)
    get_workspace_store().save_assignments(
        site_url or "",
        user_id,
        [item.model_dump() for item in resp.assignments],
        course_id=course_id,
    )
    return resp
