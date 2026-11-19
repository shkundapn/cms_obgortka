from app.config import get_settings
import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_healthz_liveness():
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_system_health():
    response = client.get("/api/system/health")
    assert response.status_code == 200
    data = response.json()
    assert "status" in data
    assert "latency_ms" in data
    assert data["target_url"] == "https://learn.ucu.edu.ua"


def test_unauthenticated_access_denied():
    response = client.get("/api/courses")
    assert response.status_code == 401


def test_auth_with_cookie(monkeypatch):
    monkeypatch.setattr(get_settings(), "MOODLE_MOCK_MODE", True)
    # Test browser cookie sign-in
    res = client.post(
        "/api/auth/login",
        json={"cookie": "mock_moodle_session_cookie_12345"}
    )
    assert res.status_code == 200
    assert res.json()["success"] is True
    assert "moodle_session" in res.cookies

    # Verify courses work with cookie session
    courses_res = client.get("/api/courses", cookies=res.cookies)
    assert courses_res.status_code == 200
    assert len(courses_res.json()) > 0


def test_auth_with_token(monkeypatch):
    monkeypatch.setattr(get_settings(), "MOODLE_MOCK_MODE", True)
    # Test direct token sign in
    res = client.post(
        "/api/auth/login",
        json={"token": "mock_token_demo"}
    )
    assert res.status_code == 200
    assert res.json()["success"] is True
    assert "moodle_session" in res.cookies


def test_auth_and_full_flow(monkeypatch):
    monkeypatch.setattr(get_settings(), "MOODLE_MOCK_MODE", True)
    # 1. Login with demo account
    login_res = client.post(
        "/api/auth/login",
        json={"username": "demo", "password": "demopassword"}
    )
    assert login_res.status_code == 200
    auth_data = login_res.json()
    assert auth_data["success"] is True
    assert "moodle_session" in login_res.cookies

    # 2. Check /api/auth/me
    me_res = client.get("/api/auth/me", cookies=login_res.cookies)
    assert me_res.status_code == 200
    assert me_res.json()["username"] == "demo"

    # 3. Check /api/courses
    courses_res = client.get("/api/courses", cookies=login_res.cookies)
    assert courses_res.status_code == 200
    courses = courses_res.json()
    assert len(courses) > 0
    course_id = courses[0]["id"]

    # 4. Check course contents
    contents_res = client.get(f"/api/courses/{course_id}/contents", cookies=login_res.cookies)
    assert contents_res.status_code == 200
    sections = contents_res.json()
    assert len(sections) > 0

    # 4b. Check single course detail endpoint
    detail_res = client.get(f"/api/courses/{course_id}", cookies=login_res.cookies)
    assert detail_res.status_code == 200
    assert detail_res.json()["id"] == course_id

    # 4c. Check dedicated course HTML page
    html_res = client.get(f"/courses/{course_id}")
    assert html_res.status_code == 200
    assert "text/html" in html_res.headers["content-type"]

    # 5. Check assignments
    assign_res = client.get("/api/assignments", cookies=login_res.cookies)
    assert assign_res.status_code == 200
    assert assign_res.json()["total"] > 0

    # 6. Check grades (all and filtered by course_id)
    grades_res = client.get("/api/grades", cookies=login_res.cookies)
    assert grades_res.status_code == 200
    assert len(grades_res.json()["courses"]) > 0

    single_grades_res = client.get(f"/api/grades?course_id={course_id}", cookies=login_res.cookies)
    assert single_grades_res.status_code == 200
    assert len(single_grades_res.json()["courses"]) == 1

    # 7. Logout
    logout_res = client.post("/api/auth/logout")
    assert logout_res.status_code == 200


def test_authorities_routing_and_api():
    # 1. API List authorities
    res = client.get("/api/authorities")
    assert res.status_code == 200
    slugs = [a["slug"] for a in res.json()]
    assert "ucu" in slugs
    assert "kpi" in slugs
    assert "lnu" in slugs

    # 2. API Single authority
    res_ucu = client.get("/api/authorities/ucu")
    assert res_ucu.status_code == 200
    assert res_ucu.json()["base_url"] == "https://learn.ucu.edu.ua"

    # 3. HTML Authority Pages
    res_page_ucu = client.get("/ucu")
    assert res_page_ucu.status_code == 200
    assert "text/html" in res_page_ucu.headers["content-type"]

    res_page_kpi = client.get("/kpi")
    assert res_page_kpi.status_code == 200

    # 4. Authority Course Page
    res_course = client.get("/ucu/courses/1022")
    assert res_course.status_code == 200
    assert "text/html" in res_course.headers["content-type"]


def test_system_inspect_endpoint():
    # Test with invalid / dummy URL to check schema response
    res = client.get("/api/system/inspect?url=https://invalid-non-existent-domain-12345.edu.ua")
    assert res.status_code == 200
    data = res.json()
    assert "is_moodle" in data
    assert "target_url" in data
    assert "engine_detected" in data
    assert data["is_moodle"] is False


def test_sliding_session_refresh_and_upstream_403_status(monkeypatch):
    from datetime import datetime, timedelta, timezone
    import jwt
    from app.core.exceptions import MoodleAuthError
    from app.services.moodle_client import MoodleClient

    settings = get_settings()
    monkeypatch.setattr(settings, "MOODLE_MOCK_MODE", True)

    stale_payload = {
        "sub": "demo",
        "user_id": 4242,
        "fullname": "Demo Student",
        "site_url": "https://learn.ucu.edu.ua",
        "moodle_token": "mock_token_demo",
        "is_mock": True,
        "auth_type": "cookie",
        "exp": datetime.now(timezone.utc) + timedelta(minutes=30),
        "iat": datetime.now(timezone.utc) - timedelta(minutes=450),
    }
    near_expiry_jwt = jwt.encode(stale_payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)

    c1 = TestClient(app)
    c1.cookies.set(settings.COOKIE_NAME, near_expiry_jwt)
    res = c1.get("/api/auth/status")
    assert res.status_code == 200
    assert res.json()["moodle_paired"] is True
    assert settings.COOKIE_NAME in res.cookies
    assert res.cookies[settings.COOKIE_NAME] != near_expiry_jwt

    c2 = TestClient(app)
    c2.cookies.set(settings.COOKIE_NAME, near_expiry_jwt)
    refreshed = c2.post("/api/auth/refresh")
    assert refreshed.status_code == 200
    assert refreshed.json()["moodle_paired"] is True
    assert settings.COOKIE_NAME in refreshed.cookies

    fresh_client = TestClient(app)
    unauth_refresh = fresh_client.post("/api/auth/refresh")
    assert unauth_refresh.status_code == 200
    assert unauth_refresh.json()["needs_reconnect"] is True

    # Upstream 403 during extension-pair returns 502 (not 401), and expired session on /api/courses returns 401 (not 500)
    monkeypatch.setattr(settings, "MOODLE_MOCK_MODE", False)

    async def blocked_cookie(self, **kwargs):
        raise MoodleAuthError("Moodle returned HTTP 403", error_code="upstream_blocked")

    monkeypatch.setattr(MoodleClient, "authenticate_with_cookie", blocked_cookie)
    pair_res = fresh_client.post("/api/auth/extension-pair", json={"moodle_url": "https://learn.ucu.edu.ua", "cookie": "abcdef123456"})
    assert pair_res.status_code == 502

    async def expired_courses(self, **kwargs):
        raise MoodleAuthError("Expired session", error_code="invalid_cookie")

    monkeypatch.setattr(MoodleClient, "get_user_courses", expired_courses)
    live_jwt = jwt.encode({**stale_payload, "is_mock": False, "moodle_token": "real_cookie"}, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    c3 = TestClient(app)
    c3.cookies.set(settings.COOKIE_NAME, live_jwt)
    courses_res = c3.get("/api/courses")
    assert courses_res.status_code == 401


def test_browser_relayed_pairing_and_course_html_sync_when_server_blocked(monkeypatch):
    from app.core.exceptions import MoodleAuthError
    from app.services.moodle_client import MoodleClient

    settings = get_settings()
    monkeypatch.setattr(settings, "MOODLE_MOCK_MODE", False)

    async def blocked_cookie(self, **kwargs):
        raise MoodleAuthError("Moodle returned HTTP 403", error_code="upstream_blocked")

    monkeypatch.setattr(MoodleClient, "authenticate_with_cookie", blocked_cookie)

    my_html = (
        '<html><span class="usertext">Олена Студентка</span>'
        '<a href="https://learn.ucu.edu.ua/user/profile.php?id=777">Профіль</a>'
        '<script>var cfg={"sesskey":"xyz789"};</script></html>'
    )
    c = TestClient(app)
    paired = c.post(
        "/api/auth/extension-pair",
        json={"moodle_url": "https://learn.ucu.edu.ua", "cookie": "real_cookie_val", "browser_my_html": my_html},
    )
    assert paired.status_code == 200
    assert paired.json()["moodle_paired"] is True
    assert paired.json()["moodle_user_id"] == 777

    course_html = (
        '<html><body><ul>'
        '<li id="section-1" class="section">'
        '<div class="course-section-header">'
        '<h3 class="sectionname">'
        '<span class="visually-hidden">Виберіть секцію Нова секція</span>'
        '<a class="icons-collapse-expand"><span>Згорнути</span><span>Розгорнути</span></a>'
        '<a href="/course/section.php?id=1">Лекція</a>'
        '</h3></div>'
        '<a href="https://learn.ucu.edu.ua/mod/page/view.php?id=301">Вступ до графів</a>'
        '</li></ul></body></html>'
    )
    import base64
    att_b64 = base64.b64encode("Граф складається з вершин та ребер.".encode("utf-8")).decode("ascii")
    sync_res = c.post(
        "/api/workspace/courses/888/sync-moodle",
        json={
            "course_title": "Алгоритми",
            "shortname": "ALG",
            "course_html": course_html,
            "module_contents": [
                {"module_id": 301, "text_excerpt": "Додатковий опис сторінки", "attachment_filename": "notes.txt", "attachment_base64": att_b64}
            ],
            "fetch_files": False,
        },
    )
    assert sync_res.status_code == 200
    bundle = c.get("/api/workspace/courses/888")
    assert bundle.status_code == 200
    assert bundle.json()["course"]["title"] == "Алгоритми"
    assert bundle.json()["sections"][0]["name"] == "Лекція"
    from app.services.workspace_store import get_workspace_store
    stored_bundle = get_workspace_store().get_course_bundle(888, owner_id=bundle.json()["course"]["owner_id"])
    snap_text = "\n".join(s.content_text for s in stored_bundle["snapshots"])
    assert "Додатковий опис сторінки" in snap_text
    assert "Граф складається з вершин та ребер." in snap_text

    grade_html = (
        '<html><table class="user-grade"><tbody>'
        '<tr><th class="column-itemname"><a href="/mod/assign/view.php?id=301">Лабораторна 1</a></th>'
        '<td class="column-grade">95.00</td><td class="column-range">0–100</td><td class="column-percentage">95.00 %</td></tr>'
        '</tbody></table></html>'
    )
    grades_res = c.post(
        "/api/grades/from-browser",
        json={"courses": [{"course_id": 888, "course_fullname": "Алгоритми", "report_html": grade_html}]},
    )
    assert grades_res.status_code == 200
    g_courses = grades_res.json()["courses"]
    assert len(g_courses) == 1
    assert g_courses[0]["course_id"] == 888
    assert g_courses[0]["grade_items"][0]["itemname"] == "Лабораторна 1"
    assert g_courses[0]["grade_items"][0]["gradeformatted"] == "95.00"

    updated_course_html = (
        '<html><body><ul>'
        '<li id="section-1" class="section"><h3 class="sectionname">Лекція</h3>'
        '<a href="https://learn.ucu.edu.ua/mod/page/view.php?id=301">Вступ до графів</a>'
        '<a href="https://learn.ucu.edu.ua/mod/page/view.php?id=302">Дерева пошуку</a>'
        '</li></ul></body></html>'
    )
    upd_res = c.post(
        "/api/workspace/courses/888/check-updates?force=true",
        json={"course_html": updated_course_html},
    )
    assert upd_res.status_code == 200
    assert upd_res.json()["checked"] is True
    assert not upd_res.json().get("upstream_blocked")

    async def blocked_ajax(*args, **kwargs):
        raise MoodleAuthError("Moodle returned HTTP 403", error_code="upstream_blocked")

    async def blocked_courses(*args, **kwargs):
        raise MoodleAuthError("Moodle returned HTTP 403", error_code="upstream_blocked")

    monkeypatch.setattr(MoodleClient, "call_ajax_ws", blocked_ajax)
    monkeypatch.setattr(MoodleClient, "get_user_courses", blocked_courses)
    monkeypatch.setattr(MoodleClient, "get_user_grades", blocked_courses)

    assert c.get("/api/courses?refresh=true").status_code == 502
    assert c.get("/api/assignments?refresh=true").status_code == 502
    assert c.get("/api/grades?refresh=true").status_code == 502

    saved_assign = c.post(
        "/api/assignments/from-browser",
        json={
            "course_id": 888,
            "assignments": [
                {"id": 901, "cmid": 301, "course_id": 888, "course_name": "Алгоритми", "name": "Дедлайн 1", "duedate": 1900000000}
            ],
        },
    )
    assert saved_assign.status_code == 200
    assert saved_assign.json()["total"] == 1

    from app.services.academic_cache import get_academic_cache
    get_academic_cache()._entries.clear()

    persisted_assign = c.get("/api/assignments?course_id=888")
    assert persisted_assign.status_code == 200
    assert persisted_assign.json()["total"] == 1
    assert persisted_assign.json()["assignments"][0]["name"] == "Дедлайн 1"


