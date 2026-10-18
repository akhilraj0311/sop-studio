#!/usr/bin/env python3
"""Publish ./static to Firebase Hosting with the Hosting REST API and your gcloud login.

  python3 deploy_hosting.py PROJECT_ID

Used by deploy_free.sh so no separate `firebase login` is needed. Standard library only.
"""
import gzip
import hashlib
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

API = "https://firebasehosting.googleapis.com/v1beta1"
ROOT = Path(__file__).parent / "static"
PROJECT = sys.argv[1] if len(sys.argv) > 1 else ""
TOKEN = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()


def call(method, url, body=None, raw=None, ctype="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("x-goog-user-project", PROJECT)
    if data is not None:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            t = r.read().decode()
            return json.loads(t) if t.strip() else {}
    except urllib.error.HTTPError as e:
        raise SystemExit(f"✗ {method} {url.split('?')[0]} → HTTP {e.code}: {e.read().decode()[:500]}")


def site_id():
    sites = call("GET", f"{API}/projects/{PROJECT}/sites").get("sites", [])
    default = next((s for s in sites if s.get("type") == "DEFAULT_SITE"), sites[0] if sites else None)
    if default:
        return default["name"].split("/")[-1]
    return call("POST", f"{API}/projects/{PROJECT}/sites?siteId={PROJECT}", {})["name"].split("/")[-1]


def main():
    if not PROJECT:
        raise SystemExit(__doc__)
    site = site_id()
    print(f"  site: {site}")
    version = call("POST", f"{API}/sites/{site}/versions", {"config": {
        "cleanUrls": True,
        "rewrites": [{"glob": "**", "path": "/index.html"}],
        "headers": [{"glob": "**/*.@(js|css)", "headers": {"Cache-Control": "no-cache"}}],
    }})["name"]

    files, blobs = {}, {}
    for f in sorted(ROOT.rglob("*")):
        if f.is_file():
            gz = gzip.compress(f.read_bytes(), mtime=0)
            h = hashlib.sha256(gz).hexdigest()
            files["/" + f.relative_to(ROOT).as_posix()] = h
            blobs[h] = gz
    pop = call("POST", f"{API}/{version}:populateFiles", {"files": files})
    for h in pop.get("uploadRequiredHashes", []):
        call("POST", f"{pop['uploadUrl']}/{h}", raw=blobs[h], ctype="application/octet-stream")
    print(f"  uploaded {len(pop.get('uploadRequiredHashes', []))} of {len(files)} files")

    call("PATCH", f"{API}/{version}?update_mask=status", {"status": "FINALIZED"})
    call("POST", f"{API}/sites/{site}/releases?versionName={version}", {})
    print(f"  ✓ Released: https://{site}.web.app")


if __name__ == "__main__":
    main()
