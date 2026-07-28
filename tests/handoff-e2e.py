import json
import os
import urllib.error
import urllib.request
from pathlib import Path

BASE_URL = "http://127.0.0.1:8791"
TAILOR_OUTPUT = Path(r"D:\codex\resume-tailor\outputs\郭伟南_AI产品经理_JD充实版-tailored-20260716-082820.docx")


def request(path, method="GET", payload=None, expected=200, headers=None):
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        f"{BASE_URL}{path}", body, method=method,
        headers=({"Content-Type": "application/json"} if body else {}) | (headers or {}),
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            assert response.status in (expected if isinstance(expected, tuple) else (expected,)), (response.status, expected)
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        assert error.code == expected, (error.code, expected, error.read())
        return json.loads(error.read())


def main():
    assert TAILOR_OUTPUT.is_file(), "expected an existing Resume Tailor DOCX output"
    source_url = "https://example.test/resumatch-handoff-e2e"
    request("/api/jobs", "POST", {
        "source_url": source_url,
        "title": "AI 产品经理",
        "company": "测试公司",
        "jd_text": "负责 AI 产品交付与流程自动化。",
    })
    jobs = request("/api/jobs")
    job = next(item for item in jobs if item["source_url"] == source_url)
    application_id = job["application_id"]
    package = {
        "schema_version": "resumatch-tailor-package/v1",
        "job_description": "负责 AI 产品交付与流程自动化。",
        "assessment": {
            "job_tier": "A",
            "match_score": 83,
            "summary": "已有项目交付证据，需核验量化结果。",
            "matched_points": [{"point": "AI 产品交付", "jd_requirement": "流程自动化"}],
            "risk_points": [{"risk": "行业经验", "evidence_to_prepare": "准备真实案例"}],
            "improvement_path": [],
            "interview_focus": [],
        },
    }
    imported = request(f"/api/applications/{application_id}/handoffs", "POST", {"package": package}, (200, 201))
    assert "message" in imported
    manifest = {
        "schema_version": "resume-tailor-manifest/v1",
        "artifacts": [{"kind": "resume_docx", "label": "端到端测试简历", "path": str(TAILOR_OUTPUT)}],
    }
    attached = request(f"/api/applications/{application_id}/artifacts", "POST", {"manifest": manifest}, (200, 201))
    assert "attached" in attached
    dossier = request(f"/api/applications/{application_id}/dossier")
    assert dossier["handoffs"][0]["assessment"]["match_score"] == 83
    assert dossier["artifacts"][0]["artifact_kind"] == "resume_docx"
    rejected = request(f"/api/applications/{application_id}/handoffs", "POST", {
        "package": {"schema_version": "invalid", "job_description": "x", "assessment": {}}
    }, 400)
    assert "不支持" in rejected["error"]
    escaped_path = request(f"/api/applications/{application_id}/artifacts", "POST", {
        "manifest": {
            "schema_version": "resume-tailor-manifest/v1",
            "artifacts": [{"kind": "resume_docx", "label": "outside", "path": r"C:\\Windows\\win.ini"}],
        }
    }, 400)
    assert "不在 Resume Tailor outputs" in escaped_path["error"]
    archive = request("/api/export/portable")
    assert archive["schema_version"] == "resumatch-workbench-export/v1"
    blocked_export = request("/api/export/portable", expected=403, headers={"Origin": "https://example.test"})
    assert "仅允许" in blocked_export["error"]
    blocked_api = request("/api/jobs", expected=403, headers={"Origin": "https://example.test"})
    assert "仅允许" in blocked_api["error"]

    print("handoff API end-to-end checks passed")


if __name__ == "__main__":
    main()
