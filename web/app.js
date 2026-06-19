// RECALL PWA — repo-native, phone-first spaced-repetition reviewer.
// FSRS runs in-browser (zero tokens). Cards + state live in the GitHub repo;
// the app reads/writes them via the GitHub Contents API using a PAT kept only
// in this device's localStorage. Offline-first via IndexedDB + a sync queue.

import {
  createEmptyCard, fsrs, generatorParameters, Rating, State,
} from "https://cdn.jsdelivr.net/npm/ts-fsrs@4.7.0/+esm";

const F = fsrs(generatorParameters({ enable_fuzz: true }));

// ---------- small utilities ----------
const $ = (sel, el = document) => el.querySelector(sel);
const view = $("#view");
const enc = new TextEncoder();
const dec = new TextDecoder();
const nowISO = () => new Date().toISOString();

function b64encodeUtf8(str) {
  const bytes = enc.encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decodeUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return dec.decode(bytes);
}

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}

// ---------- settings (localStorage) ----------
const SET = {
  get owner() { return localStorage.getItem("gh_owner") || ""; },
  get repo() { return localStorage.getItem("gh_repo") || ""; },
  get branch() { return localStorage.getItem("gh_branch") || "main"; },
  get pat() { return localStorage.getItem("gh_pat") || ""; },
  get tutorKey() { return localStorage.getItem("tutor_key") || ""; },
  get model() { return localStorage.getItem("tutor_model") || ""; },
  set(k, v) { localStorage.setItem(k, v); },
};

// ---------- IndexedDB (single key/value store) ----------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("recall", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((res) => {
    const tx = db.transaction("kv").objectStore("kv").get(key);
    tx.onsuccess = () => res(tx.result);
    tx.onerror = () => res(undefined);
  });
}
async function idbSet(key, val) {
  const db = await idb();
  return new Promise((res) => {
    const tx = db.transaction("kv", "readwrite").objectStore("kv").put(val, key);
    tx.onsuccess = () => res();
    tx.onerror = () => res();
  });
}

// ---------- GitHub Contents API ----------
function ghHeaders() {
  const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (SET.pat) h.Authorization = `Bearer ${SET.pat}`;
  return h;
}
function ghBase() { return `https://api.github.com/repos/${SET.owner}/${SET.repo}`; }

async function ghGetFile(path) {
  const url = `${ghBase()}/contents/${path}?ref=${SET.branch}`;
  const r = await fetch(url, { headers: ghHeaders(), cache: "no-store" });
  if (r.status === 404) return { text: null, sha: null };
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  const j = await r.json();
  return { text: b64decodeUtf8(j.content), sha: j.sha };
}
async function ghListDir(path) {
  const r = await fetch(`${ghBase()}/contents/${path}?ref=${SET.branch}`, { headers: ghHeaders(), cache: "no-store" });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`LIST ${path}: ${r.status}`);
  return (await r.json()).filter((e) => e.type === "file");
}
async function ghPutFile(path, text, sha, message) {
  const body = { message, content: b64encodeUtf8(text), branch: SET.branch };
  if (sha) body.sha = sha;
  const r = await fetch(`${ghBase()}/contents/${path}`, {
    method: "PUT", headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PUT ${path}: ${r.status}`);
  return (await r.json()).content.sha;
}

// ---------- in-memory state ----------
const S = {
  config: null,
  decks: {},          // slug -> { deck, domain, cards:[], sha }
  scheduler: {},      // id -> stored FSRS card
  pendingReviews: [], // jsonl lines to append to state/reviews.jsonl
  pendingTutor: [],   // jsonl lines to append to state/tutor_calls.jsonl
  dirtyDecks: new Set(),
  schedulerDirty: false,
  indexDirty: false,
  loaded: false,
};

async function persistLocal() {
  await idbSet("snapshot", {
    config: S.config, decks: S.decks, scheduler: S.scheduler,
    pendingReviews: S.pendingReviews, pendingTutor: S.pendingTutor,
    dirtyDecks: [...S.dirtyDecks], schedulerDirty: S.schedulerDirty, indexDirty: S.indexDirty,
  });
}
async function restoreLocal() {
  const snap = await idbGet("snapshot");
  if (!snap) return false;
  S.config = snap.config; S.decks = snap.decks || {}; S.scheduler = snap.scheduler || {};
  S.pendingReviews = snap.pendingReviews || []; S.pendingTutor = snap.pendingTutor || [];
  S.dirtyDecks = new Set(snap.dirtyDecks || []); S.schedulerDirty = !!snap.schedulerDirty;
  S.indexDirty = !!snap.indexDirty;
  S.loaded = true;
  return true;
}

// Parallel loading: config + scheduler + directory listing in one round-trip,
// then all deck files fetched concurrently.
async function loadFromGitHub() {
  const [cfgResult, schResult, files] = await Promise.all([
    ghGetFile("config.json").catch(() => ({ text: null })),
    ghGetFile("state/scheduler.json").catch(() => ({ text: null })),
    ghListDir("cards"),
  ]);
  if (cfgResult.text) { try { S.config = JSON.parse(cfgResult.text); } catch (_) {} }
  S.scheduler = schResult.text ? JSON.parse(schResult.text) : {};

  const deckFiles = files.filter((f) => f.name.endsWith(".json") && f.name !== "index.json");
  const deckResults = await Promise.all(
    deckFiles.map((f) =>
      ghGetFile(`cards/${f.name}`).then(({ text, sha }) => ({
        slug: f.name.replace(/\.json$/, ""),
        obj: JSON.parse(text),
        sha,
      }))
    )
  );
  S.decks = {};
  for (const { slug, obj, sha } of deckResults) S.decks[slug] = { ...obj, sha };

  S.loaded = true;
  await persistLocal();
}

async function loadFromRelative() {
  // Read-only over plain HTTP (public Pages / local dev), no PAT needed.
  const [idxRes, schRes, cfgRes] = await Promise.all([
    fetch("../cards/index.json", { cache: "no-store" }),
    fetch("../state/scheduler.json", { cache: "no-store" }).catch(() => null),
    fetch("../config.json", { cache: "no-store" }).catch(() => null),
  ]);
  if (!idxRes.ok) throw new Error("no cards/index.json");
  const slugs = (await idxRes.json()).decks || [];
  if (cfgRes?.ok) { try { S.config = await cfgRes.json(); } catch (_) {} }
  S.scheduler = (schRes?.ok) ? await schRes.json() : {};

  const deckResults = await Promise.all(
    slugs.map((slug) =>
      fetch(`../cards/${slug}.json`, { cache: "no-store" })
        .then((r) => r.ok ? r.json().then((obj) => ({ slug, obj })) : null)
    )
  );
  S.decks = {};
  for (const item of deckResults) {
    if (item) S.decks[item.slug] = { ...item.obj, sha: null };
  }
  S.loaded = true;
  await persistLocal();
}

// ---------- FSRS helpers ----------
function hydrate(stored) {
  const c = stored ? { ...stored } : createEmptyCard(new Date());
  c.due = new Date(c.due);
  c.last_review = c.last_review ? new Date(c.last_review) : undefined;
  return c;
}
function dehydrate(card) {
  return {
    due: card.due.toISOString(),
    stability: card.stability, difficulty: card.difficulty,
    elapsed_days: card.elapsed_days, scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps ?? 0,
    reps: card.reps, lapses: card.lapses, state: card.state,
    last_review: card.last_review ? new Date(card.last_review).toISOString() : null,
  };
}
function isDue(id, when = new Date()) {
  const s = S.scheduler[id];
  if (!s) return true;
  if (s.state === State.New) return true;
  return new Date(s.due) <= when;
}
function allCards() {
  const out = [];
  for (const slug in S.decks) {
    const d = S.decks[slug];
    for (const c of d.cards) {
      out.push({ ...c, _slug: slug });
      if (d.domain === "language" && !c.suspended) {
        const revId = c.id + "~rev";
        if (!S.scheduler[revId]) {
          S.scheduler[revId] = dehydrate(createEmptyCard(new Date()));
          S.schedulerDirty = true;
        }
        out.push({ ...c, _slug: slug, id: revId, _reverse: true, _origId: c.id });
      }
    }
  }
  return out;
}
function dueQueue(filterSlug = null) {
  const now = new Date();
  return allCards()
    .filter((c) => !c.suspended && isDue(c.id, now) && (!filterSlug || c._slug === filterSlug))
    .sort((a, b) => {
      const sa = S.scheduler[a.id], sb = S.scheduler[b.id];
      const na = !sa || sa.state === State.New, nb = !sb || sb.state === State.New;
      if (na !== nb) return na ? 1 : -1;
      return new Date(sa?.due || 0) - new Date(sb?.due || 0);
    });
}
function gradeCard(id, rating) {
  const card = hydrate(S.scheduler[id]);
  const { card: next } = F.next(card, new Date(), rating);
  S.scheduler[id] = dehydrate(next);
  S.schedulerDirty = true;
  S.pendingReviews.push(JSON.stringify({ id, grade: rating, ts: nowISO() }));
}

// ---------- rendering (XSS-safe markdown + math) ----------
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function mdToHtml(text) {
  if (!text) return "";
  if (!window.DOMPurify) {
    toast("DOMPurify not loaded — refresh page", 4000);
    return "[Rendering unavailable]";
  }
  // 1. Pull out fenced code blocks first so nothing else rewrites their contents.
  const blocks = [];
  let h = text.replace(/```[ \t]*([\w+-]*)\r?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = blocks.length;
    const label = lang ? `<div class="code-lang">${escapeHtml(lang)}</div>` : "";
    blocks.push(`${label}<pre class="code"><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return ` B${i} `;
  });

  // 2. Protect inline code spans too.
  const inlines = [];
  h = h.replace(/`([^`\n]+)`/g, (_, code) => {
    const i = inlines.length;
    inlines.push(`<code class="inline">${escapeHtml(code)}</code>`);
    return ` I${i} `;
  });

  // 3. Extract markdown tables (runs of lines starting with |) before escaping.
  const tables = [];
  {
    const tlines = h.split("\n");
    const out = [];
    let buf = [];
    const isSep = (r) => /^\|[\s|:-]+\|$/.test(r.trim());
    const parseCells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const flushBuf = () => {
      if (buf.length < 2) { out.push(...buf); buf = []; return; }
      const si = buf.findIndex(isSep);
      if (si < 0) { out.push(...buf); buf = []; return; }
      const hdr = si > 0 ? buf[si - 1] : null;
      const rows = buf.filter((_, idx) => idx !== si && idx !== si - 1);
      let t = `<div class="tbl-wrap"><table class="md-table">`;
      if (hdr)
        t += `<thead><tr>` + parseCells(hdr).map((c) => `<th>${escapeHtml(c)}</th>`).join("") + `</tr></thead>`;
      t += "<tbody>";
      for (const row of rows) t += `<tr>` + parseCells(row).map((c) => `<td>${escapeHtml(c)}</td>`).join("") + `</tr>`;
      t += "</tbody></table></div>";
      const ti = tables.length; tables.push(t);
      out.push(` T${ti} `); buf = [];
    };
    for (const line of tlines) {
      if (line.trimStart().startsWith("|")) buf.push(line);
      else { if (buf.length) flushBuf(); out.push(line); }
    }
    if (buf.length) flushBuf();
    h = out.join("\n");
  }

  // 4. Escape everything else, then apply lightweight markdown.
  h = escapeHtml(h)
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => "\\[" + m.replace(/\n/g, " ") + "\\]")
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, m) => "$$" + m.replace(/\n/g, " ") + "$$")
    .replace(/^###?\s+(.+)$/gm, "<h4>$1</h4>")
    .replace(/^\s*[-*]\s+(.+)$/gm, "<div class=\"li\">\u2022 $1</div>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br>");

  // 5. Restore protected spans/blocks.
  h = h.replace(/ I(\d+) /g, (_, i) => inlines[Number(i)])
       .replace(/ T(\d+) (<br>)?/g, (_, i) => tables[Number(i)])
       .replace(/ B(\d+) (<br>)?/g, (_, i) => blocks[Number(i)]);
  return DOMPurify.sanitize(h);
}
function renderMath(el) {
  if (window.renderMathInElement) {
    try {
      renderMathInElement(el, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
        ],
        throwOnError: false,
      });
    } catch (_) {}
  }
}

// ---------- pronunciation ----------
function langCodeFromCard(card) {
  const langTag = (card.tags || []).find((t) => t.startsWith("lang::"));
  if (langTag) return langTag.slice(6);
  // Infer from deck name: Language::Turkish → tr, Language::Japanese → ja
  const deck = card._deck || (card._slug ? S.decks[card._slug]?.deck : null) || "";
  const sub = deck.split("::")[1]?.toLowerCase();
  const map = { turkish: "tr", english: "en", japanese: "ja", french: "fr", german: "de",
    spanish: "es", portuguese: "pt", arabic: "ar", chinese: "zh", korean: "ko" };
  return map[sub] || null;
}

function isLanguageCard(card) {
  const dom = card._slug ? S.decks[card._slug]?.domain : null;
  if (dom === "language") return true;
  if ((card.tags || []).some((t) => t.startsWith("lang::"))) return true;
  return !!langCodeFromCard(card);
}

// Voices load asynchronously in most browsers — resolve once they're ready.
function voicesReady() {
  return new Promise((resolve) => {
    const v = speechSynthesis.getVoices();
    if (v.length) return resolve(v);
    speechSynthesis.onvoiceschanged = () => resolve(speechSynthesis.getVoices());
    setTimeout(() => resolve(speechSynthesis.getVoices()), 1000);
  });
}

async function speak(text, lang) {
  if (!text) return;
  try {
    const voices = await voicesReady();
    const u = new SpeechSynthesisUtterance(text);
    if (lang) {
      u.lang = lang;
      // Pick a voice whose language matches (e.g. "ja", "ja-JP") so it's not read with an English accent.
      const match = voices.find((v) => v.lang?.toLowerCase().startsWith(lang.toLowerCase()))
        || voices.find((v) => v.lang?.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
      if (match) u.voice = match;
    }
    u.rate = 0.9;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (_) {}
}

async function playPronunciation(card, what = "word") {
  const lang = langCodeFromCard(card);
  const word = card.front?.trim();
  const target = what === "example" ? (card.example || word) : word;
  // For English single words, try the free Dictionary API for real human audio first.
  if ((!lang || lang === "en") && what === "word") {
    try {
      const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      if (r.ok) {
        const j = await r.json();
        const ph = j?.[0]?.phonetics?.find((p) => p.audio);
        if (ph?.audio) { new Audio(ph.audio).play(); return; }
      }
    } catch (_) {}
  }
  speak(target, lang);
}

function cardBodyHtml(c) {
  const grounding = (c.tags || []).find((t) => t.startsWith("grounding::")) || "";
  let html = `<div class="answer">${mdToHtml(c.answer)}</div>`;
  if (c.math) {
    html += `<div class="answer math-block">${DOMPurify.sanitize(c.math)}</div>`;
  }
  if (c.code) html += `<pre class="code"><code>${escapeHtml(c.code)}</code></pre>`;
  const langCard = isLanguageCard(c);
  if (c.example || c.ipa || langCard) {
    const ipaHtml = c.ipa ? `<span class="ipa"> /${c.ipa}/</span>` : "";
    const exHtml = c.example ? `<em>${mdToHtml(c.example)}</em>` : "";
    const wordBtn = langCard ? `<button class="speak" data-speak="word" title="Pronounce word">🔊</button>` : "";
    const exBtn = (langCard && c.example) ? `<button class="speak" data-speak="example" title="Pronounce sentence">🔊 sentence</button>` : "";
    html += `<div class="answer lang-row">${exHtml}${ipaHtml}${wordBtn}${exBtn}</div>`;
  }
  if (c.cloze) {
    html += `<div class="cloze"><b>Fill in:</b> ${DOMPurify.sanitize(c.cloze)}</div>`;
  }
  if (c.note) html += `<div class="note"><b>💡 Note:</b> ${mdToHtml(c.note)}</div>`;
  if (c.application) {
    const illus = grounding === "grounding::model"
      ? ` <span class="illus">(illustrative)</span>` : "";
    const link = c.application_url
      ? ` <a href="${DOMPurify.sanitize(c.application_url)}" target="_blank" rel="noopener noreferrer">source ↗</a>` : "";
    html += `<div class="practice"><b>🛠 In practice:</b>${illus} ${mdToHtml(c.application)}${link}</div>`;
  }
  if (c.source_text) {
    html += `<details class="src"><summary>📖 ${DOMPurify.sanitize(c.source || "")}</summary>
      <div class="answer">${mdToHtml(c.source_text)}</div></details>`;
  } else if (c.source) {
    html += `<div class="src muted" style="font-size:13px">📖 ${DOMPurify.sanitize(c.source)}</div>`;
  }
  html += `<div class="tags-row">${(c.tags || []).map((t) => `<span class="tag">${DOMPurify.sanitize(t)}</span>`).join("")}</div>`;
  return html;
}

// ---------- tutor button label ----------
function tutorBtnLabel() {
  return "💬 Ask Tutor";
}

// ---------- tutor ----------
// Card grounding goes into the system prompt once; the conversation itself
// stays a clean user/assistant exchange so follow-up questions keep context.
function cardSystemPrompt(card, maxChars) {
  const src = card.source_text ? card.source_text.slice(0, 300) : "";
  const context = [card.source, src, card.note].filter(Boolean).join("\n");
  let prompt =
    "You are a concise study tutor for one flashcard. Explain clearly, grounded in the source. " +
    "Add intuition and examples. Don't invent facts without flagging them.\n\n" +
    `Q: ${card.front}\nA: ${card.answer}` +
    (context ? `\n\nCONTEXT:\n${context}` : "");
  if (maxChars && prompt.length > maxChars) prompt = prompt.slice(0, maxChars);
  return prompt;
}

// ~4 chars per token rough estimate; keep conversation under model context budget
function trimHistory(history, maxChars) {
  let total = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    total += history[i].content.length;
    if (total > maxChars) return history.slice(i + 1);
  }
  return history;
}

// history: array of { role: "user" | "assistant", content } — full conversation so far.
async function askTutor(card, history, modelOverride) {
  const model = modelOverride || SET.model || S.config?.tutor?.default_model || "groq/llama-3.3-70b-versatile";
  const mcfg = (S.config?.tutor?.models || []).find((m) => m.id === model) || {};
  const maxTokens = mcfg.max_tokens || 700;
  const ctxWindow = mcfg.context_window || 8192;
  // ~4 chars per token; reserve space for system prompt + response
  const ctxChars = ctxWindow * 4;
  const sysMaxChars = Math.min(Math.floor(ctxChars * 0.5), 4000);
  const system = cardSystemPrompt(card, sysMaxChars);
  const histBudget = ctxChars - system.length - maxTokens * 4;
  const trimmed = trimHistory(history, Math.max(histBudget, 800));

  S.pendingTutor.push(JSON.stringify({ id: card.id, model, ts: nowISO() }));
  persistLocal(); syncSoon();

  if (!SET.tutorKey) throw new Error("No Groq API key set — add one in Settings.");
  const groqModel = model.startsWith("groq/") ? model.slice(5) : model;

  async function doFetch(sys, hist) {
    return fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SET.tutorKey}` },
      body: JSON.stringify({
        model: groqModel, max_tokens: maxTokens,
        messages: [{ role: "system", content: sys }, ...hist],
      }),
    });
  }

  let r = await doFetch(system, trimmed);

  // 413 = request too large — retry with aggressive truncation
  if (r.status === 413) {
    const smallSys = cardSystemPrompt(card, 1200);
    const smallHist = trimHistory(trimmed, 800);
    r = await doFetch(smallSys, smallHist);
  }

  if (!r.ok) {
    const body = await r.text();
    const short = body.length > 200 ? body.slice(0, 200) + "…" : body;
    throw new Error(`Groq ${r.status}: ${short}`);
  }
  return (await r.json()).choices[0].message.content;
}

// ---------- sync ----------
let online = navigator.onLine;
let syncTimer;
function syncSoon() { clearTimeout(syncTimer); syncTimer = setTimeout(sync, 1200); }

async function appendLog(path, lines) {
  if (!lines.length) return;
  const { text, sha } = await ghGetFile(path);
  const body = (text || "") + lines.map((l) => l + "\n").join("");
  await ghPutFile(path, body, sha, `recall: append ${lines.length} to ${path}`);
}

async function sync() {
  if (!online || !SET.owner || !SET.pat) { updatePill(); return; }
  try {
    for (const slug of [...S.dirtyDecks]) {
      const d = S.decks[slug];
      const cur = await ghGetFile(`cards/${slug}.json`);
      const text = JSON.stringify({ deck: d.deck, domain: d.domain, cards: d.cards }, null, 2) + "\n";
      d.sha = await ghPutFile(`cards/${slug}.json`, text, cur.sha, `recall: update ${slug}`);
      S.dirtyDecks.delete(slug);
    }
    if (S.indexDirty) {
      const cur = await ghGetFile("cards/index.json");
      const slugs = Object.keys(S.decks).sort();
      await ghPutFile("cards/index.json", JSON.stringify({ decks: slugs }, null, 2) + "\n",
        cur.sha, "recall: update deck index");
      S.indexDirty = false;
    }
    if (S.schedulerDirty) {
      const cur = await ghGetFile("state/scheduler.json");
      await ghPutFile("state/scheduler.json", JSON.stringify(S.scheduler, null, 2) + "\n",
        cur.sha, "recall: update scheduler");
      S.schedulerDirty = false;
    }
    if (S.pendingReviews.length) { await appendLog("state/reviews.jsonl", S.pendingReviews); S.pendingReviews = []; }
    if (S.pendingTutor.length) { await appendLog("state/tutor_calls.jsonl", S.pendingTutor); S.pendingTutor = []; }
    await persistLocal();
    toast("Synced ✓");
  } catch (e) {
    toast("Sync deferred: " + e.message);
  }
  updatePill();
}

function pendingCount() {
  return S.dirtyDecks.size + (S.schedulerDirty ? 1 : 0) + (S.indexDirty ? 1 : 0)
    + S.pendingReviews.length + S.pendingTutor.length;
}
function updatePill() {
  const pill = $("#syncPill");
  const n = pendingCount();
  if (!SET.owner || !SET.pat) { pill.textContent = "setup"; pill.className = "pill off"; return; }
  if (!online) { pill.textContent = `offline · ${n}`; pill.className = "pill off"; return; }
  pill.textContent = n ? `${n} to sync` : "synced";
  pill.className = n ? "pill" : "pill ok";
}

// ---------- views ----------
let activeTab = "review";
let reviewDeckFilter = "";  // slug or "" for all

function renderTabs() {
  document.querySelectorAll("nav.tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === activeTab));
}

function render() {
  renderTabs();
  updatePill();
  if (!S.loaded && (!SET.owner || !SET.pat)) { activeTab = "settings"; renderTabs(); return viewSettings(); }
  if (!S.loaded) { view.innerHTML = `<p class="muted">Loading…</p>`; return; }
  ({ review: viewReview, browse: viewBrowse, import: viewImport, settings: viewSettings }[activeTab])();
}

// --- Review ---
let reviewState = null;

function viewReview() {
  updateBadge();
  const slugs = Object.keys(S.decks).sort();
  const deckOpts = `<option value="">All decks</option>` +
    slugs.map((s) => {
      const due = S.decks[s].cards.filter((c) => !c.suspended && isDue(c.id)).length;
      return `<option value="${s}" ${s === reviewDeckFilter ? "selected" : ""}>${S.decks[s].deck} (${due} due)</option>`;
    }).join("");

  const q = dueQueue(reviewDeckFilter || null);
  if (!q.length) {
    view.innerHTML = `
      <div style="margin-bottom:8px">
        <select id="deckFilter" style="width:100%">${deckOpts}</select></div>
      <div class="card center">
        <div class="big">✓</div>
        <h2>All caught up</h2>
        <p class="muted">${allCards().length} cards in your decks. Nothing due right now.</p>
      </div>`;
    $("#deckFilter").onchange = (e) => { reviewDeckFilter = e.target.value; viewReview(); };
    return;
  }
  reviewState = { queue: q, idx: 0, revealed: false, deckOpts };
  showReviewCard();
}

function reverseCardBody(c) {
  let html = `<div class="answer" style="font-size:20px;font-weight:600">${mdToHtml(c.front)}</div>`;
  if (c.ipa) html += `<div class="ipa" style="margin-top:4px">/${DOMPurify.sanitize(c.ipa)}/</div>`;
  const langCard = isLanguageCard(c);
  if (langCard) {
    html += `<div class="answer lang-row" style="margin-top:8px">
      <button class="speak" data-speak="word" title="Pronounce word">🔊</button>
      ${c.example ? `<button class="speak" data-speak="example" title="Pronounce sentence">🔊 sentence</button>` : ""}
    </div>`;
  }
  if (c.example) html += `<div class="answer" style="margin-top:8px"><em>${mdToHtml(c.example)}</em></div>`;
  if (c.note) html += `<div class="note"><b>💡 Note:</b> ${mdToHtml(c.note)}</div>`;
  return html;
}

function showReviewCard() {
  const { queue, idx, revealed, deckOpts } = reviewState;
  const c = queue[idx];
  const isRev = !!c._reverse;
  const remaining = queue.length - idx;
  const askLabel = tutorBtnLabel();

  const frontContent = isRev
    ? `<span class="muted" style="font-size:12px">🔄 Produce the German word</span><div style="margin-top:6px">${mdToHtml(c.answer)}</div>`
    : `${mdToHtml(c.front)}${isLanguageCard(c) ? ` <button class="speak" id="frontSpeak" title="Pronounce">🔊</button>` : ""}`;

  const promptsHtml = !isRev && c.prompts && c.prompts.length
    ? `<div class="prompts muted" style="margin-top:8px;font-size:13px">${c.prompts.map(p => `<span class="prompt-tag">${DOMPurify.sanitize(p)}</span>`).join(" · ")}</div>`
    : "";

  const backContent = revealed
    ? (isRev ? reverseCardBody(c) : cardBodyHtml(c))
    : "";

  view.innerHTML = `
    <div style="margin-bottom:8px">
      <select id="deckFilter" style="width:100%">${deckOpts}</select></div>
    <div class="row" style="margin-bottom:6px">
      <span class="pill">${remaining} due</span>
      ${isRev ? `<span class="pill" style="color:var(--accent);border-color:var(--accent2)">🔄 reverse</span>` : ""}
      <span class="grow"></span>
      <button class="ghost" id="suspendBtn">Suspend</button>
      <button class="ghost" id="editBtn">Edit</button></div>
    <div class="card">
      <div class="front">${frontContent}</div>
      ${promptsHtml}
      <div id="back" class="${revealed ? "" : "hidden"}">${backContent}</div>
      ${revealed ? "" : `<div class="grades"><button class="primary" id="showBtn" style="grid-column:1/-1;min-height:44px">Show answer</button></div>`}
      ${revealed ? `<div class="grades">
        <button class="g-again" data-r="1">Again</button>
        <button class="g-hard" data-r="2">Hard</button>
        <button class="g-good" data-r="3">Good</button>
        <button class="g-easy" data-r="4">Easy</button></div>
        <div class="row" style="margin-top:10px">
          <button class="ghost" id="askBtn">${askLabel}</button></div>
        <div id="tutorOut"></div>` : ""}
    </div>`;

  $("#deckFilter").onchange = (e) => {
    reviewDeckFilter = e.target.value;
    viewReview();
  };
  renderMath($("#back"));
  const frontSpeakBtn = $("#frontSpeak");
  if (frontSpeakBtn) frontSpeakBtn.onclick = () => playPronunciation(c, "word");
  if (!revealed) {
    $("#showBtn").onclick = () => { reviewState.revealed = true; showReviewCard(); };
  } else {
    document.querySelectorAll(".grades button[data-r]").forEach((b) =>
      b.onclick = () => doGrade(c, Number(b.dataset.r)));
    $("#askBtn").onclick = () => askUI(c, $("#tutorOut"));
    document.querySelectorAll("#back [data-speak]").forEach((b) =>
      b.onclick = () => playPronunciation(c, b.dataset.speak));
  }
  const origId = c._origId || c.id;
  const origSlug = c._slug;
  $("#suspendBtn").onclick = () => {
    const origCard = { ...c, id: origId, _slug: origSlug };
    setSuspended(origCard, true);
    nextCard();
  };
  $("#editBtn").onclick = () => openEditor(origSlug, origId);
}

function doGrade(c, r) {
  gradeCard(c.id, r);
  persistLocal(); syncSoon();
  updateBadge();
  nextCard();
}
function nextCard() {
  reviewState.idx += 1; reviewState.revealed = false;
  if (reviewState.idx >= reviewState.queue.length) return viewReview();
  showReviewCard();
}
function setSuspended(c, val) {
  const deck = S.decks[c._slug];
  const card = deck.cards.find((x) => x.id === c.id);
  card.suspended = val;
  S.dirtyDecks.add(c._slug);
  persistLocal(); syncSoon();
}

// --- Ask UI (tutor chat) ---
// Multi-turn: the thread scrolls inside its own fixed-height box so the page
// doesn't grow, and follow-up questions keep the full conversation context.
function askUI(card, outEl) {
  const models = S.config?.tutor?.models || [{ id: "groq/llama-3.3-70b-versatile", label: "Llama 3.3 70B (free)" }];
  const fallback = S.config?.tutor?.default_model || models[0].id;
  let selectedModel = SET.model || fallback;
  // Heal stale/removed selections (e.g. an old Claude model still in localStorage).
  if (!models.some((m) => m.id === selectedModel)) { selectedModel = fallback; SET.set("tutor_model", selectedModel); }
  const convo = [];      // [{ role:"user"|"assistant", content }]
  let busy = false;

  outEl.innerHTML = `
    <div class="card tutor-card">
      <div class="row" style="gap:6px;margin-bottom:8px">
        <span class="muted" style="font-size:12px">💬 Tutor chat</span>
        <span class="grow"></span>
        <button class="ghost btn-sm" id="modelToggle">⚙ ${models.find(m=>m.id===selectedModel)?.label || selectedModel}</button>
        <button class="ghost btn-sm" id="chatClear" title="Clear conversation">🗑</button>
      </div>
      <div id="modelSel" class="hidden" style="margin-bottom:8px">
        <select id="askModel">${models.map((m) =>
          `<option value="${m.id}" ${m.id === selectedModel ? "selected" : ""}>${m.label}</option>`).join("")}</select>
      </div>
      <div id="chatThread" class="chat-thread"></div>
      <div class="chat-input">
        <textarea id="askQ" placeholder="Ask about this card… (Enter to send)" rows="1"></textarea>
        <button class="primary" id="askGo">Send</button>
      </div>
    </div>`;

  const thread = $("#chatThread");

  function renderThread() {
    if (!convo.length) {
      thread.innerHTML = `<p class="muted" style="font-size:13px;margin:4px 2px">Ask a question to start. Follow-ups keep the context.</p>`;
      return;
    }
    thread.innerHTML = convo.map((m) =>
      m.role === "user"
        ? `<div class="msg msg-user">${mdToHtml(m.content)}</div>`
        : `<div class="msg msg-bot">${mdToHtml(m.content)}</div>`
    ).join("");
    renderMath(thread);
    thread.scrollTop = thread.scrollHeight;
  }
  renderThread();

  $("#modelToggle").onclick = () => $("#modelSel").classList.toggle("hidden");
  $("#askModel").onchange = (e) => {
    selectedModel = e.target.value;
    SET.set("tutor_model", selectedModel);
    $("#modelToggle").textContent = `⚙ ${models.find(m=>m.id===selectedModel)?.label || selectedModel}`;
  };
  $("#chatClear").onclick = () => { convo.length = 0; renderThread(); $("#askQ").focus(); };

  async function send() {
    if (busy) return;
    const qv = $("#askQ").value.trim(); if (!qv) return;
    $("#askQ").value = "";
    convo.push({ role: "user", content: qv });
    convo.push({ role: "assistant", content: "⏳ …" });
    busy = true; renderThread();
    try {
      // Strip error messages from history before sending — they poison context
      const clean = convo.slice(0, -1).filter((m) => !m._error);
      const ans = await askTutor(card, clean, selectedModel);
      convo[convo.length - 1] = { role: "assistant", content: ans };
    } catch (e) {
      convo[convo.length - 1] = { role: "assistant", content: "⚠ " + e.message, _error: true };
    }
    busy = false; renderThread();
  }

  $("#askGo").onclick = send;
  const ta = $("#askQ");
  ta.focus();
  // Enter sends; Shift+Enter makes a newline. Auto-grow up to a few rows.
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };
  ta.oninput = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 96) + "px"; };
}

// --- Browse ---
function viewBrowse() {
  const slugs = Object.keys(S.decks).sort();

  // Group by top-level deck domain (first "::" segment)
  const groups = {};
  for (const s of slugs) {
    const d = S.decks[s];
    const top = d.deck.split("::")[0] || "Other";
    if (!groups[top]) groups[top] = [];
    groups[top].push(s);
  }

  const groupHtml = Object.keys(groups).sort().map((top) => {
    const decksHtml = groups[top].map((s) => {
      const d = S.decks[s];
      const due = d.cards.filter((c) => !c.suspended && isDue(c.id)).length;
      const cardsHtml = d.cards.map((c) =>
        `<div class="browse-row"><span style="flex:1;font-size:14px">${DOMPurify.sanitize(c.front)}</span>
         <button class="ghost btn-sm" data-edit="${s}|${c.id}">edit</button></div>`
      ).join("");
      return `<details class="deck-item">
        <summary class="deck-summary">
          <span class="deck-name">${DOMPurify.sanitize(d.deck)}</span>
          <span class="deck-meta"><span class="pill">${d.cards.length}</span><span class="pill ${due ? "" : "ok"}">${due} due</span></span>
        </summary>
        <div class="deck-cards">${cardsHtml}</div>
      </details>`;
    }).join("");
    return `<details class="domain-group" open>
      <summary class="domain-summary">${DOMPurify.sanitize(top)}</summary>
      ${decksHtml}
    </details>`;
  }).join("");

  view.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <h2 style="margin:0">Browse</h2>
      <span class="grow"></span>
      <button class="ghost" id="newDeckBtn">＋ New deck</button>
      <button class="primary" id="addCardBtn">＋ Card</button>
    </div>
    ${slugs.length ? groupHtml : `<p class="muted">No decks yet — use the <code>/recall-cards</code> skill in Claude, then come back to Import.</p>`}`;

  $("#addCardBtn").onclick = () => openEditor(null, null);
  $("#newDeckBtn").onclick = () => newDeckDialog();
  document.querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => {
    const [slug, id] = b.dataset.edit.split("|"); openEditor(slug, id);
  });
}

function newDeckDialog() {
  view.innerHTML = `
    <div class="row"><h2 style="margin:0">New deck</h2>
      <span class="grow"></span><button class="ghost" id="cancelBtn">Cancel</button></div>
    <div class="card">
      <label>Deck name (use :: for hierarchy)</label>
      <input id="nDeckName" placeholder="CS::MyTopic" />
      <label>Domain</label>
      <select id="nDomain">
        <option value="cs">CS</option>
        <option value="finance">Finance</option>
        <option value="language">Language</option>
        <option value="general">Other</option>
      </select>
      <div class="row end" style="margin-top:12px">
        <button class="primary" id="createDeckBtn">Create</button></div>
    </div>`;
  $("#cancelBtn").onclick = () => { activeTab = "browse"; render(); };
  $("#createDeckBtn").onclick = () => {
    const name = $("#nDeckName").value.trim();
    if (!name) return toast("Enter a deck name");
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (S.decks[slug]) return toast("Deck already exists");
    S.decks[slug] = { deck: name, domain: $("#nDomain").value, cards: [] };
    S.indexDirty = true;
    persistLocal(); syncSoon();
    toast(`Deck "${name}" created`);
    activeTab = "browse"; render();
  };
}

function openEditor(slug, id) {
  const deck = slug ? S.decks[slug] : null;
  const c = deck && id ? deck.cards.find((x) => x.id === id) : {};
  const esc = (k) => (c && c[k]) ? String(c[k]).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;") : "";
  const deckOptions = Object.keys(S.decks).map((s) =>
    `<option value="${s}" ${s === slug ? "selected" : ""}>${S.decks[s].deck}</option>`).join("");
  view.innerHTML = `
    <div class="row"><h2 style="margin:0">${id ? "Edit card" : "New card"}</h2>
      <span class="grow"></span><button class="ghost" id="cancelBtn">Cancel</button></div>
    <div class="card">
      <label>Deck</label>
      <select id="eDeck">${deckOptions}${slug ? "" : `<option value="" selected>(pick a deck)</option>`}</select>
      <label>Front (question)</label><textarea id="eFront">${esc("front")}</textarea>
      <label>Answer</label><textarea id="eAnswer">${esc("answer")}</textarea>
      <label>💡 Note (intuition / gotcha)</label><textarea id="eNote">${esc("note")}</textarea>
      <label>🛠 In practice (optional)</label><textarea id="eApp">${esc("application")}</textarea>
      <label>Code (optional)</label><textarea id="eCode" style="font-family:monospace;font-size:13px">${esc("code")}</textarea>
      <label>Math / LaTeX (optional)</label><textarea id="eMath">${esc("math")}</textarea>
      <label>IPA pronunciation (language cards)</label><input id="eIpa" value="${esc("ipa")}" placeholder="/fonetik/" />
      <label>Example sentence (language cards)</label><textarea id="eExample">${esc("example")}</textarea>
      <label>Source</label><input id="eSource" value="${esc("source")}" placeholder="OSTEP ch28 §locks" />
      <details style="margin-top:6px">
        <summary style="cursor:pointer;color:var(--muted);font-size:13px">📖 Source text (verbatim quote)</summary>
        <textarea id="eSourceText" style="margin-top:6px">${esc("source_text")}</textarea>
      </details>
      <label style="margin-top:10px">Tags (space-separated)</label>
      <input id="eTags" value="${(c?.tags || []).join(" ")}" placeholder="recall::definition diff::2 cs::concurrency" />
      <div class="row end" style="margin-top:12px">
        ${id ? `<button class="ghost" id="delBtn" style="color:var(--bad)">Delete</button>` : ""}
        <button class="primary" id="saveBtn">Save</button></div>
    </div>`;
  $("#cancelBtn").onclick = () => { activeTab = "browse"; render(); };
  if (id) $("#delBtn").onclick = () => {
    if (!confirm("Delete this card?")) return;
    deck.cards = deck.cards.filter((x) => x.id !== id);
    S.dirtyDecks.add(slug); persistLocal(); syncSoon();
    activeTab = "browse"; render();
  };
  $("#saveBtn").onclick = () => {
    const targetSlug = $("#eDeck").value;
    if (!targetSlug) return toast("Pick a deck");
    const tgt = S.decks[targetSlug];
    const card = id ? tgt.cards.find((x) => x.id === id) : { id: nextId(targetSlug) };
    card.front = $("#eFront").value.trim();
    card.answer = $("#eAnswer").value.trim();
    card.note = $("#eNote").value.trim() || null;
    card.application = $("#eApp").value.trim() || null;
    card.code = $("#eCode").value.trim() || null;
    card.math = $("#eMath").value.trim() || null;
    card.ipa = $("#eIpa").value.trim() || null;
    card.example = $("#eExample").value.trim() || null;
    card.source = $("#eSource").value.trim() || null;
    card.source_text = $("#eSourceText").value.trim() || null;
    card.tags = $("#eTags").value.trim().split(/\s+/).filter(Boolean);
    if (!id) { tgt.cards.push(card); S.scheduler[card.id] = dehydrate(createEmptyCard(new Date())); S.schedulerDirty = true; }
    S.dirtyDecks.add(targetSlug); persistLocal(); syncSoon();
    activeTab = "browse"; render();
  };
}
function nextId(slug) {
  const ids = S.decks[slug].cards.map((c) => c.id);
  let n = 1;
  while (ids.includes(`${slug}-${String(n).padStart(3, "0")}`)) n++;
  return `${slug}-${String(n).padStart(3, "0")}`;
}

// --- Import ---
function viewImport() {
  view.innerHTML = `
    <h2>Import cards</h2>
    <p class="muted">Paste the JSON block generated by the <code>/recall-cards</code> skill. New cards are added; existing ids are updated (idempotent).</p>
    <textarea id="impText" style="min-height:220px" placeholder='{ "deck": "CS::OSTEP::ch29", "domain": "cs", "cards": [ ... ] }'></textarea>
    <div class="row end" style="margin-top:10px"><button class="primary" id="impGo">Import</button></div>
    <div id="impOut"></div>`;
  $("#impGo").onclick = () => {
    let obj;
    try { obj = JSON.parse($("#impText").value); }
    catch (e) { return ($("#impOut").innerHTML = `<p class="muted">⚠ Invalid JSON: ${DOMPurify.sanitize(e.message)}</p>`); }
    try {
      const res = importDeck(obj);
      $("#impOut").innerHTML = `<div class="note" style="border-color:var(--good);color:var(--fg)">
        ${res.added} added, ${res.updated} updated in <b>${DOMPurify.sanitize(res.deck)}</b>. Syncing…</div>`;
    } catch (e) {
      $("#impOut").innerHTML = `<p class="muted">⚠ ${DOMPurify.sanitize(e.message)}</p>`;
    }
  };
}
function importDeck(obj) {
  if (!obj.deck || !Array.isArray(obj.cards)) throw new Error("missing deck/cards fields");
  const slug = obj.deck.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!S.decks[slug]) { S.decks[slug] = { deck: obj.deck, domain: obj.domain || "general", cards: [] }; S.indexDirty = true; }
  const d = S.decks[slug];
  let added = 0, updated = 0;
  for (const c of obj.cards) {
    if (!c.id) c.id = nextId(slug);
    const ix = d.cards.findIndex((x) => x.id === c.id);
    if (ix >= 0) { d.cards[ix] = { ...d.cards[ix], ...c }; updated++; }
    else {
      d.cards.push(c); added++;
      if (!S.scheduler[c.id]) { S.scheduler[c.id] = dehydrate(createEmptyCard(new Date())); S.schedulerDirty = true; }
    }
  }
  S.dirtyDecks.add(slug); persistLocal(); syncSoon();
  return { added, updated, deck: obj.deck };
}

// --- Settings ---
function viewSettings() {
  view.innerHTML = `
    <h2>Settings</h2>
    <div class="card">
      <p class="muted">Stored only on this device (localStorage). GitHub token needs <b>Contents: read &amp; write</b> on this repo only.</p>
      <label>GitHub owner</label><input id="sOwner" value="${SET.owner}" placeholder="utkusama0" />
      <label>Repo</label><input id="sRepo" value="${SET.repo}" placeholder="recall_agent" />
      <label>Branch</label><input id="sBranch" value="${SET.branch}" />
      <label>GitHub token (PAT)</label><input id="sPat" type="password" value="${SET.pat}" placeholder="github_pat_…" autocomplete="current-password" />
      <hr style="border-color:var(--border);margin:16px 0" />
      <label>Groq API key <span class="muted">(free at groq.com — powers the AI tutor)</span></label>
      <input id="sKey" type="password" value="${SET.tutorKey}" placeholder="gsk_…" autocomplete="current-password" />
      <hr style="border-color:var(--border);margin:16px 0" />
      <div class="row" style="gap:10px">
        <div style="flex:1">
          <b>Reminders</b><br/>
          <span class="muted" style="font-size:13px">Notify when cards are due</span>
        </div>
        <button id="notifToggle" class="${localStorage.getItem("notif_enabled") === "1" && Notification?.permission === "granted" ? "primary" : "ghost"}">${localStorage.getItem("notif_enabled") === "1" && Notification?.permission === "granted" ? "✓ Enabled" : "Enable"}</button>
      </div>
      <div class="row end" style="margin-top:14px">
        <button class="ghost" id="reloadBtn">↺ Reload from GitHub</button>
        <button class="primary" id="saveSet">Save</button></div>
    </div>
    <p class="muted center" style="margin-top:16px">RECALL · FSRS in-browser · ${allCards().length} cards loaded</p>`;
  $("#notifToggle").onclick = async () => {
    const ok = await requestNotifPermission();
    if (ok) toast("Reminders enabled ✓");
    viewSettings();
  };
  $("#saveSet").onclick = async () => {
    SET.set("gh_owner", $("#sOwner").value.trim());
    SET.set("gh_repo", $("#sRepo").value.trim());
    SET.set("gh_branch", $("#sBranch").value.trim() || "main");
    SET.set("gh_pat", $("#sPat").value.trim());
    SET.set("tutor_key", $("#sKey").value.trim());
    toast("Saved. Loading…");
    await boot(true);
    sendConfigToSW();
    activeTab = "review"; render();
  };
  $("#reloadBtn").onclick = async () => { toast("Reloading…"); await loadFromGitHub(); render(); };
}

// ---------- boot ----------
async function boot(force = false) {
  if (!force) await restoreLocal();
  try {
    const r = await fetch("../config.json", { cache: "no-store" });
    if (r.ok) {
      const cfg = await r.json(); S.config = cfg;
      if (!SET.owner && cfg.github?.owner) SET.set("gh_owner", cfg.github.owner);
      if (!SET.repo && cfg.github?.repo) SET.set("gh_repo", cfg.github.repo);
      if (cfg.github?.branch && !localStorage.getItem("gh_branch")) SET.set("gh_branch", cfg.github.branch);
    }
  } catch (_) {}
  if (force || !S.loaded || Object.keys(S.decks).length === 0) {
    try {
      if (SET.owner && SET.pat) await loadFromGitHub();
      else await loadFromRelative();
    } catch (e) { if (!S.loaded) toast("Load failed: " + e.message); }
  }
}

document.querySelectorAll("nav.tabs button").forEach((b) =>
  b.onclick = () => { activeTab = b.dataset.tab; render(); });
window.addEventListener("online", () => { online = true; updatePill(); sync(); });
window.addEventListener("offline", () => { online = false; updatePill(); });

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "NAVIGATE") {
      activeTab = e.data.tab || "review";
      render();
    }
  });
}

// ---------- app badge ----------
function updateBadge() {
  if (!("setAppBadge" in navigator)) return;
  const n = dueQueue().length;
  if (n > 0) navigator.setAppBadge(n).catch(() => {});
  else navigator.clearAppBadge().catch(() => {});
}

// ---------- send config to SW for periodic sync ----------
async function sendConfigToSW() {
  if (!("serviceWorker" in navigator) || !SET.owner || !SET.pat) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    reg.active.postMessage({
      type: "STORE_CONFIG",
      owner: SET.owner,
      repo: SET.repo,
      branch: SET.branch,
      pat: SET.pat,
    });
  } catch (_) {}
}

// ---------- notifications ----------
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches
    || navigator.standalone === true;
}

async function requestNotifPermission() {
  if (!("Notification" in window)) { toast("Notifications not supported"); return false; }
  if (!isStandalone()) { toast("Install the app first — add to home screen"); return false; }
  const perm = await Notification.requestPermission();
  if (perm === "granted") {
    localStorage.setItem("notif_enabled", "1");
    await registerPeriodicSync();
    return true;
  }
  toast("Notification permission denied");
  return false;
}

async function registerPeriodicSync() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if ("periodicSync" in reg) {
      await reg.periodicSync.register("recall-due", { minInterval: 86400000 });
    }
  } catch (_) {}
}

async function showDueNotification() {
  if (localStorage.getItem("notif_enabled") !== "1") return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const n = dueQueue().length;
  if (n === 0) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification("RECALL", {
      body: `${n} card${n === 1 ? "" : "s"} due for review`,
      tag: "recall-due",
      icon: "./icon.svg",
      badge: "./icon.svg",
      data: { tab: "review" },
    });
  } catch (_) {}
}

(async () => {
  await boot();
  render();
  if (pendingCount()) sync();
  updateBadge();
  sendConfigToSW();
  showDueNotification();
})();
