#!/usr/bin/env bash
# SOP Studio: one-command setup + deploy (run in Google Cloud Shell).
#
#   bash deploy.sh YOUR_PROJECT_ID
#
# Sets up Firestore, Cloud Storage, Firebase (web app, rules, guest sign-in), IAM,
# deploys to Cloud Run, checks Gemini end to end and loads the demo SOPs.
# Safe to re-run: every step skips work that's already done.
set -euo pipefail
cd "$(dirname "$0")"
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

[ -f .env ] && { set -a; source .env; set +a; }
PROJECT_ID="${1:-${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}}"
if [ -z "$PROJECT_ID" ]; then echo "Usage: bash deploy.sh YOUR_PROJECT_ID"; exit 1; fi
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-sop-studio}"
BUCKET="${FIREBASE_STORAGE_BUCKET:-${PROJECT_ID}-sop-videos}"
GEMINI_LOCATION="${GEMINI_LOCATION:-global}"
GEMINI_MODELS="${GEMINI_MODELS:-gemini-3.5-flash,gemini-flash-latest,gemini-2.5-flash}"
SEED_KEY="${SEED_KEY:-$(python3 -c 'import secrets;print(secrets.token_urlsafe(24))')}"

step() { echo; echo "━━ $* ━━"; }
upsert_env() {  # upsert_env KEY VALUE  → keeps .env in sync so re-runs reuse values
  touch .env
  if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi
}

step "1/8  Project: $PROJECT_ID  (region $REGION)"
gcloud config set project "$PROJECT_ID" >/dev/null
if [ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null)" != "True" ]; then
  echo "✗ Billing is not enabled on $PROJECT_ID. Cloud Run and Gemini need it."
  echo "  Enable it at https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID and re-run."
  exit 1
fi
upsert_env PROJECT_ID "$PROJECT_ID"; upsert_env REGION "$REGION"; upsert_env SEED_KEY "$SEED_KEY"
upsert_env FIREBASE_STORAGE_BUCKET "$BUCKET"
upsert_env GEMINI_LOCATION "$GEMINI_LOCATION"; upsert_env GEMINI_MODELS "$GEMINI_MODELS"
echo "  ✓ Billing enabled"

step "2/8  Enabling Google Cloud APIs (first run takes 1–2 minutes)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  aiplatform.googleapis.com firestore.googleapis.com storage.googleapis.com iam.googleapis.com \
  firebase.googleapis.com firebasestorage.googleapis.com firebaserules.googleapis.com \
  identitytoolkit.googleapis.com cloudresourcemanager.googleapis.com
echo "  ✓ APIs enabled"

step "3/8  Firestore database + Cloud Storage bucket"
if gcloud firestore databases describe --database='(default)' >/dev/null 2>&1; then
  echo "  ✓ Firestore database already exists"
else
  gcloud firestore databases create --database='(default)' --location="$REGION" --type=firestore-native >/dev/null
  echo "  ✓ Created Firestore database in $REGION"
fi
if gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  echo "  ✓ Bucket gs://$BUCKET already exists"
else
  gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access >/dev/null
  echo "  ✓ Created bucket gs://$BUCKET"
fi

step "4/8  Firebase project, web app, security rules and sign-in"
set +e
python3 setup_firebase.py init "$PROJECT_ID" "$BUCKET"
RC=$?
set -e
if [ $RC -ne 0 ]; then
  echo "✗ Firebase setup needs the manual fix shown above. After that, re-run: bash deploy.sh $PROJECT_ID"
  exit 1
fi
set -a; source .env; set +a

step "5/8  Permissions for the Cloud Run service account"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for ROLE in roles/aiplatform.user roles/datastore.user roles/storage.objectAdmin \
            roles/run.builder roles/logging.logWriter roles/artifactregistry.writer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${RUN_SA}" \
    --role="$ROLE" --condition=None --quiet >/dev/null 2>&1 || echo "  (skipped $ROLE)"
done
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:${RUN_SA}" \
  --role=roles/storage.legacyBucketReader >/dev/null 2>&1 || true
# Lets Gemini read recordings straight from the bucket (gs:// URIs)
gcloud beta services identity create --service=aiplatform.googleapis.com --project="$PROJECT_ID" >/dev/null 2>&1 || true
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-aiplatform.iam.gserviceaccount.com" \
  --role=roles/storage.objectViewer >/dev/null 2>&1 || true
echo "  ✓ Roles granted"

step "6/8  Building and deploying to Cloud Run (3–5 minutes)"
ENV_VARS="^@^FIREBASE_PROJECT_ID=${PROJECT_ID}@GOOGLE_CLOUD_PROJECT=${PROJECT_ID}"
ENV_VARS+="@FIREBASE_API_KEY=${FIREBASE_API_KEY}@FIREBASE_AUTH_DOMAIN=${FIREBASE_AUTH_DOMAIN}"
ENV_VARS+="@FIREBASE_STORAGE_BUCKET=${BUCKET}@FIREBASE_MESSAGING_SENDER_ID=${FIREBASE_MESSAGING_SENDER_ID}"
ENV_VARS+="@FIREBASE_APP_ID=${FIREBASE_APP_ID}@GEMINI_LOCATION=${GEMINI_LOCATION}"
ENV_VARS+="@GEMINI_MODELS=${GEMINI_MODELS}@SEED_KEY=${SEED_KEY}"
if [ -n "${GEMINI_API_KEY:-}" ]; then ENV_VARS+="@GEMINI_API_KEY=${GEMINI_API_KEY}"; fi

gcloud run deploy "$SERVICE" --source . --region "$REGION" --quiet \
  --allow-unauthenticated --min-instances 1 --max-instances 5 \
  --memory 1Gi --cpu 1 --timeout 600 --concurrency 40 \
  --set-env-vars "$ENV_VARS"
URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
HOST="${URL#https://}"
upsert_env APP_URL "$URL"

step "7/8  Authorizing $HOST for sign-in"
python3 setup_firebase.py domain "$PROJECT_ID" "$HOST" || true

step "8/8  End-to-end check (Firestore + Storage + Gemini) and demo data"
HEALTH=$(curl -s -m 120 -H "X-Seed-Key: $SEED_KEY" "$URL/api/admin/health" || echo '{"ok":false,"error":"no response"}')
echo "  $HEALTH"
if echo "$HEALTH" | grep -q '"ok":true'; then
  echo "  Loading 3 demo SOPs through Gemini (about 1–2 minutes)…"
  curl -s -m 540 -X POST -H "X-Seed-Key: $SEED_KEY" "$URL/api/admin/seed" || echo "  (seed request timed out; check the library in a minute)"
  echo
  RESULT="✅ All checks passed."
else
  RESULT="⚠ Deployed, but the health check failed. See the message above and SETUP.md → Troubleshooting."
fi

cat <<EOF

══════════════════════════════════════════════════════════════
 $RESULT
 Live app:  $URL
 Open it in an incognito window → "Try it as a guest".
 Logs:      gcloud run services logs read $SERVICE --region $REGION --limit 50
══════════════════════════════════════════════════════════════
EOF
