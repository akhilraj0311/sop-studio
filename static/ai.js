// Gemini via Firebase AI Logic (Gemini Developer API backend: works on the free Spark plan).
// Same prompts as the Cloud Run backend (gemini_service.py), run from the browser.
import { getAI, getGenerativeModel, GoogleAIBackend } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-ai.js";

let ai = null;
// First model that works is remembered; the rest are fallbacks if a name is unavailable or out of quota.
const MODELS = (window.SOP_CONFIG?.geminiModels || "gemini-flash-latest,gemini-3.8-flash")
  .split(",").map((s) => s.trim()).filter(Boolean);

export function initAI(app) { ai = getAI(app, { backend: new GoogleAIBackend() }); }

function parseJson(text) {
  text = (text || "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  try { return JSON.parse(text); } catch {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a !== -1 && b > a) return JSON.parse(text.slice(a, b + 1));
    throw new Error("Gemini returned an unreadable answer. Please try again.");
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generate(parts, system, temperature = 0.2) {
  let lastErr;
  for (const name of [...MODELS]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const model = getGenerativeModel(ai, {
          model: name, systemInstruction: system,
          generationConfig: { temperature, responseMimeType: "application/json" },
        });
        const res = await model.generateContent(parts);
        const data = parseJson(res.response.text());
        if (MODELS[0] !== name) { MODELS.splice(MODELS.indexOf(name), 1); MODELS.unshift(name); }
        return { data, model: name };
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e);
        console.warn(`[SOP Studio] Gemini ${name} attempt ${attempt} failed:`, msg.slice(0, 300));
        if (/404|not found|NOT_FOUND|not supported/i.test(msg)) break;           // unknown model → next
        if (/429|quota|RESOURCE_EXHAUSTED/i.test(msg)) { await sleep(1500); break; } // free-tier limit → next
        if (/api-not-enabled|PERMISSION_DENIED|403/i.test(msg)) throw friendly(e);
        await sleep(2000 + attempt * 3000);
      }
    }
  }
  throw friendly(lastErr);
}
function friendly(e) {
  const msg = String(e?.message || e);
  if (/api-not-enabled|firebasevertexai|AI Logic/i.test(msg)) return new Error("Gemini isn't enabled for this project yet (Firebase console → AI Logic → Get started).");
  if (/429|quota|RESOURCE_EXHAUSTED/i.test(msg)) return new Error("Gemini's free quota is busy right now. Wait a minute and press Try again.");
  return new Error(`Gemini request failed: ${msg.slice(0, 200)}`);
}

const SOP_SYSTEM = `You are a senior technical writer and process-improvement consultant.
You turn screen recordings or rough notes of a work task into a clear, accurate
Standard Operating Procedure (SOP) that a brand-new employee could follow alone.
Only describe what is actually shown or stated. Never invent UI elements, URLs or data.
Write instructions in the imperative ("Click Save", "Open the Billing tab").
Always respond with a single JSON object and nothing else.`;

const SOP_SCHEMA = `Return JSON with exactly this shape:
{
  "title": "short action-oriented title, e.g. 'Issue a customer refund in Stripe'",
  "summary": "2-3 sentence overview: what the process achieves and when to use it",
  "category": "one of: Finance, Sales, Support, HR, Engineering, Operations, Marketing, IT, Other",
  "audience": "who should use this SOP",
  "estimated_minutes": integer,
  "tools": ["apps / websites / systems used"],
  "prerequisites": ["access, data or permissions needed before starting"],
  "steps": [
    {"n": 1, "title": "short step title", "instruction": "precise instruction, mention exact buttons/fields seen",
     "start_seconds": number or null, "end_seconds": number or null,
     "tip": "optional helpful tip or empty string", "warning": "optional risk / common mistake or empty string"}
  ],
  "insights": {
    "efficiency_score": integer 1-10 (10 = already very efficient),
    "bottlenecks": ["slow, repetitive or error-prone parts of the process"],
    "automation_ideas": [{"idea": "concrete automation or simplification", "estimated_minutes_saved": integer, "effort": "Low|Medium|High"}]
  }
}`;

export async function analyzeNotes(notes, context = "") {
  const extra = context ? `\nContext from the author: ${context}` : "";
  const prompt = `Below are rough notes describing how a work task is done. Turn them into a complete SOP. Set start_seconds and end_seconds to null.${extra}\n\n${SOP_SCHEMA}\n\nNOTES:\n${notes}`;
  const { data, model } = await generate([prompt], SOP_SYSTEM);
  return { sop: cleanSop(data), model };
}

export async function analyzeVideo(base64, mimeType, context = "") {
  const extra = context ? `\nContext from the author: ${context}` : "";
  const prompt = `Watch this screen recording of someone performing a work task. Break it into clear sequential steps. For every step give start_seconds and end_seconds (seconds from the start of the video) where it happens. If the person narrates, use the narration as extra context.${extra}\n\n${SOP_SCHEMA}`;
  const { data, model } = await generate([{ inlineData: { data: base64, mimeType } }, prompt], SOP_SYSTEM);
  return { sop: cleanSop(data), model };
}

const TRAINING_SYSTEM = "You are an onboarding specialist. You create practical training material for new employees from an SOP. Respond with a single JSON object only.";
export async function buildTraining(sop) {
  const prompt = `Create training material for a new hire learning this SOP.

Return JSON:
{"checklist": [{"id": "c1", "text": "verifiable action the new hire ticks off", "step": step number}],
 "quiz": [{"question": "scenario-style question", "options": ["A","B","C","D"], "answer_index": 0-3, "explanation": "why the answer is right"}]}
Rules: one checklist item per SOP step (ids c1, c2, ...); exactly 4 quiz questions that test
understanding of order, warnings and judgement (not trivia); vary the correct answer position.

SOP:
${JSON.stringify(sop)}`;
  const { data } = await generate([prompt], TRAINING_SYSTEM, 0.4);
  return cleanTraining(data, sop);
}

const QA_SYSTEM = `You are a helpful teammate answering questions about a company SOP.
Answer ONLY from the SOP provided. If the SOP does not cover the question, say so plainly
and suggest who or what to check. Be concise (max ~120 words). Respond with JSON only.`;
export async function answerQuestion(sop, question, history = []) {
  const hist = history.length ? "\nEarlier Q&A:\n" + history.slice(-4).map((h) => `Q: ${h.question}\nA: ${h.answer}`).join("\n") : "";
  const prompt = `SOP:\n${JSON.stringify(sop)}\n${hist}\n\nQuestion: ${question}\n\nReturn JSON: {"answer": "plain text answer", "step_refs": [step numbers used], "covered": true|false}`;
  const { data } = await generate([prompt], QA_SYSTEM, 0.3);
  return {
    answer: String(data.answer || "").trim() || "Sorry, I couldn't find an answer.",
    stepRefs: (data.step_refs || []).map(Number).filter((n) => Number.isInteger(n) && n > 0),
    covered: data.covered !== false,
  };
}

// ---------------------------------------------------------------- cleaning (mirrors main.py)
const num = (v) => { const n = Number(v); return v === null || v === undefined || v === "" || Number.isNaN(n) ? null : Math.max(0, n); };
export function cleanSop(s) {
  const ins = s.insights || {};
  return {
    title: String(s.title || "Untitled SOP"), summary: String(s.summary || ""),
    category: String(s.category || "Other"), audience: String(s.audience || ""),
    estimated_minutes: parseInt(s.estimated_minutes, 10) || 0,
    tools: (s.tools || []).map(String), prerequisites: (s.prerequisites || []).map(String),
    steps: (s.steps || []).map((st, i) => ({
      n: i + 1, title: String(st.title || `Step ${i + 1}`), instruction: String(st.instruction || ""),
      start_seconds: num(st.start_seconds), end_seconds: num(st.end_seconds),
      tip: String(st.tip || ""), warning: String(st.warning || ""),
    })),
    insights: {
      efficiency_score: ins.efficiency_score ?? null,
      bottlenecks: (ins.bottlenecks || []).map(String),
      automation_ideas: (ins.automation_ideas || []).filter((a) => a && typeof a === "object").map((a) => ({
        idea: String(a.idea || ""), estimated_minutes_saved: Number(a.estimated_minutes_saved) || 0, effort: String(a.effort || "Medium"),
      })),
    },
  };
}
function cleanTraining(t, sop) {
  let checklist = (t.checklist || []).map((c, i) => ({ id: `c${i + 1}`, text: String(c.text || ""), step: c.step ?? null }));
  if (!checklist.length) checklist = sop.steps.map((s) => ({ id: `c${s.n}`, text: s.title, step: s.n }));
  const quiz = (t.quiz || []).map((q) => {
    const options = (q.options || []).slice(0, 4).map(String);
    const answer_index = parseInt(q.answer_index, 10);
    return { question: String(q.question || ""), options, answer_index, explanation: String(q.explanation || "") };
  }).filter((q) => q.options.length >= 2 && q.answer_index >= 0 && q.answer_index < q.options.length);
  return { checklist, quiz };
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
