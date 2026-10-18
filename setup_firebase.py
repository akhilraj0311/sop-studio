#!/usr/bin/env python3
"""Automates the Firebase console steps for SOP Studio (called by deploy.sh).

  python3 setup_firebase.py init   PROJECT_ID BUCKET|-  → Firebase project, web app, Storage link,
                                                        security rules, Auth (+ guest sign-in), writes .env
  python3 setup_firebase.py domain PROJECT_ID HOST     → adds the Cloud Run host to Auth authorized domains

Uses only the Python standard library and your `gcloud` login. Every step is idempotent, and
any step that fails prints the manual console fix instead of stopping the whole setup.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
ENV_FILE = HERE / ".env"
FB = "https://firebase.googleapis.com/v1beta1"
RULES = "https://firebaserules.googleapis.com/v1"
IDT = "https://identitytoolkit.googleapis.com"
FBS = "https://firebasestorage.googleapis.com/v1beta"

PROJECT = ""
_TOKEN = ""
WARNINGS: list[str] = []


class ApiError(Exception):
    def __init__(self, code: int, body: str):
        super().__init__(f"HTTP {code}: {body}")
        self.code, self.body = code, body


def ok(msg): print(f"  ✓ {msg}")
def warn(msg, fix):
    print(f"  ⚠ {msg}\n    → Manual fix: {fix}")
    WARNINGS.append(fix)


def token() -> str:
    global _TOKEN
    if not _TOKEN:
        _TOKEN = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()
    return _TOKEN


def call(method: str, url: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token()}")
    req.add_header("Content-Type", "application/json")
    req.add_header("x-goog-user-project", PROJECT)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            txt = r.read().decode()
            return json.loads(txt) if txt.strip() else {}
    except urllib.error.HTTPError as e:
        raise ApiError(e.code, e.read().decode(errors="replace")[:700]) from None


def wait_op(op: dict, base: str = FB, label: str = "operation") -> dict:
    if not op.get("name") or op.get("done"):
        if op.get("error"):
            raise RuntimeError(f"{label} failed: {op['error']}")
        return op.get("response", {})
    for _ in range(60):
        cur = call("GET", f"{base}/{op['name']}")
        if cur.get("done"):
            if cur.get("error"):
                raise RuntimeError(f"{label} failed: {cur['error']}")
            return cur.get("response", {})
        time.sleep(3)
    raise RuntimeError(f"{label} timed out")


# ------------------------------------------------------------------ steps

def add_firebase() -> bool:
    try:
        wait_op(call("POST", f"{FB}/projects/{PROJECT}:addFirebase", {}), label="addFirebase")
        ok("Firebase added to the project")
    except ApiError as e:
        if e.code == 409 or "ALREADY_EXISTS" in e.body:
            ok("Firebase already enabled on the project")
        else:
            warn(f"Could not add Firebase automatically ({e.code})",
                 f"Open https://console.firebase.google.com → Add project → pick '{PROJECT}', then re-run deploy.sh")
            return False
    except RuntimeError as e:
        warn(str(e), f"Open https://console.firebase.google.com → Add project → pick '{PROJECT}', then re-run deploy.sh")
        return False
    return True


def web_app_config() -> dict | None:
    try:
        apps = call("GET", f"{FB}/projects/{PROJECT}/webApps").get("apps", [])
        app = next((a for a in apps if a.get("displayName") == "SOP Studio" and a.get("state", "ACTIVE") == "ACTIVE"), None)
        if app:
            app_id = app["appId"]
            ok("Using existing 'SOP Studio' web app")
        else:
            res = wait_op(call("POST", f"{FB}/projects/{PROJECT}/webApps", {"displayName": "SOP Studio"}),
                          label="create web app")
            app_id = res.get("appId")
            if not app_id:  # fall back to listing
                apps = call("GET", f"{FB}/projects/{PROJECT}/webApps").get("apps", [])
                app_id = next(a["appId"] for a in apps if a.get("displayName") == "SOP Studio")
            ok("Created 'SOP Studio' web app")
        cfg = {}
        for _ in range(10):  # the API key can take a few seconds to appear on a brand-new app
            cfg = call("GET", f"{FB}/projects/-/webApps/{app_id}/config")
            if cfg.get("apiKey"):
                break
            time.sleep(3)
        if not cfg.get("apiKey"):
            raise RuntimeError("web app config has no apiKey yet")
        return cfg
    except (ApiError, RuntimeError, StopIteration) as e:
        warn(f"Could not create/read the web app: {e}",
             "Firebase console → Project settings → Your apps → Add app (</> Web), then copy the config values into .env and re-run")
        return None


def link_bucket(bucket: str):
    try:
        call("POST", f"{FBS}/projects/{PROJECT}/buckets/{bucket}:addFirebase", {})
        ok(f"Linked gs://{bucket} to Firebase Storage")
    except ApiError as e:
        if e.code == 409 or "ALREADY_EXISTS" in e.body:
            ok(f"gs://{bucket} already linked to Firebase Storage")
        else:
            warn(f"Could not link the Storage bucket ({e.code}): {e.body[:200]}",
                 f"Firebase console → Storage → bucket menu → Import existing bucket → gs://{bucket}")


def release_rules(release: str, filename: str):
    content = (HERE / filename).read_text()
    try:
        rs = call("POST", f"{RULES}/projects/{PROJECT}/rulesets",
                  {"source": {"files": [{"name": filename, "content": content}]}})
        body = {"name": f"projects/{PROJECT}/releases/{release}", "rulesetName": rs["name"]}
        try:
            call("POST", f"{RULES}/projects/{PROJECT}/releases", body)
        except ApiError as e:
            if e.code != 409 and "ALREADY_EXISTS" not in e.body:
                raise
            call("PATCH", f"{RULES}/projects/{PROJECT}/releases/{release}", {"release": body})
        ok(f"Published {filename}")
    except ApiError as e:
        page = "Firestore → Rules" if filename.startswith("firestore") else "Storage → Rules"
        warn(f"Could not publish {filename} ({e.code}): {e.body[:200]}",
             f"Firebase console → {page}: paste the contents of {filename} and click Publish")


def auth_config() -> dict | None:
    url = f"{IDT}/admin/v2/projects/{PROJECT}/config"
    try:
        return call("GET", url)
    except ApiError:
        pass
    try:  # first-time Auth setup (same as clicking "Get started" in the console)
        call("POST", f"{IDT}/v2/projects/{PROJECT}/identityPlatform:initializeAuth", {})
        time.sleep(3)
        return call("GET", url)
    except ApiError as e:
        warn(f"Could not initialise Firebase Authentication ({e.code}): {e.body[:200]}",
             "Firebase console → Authentication → Get started, then re-run deploy.sh")
        return None


def setup_auth(extra_domains: list[str] | None = None, enable_guest: bool = True):
    cfg = auth_config()
    if cfg is None:
        return
    domains = list(dict.fromkeys((cfg.get("authorizedDomains") or []) +
                                 [f"{PROJECT}.firebaseapp.com", f"{PROJECT}.web.app", "localhost"] +
                                 (extra_domains or [])))
    body = {"authorizedDomains": domains}
    mask = ["authorizedDomains"]
    if enable_guest:
        body["signIn"] = {"anonymous": {"enabled": True}}
        mask.append("signIn.anonymous.enabled")
    try:
        call("PATCH", f"{IDT}/admin/v2/projects/{PROJECT}/config?updateMask={','.join(mask)}", body)
        if enable_guest:
            ok("Enabled guest (anonymous) sign-in")
        if extra_domains:
            ok(f"Authorized sign-in domain: {', '.join(extra_domains)}")
    except ApiError as e:
        fix = ("Firebase console → Authentication → Sign-in method → enable Anonymous"
               if enable_guest else
               f"Firebase console → Authentication → Settings → Authorized domains → add {', '.join(extra_domains or [])}")
        warn(f"Could not update Auth settings ({e.code}): {e.body[:200]}", fix)

    if enable_guest:
        try:
            g = call("GET", f"{IDT}/admin/v2/projects/{PROJECT}/defaultSupportedIdpConfigs/google.com")
            google_on = bool(g.get("enabled"))
        except ApiError:
            google_on = False
        if google_on:
            ok("Google sign-in already enabled")
        else:
            print("  ℹ Google sign-in isn't enabled yet (optional, guest mode works without it).\n"
                  f"    → Firebase console → Authentication → Sign-in method → Google → Enable → Save\n"
                  f"      https://console.firebase.google.com/project/{PROJECT}/authentication/providers")


def write_env(values: dict):
    lines = ENV_FILE.read_text().splitlines() if ENV_FILE.exists() else []
    seen = set()
    out = []
    for line in lines:
        key = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else None
        if key in values:
            out.append(f"{key}={values[key]}")
            seen.add(key)
        else:
            out.append(line)
    out += [f"{k}={v}" for k, v in values.items() if k not in seen]
    ENV_FILE.write_text("\n".join(out) + "\n")


# ------------------------------------------------------------------ entry points

def cmd_init(bucket: str) -> int:
    print("▶ Setting up Firebase")
    if not add_firebase():
        return 2
    cfg = web_app_config()
    release_rules("cloud.firestore", "firestore.rules")
    if bucket != "-":  # "-" = free Spark plan: no Cloud Storage bucket
        link_bucket(bucket)
        release_rules(f"firebase.storage/{bucket}", "storage.rules")
    setup_auth()
    if cfg:
        write_env({
            "FIREBASE_API_KEY": cfg.get("apiKey", ""),
            "FIREBASE_AUTH_DOMAIN": cfg.get("authDomain") or f"{PROJECT}.firebaseapp.com",
            "FIREBASE_STORAGE_BUCKET": bucket if bucket != "-" else "",
            "FIREBASE_MESSAGING_SENDER_ID": cfg.get("messagingSenderId", ""),
            "FIREBASE_APP_ID": cfg.get("appId", ""),
        })
        ok("Saved the web app config to .env")
    if WARNINGS:
        print(f"\n  {len(WARNINGS)} step(s) need a manual fix (listed above). Deployment will continue.")
    return 0 if cfg else 3


def cmd_domain(host: str) -> int:
    print("▶ Authorizing the Cloud Run domain for sign-in")
    setup_auth(extra_domains=[host], enable_guest=False)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] not in ("init", "domain"):
        print(__doc__)
        sys.exit(1)
    PROJECT = sys.argv[2]
    sys.exit(cmd_init(sys.argv[3]) if sys.argv[1] == "init" else cmd_domain(sys.argv[3]))
