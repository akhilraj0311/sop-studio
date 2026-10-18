"""Gemini calls for SOP Studio.

Three jobs:
  1. analyze_source()   – watch a screen recording (or read rough notes) and write a structured SOP
  2. build_training()   – turn the SOP into a new-hire checklist + quiz
  3. answer_question()  – answer questions grounded in one SOP

Runs on Vertex AI by default (no API key needed on Cloud Run — it uses the service account).
Set GEMINI_API_KEY to use the Gemini Developer API instead.
"""
from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import time

from google import genai
from google.genai import types

log = logging.getLogger("sop-studio.gemini")

PROJECT = os.getenv("GOOGLE_CLOUD_PROJECT") or os.getenv("FIREBASE_PROJECT_ID")
LOCATION = os.getenv("GEMINI_LOCATION", "global")
API_KEY = os.getenv("GEMINI_API_KEY")

# First model that works is used (and remembered); later ones are fallbacks if a name
# isn't available in the project/region or has been retired.
MODELS = [m.strip() for m in os.getenv(
    "GEMINI_MODELS", "gemini-flash-latest,gemini-3.8-flash").split(",") if m.strip()]

INLINE_LIMIT = 18 * 1024 * 1024  # inline video bytes limit (request max is ~20MB)

_client = None


def client() -> genai.Client:
    global _client
    if _client is None:
        if API_KEY:
            _client = genai.Client(api_key=API_KEY)
        else:
            _client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    return _client


def using_vertex() -> bool:
    return not API_KEY


# ---------------------------------------------------------------- helpers

def _parse_json(text: str) -> dict:
    text = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            return json.loads(text[start:end + 1])
        raise


def _generate(contents, system: str, temperature: float = 0.2) -> tuple[dict, str]:
    """Call Gemini, return (parsed_json, model_used). Tries fallback models."""
    last_err = None
    for model in list(MODELS):
        for attempt in range(2):
            try:
                resp = client().models.generate_content(
                    model=model,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        system_instruction=system,
                        temperature=temperature,
                        response_mime_type="application/json",
                    ),
                )
                result = _parse_json(resp.text)
                _remember(model)
                return result, model
            except Exception as e:  # noqa: BLE001
                last_err = e
                msg = str(e)
                log.warning("Gemini call failed (model=%s attempt=%s): %s", model, attempt, msg[:300])
                if "404" in msg or "NOT_FOUND" in msg:
                    break  # model name not available → next model
                time.sleep(2 + attempt * 3)
    raise RuntimeError(f"Gemini request failed: {last_err}")


def _remember(model: str) -> None:
    """Move a model that worked to the front so later calls skip dead names."""
    if MODELS and MODELS[0] != model and model in MODELS:
        MODELS.remove(model)
        MODELS.insert(0, model)


def ping() -> str:
    """Tiny call used by the deploy health check. Returns the model that answered."""
    _, model = _generate(['Return {"ok": true}'], "Respond with JSON only.", temperature=0)
    return model


# ---------------------------------------------------------------- prompts

SOP_SYSTEM = """You are a senior technical writer and process-improvement consultant.
You turn screen recordings or rough notes of a work task into a clear, accurate
Standard Operating Procedure (SOP) that a brand-new employee could follow alone.
Only describe what is actually shown or stated. Never invent UI elements, URLs or data.
Write instructions in the imperative ("Click Save", "Open the Billing tab").
Always respond with a single JSON object and nothing else."""

SOP_SCHEMA = """Return JSON with exactly this shape:
{
  "title": "short action-oriented title, e.g. 'Issue a customer refund in Stripe'",
  "summary": "2-3 sentence overview: what the process achieves and when to use it",
  "category": "one of: Finance, Sales, Support, HR, Engineering, Operations, Marketing, IT, Other",
  "audience": "who should use this SOP",
  "estimated_minutes": integer,
  "tools": ["apps / websites / systems used"],
  "prerequisites": ["access, data or permissions needed before starting"],
  "steps": [
    {
      "n": 1,
      "title": "short step title",
      "instruction": "precise instruction, mention exact buttons/fields seen",
      "start_seconds": number or null,
      "end_seconds": number or null,
      "tip": "optional helpful tip or empty string",
      "warning": "optional risk / common mistake or empty string"
    }
  ],
  "insights": {
    "efficiency_score": integer 1-10 (10 = already very efficient),
    "bottlenecks": ["slow, repetitive or error-prone parts of the process"],
    "automation_ideas": [
      {"idea": "concrete automation or simplification", "estimated_minutes_saved": integer, "effort": "Low|Medium|High"}
    ]
  }
}"""


def analyze_source(*, gs_uri: str | None = None, video_bytes_loader=None, mime_type: str = "video/webm",
                   notes: str | None = None, context: str = "") -> tuple[dict, str]:
    """Produce the SOP JSON from a video (Cloud Storage URI) or from typed notes."""
    extra = f"\nContext from the author: {context.strip()}" if context and context.strip() else ""

    if notes:
        prompt = ("Below are rough notes describing how a work task is done. "
                  "Turn them into a complete SOP. Set start_seconds and end_seconds to null."
                  f"{extra}\n\n{SOP_SCHEMA}\n\nNOTES:\n{notes}")
        return _generate([prompt], SOP_SYSTEM)

    prompt = ("Watch this screen recording of someone performing a work task. "
              "Break it into clear sequential steps. For every step give start_seconds and "
              "end_seconds (seconds from the start of the video) where it happens. "
              "If the person narrates, use the narration as extra context."
              f"{extra}\n\n{SOP_SCHEMA}")

    video_part = None
    if using_vertex() and gs_uri:
        video_part = types.Part.from_uri(file_uri=gs_uri, mime_type=mime_type)
        try:
            return _generate([video_part, prompt], SOP_SYSTEM)
        except RuntimeError as e:
            log.warning("gs:// read failed, falling back to inline bytes: %s", e)

    data = video_bytes_loader()
    if len(data) <= INLINE_LIMIT:
        video_part = types.Part.from_bytes(data=data, mime_type=mime_type)
    elif not using_vertex():
        video_part = _upload_via_files_api(data, mime_type)
    else:
        raise RuntimeError("Video too large to process. Please keep recordings under ~3 minutes.")
    return _generate([video_part, prompt], SOP_SYSTEM)


def _upload_via_files_api(data: bytes, mime_type: str):
    suffix = ".webm" if "webm" in mime_type else ".mp4"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(data)
        path = f.name
    up = client().files.upload(file=path, config={"mime_type": mime_type})
    for _ in range(60):
        state = getattr(up.state, "name", str(up.state))
        if state == "ACTIVE":
            break
        if state == "FAILED":
            raise RuntimeError("Gemini could not process the video file.")
        time.sleep(2)
        up = client().files.get(name=up.name)
    os.unlink(path)
    return up


TRAINING_SYSTEM = """You are an onboarding specialist. You create practical training
material for new employees from an SOP. Respond with a single JSON object only."""


def build_training(sop: dict) -> tuple[dict, str]:
    prompt = f"""Create training material for a new hire learning this SOP.

Return JSON:
{{
  "checklist": [{{"id": "c1", "text": "verifiable action the new hire ticks off", "step": step number}}],
  "quiz": [
    {{"question": "scenario-style question", "options": ["A","B","C","D"],
      "answer_index": 0-3, "explanation": "why the answer is right"}}
  ]
}}
Rules: one checklist item per SOP step (ids c1, c2, ...); exactly 4 quiz questions that test
understanding of order, warnings and judgement (not trivia); vary the correct answer position.

SOP:
{json.dumps(sop, ensure_ascii=False)}"""
    return _generate([prompt], TRAINING_SYSTEM, temperature=0.4)


QA_SYSTEM = """You are a helpful teammate answering questions about a company SOP.
Answer ONLY from the SOP provided. If the SOP does not cover the question, say so plainly
and suggest who or what to check. Be concise (max ~120 words). Respond with JSON only."""


def answer_question(sop: dict, question: str, history: list[dict] | None = None) -> tuple[dict, str]:
    hist = ""
    if history:
        hist = "\nEarlier Q&A:\n" + "\n".join(f"Q: {h['question']}\nA: {h['answer']}" for h in history[-4:])
    prompt = f"""SOP:
{json.dumps(sop, ensure_ascii=False)}
{hist}

Question: {question}

Return JSON: {{"answer": "markdown-free plain text answer", "step_refs": [step numbers used], "covered": true|false}}"""
    return _generate([prompt], QA_SYSTEM, temperature=0.3)
