// SOP Studio — single-page app (no build step).
// Firebase Auth + Firestore (real-time) + Gemini via Firebase AI Logic, all from the browser.
// Runs on Firebase Hosting (free Spark plan). The optional Cloud Run backend (main.py) serves the same app.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signInAnonymously, signOut,
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, getDoc, getDocs, updateDoc, addDoc, deleteDoc,
  onSnapshot, query, orderBy, limit, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
import { initAI, analyzeNotes, analyzeVideo, buildTraining, answerQuestion, blobToBase64 } from "./ai.js";
import { DEMO_SOPS } from "./demo.js";

// ------------------------------------------------------------------ boot
const $app = document.getElementById("app");
const cfg = window.SOP_CONFIG || await fetch("/api/config").then((r) => r.json());
const fbApp = initializeApp(cfg);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
initAI(fbApp);
const MAX_VIDEO_BYTES = 14 * 1024 * 1024; // sent inline to Gemini (request limit ~20 MB after base64)

// Recordings stay on the recorder's device (IndexedDB) for step playback; only the SOP goes to Firestore.
const videoStore = {
  _db: null,
  async open() {
    if (this._db) return this._db;
    this._db = await new Promise((res, rej) => {
      const r = indexedDB.open("sop-studio", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("videos");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this._db;
  },
  async put(id, blob) { try { const d = await this.open(); await new Promise((res, rej) => { const t = d.transaction("videos", "readwrite"); t.objectStore("videos").put(blob, id); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch (e) { console.warn("video save failed", e); } },
  async get(id) { try { const d = await this.open(); return await new Promise((res) => { const r = d.transaction("videos").objectStore("videos").get(id); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); }); } catch { return null; } },
  async del(id) { try { const d = await this.open(); d.transaction("videos", "readwrite").objectStore("videos").delete(id); } catch {} },
};

// The Gemini pipeline: source → SOP → training, streaming status through Firestore.
const running = new Set();
async function runPipeline(id, data, blob = null) {
  if (running.has(id)) return;
  running.add(id);
  const ref = doc(db, "sops", id);
  const status = (status, statusMessage, extra = {}) => updateDoc(ref, { status, statusMessage, updatedAt: serverTimestamp(), ...extra });
  try {
    let result;
    if (data.sourceType === "notes") {
      await status("analyzing", "Gemini is reading your notes…");
      result = await analyzeNotes(data.notes, data.context);
    } else {
      blob = blob || await videoStore.get(id);
      if (!blob) throw new Error("The recording is only stored on the device that made it. Open this SOP there to retry.");
      await status("analyzing", "Gemini is watching your recording…");
      result = await analyzeVideo(await blobToBase64(blob), (data.videoMime || blob.type || "video/webm").split(";")[0], data.context);
    }
    const { sop, model } = result;
    await status("training", "Writing the checklist and quiz…", { sop, title: sop.title, category: sop.category, model });
    const training = await buildTraining(sop);
    await status("ready", "Ready", { training });
  } catch (e) {
    console.error(e);
    await status("error", String(e.message || e).slice(0, 300)).catch(() => {});
  } finally { running.delete(id); }
}

async function seedDemo(btn) {
  btn.disabled = true;
  for (const [i, d] of DEMO_SOPS.entries()) {
    btn.textContent = `Creating demo ${i + 1} of ${DEMO_SOPS.length}…`;
    const id = `${d.id}-${user.uid.slice(0, 6)}`;
    const data = {
      ownerUid: user.uid, ownerName: d.owner, title: d.title, context: d.context, sourceType: "notes", notes: d.notes,
      status: "uploaded", statusMessage: "Queued", createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    };
    await setDoc(doc(db, "sops", id), data);
    await runPipeline(id, data);
  }
  btn.textContent = "Demo SOPs ready";
}

let user = null;
let unsubs = [];
let cleanupFns = [];
const MAX_RECORD_SECONDS = 180;

function resetView() {
  unsubs.forEach((u) => { try { u(); } catch {} });
  cleanupFns.forEach((f) => { try { f(); } catch {} });
  unsubs = []; cleanupFns = [];
}

onAuthStateChanged(auth, (u) => {
  user = u;
  const nav = document.getElementById("nav");
  nav.hidden = !u;
  if (u) document.getElementById("userChip").textContent = displayName(u);
  route();
});
document.getElementById("signOutBtn").onclick = () => signOut(auth).then(() => (location.hash = "#/"));
window.addEventListener("hashchange", route);

function displayName(u) {
  return u.isAnonymous ? "Guest" : (u.displayName || u.email || "You");
}

function route() {
  resetView();
  const hash = location.hash || "#/";
  if (!user) return renderLanding();
  const m = hash.match(/^#\/sop\/([\w-]+)/);
  if (m) return renderSop(m[1]);
  if (hash.startsWith("#/new")) return renderNew();
  return renderLibrary();
}

// ------------------------------------------------------------------ utils
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (s) => (s == null ? "" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`);
function timeAgo(ts) {
  if (!ts?.toDate) return "just now";
  const sec = (Date.now() - ts.toDate().getTime()) / 1000;
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
function toast(msg, kind = "") {
  const t = document.getElementById("toast");
  t.textContent = msg; t.className = `toast ${kind}`; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 4000);
}
const newId = () => doc(collection(db, "sops")).id;

// ------------------------------------------------------------------ landing
function renderLanding() {
  $app.innerHTML = `
  <section class="hero">
    <div class="hero-copy">
      <p class="eyebrow">Gemini · Firebase · Firestore</p>
      <h1>Record a task once.<br/><em>Onboard everyone forever.</em></h1>
      <p class="lede">Record your screen while you do a work task. SOP Studio's Gemini pipeline watches it and writes a step-by-step SOP with clickable video moments. It also builds a new-hire checklist and quiz, and points out where the process could be automated.</p>
      <div class="hero-cta">
        <button id="googleBtn" class="btn btn-primary btn-lg">Sign in with Google</button>
        <button id="guestBtn" class="btn btn-ghost btn-lg">Try it as a guest →</button>
      </div>
      <p class="fine">Guest mode needs no account. It's ideal for a quick look.</p>
    </div>
    <div class="hero-card" aria-hidden="true">
      <div class="mock-video"><span class="rec">● REC 01:42</span></div>
      <ol class="mock-steps">
        <li><b>1</b> Open the Billing tab <span>0:04</span></li>
        <li><b>2</b> Search the customer by email <span>0:11</span></li>
        <li class="on"><b>3</b> Click “Refund” and choose amount <span>0:27</span></li>
        <li><b>4</b> Add the reason code <span>0:48</span></li>
      </ol>
      <div class="mock-insight">⚡ Automation idea: pre-fill reason codes. Saves ~3 min per refund</div>
    </div>
  </section>
  <section class="features">
    <div><h3>🎥 Watch → write</h3><p>Gemini understands the video, including clicks, screens and narration, and writes exact instructions.</p></div>
    <div><h3>✅ Train new hires</h3><p>Every SOP gets a tracked checklist and a scenario quiz automatically.</p></div>
    <div><h3>💬 Ask the SOP</h3><p>Teammates ask questions and get answers grounded in the steps, with links back to the right moment.</p></div>
    <div><h3>⚡ Find the waste</h3><p>Each process gets an efficiency score, a list of bottlenecks, and automation ideas with time saved.</p></div>
  </section>`;
  document.getElementById("googleBtn").onclick = () =>
    signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => toast(`Sign-in failed: ${e.code || e.message}. Try guest mode.`, "err"));
  document.getElementById("guestBtn").onclick = () =>
    signInAnonymously(auth).catch((e) => toast(`Guest sign-in failed: ${e.code || e.message}`, "err"));
}

// ------------------------------------------------------------------ library
function renderLibrary() {
  $app.innerHTML = `
  <section class="page-head">
    <div><h1>Team SOP library</h1><p class="muted">Every process your team has recorded, ready to follow.</p></div>
    <a href="#/new" class="btn btn-primary">+ New SOP</a>
  </section>
  <section class="stats" id="stats"></section>
  <div class="toolbar"><input id="search" class="input" placeholder="Search SOPs, tools, categories…" /></div>
  <section id="grid" class="grid"><div class="center-load"><div class="spinner"></div></div></section>`;
  let all = [];
  const draw = () => {
    const q = document.getElementById("search").value.toLowerCase().trim();
    const list = all.filter((s) => !q || JSON.stringify([s.title, s.category, s.sop?.tools, s.sop?.summary]).toLowerCase().includes(q));
    const grid = document.getElementById("grid");
    if (!all.length) {
      grid.innerHTML = `<div class="empty"><h3>No SOPs yet</h3><p>Record your first process. It takes under 3 minutes.</p>
        <div class="row" style="justify-content:center"><a class="btn btn-primary" href="#/new">Record a process</a>
        <button class="btn btn-ghost" id="seedBtn">Load 3 demo SOPs</button></div></div>`;
      document.getElementById("seedBtn").onclick = (e) => seedDemo(e.currentTarget).catch((err) => toast(err.message, "err"));
      return;
    }
    grid.innerHTML = list.map(cardHtml).join("") || `<p class="muted">No matches.</p>`;
  };
  document.getElementById("search").oninput = draw;
  unsubs.push(onSnapshot(query(collection(db, "sops"), orderBy("createdAt", "desc"), limit(60)), (snap) => {
    all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    drawStats(all); draw();
  }, (e) => toast(`Could not load library: ${e.message}`, "err")));
}

function drawStats(all) {
  const ready = all.filter((s) => s.status === "ready");
  const steps = ready.reduce((a, s) => a + (s.sop?.steps?.length || 0), 0);
  const saved = ready.reduce((a, s) => a + (s.sop?.insights?.automation_ideas || []).reduce((x, i) => x + (Number(i.estimated_minutes_saved) || 0), 0), 0);
  const tools = new Set(ready.flatMap((s) => s.sop?.tools || []));
  document.getElementById("stats").innerHTML = `
    <div class="stat"><b>${ready.length}</b><span>SOPs documented</span></div>
    <div class="stat"><b>${steps}</b><span>steps captured</span></div>
    <div class="stat"><b>${tools.size}</b><span>tools covered</span></div>
    <div class="stat accent"><b>${saved} min</b><span>saving per run found by Gemini</span></div>`;
}

function cardHtml(s) {
  const steps = s.sop?.steps?.length;
  return `<a class="card" href="#/sop/${s.id}">
    <div class="card-top"><span class="pill cat">${esc(s.category || "New")}</span>${statusPill(s.status)}</div>
    <h3>${esc(s.title || "Untitled SOP")}</h3>
    <p class="muted clamp">${esc(s.sop?.summary || s.statusMessage || "")}</p>
    <div class="card-meta">
      ${steps ? `<span>${steps} steps</span>` : ""}
      ${s.sop?.estimated_minutes ? `<span>~${s.sop.estimated_minutes} min</span>` : ""}
      <span>${s.sourceType === "notes" ? "📝 notes" : "🎥 video"}</span>
      <span class="right">${esc(s.ownerName || "")} · ${timeAgo(s.createdAt)}</span>
    </div></a>`;
}
function statusPill(st) {
  const map = { ready: ["Ready", "ok"], error: ["Error", "err"], uploaded: ["Queued", "run"], analyzing: ["Analyzing", "run"], training: ["Building training", "run"] };
  const [t, k] = map[st] || ["Draft", ""];
  return `<span class="pill ${k}">${t}</span>`;
}

// ------------------------------------------------------------------ new SOP
function renderNew() {
  $app.innerHTML = `
  <section class="page-head"><div><h1>Create an SOP</h1><p class="muted">Show Gemini how the work is done. It handles the documentation.</p></div></section>
  <div class="new-wrap">
    <div class="tabs" role="tablist">
      <button class="tab active" data-tab="record">🎥 Record screen</button>
      <button class="tab" data-tab="upload">⬆ Upload video</button>
      <button class="tab" data-tab="notes">📝 Paste notes</button>
    </div>
    <div class="panel" id="panel-record">
      <div class="rec-stage" id="recStage">
        <video id="recPreview" playsinline muted></video>
        <div class="rec-empty" id="recEmpty"><p>Pick a window or tab, then do the task as you normally would.<br/><span class="muted">Tip: talk through what you're doing. Gemini uses your narration too.</span></p></div>
        <span class="rec-badge" id="recBadge" hidden>● REC <span id="recTime">0:00</span> / 3:00</span>
      </div>
      <label class="check"><input type="checkbox" id="micToggle" checked /> Narrate with my microphone</label>
      <div class="row">
        <button class="btn btn-primary" id="recStart">Start recording</button>
        <button class="btn btn-danger" id="recStop" hidden>Stop</button>
        <button class="btn btn-ghost" id="recRedo" hidden>Record again</button>
      </div>
    </div>
    <div class="panel" id="panel-upload" hidden>
      <label class="drop" id="drop"><input type="file" id="fileInput" accept="video/*" hidden />
        <strong>Drop a screen recording here</strong><span class="muted">or click to choose · MP4, WebM or MOV · up to ~2 min / 14 MB</span>
        <span id="fileName" class="file-name"></span></label>
    </div>
    <div class="panel" id="panel-notes" hidden>
      <textarea id="notes" class="input" rows="9" placeholder="Paste rough notes, a Slack thread or a messy how-to. For example:&#10;login to zoho → go to invoices → filter overdue → for each send reminder, if >60 days cc finance lead…"></textarea>
    </div>
    <div class="meta-fields">
      <input id="titleInput" class="input" placeholder="Process name (optional). Gemini will suggest one." maxlength="120" />
      <input id="contextInput" class="input" placeholder="Extra context (optional), e.g. 'for new support agents', 'our CRM is HubSpot'" maxlength="300" />
    </div>
    <div class="submit-row">
      <div id="uploadProgress" class="progress" hidden><div></div></div>
      <button class="btn btn-primary btn-lg" id="generateBtn" disabled>Generate SOP with Gemini ✨</button>
    </div>
  </div>`;

  let mode = "record";
  let blob = null, blobMime = "";
  const genBtn = document.getElementById("generateBtn");
  const refreshBtn = () => {
    genBtn.disabled = mode === "notes" ? document.getElementById("notes").value.trim().length < 20 : !blob;
  };

  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    mode = t.dataset.tab;
    ["record", "upload", "notes"].forEach((p) => (document.getElementById(`panel-${p}`).hidden = p !== mode));
    blob = null; refreshBtn();
  }));
  document.getElementById("notes").oninput = refreshBtn;

  // upload
  const fileInput = document.getElementById("fileInput");
  const drop = document.getElementById("drop");
  const takeFile = (f) => {
    if (!f) return;
    if (!f.type.startsWith("video/")) return toast("Please choose a video file", "err");
    if (f.size > MAX_VIDEO_BYTES) return toast("That file is over 14 MB. Please trim it to about 2 minutes or record with the Record tab.", "err");
    blob = f; blobMime = f.type; document.getElementById("fileName").textContent = `✓ ${f.name} (${(f.size / 1048576).toFixed(1)} MB)`; refreshBtn();
  };
  fileInput.onchange = () => takeFile(fileInput.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); takeFile(e.dataTransfer.files[0]); };

  // record
  let recorder = null, streams = [], chunks = [], timer = null, startedAt = 0;
  const preview = document.getElementById("recPreview");
  const startBtn = document.getElementById("recStart"), stopBtn = document.getElementById("recStop"), redoBtn = document.getElementById("recRedo");
  const stopAll = () => { streams.forEach((s) => s.getTracks().forEach((t) => t.stop())); streams = []; clearInterval(timer); };
  cleanupFns.push(() => { try { recorder?.state === "recording" && recorder.stop(); } catch {} stopAll(); });

  startBtn.onclick = async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) return toast("Screen recording isn't supported in this browser. Use Upload instead.", "err");
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 12 }, audio: true });
      streams = [display];
      const tracks = [...display.getVideoTracks()];
      let audioTracks = display.getAudioTracks();
      if (document.getElementById("micToggle").checked) {
        try {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
          streams.push(mic);
          audioTracks = mixAudio([...audioTracks, ...mic.getAudioTracks()]);
        } catch { toast("Microphone unavailable. Recording without narration."); }
      }
      const combined = new MediaStream([...tracks, ...audioTracks]);
      const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
      recorder = new MediaRecorder(combined, { mimeType: mime || undefined, videoBitsPerSecond: 450_000, audioBitsPerSecond: 48_000 });
      chunks = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => {
        blobMime = (recorder.mimeType || "video/webm").split(";")[0];
        blob = new Blob(chunks, { type: blobMime });
        stopAll();
        preview.srcObject = null; preview.src = URL.createObjectURL(blob); preview.muted = false; preview.controls = true;
        document.getElementById("recBadge").hidden = true;
        stopBtn.hidden = true; redoBtn.hidden = false; refreshBtn();
        toast(`Recording ready (${(blob.size / 1048576).toFixed(1)} MB)`, "ok");
      };
      tracks[0].onended = () => recorder?.state === "recording" && recorder.stop();
      preview.srcObject = display; preview.controls = false; preview.muted = true; preview.play();
      document.getElementById("recEmpty").hidden = true;
      recorder.start(1000);
      startedAt = Date.now();
      document.getElementById("recBadge").hidden = false;
      timer = setInterval(() => {
        const s = (Date.now() - startedAt) / 1000;
        document.getElementById("recTime").textContent = fmtTime(s);
        if (s >= MAX_RECORD_SECONDS && recorder.state === "recording") recorder.stop();
      }, 500);
      startBtn.hidden = true; stopBtn.hidden = false; redoBtn.hidden = true; blob = null; refreshBtn();
    } catch (e) {
      stopAll();
      if (e.name !== "NotAllowedError") toast(`Could not start recording: ${e.message}`, "err");
    }
  };
  stopBtn.onclick = () => recorder?.state === "recording" && recorder.stop();
  redoBtn.onclick = () => { blob = null; preview.removeAttribute("src"); preview.load(); redoBtn.hidden = true; startBtn.hidden = false; document.getElementById("recEmpty").hidden = false; refreshBtn(); };

  // generate
  genBtn.onclick = async () => {
    genBtn.disabled = true; genBtn.textContent = "Uploading…";
    const id = newId();
    const base = {
      ownerUid: user.uid, ownerName: displayName(user),
      title: document.getElementById("titleInput").value.trim() || "Untitled SOP",
      context: document.getElementById("contextInput").value.trim(),
      status: "uploaded", statusMessage: "Uploaded. Waiting for Gemini…",
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    };
    try {
      if (mode === "notes") {
        await setDoc(doc(db, "sops", id), { ...base, sourceType: "notes", notes: document.getElementById("notes").value.trim().slice(0, 20000) });
      } else {
        if (blob.size > MAX_VIDEO_BYTES) throw new Error("Recording is over 14 MB. Please keep it to about 2 minutes.");
        await videoStore.put(id, blob);
        await setDoc(doc(db, "sops", id), { ...base, sourceType: "video", videoMime: blobMime || "video/webm", videoBytes: blob.size });
      }
      const created = (await getDoc(doc(db, "sops", id))).data();
      location.hash = `#/sop/${id}`;
      runPipeline(id, created, mode === "notes" ? null : blob);
    } catch (e) {
      toast(`Upload failed: ${e.message}`, "err");
      genBtn.disabled = false; genBtn.textContent = "Generate SOP with Gemini ✨";
    }
  };
}

function mixAudio(tracks) {
  if (tracks.length <= 1) return tracks;
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  tracks.forEach((t) => ctx.createMediaStreamSource(new MediaStream([t])).connect(dest));
  return dest.stream.getAudioTracks();
}

// ------------------------------------------------------------------ SOP view
function renderSop(id) {
  $app.innerHTML = `<div class="center-load"><div class="spinner"></div></div>`;
  let renderedReady = false;
  let current = null;
  unsubs.push(onSnapshot(doc(db, "sops", id), async (snap) => {
    if (!snap.exists()) { $app.innerHTML = `<div class="empty"><h3>SOP not found</h3><a href="#/library" class="btn">Back to library</a></div>`; return; }
    current = { id, ...snap.data() };
    if (current.status === "ready") {
      if (!renderedReady) { renderedReady = true; await renderReady(current); }
    } else {
      renderedReady = false;
      renderPipeline(current);
    }
  }, (e) => toast(e.message, "err")));
}

function renderPipeline(s) {
  const order = ["uploaded", "analyzing", "training", "ready"];
  const idx = order.indexOf(s.status);
  const stages = [
    ["uploaded", s.sourceType === "notes" ? "Notes saved to Firestore" : "Recording ready (kept on this device)"],
    ["analyzing", s.sourceType === "notes" ? "Gemini is reading your notes" : "Gemini is watching the recording"],
    ["training", "Building the checklist and quiz"],
    ["ready", "SOP ready"],
  ];
  const stale = ["analyzing", "training"].includes(s.status) && !running.has(s.id) && s.updatedAt?.toDate && Date.now() - s.updatedAt.toDate().getTime() > 120000;
  const isErr = s.status === "error" || stale;
  $app.innerHTML = `
  <section class="pipeline">
    <h1>${esc(s.title || "Untitled SOP")}</h1>
    <p class="muted">${esc(s.statusMessage || "")}</p>
    <ol class="stages">
      ${stages.map(([k, label], i) => `<li class="${isErr ? (i === 0 ? "done" : "") : i < idx ? "done" : i === idx ? "active" : ""}">
        <span class="dot">${i < idx ? "✓" : i + 1}</span><span>${label}</span></li>`).join("")}
    </ol>
    ${isErr ? `<div class="error-box">${esc(stale ? "Processing was interrupted (the page was closed or refreshed)." : s.statusMessage)}<div class="row">
      ${s.ownerUid === user.uid ? `<button class="btn btn-primary" id="retryBtn">Try again</button>` : ""}<a class="btn btn-ghost" href="#/library">Back to library</a></div></div>`
      : `<p class="muted small">This usually takes 20–60 seconds. Updates appear here live through Firestore.</p>`}
  </section>`;
  const retry = document.getElementById("retryBtn");
  if (retry) retry.onclick = () => { retry.disabled = true; runPipeline(s.id, s); };
  // If this user created it and it's still queued (e.g. page refresh mid-flow), make sure processing starts.
  if (s.status === "uploaded" && s.ownerUid === user.uid && !running.has(s.id) && !renderPipeline._kicked?.[s.id]) {
    renderPipeline._kicked = { ...(renderPipeline._kicked || {}), [s.id]: true };
    setTimeout(async () => {
      const fresh = await getDoc(doc(db, "sops", s.id)).catch(() => null);
      if (fresh?.data()?.status === "uploaded" && !running.has(s.id)) runPipeline(s.id, fresh.data());
    }, 4000);
  }
}

async function renderReady(s) {
  const sop = s.sop || {};
  const ins = sop.insights || {};
  let videoUrl = null;
  if (s.sourceType === "video") { const b = await videoStore.get(s.id); if (b) { videoUrl = URL.createObjectURL(b); cleanupFns.push(() => URL.revokeObjectURL(videoUrl)); } }
  const saved = (ins.automation_ideas || []).reduce((a, i) => a + (Number(i.estimated_minutes_saved) || 0), 0);

  $app.innerHTML = `
  <article class="sop">
    <div class="sop-head">
      <a href="#/library" class="back">← Library</a>
      <div class="sop-title-row">
        <div>
          <div class="pills"><span class="pill cat">${esc(sop.category)}</span>${sop.estimated_minutes ? `<span class="pill">~${sop.estimated_minutes} min</span>` : ""}<span class="pill">${sop.steps?.length || 0} steps</span></div>
          <h1>${esc(sop.title)}</h1>
          <p class="lede">${esc(sop.summary)}</p>
          <p class="muted small">By ${esc(s.ownerName)} · ${timeAgo(s.createdAt)} · written by ${esc(s.model || "Gemini")}</p>
        </div>
        <div class="actions no-print">
          <button class="btn btn-ghost btn-sm" id="copyLink">🔗 Copy link</button>
          <button class="btn btn-ghost btn-sm" id="exportMd">⬇ Markdown</button>
          <button class="btn btn-ghost btn-sm" id="printBtn">🖨 PDF</button>
          ${s.ownerUid === user.uid ? `<button class="btn btn-ghost btn-sm danger-text" id="deleteBtn">Delete</button>` : ""}
        </div>
      </div>
    </div>
    <div class="tabs no-print" role="tablist">
      <button class="tab active" data-tab="steps">📋 Steps</button>
      <button class="tab" data-tab="training">✅ Training</button>
      <button class="tab" data-tab="ask">💬 Ask this SOP</button>
      <button class="tab" data-tab="insights">⚡ Insights${saved ? ` <span class="count">${saved}m</span>` : ""}</button>
    </div>

    <section class="tabpanel" id="tp-steps">
      <div class="sop-grid ${videoUrl ? "" : "no-video"}">
        ${videoUrl ? `<div class="video-col"><div class="sticky"><video id="sopVideo" src="${esc(videoUrl)}" controls playsinline preload="metadata"></video>
          <p class="muted small">Press ▶ on any step to play just that moment.</p></div></div>` : ""}
        <div class="steps-col">
          ${s.sourceType === "video" && !videoUrl ? `<p class="note tip">🎥 Made from a screen recording. The video stays on the recorder's device, so step playback is available there.</p>` : ""}
          ${(sop.prerequisites || []).length || (sop.tools || []).length ? `<div class="prereq">
            ${(sop.tools || []).length ? `<div><h4>Tools</h4><div class="chips">${sop.tools.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div></div>` : ""}
            ${(sop.prerequisites || []).length ? `<div><h4>Before you start</h4><ul>${sop.prerequisites.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}
          </div>` : ""}
          <ol class="steps">${(sop.steps || []).map((st) => `
            <li class="step" id="step-${st.n}">
              <div class="step-n">${st.n}</div>
              <div class="step-body">
                <div class="step-head"><h3>${esc(st.title)}</h3>
                  ${videoUrl && st.start_seconds != null ? `<button class="play no-print" data-start="${st.start_seconds}" data-end="${st.end_seconds ?? ""}">▶ ${fmtTime(st.start_seconds)}</button>` : ""}</div>
                <p>${esc(st.instruction)}</p>
                ${st.tip ? `<div class="note tip">💡 ${esc(st.tip)}</div>` : ""}
                ${st.warning ? `<div class="note warn">⚠️ ${esc(st.warning)}</div>` : ""}
              </div></li>`).join("")}
          </ol>
        </div>
      </div>
    </section>

    <section class="tabpanel" id="tp-training" hidden>
      <div class="training">
        <div class="box">
          <div class="box-head"><h3>New-hire checklist</h3><span id="ckPct" class="pill ok">0%</span></div>
          <div class="progress"><div id="ckBar"></div></div>
          <ul class="checklist" id="checklist"></ul>
        </div>
        <div class="box"><div class="box-head"><h3>Knowledge check</h3><span id="quizScore" class="pill"></span></div><div id="quiz"></div></div>
      </div>
    </section>

    <section class="tabpanel" id="tp-ask" hidden>
      <div class="chat">
        <div id="qaList" class="qa-list"></div>
        <form id="askForm" class="ask-form">
          <input id="askInput" class="input" placeholder="e.g. What if the customer was charged twice?" maxlength="600" autocomplete="off" />
          <button class="btn btn-primary" id="askBtn">Ask</button>
        </form>
        <div class="suggest" id="suggest">
          ${["What do I need before starting?", "What's the most common mistake here?", "Which step takes the longest?"].map((q) => `<button class="chip-btn">${q}</button>`).join("")}
        </div>
      </div>
    </section>

    <section class="tabpanel" id="tp-insights" hidden>
      <div class="insights">
        <div class="score-card">
          <div class="score">${ins.efficiency_score ?? "–"}<small>/10</small></div>
          <div><h3>Process efficiency</h3><p class="muted">Gemini's assessment of how streamlined this process is today.${saved ? ` It found about <b>${saved} minutes</b> that could be saved on every run.` : ""}</p></div>
        </div>
        ${(ins.bottlenecks || []).length ? `<div class="box"><h3>Bottlenecks</h3><ul class="bullets">${ins.bottlenecks.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>` : ""}
        ${(ins.automation_ideas || []).length ? `<div class="box"><h3>Automation ideas</h3><div class="ideas">${ins.automation_ideas.map((a) => `
          <div class="idea"><p>${esc(a.idea)}</p><div class="idea-meta"><span class="pill ok">saves ~${esc(a.estimated_minutes_saved)} min</span><span class="pill">${esc(a.effort)} effort</span></div></div>`).join("")}</div></div>` : ""}
      </div>
    </section>
  </article>`;

  // tabs
  const showTab = (name) => {
    document.querySelectorAll(".sop .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".tabpanel").forEach((p) => (p.hidden = p.id !== `tp-${name}`));
  };
  document.querySelectorAll(".sop .tab").forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));

  // step playback (plays only that segment)
  const video = document.getElementById("sopVideo");
  let stopAt = null;
  if (video) {
    video.addEventListener("timeupdate", () => { if (stopAt != null && video.currentTime >= stopAt) { video.pause(); stopAt = null; } });
    document.querySelectorAll(".play").forEach((b) => (b.onclick = () => {
      document.querySelectorAll(".step").forEach((x) => x.classList.remove("playing"));
      b.closest(".step").classList.add("playing");
      video.currentTime = Number(b.dataset.start);
      stopAt = b.dataset.end ? Number(b.dataset.end) + 0.5 : null;
      video.play();
      if (window.innerWidth < 900) video.scrollIntoView({ behavior: "smooth", block: "center" });
    }));
  }
  const gotoStep = (n) => {
    showTab("steps");
    const el = document.getElementById(`step-${n}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1600);
    el.querySelector(".play")?.click();
  };

  // actions
  document.getElementById("copyLink").onclick = () => navigator.clipboard.writeText(location.href).then(() => toast("Link copied", "ok"));
  document.getElementById("printBtn").onclick = () => { showTab("steps"); setTimeout(() => window.print(), 100); };
  document.getElementById("exportMd").onclick = () => downloadMarkdown(s);
  const del = document.getElementById("deleteBtn");
  if (del) del.onclick = async () => {
    if (!confirm("Delete this SOP for everyone?")) return;
    try {
      const qa = await getDocs(collection(db, "sops", s.id, "qa"));
      await Promise.all(qa.docs.map((d) => deleteDoc(d.ref)));
      await deleteDoc(doc(db, "sops", s.id)); await videoStore.del(s.id); location.hash = "#/library";
    } catch (e) { toast(e.message, "err"); }
  };

  // training
  setupTraining(s);

  // ask
  const qaList = document.getElementById("qaList");
  unsubs.push(onSnapshot(query(collection(db, "sops", s.id, "qa"), orderBy("createdAt", "asc"), limit(50)), (snap) => {
    if (snap.empty) { qaList.innerHTML = `<p class="muted center">Ask anything about this process. Answers come only from this SOP.</p>`; return; }
    qaList.innerHTML = snap.docs.map((d) => qaHtml(d.data())).join("");
    qaList.querySelectorAll("[data-step]").forEach((b) => (b.onclick = () => gotoStep(b.dataset.step)));
    qaList.scrollTop = qaList.scrollHeight;
  }));
  const form = document.getElementById("askForm"), input = document.getElementById("askInput"), askBtn = document.getElementById("askBtn");
  const ask = async (q) => {
    if (!q.trim()) return;
    askBtn.disabled = true; askBtn.textContent = "Thinking…"; input.value = "";
    qaList.insertAdjacentHTML("beforeend", `<div class="qa pending"><div class="q">${esc(q)}</div><div class="a"><span class="typing"><i></i><i></i><i></i></span></div></div>`);
    qaList.scrollTop = qaList.scrollHeight;
    try {
      const hist = (await getDocs(query(collection(db, "sops", s.id, "qa"), orderBy("createdAt", "desc"), limit(4)))).docs.map((d) => d.data()).reverse();
      const a = await answerQuestion(s.sop, q.trim().slice(0, 600), hist);
      await addDoc(collection(db, "sops", s.id, "qa"), { question: q.trim().slice(0, 600), ...a, askedBy: displayName(user), askedByUid: user.uid, createdAt: serverTimestamp() });
    }
    catch (e) { toast(`Couldn't answer: ${e.message}`, "err"); qaList.querySelector(".qa.pending")?.remove(); }
    finally { askBtn.disabled = false; askBtn.textContent = "Ask"; }
  };
  form.onsubmit = (e) => { e.preventDefault(); ask(input.value); };
  document.querySelectorAll("#suggest .chip-btn").forEach((b) => (b.onclick = () => ask(b.textContent)));
}

function qaHtml(q) {
  return `<div class="qa"><div class="q"><span class="who">${esc(q.askedBy || "")}</span>${esc(q.question)}</div>
    <div class="a ${q.covered === false ? "uncovered" : ""}">${esc(q.answer)}
    ${(q.stepRefs || []).length ? `<div class="refs">${q.stepRefs.map((n) => `<button class="chip-btn" data-step="${n}">Step ${n} ↗</button>`).join("")}</div>` : ""}</div></div>`;
}

async function setupTraining(s) {
  const training = s.training || { checklist: [], quiz: [] };
  const progRef = doc(db, "users", user.uid, "progress", s.id);
  let prog = { checked: {}, quizBest: null };
  try { const p = await getDoc(progRef); if (p.exists()) prog = { ...prog, ...p.data() }; } catch {}
  const save = () => setDoc(progRef, { ...prog, sopTitle: s.sop?.title || "", updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});

  const list = document.getElementById("checklist");
  const drawChecklist = () => {
    const items = training.checklist;
    const done = items.filter((c) => prog.checked[c.id]).length;
    const pct = items.length ? Math.round((done / items.length) * 100) : 0;
    document.getElementById("ckPct").textContent = pct === 100 ? "Complete 🎉" : `${pct}%`;
    document.getElementById("ckBar").style.width = `${pct}%`;
    list.innerHTML = items.map((c) => `<li class="${prog.checked[c.id] ? "done" : ""}"><label>
      <input type="checkbox" data-id="${c.id}" ${prog.checked[c.id] ? "checked" : ""}/> <span>${esc(c.text)}</span></label>
      ${c.step ? `<span class="muted small">step ${esc(c.step)}</span>` : ""}</li>`).join("");
    list.querySelectorAll("input").forEach((i) => (i.onchange = () => { prog.checked[i.dataset.id] = i.checked; save(); drawChecklist(); }));
  };
  drawChecklist();

  const quizEl = document.getElementById("quiz");
  const quiz = training.quiz;
  const answers = {};
  const scoreEl = document.getElementById("quizScore");
  if (prog.quizBest != null) scoreEl.textContent = `Best: ${prog.quizBest}/${quiz.length}`;
  quizEl.innerHTML = quiz.map((q, qi) => `<div class="q-card" data-q="${qi}">
    <p class="q-text"><b>Q${qi + 1}.</b> ${esc(q.question)}</p>
    <div class="opts">${q.options.map((o, oi) => `<button class="opt" data-o="${oi}">${esc(o)}</button>`).join("")}</div>
    <p class="explain" hidden></p></div>`).join("") || `<p class="muted">No quiz generated.</p>`;
  quizEl.querySelectorAll(".q-card").forEach((card) => {
    const qi = Number(card.dataset.q), q = quiz[qi];
    card.querySelectorAll(".opt").forEach((b) => (b.onclick = () => {
      if (answers[qi] != null) return;
      const oi = Number(b.dataset.o); answers[qi] = oi;
      card.querySelectorAll(".opt").forEach((x, i) => { x.disabled = true; if (i === q.answer_index) x.classList.add("right"); });
      if (oi !== q.answer_index) b.classList.add("wrong");
      const ex = card.querySelector(".explain"); ex.hidden = false;
      ex.textContent = `${oi === q.answer_index ? "✓ Correct. " : "✗ Not quite. "}${q.explanation}`;
      if (Object.keys(answers).length === quiz.length) {
        const score = quiz.filter((qq, i) => answers[i] === qq.answer_index).length;
        scoreEl.textContent = `Score: ${score}/${quiz.length}`;
        if (prog.quizBest == null || score > prog.quizBest) { prog.quizBest = score; save(); }
        toast(score === quiz.length ? "Perfect score! 🎉" : `You scored ${score}/${quiz.length}`, "ok");
      }
    }));
  });
}

function downloadMarkdown(s) {
  const sop = s.sop;
  const L = [`# ${sop.title}`, "", sop.summary, ""];
  if (sop.audience) L.push(`**Audience:** ${sop.audience}  `);
  if (sop.estimated_minutes) L.push(`**Time:** ~${sop.estimated_minutes} min  `);
  if (sop.tools?.length) L.push(`**Tools:** ${sop.tools.join(", ")}`);
  if (sop.prerequisites?.length) L.push("", "## Before you start", ...sop.prerequisites.map((p) => `- ${p}`));
  L.push("", "## Steps");
  sop.steps.forEach((st) => {
    L.push("", `### ${st.n}. ${st.title}${st.start_seconds != null ? ` _(video ${fmtTime(st.start_seconds)})_` : ""}`, "", st.instruction);
    if (st.tip) L.push("", `> 💡 ${st.tip}`);
    if (st.warning) L.push("", `> ⚠️ ${st.warning}`);
  });
  const ideas = sop.insights?.automation_ideas || [];
  if (ideas.length) L.push("", "## Automation ideas", ...ideas.map((a) => `- ${a.idea} (saves ~${a.estimated_minutes_saved} min, ${a.effort} effort)`));
  L.push("", `---`, `Generated with SOP Studio · ${location.origin}/#/sop/${s.id}`);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([L.join("\n")], { type: "text/markdown" }));
  a.download = `${sop.title.replace(/[^\w]+/g, "-").toLowerCase()}.md`;
  a.click();
}
