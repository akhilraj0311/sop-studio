# Deploy SOP Studio (about 15 minutes, one command)

Everything runs in **Google Cloud Shell**, a free browser terminal that's already logged in as you, with `gcloud` preinstalled.

## Before you start
- A Google Cloud project **with billing enabled** (Cloud Run and Gemini need it). If you need one, create it at <https://console.cloud.google.com/projectcreate>, then link billing at <https://console.cloud.google.com/billing>.
- Note the **project ID** (not the name). It's shown on the console home page.

## Steps
1. Open <https://shell.cloud.google.com>.
2. Upload `sop-studio.zip`: in the terminal's **⋮ (More) menu → Upload**, choose the file.
3. Run:
   ```bash
   unzip -o sop-studio.zip && cd sop-studio
   bash deploy.sh YOUR_PROJECT_ID
   ```
   If Cloud Shell asks to **Authorize**, click it.
4. Wait about 10 minutes. The script prints each step with a ✓ and finishes with your **Live app** URL.

The script handles all of this automatically:
| Step | What it sets up |
|---|---|
| 1 | Checks billing, saves settings to `.env` |
| 2 | Enables Cloud Run, Vertex AI (Gemini), Firestore, Storage, Firebase and Auth APIs |
| 3 | Firestore database and Cloud Storage bucket in `asia-south1` (Mumbai) |
| 4 | Adds Firebase to the project, creates the web app, links Storage, publishes `firestore.rules` and `storage.rules`, enables **guest sign-in** |
| 5 | Grants the Cloud Run service account access to Gemini, Firestore and Storage |
| 6 | Builds the container and deploys to Cloud Run (`min-instances=1`, so no cold starts) |
| 7 | Authorizes the Cloud Run domain for sign-in |
| 8 | End-to-end health check (Firestore + Storage + Gemini) and loads **3 demo SOPs** through Gemini |

## One optional click: Google sign-in
Guest mode works without this. To also allow "Sign in with Google", go to Firebase console → **Authentication → Sign-in method → Google → Enable → Save**. The script prints the direct link.

## Smoke test (incognito window)
- [ ] The app loads, and **Try it as a guest** opens a library with 3 demo SOPs.
- [ ] A demo SOP has steps, a Training tab (checklist + quiz), Ask this SOP, and Insights.
- [ ] **+ New SOP → Paste notes → Generate**: the pipeline animates and the SOP appears in about 30 seconds.
- [ ] **+ New SOP → Record screen**: record a 30–60 second task. The SOP appears with ▶ buttons that play each step.
- [ ] Ticked checklist items stay ticked after a refresh.

## Before submitting
- Record 1–2 real processes with narration, so the library shows video-based SOPs as well.
- Don't redeploy during the judging window.
- Set a budget alert: Billing → Budgets & alerts.
- Re-running `bash deploy.sh YOUR_PROJECT_ID` is safe. It reuses everything already set up.

## Troubleshooting
| Symptom | Fix |
|---|---|
| Step 1: "Billing is not enabled" | Link a billing account to the project and re-run. |
| Step 4: "Could not add Firebase automatically" | Open <https://console.firebase.google.com> → **Add project** → choose your existing GCP project → accept the terms → re-run. (First-time Firebase users must accept the terms once in the console.) |
| Any other ⚠ in step 4 | Do the printed "Manual fix" in the Firebase console. Deployment continues regardless. |
| Health check: `gemini: error … 404` / not found | No model in the list exists in your project. Check Vertex AI → Model Garden for an available Flash model, put `GEMINI_MODELS=<model-id>` in `.env`, and re-run. |
| Health check: `gemini: error … 403` / permission | Wait 2 minutes (IAM propagation) and re-run. |
| Health check: `firestore: error` | Confirm the database exists: Firestore page in the console. Re-run. |
| `auth/unauthorized-domain` on Google sign-in | Firebase console → Authentication → Settings → Authorized domains → add the Cloud Run host. |
| Video SOP fails but notes SOPs work | Keep recordings under 3 minutes. Check logs: `gcloud run services logs read sop-studio --region asia-south1 --limit 50` |
