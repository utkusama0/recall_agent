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
  get proxy() { return localStorage.getItem("tutor_proxy") || ""; },
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
  for (const slug in S.decks)
    for (const c of S.decks[slug].cards) out.push({ ...c, _slug: slug });
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
function mdToHtml(text) {
  if (!text) return "";
  if (!window.DOMPurify) {
    toast("DOMPurify not loaded — refresh page", 4000);
    return "[Rendering unavailable]";
  }
  let h = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br>");
  return DOMPurify.sanitize(h);
}
function renderMath(el) {
  if (window.renderMathInElement) {
    try {
      renderMathInElement(el, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
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

function speak(text, lang) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    if (lang) u.lang = lang;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (_) {}
}
async function playPronunciation(card) {
  const lang = langCodeFromCard(card);
  const word = card.front?.trim();
  // For English, try the free Dictionary API for real audio first.
  if (!lang || lang === "en") {
    try {
      const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      if (r.ok) {
        const j = await r.json();
        const ph = j?.[0]?.phonetics?.find((p) => p.audio);
        if (ph?.audio) { new Audio(ph.audio).play(); return; }
      }
    } catch (_) {}
  }
  speak(card.example || word, lang);
}

function cardBodyHtml(c) {
  const grounding = (c.tags || []).find((t) => t.startsWith("grounding::")) || "";
  let html = `<div class="answer">${mdToHtml(c.answer)}</div>`;
  if (c.math) {
    html += `<div class="answer math-block">${DOMPurify.sanitize(c.math)}</div>`;
  }
  if (c.code) html += `<div class="code"><pre><code>${mdToHtml(c.code)}</code></pre></div>`;
  if (c.example || c.ipa) {
    const ipaHtml = c.ipa ? `<span class="ipa"> /${c.ipa}/</span>` : "";
    const exHtml = c.example ? `<em>${mdToHtml(c.example)}</em>` : "";
    html += `<div class="answer lang-row">${exHtml}${ipaHtml}
      <button class="speak" data-speak="1" title="Pronounce">🔊</button></div>`;
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
  const model = SET.model || S.config?.tutor?.default_model || "groq/llama-3.3-70b-versatile";
  if (model.startsWith("groq/")) return "💬 Ask Llama";
  if (model.startsWith("claude-")) return "💬 Ask Claude";
  return "💬 Ask Tutor";
}

// ---------- tutor ----------
async function askTutor(card, question, modelOverride) {
  const model = modelOverride || SET.model || S.config?.tutor?.default_model || "groq/llama-3.3-70b-versatile";
  const mcfg = (S.config?.tutor?.models || []).find((m) => m.id === model) || {};
  // Trim source_text to keep token count low for free-tier models.
  const srcSnippet = card.source_text ? card.source_text.slice(0, 400) : "";
  const grounding = [card.source, srcSnippet, card.answer, card.note]
    .filter(Boolean).join("\n");
  const system =
    "You are a study tutor. Explain the flashcard concept clearly and in depth, " +
    "grounded in the provided source. Add helpful intuition and a concrete example. " +
    "Be concise and pedagogical; do not invent facts beyond the source without flagging them.";
  const user = `CARD\nQ: ${card.front}\nA: ${card.answer}\n\nSOURCE/CONTEXT:\n${grounding}\n\nMY QUESTION: ${question}`;

  S.pendingTutor.push(JSON.stringify({ id: card.id, model, ts: nowISO() }));
  persistLocal(); syncSoon();

  // Route by model family — NOT by whether a proxy is configured.
  // Groq models always go direct to Groq (free key); only Claude models use the proxy.
  if (model.startsWith("groq/")) {
    if (!SET.tutorKey) throw new Error("No Groq API key set — add one in Settings.");
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SET.tutorKey}` },
      body: JSON.stringify({
        model: model.slice(5), max_tokens: mcfg.max_tokens || 700,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!r.ok) throw new Error(`Groq ${r.status}: ${await r.text()}`);
    return (await r.json()).choices[0].message.content;
  }

  // Claude (or any non-Groq) model → proxy only. Keys stay server-side.
  const proxyUrl = SET.proxy || S.config?.tutor?.proxy_url;
  if (!proxyUrl) throw new Error("Claude models require a proxy URL — set it in Settings or switch to a free Groq model.");
  const r = await fetch(proxyUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, system, user, card_id: card.id, question, max_tokens: mcfg.max_tokens || 700, effort: mcfg.effort }),
  });
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json()).error || ""; } catch (_) { try { detail = await r.text(); } catch (_) {} }
    throw new Error(`tutor proxy ${r.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  const j = await r.json();
  return j.text || j.content || JSON.stringify(j);
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

function showReviewCard() {
  const { queue, idx, revealed, deckOpts } = reviewState;
  const c = queue[idx];
  const remaining = queue.length - idx;
  const askLabel = tutorBtnLabel();
  view.innerHTML = `
    <div style="margin-bottom:8px">
      <select id="deckFilter" style="width:100%">${deckOpts}</select></div>
    <div class="row" style="margin-bottom:6px">
      <span class="pill">${remaining} due</span>
      <span class="grow"></span>
      <button class="ghost" id="suspendBtn">Suspend</button>
      <button class="ghost" id="editBtn">Edit</button></div>
    <div class="card">
      <div class="front">${mdToHtml(c.front)}</div>
      <div id="back" class="${revealed ? "" : "hidden"}">${revealed ? cardBodyHtml(c) : ""}</div>
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
  if (!revealed) {
    $("#showBtn").onclick = () => { reviewState.revealed = true; showReviewCard(); };
  } else {
    document.querySelectorAll(".grades button[data-r]").forEach((b) =>
      b.onclick = () => doGrade(c, Number(b.dataset.r)));
    $("#askBtn").onclick = () => askUI(c, $("#tutorOut"));
    const sp = $("#back [data-speak]"); if (sp) sp.onclick = () => playPronunciation(c);
  }
  $("#suspendBtn").onclick = () => { setSuspended(c, true); nextCard(); };
  $("#editBtn").onclick = () => openEditor(c._slug, c.id);
}

function doGrade(c, r) {
  gradeCard(c.id, r);
  persistLocal(); syncSoon();
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

// --- Ask UI (tutor) ---
function askUI(card, outEl) {
  const models = S.config?.tutor?.models || [{ id: "groq/llama-3.3-70b-versatile", label: "Llama 3.3 70B (free)" }];
  const cur = SET.model || S.config?.tutor?.default_model || models[0].id;
  outEl.innerHTML = `
    <div class="card tutor-card">
      <textarea id="askQ" placeholder="What would you like to understand better?" rows="2"></textarea>
      <div class="row" style="margin-top:8px;gap:6px">
        <button class="ghost" id="modelToggle" style="font-size:12px">⚙ ${models.find(m=>m.id===cur)?.label || cur}</button>
        <span class="grow"></span>
        <button class="primary" id="askGo">Ask</button>
      </div>
      <div id="modelSel" class="hidden" style="margin-top:6px">
        <select id="askModel">${models.map((m) =>
          `<option value="${m.id}" ${m.id === cur ? "selected" : ""}>${m.label}</option>`).join("")}</select>
      </div>
      <div id="askAns"></div>
    </div>`;

  let selectedModel = cur;
  $("#modelToggle").onclick = () => $("#modelSel").classList.toggle("hidden");
  $("#askModel").onchange = (e) => {
    selectedModel = e.target.value;
    SET.set("tutor_model", selectedModel);
    $("#modelToggle").textContent = `⚙ ${models.find(m=>m.id===selectedModel)?.label || selectedModel}`;
  };
  $("#askQ").focus();
  $("#askGo").onclick = async () => {
    const qv = $("#askQ").value.trim(); if (!qv) return;
    $("#askAns").innerHTML = `<p class="muted">⏳ Waiting for response…</p>`;
    try {
      const ans = await askTutor(card, qv, selectedModel);
      $("#askAns").innerHTML = `<div class="tutor-ans">${mdToHtml(ans)}</div>`;
      renderMath($("#askAns"));
    } catch (e) { $("#askAns").innerHTML = `<p class="muted">⚠ ${DOMPurify.sanitize(e.message)}</p>`; }
  };
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
      <label>Tutor proxy URL <span class="muted">(recommended for Claude models)</span></label>
      <input id="sProxy" value="${SET.proxy}" placeholder="https://your-worker.workers.dev" />
      <label>Groq API key <span class="muted">(free at groq.com — for direct Llama access)</span></label>
      <input id="sKey" type="password" value="${SET.tutorKey}" placeholder="gsk_…" autocomplete="current-password" />
      <div class="row end" style="margin-top:14px">
        <button class="ghost" id="reloadBtn">↺ Reload from GitHub</button>
        <button class="primary" id="saveSet">Save</button></div>
    </div>
    <p class="muted center" style="margin-top:16px">RECALL · FSRS in-browser · ${allCards().length} cards loaded</p>`;
  $("#saveSet").onclick = async () => {
    SET.set("gh_owner", $("#sOwner").value.trim());
    SET.set("gh_repo", $("#sRepo").value.trim());
    SET.set("gh_branch", $("#sBranch").value.trim() || "main");
    SET.set("gh_pat", $("#sPat").value.trim());
    SET.set("tutor_proxy", $("#sProxy").value.trim());
    SET.set("tutor_key", $("#sKey").value.trim());
    toast("Saved. Loading…");
    await boot(true);
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
      if (!SET.proxy && cfg.tutor?.proxy_url) SET.set("tutor_proxy", cfg.tutor.proxy_url);
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

if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("sw.js").catch(() => {});

(async () => { await boot(); render(); if (pendingCount()) sync(); })();
