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
Browser (vanilla JS SPA, served by Firebase Hosting)
  ├─ Firebase Auth ───────────── Google sign-in + anonymous guest mode
  ├─ Firestore (real-time) ──── SOPs, live pipeline status, Q&A, training progress
  ├─ Firebase AI Logic → Gemini  video/notes → SOP, training, grounded Q&A
  └─ IndexedDB ───────────────── recordings stay on the recorder's device (step playback)

Optional production backend (needs a billing account): Cloud Run (FastAPI, main.py)
  └─ same app + server-side Gemini on Vertex AI, recordings in Cloud Storage
```

| Google technology | How it's used |
|---|---|
| **Gemini** | Multimodal understanding of screen recordings (clicks, screens, narration) → SOP with per-step timestamps; new-hire checklist and quiz; Q&A grounded only in the SOP; process-efficiency analysis. JSON outputs with automatic model fallback. Called through **Firebase AI Logic** (Gemini Developer API). |
| **Firestore** | System of record for SOPs, Q&A history and per-user training progress. Real-time listeners stream the pipeline status (Saved → Gemini watching → Writing training → Ready) to every open browser. Security rules: creators own their SOPs, teammates can read and ask. |
| **Firebase** | Hosting (live app at `*.web.app`), Authentication (Google + anonymous guest mode), AI Logic (Gemini access without exposing keys), security rules. |
| **Cloud Run** | Production backend in this repo (`main.py`, `Dockerfile`, `deploy.sh`): server-side Gemini on Vertex AI, Cloud Storage for recordings, `min-instances=1`. Deployable with one command once billing is enabled. The live demo runs on the free Firebase tier. |

## Tech stack
Python 3.12 · FastAPI · google-genai SDK · firebase-admin · Firebase JS SDK v10 · MediaRecorder / Screen Capture API · Docker

## Project structure
```
static/ai.js        Gemini prompts via Firebase AI Logic (browser)
deploy_free.sh      One-command free deploy (Firebase Hosting + Firestore + Auth + AI Logic)
main.py             Cloud Run backend (FastAPI): auth, pipeline, Q&A, health check, static hosting
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
Free (Firebase Spark plan, no billing account), in Google Cloud Shell:
```bash
bash deploy_free.sh YOUR_PROJECT_ID
```
With billing enabled, the Cloud Run version: `bash deploy.sh YOUR_PROJECT_ID`. Full guide: [SETUP.md](SETUP.md).

## Run locally (after deploying once)
```bash
pip install -r requirements.txt
gcloud auth application-default login
set -a && source .env && set +a
export FIREBASE_PROJECT_ID=$PROJECT_ID GOOGLE_CLOUD_PROJECT=$PROJECT_ID
uvicorn main:app --reload --port 8080
```

## Links
- **Live prototype:** https://ai-builder-512016.web.app (Firebase Hosting, free tier)
- **Demo video:** _coming soon_
