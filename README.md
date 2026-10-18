# SOP Studio: record a task once, onboard everyone forever

**Challenge:** Future of Work & Enterprise Productivity

Most company know-how lives in people's heads. When someone leaves or a new hire joins, the same processes get explained again and again, or they get done wrong. Writing documentation by hand is slow, so nobody does it.

**SOP Studio** turns a screen recording into a complete Standard Operating Procedure. You do the task once while recording, and Gemini watches the video and produces:

- 📋 **Step-by-step SOP** with exact clicks and fields. Every step has a **▶ timestamp** that plays just that moment of the video.
- ✅ **New-hire training**: a tracked checklist (progress saved per person) and a scenario-based quiz.
- 💬 **Ask this SOP**: teammates ask questions and get answers grounded only in the SOP, with links back to the relevant steps.
- ⚡ **Process insights**: an efficiency score, bottlenecks, and automation ideas with estimated minutes saved per run.
- 📚 A searchable **team library**, plus Markdown and PDF export.

No recording? You can **paste rough notes** or a messy Slack thread instead, and Gemini still produces the full SOP.

## Architecture

```
Browser (vanilla JS SPA)
  ├─ Firebase Auth ───────────── Google sign-in + anonymous guest mode
  ├─ Cloud Storage for Firebase ─ screen recordings (uploads/{uid}/…)
  ├─ Firestore (real-time) ──── SOPs, live pipeline status, Q&A, training progress
  └─ fetch /api/* ──────────────┐
                                ▼
                Cloud Run: FastAPI container
                  ├─ verifies Firebase ID tokens (Admin SDK)
                  ├─ Gemini on Vertex AI
                  │    1. video (gs://) → structured SOP JSON + insights
                  │    2. SOP → checklist + quiz
                  │    3. SOP + question → grounded answer
                  └─ writes results to Firestore → UI updates live
```

| Google technology | How it's used |
|---|---|
| **Gemini** | Multimodal video understanding of screen recordings (clicks, screens, narration) → SOP with timestamps; training generation; grounded Q&A; process-efficiency analysis. JSON-mode outputs with model fallback. |
| **Cloud Run** | Hosts the whole app (API + web UI) in one container. `min-instances=1`, 10-min request timeout for long videos, autoscaling to 5 instances. |
| **Firestore** | System of record for SOPs, Q&A history and per-user training progress. Real-time listeners stream pipeline status (Uploaded → Watching → Writing → Ready) to the browser. Security rules lock writes to the backend. |
| **Firebase** | Authentication (Google + anonymous), Cloud Storage for recordings, and security rules for Firestore and Storage. |

## Tech stack
Python 3.12 · FastAPI · google-genai SDK · firebase-admin · Firebase JS SDK v10 · MediaRecorder / Screen Capture API · Docker

## Project structure
```
main.py             FastAPI app: auth, pipeline, Q&A, health check, static hosting
gemini_service.py   All Gemini prompts and calls (model fallback)
demo_data.py        Sample process notes used to seed the demo library
setup_firebase.py   Automates Firebase setup (web app, rules, Auth, Storage link)
static/             index.html, app.js (SPA), style.css
firestore.rules     Firestore security rules
storage.rules       Storage security rules
Dockerfile          Cloud Run container
deploy.sh           One-command setup + deploy (APIs, Firebase, IAM, Cloud Run, demo data)
SETUP.md            Step-by-step deployment guide
```

## Deploy (one command)
In Google Cloud Shell:
```bash
bash deploy.sh YOUR_PROJECT_ID
```
This sets up Firestore, Storage, Firebase (web app, security rules, sign-in), IAM and Cloud Run, then runs an end-to-end Gemini health check and loads demo SOPs. Full guide: [SETUP.md](SETUP.md).

## Run locally (after deploying once)
```bash
pip install -r requirements.txt
gcloud auth application-default login
set -a && source .env && set +a
export FIREBASE_PROJECT_ID=$PROJECT_ID GOOGLE_CLOUD_PROJECT=$PROJECT_ID
uvicorn main:app --reload --port 8080
```

## Links
- **Live prototype:** _add Cloud Run URL_
- **Demo video:** _add link_
