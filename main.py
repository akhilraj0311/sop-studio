"""SOP Studio — FastAPI backend (runs on Cloud Run).

Serves the single-page web app and the API that:
  * verifies Firebase Auth ID tokens
  * reads uploaded recordings from Cloud Storage for Firebase
  * calls Gemini to write the SOP, training and answers
  * writes everything to Firestore (the web app listens in real time)
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

import firebase_admin
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from firebase_admin import auth as fb_auth
from firebase_admin import firestore, storage
from pydantic import BaseModel, Field

import gemini_service as gem

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("sop-studio")

PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID") or os.getenv("GOOGLE_CLOUD_PROJECT")
BUCKET = os.getenv("FIREBASE_STORAGE_BUCKET")
STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="SOP Studio", version="1.0.0")

_db = None


def db():
    """Lazy Firebase init so the container starts even before credentials are reachable."""
    global _db
    if _db is None:
        if not firebase_admin._apps:
            opts = {}
            if PROJECT_ID:
                opts["projectId"] = PROJECT_ID
            if BUCKET:
                opts["storageBucket"] = BUCKET
            firebase_admin.initialize_app(options=opts)
        _db = firestore.client()
    return _db


def current_user(authorization: str | None) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing sign-in token")
    db()  # ensure app initialised
    try:
        return fb_auth.verify_id_token(authorization.split(" ", 1)[1], clock_skew_seconds=10)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(401, f"Invalid sign-in token: {e}") from e


def set_status(ref, status: str, message: str, **extra):
    ref.update({"status": status, "statusMessage": message,
                "updatedAt": firestore.SERVER_TIMESTAMP, **extra})


# ------------------------------------------------------------------ routes

@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/api/config")
def config():
    """Public Firebase web config (these values are not secrets)."""
    return {
        "apiKey": os.getenv("FIREBASE_API_KEY", ""),
        "authDomain": os.getenv("FIREBASE_AUTH_DOMAIN", f"{PROJECT_ID}.firebaseapp.com"),
        "projectId": PROJECT_ID or "",
        "storageBucket": BUCKET or "",
        "messagingSenderId": os.getenv("FIREBASE_MESSAGING_SENDER_ID", ""),
        "appId": os.getenv("FIREBASE_APP_ID", ""),
    }


@app.post("/api/sops/{sop_id}/process")
def process_sop(sop_id: str, authorization: str | None = Header(default=None)):
    """Run the full Gemini pipeline for an SOP the user just created.

    Runs synchronously (Cloud Run keeps CPU for the whole request); progress is
    streamed to the browser through Firestore status updates.
    """
    user = current_user(authorization)
    ref = db().collection("sops").document(sop_id)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(404, "SOP not found")
    doc = snap.to_dict()
    if doc.get("ownerUid") != user["uid"]:
        raise HTTPException(403, "Only the creator can process this SOP")
    if not _claim(ref):
        return {"ok": True, "status": "already-processing"}
    try:
        _run_pipeline(ref, doc)
        return {"ok": True, "status": "ready"}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, "Processing failed") from e


def _run_pipeline(ref, doc: dict) -> None:
    """Source → Gemini SOP → Gemini training → Firestore. Status is streamed via Firestore."""
    try:
        source = doc.get("sourceType", "video")
        if source == "notes":
            set_status(ref, "analyzing", "Gemini is reading your notes…")
            sop, model = gem.analyze_source(notes=doc.get("notes", ""), context=doc.get("context", ""))
        else:
            path = doc.get("videoPath")
            if not path:
                raise ValueError("No video attached")
            set_status(ref, "analyzing", "Gemini is watching your recording…")
            bucket = storage.bucket()
            sop, model = gem.analyze_source(
                gs_uri=f"gs://{bucket.name}/{path}",
                video_bytes_loader=lambda: bucket.blob(path).download_as_bytes(),
                mime_type=(doc.get("videoMime") or "video/webm").split(";")[0],
                context=doc.get("context", ""),
            )
        sop = _clean_sop(sop)
        set_status(ref, "training", "Writing the checklist and quiz…",
                   sop=sop, title=sop.get("title") or doc.get("title") or "Untitled SOP",
                   category=sop.get("category", "Other"), model=model)

        training, _ = gem.build_training(sop)
        training = _clean_training(training, sop)
        set_status(ref, "ready", "Ready", training=training)
    except Exception as e:
        log.exception("Processing failed for %s", ref.id)
        set_status(ref, "error", f"Something went wrong: {str(e)[:240]}")
        raise


# ------------------------------------------------------------------ ops (deploy script)

SEED_KEY = os.getenv("SEED_KEY", "")


def _check_key(key: str | None):
    if not SEED_KEY or key != SEED_KEY:
        raise HTTPException(403, "Forbidden")


@app.get("/api/admin/health")
def deep_health(x_seed_key: str | None = Header(default=None)):
    """Checks Firestore, Storage and Gemini end to end. Used by deploy.sh."""
    _check_key(x_seed_key)
    out = {}
    try:
        list(db().collection("sops").limit(1).get())
        out["firestore"] = "ok"
    except Exception as e:  # noqa: BLE001
        out["firestore"] = f"error: {str(e)[:300]}"
    try:
        out["storage"] = "ok" if storage.bucket().exists() else "error: bucket not found"
    except Exception as e:  # noqa: BLE001
        out["storage"] = f"error: {str(e)[:300]}"
    try:
        out["gemini"] = f"ok ({gem.ping()})"
    except Exception as e:  # noqa: BLE001
        out["gemini"] = f"error: {str(e)[:300]}"
    ok = all(v.startswith("ok") for v in out.values())
    return JSONResponse({"ok": ok, **out}, status_code=200 if ok else 503)


@app.post("/api/admin/seed")
def seed(x_seed_key: str | None = Header(default=None)):
    """Creates the demo SOPs so judges land on a populated library. Safe to re-run."""
    _check_key(x_seed_key)
    from demo_data import DEMO_SOPS

    results = {}
    for item in DEMO_SOPS:
        ref = db().collection("sops").document(item["id"])
        snap = ref.get()
        if snap.exists and snap.to_dict().get("status") == "ready":
            results[item["id"]] = "already ready"
            continue
        doc = {
            "ownerUid": "demo", "ownerName": item.get("owner", "Demo team"),
            "title": item["title"], "context": item.get("context", ""),
            "sourceType": "notes", "notes": item["notes"],
            "status": "uploaded", "statusMessage": "Queued",
            "createdAt": firestore.SERVER_TIMESTAMP, "updatedAt": firestore.SERVER_TIMESTAMP,
        }
        ref.set(doc)
        try:
            _claim(ref)
            _run_pipeline(ref, doc)
            results[item["id"]] = "ready"
        except Exception as e:  # noqa: BLE001
            results[item["id"]] = f"error: {str(e)[:200]}"
    return {"results": results}


class AskBody(BaseModel):
    question: str = Field(min_length=2, max_length=600)


@app.post("/api/sops/{sop_id}/ask")
def ask(sop_id: str, body: AskBody, authorization: str | None = Header(default=None)):
    user = current_user(authorization)
    ref = db().collection("sops").document(sop_id)
    snap = ref.get()
    if not snap.exists or not snap.to_dict().get("sop"):
        raise HTTPException(404, "SOP not ready")
    history = [d.to_dict() for d in ref.collection("qa").order_by("createdAt").limit_to_last(4).get()]
    result, _ = gem.answer_question(snap.to_dict()["sop"], body.question, history)
    entry = {
        "question": body.question,
        "answer": str(result.get("answer", "")).strip() or "Sorry, I couldn't find an answer.",
        "stepRefs": [int(s) for s in result.get("step_refs", []) if str(s).isdigit()],
        "covered": bool(result.get("covered", True)),
        "askedBy": user.get("name") or ("Guest" if user.get("firebase", {}).get("sign_in_provider") == "anonymous" else user.get("email", "User")),
        "askedByUid": user["uid"],
        "createdAt": firestore.SERVER_TIMESTAMP,
    }
    ref.collection("qa").add(entry)
    entry.pop("createdAt")
    return entry


@app.delete("/api/sops/{sop_id}")
def delete_sop(sop_id: str, authorization: str | None = Header(default=None)):
    user = current_user(authorization)
    ref = db().collection("sops").document(sop_id)
    snap = ref.get()
    if not snap.exists:
        return {"ok": True}
    doc = snap.to_dict()
    if doc.get("ownerUid") != user["uid"]:
        raise HTTPException(403, "Only the creator can delete this SOP")
    for q in ref.collection("qa").list_documents():
        q.delete()
    if doc.get("videoPath"):
        try:
            storage.bucket().blob(doc["videoPath"]).delete()
        except Exception:  # noqa: BLE001
            log.warning("Video delete failed for %s", sop_id)
    ref.delete()
    return {"ok": True}


def _claim(ref) -> bool:
    """Atomically move an SOP into 'analyzing' so duplicate requests don't double-process."""
    transaction = db().transaction()

    @firestore.transactional
    def run(tx):
        snap = ref.get(transaction=tx)
        if snap.to_dict().get("status") not in ("uploaded", "error", "ready"):
            return False
        tx.update(ref, {"status": "analyzing", "statusMessage": "Starting Gemini…",
                        "updatedAt": firestore.SERVER_TIMESTAMP})
        return True

    return run(transaction)


# ------------------------------------------------------------------ cleaning

def _clean_sop(sop: dict) -> dict:
    steps = []
    for i, s in enumerate(sop.get("steps") or [], start=1):
        def num(v):
            try:
                return max(0.0, float(v))
            except (TypeError, ValueError):
                return None
        steps.append({
            "n": i,
            "title": str(s.get("title", f"Step {i}")),
            "instruction": str(s.get("instruction", "")),
            "start_seconds": num(s.get("start_seconds")),
            "end_seconds": num(s.get("end_seconds")),
            "tip": str(s.get("tip") or ""),
            "warning": str(s.get("warning") or ""),
        })
    ins = sop.get("insights") or {}
    try:
        minutes = int(sop.get("estimated_minutes") or 0)
    except (TypeError, ValueError):
        minutes = 0
    return {
        "title": str(sop.get("title") or "Untitled SOP"),
        "summary": str(sop.get("summary") or ""),
        "category": str(sop.get("category") or "Other"),
        "audience": str(sop.get("audience") or ""),
        "estimated_minutes": minutes,
        "tools": [str(t) for t in sop.get("tools") or []],
        "prerequisites": [str(t) for t in sop.get("prerequisites") or []],
        "steps": steps,
        "insights": {
            "efficiency_score": ins.get("efficiency_score"),
            "bottlenecks": [str(b) for b in ins.get("bottlenecks") or []],
            "automation_ideas": [
                {"idea": str(a.get("idea", "")),
                 "estimated_minutes_saved": a.get("estimated_minutes_saved") or 0,
                 "effort": str(a.get("effort", "Medium"))}
                for a in ins.get("automation_ideas") or [] if isinstance(a, dict)
            ],
        },
    }


def _clean_training(t: dict, sop: dict) -> dict:
    checklist = []
    for i, c in enumerate(t.get("checklist") or [], start=1):
        checklist.append({"id": f"c{i}", "text": str(c.get("text", "")), "step": c.get("step")})
    if not checklist:
        checklist = [{"id": f"c{s['n']}", "text": s["title"], "step": s["n"]} for s in sop["steps"]]
    quiz = []
    for q in t.get("quiz") or []:
        opts = [str(o) for o in q.get("options") or []][:4]
        try:
            ans = int(q.get("answer_index", 0))
        except (TypeError, ValueError):
            ans = 0
        if len(opts) >= 2 and 0 <= ans < len(opts):
            quiz.append({"question": str(q.get("question", "")), "options": opts,
                         "answer_index": ans, "explanation": str(q.get("explanation", ""))})
    return {"checklist": checklist, "quiz": quiz}


# ------------------------------------------------------------------ static SPA

@app.get("/config.js", include_in_schema=False)
def config_js():
    from fastapi.responses import Response
    import json
    return Response(f"window.SOP_CONFIG = {json.dumps(config())};", media_type="application/javascript")


@app.get("/{full_path:path}", include_in_schema=False)
def spa(full_path: str):
    if full_path.startswith("api/"):
        return JSONResponse({"detail": "Not found"}, status_code=404)
    f = (STATIC_DIR / full_path).resolve()
    if full_path and f.is_file() and STATIC_DIR.resolve() in f.parents:
        return FileResponse(f)
    return FileResponse(STATIC_DIR / "index.html")
