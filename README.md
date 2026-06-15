# RECALL — Spaced Repetition Card Pipeline

A Git-backed flashcard pipeline: Claude generates cards from your study sessions, Anki + FSRS handles all scheduling, and you do the daily review.

---

## The Daily Loop

```
Study in chat
    ↓
Run /capture command → paste output into _inbox/digest.md → push to GitHub
    ↓
Nightly Generate routine runs (cloud, Sonnet 4.6) → draft TSV files appear in _review/
    ↓
You open _review/, read the drafts, fix or delete bad cards
    ↓
Move approved files to _approved/
    ↓
Run locally: python scripts/import_to_anki.py
    ↓
Open Anki → do your daily review
```

---

## Directory Structure

| Path | Purpose |
|---|---|
| `prompts/RECALL-Anki-Generate.md` | System prompt for the card generator |
| `prompts/RECALL-Tutor.md` | System prompt for the on-demand tutor |
| `prompts/capture-command.md` | Paste-able command to convert a study chat into a digest |
| `_inbox/digest.md` | Running capture buffer — append here after each session |
| `_inbox/processed.md` | Archive of processed blocks (do not edit) |
| `_review/` | Draft TSV files awaiting your review |
| `_approved/` | Approved files waiting to be imported into Anki |
| `_archive/` | Imported files; `import.log` records every import run |
| `_reports/` | Weekly audit reports |
| `scripts/generate_from_inbox.py` | Reads inbox → calls Claude → writes drafts to _review/ |
| `scripts/import_to_anki.py` | Reads _approved/ → imports to Anki → moves to _archive/ |
| `routines/nightly-generate.md` | Cloud routine spec (copy prompt into claude.ai/code) |
| `routines/weekly-audit.md` | Weekly audit routine spec |
| `cs/ language/ finance/` | Source material organized by domain and chapter |

---

## Cloud vs. Local Split

**Why the split?** The cloud routine runs on Anthropic's servers — it cannot reach `localhost:8765` where AnkiConnect listens. So generation (calling Claude API) happens in the cloud, but importing into Anki must happen on your local machine.

| Step | Where it runs | Why |
|---|---|---|
| Card generation | Cloud (Routine) | Claude API call, no Anki access needed |
| Anki import | Local (`import_to_anki.py`) | Needs `localhost:8765` |
| Weekly audit | Cloud (Routine) | Reads committed TSV files, no Anki access needed |

**If you prefer a single local script** (machine always on when studying): run `generate_from_inbox.py` then `import_to_anki.py` manually instead of enabling the cloud routine. Do NOT run both the cloud routine and a local auto-import — that creates a race condition.

---

## The Approval Gate

Generated cards land in `_review/` as drafts. **Never auto-import unreviewed cards.**

A bad card (wrong answer, ambiguous front, two facts on one card) corrupts months of scheduling in Anki — FSRS will build a wrong memory model around it and it is painful to fix later.

Your review checklist per card:
- [ ] Front is unambiguous — exactly one interpretation
- [ ] Back's first sentence is a complete headline answer
- [ ] The card tests exactly one fact
- [ ] Difficulty tag (`diff::1-5`) feels right
- [ ] No answer leakage in the front

Move to `_approved/` when satisfied. Delete cards you don't want — don't leave junk.

---

## Idempotent Import (no duplicates)

Every generated card has a stable GUID: `<deck-slug>-NNN` (e.g. `cs-ostep-ch28-001`).

The import script checks Anki for a note tagged `guid::<GUID>` before adding:
- **Not found** → add as a new note, attach the `guid::` tag.
- **Found** → update Front/Back fields in place. Anki keeps the existing scheduling data — your review history is preserved.

This means you can safely re-import a corrected TSV: it updates, never duplicates.

---

## Two Q&A Endpoints

When you fail a card or want a deeper explanation:

| Source tag | Go to | Why |
|---|---|---|
| `src::notebooklm` or from an uploaded PDF | **NotebookLM** | Cited retrieval from the source text |
| `src::claude` or from a study conversation | **RECALL Tutor** | Reasoning from first principles |

The Tutor (prompt at `prompts/RECALL-Tutor.md`) will explain, re-test you, and ask one elaborative question. It will not answer your Anki cards for you.

---

## Domain Deck Naming

Default scheme: `Domain::Source::chapter`

Examples:
- `CS::OSTEP::ch28-locks`
- `Language::Turkish::nouns`
- `Finance::CFA-L1::ethics`
- `CS::Algorithms::sorting` (general learning)

---

## Setup Checklist

### One-time (human steps)
- [ ] Install AnkiConnect add-on in Anki (code: **2055492159**)
- [ ] Enable FSRS in Anki: Deck Options → FSRS toggle ON (not configurable via API)
- [ ] Create Routines at `claude.ai/code` using prompts from `routines/nightly-generate.md` and `routines/weekly-audit.md`
- [ ] Set routine model to **claude-sonnet-4-6** on each routine
- [ ] Set `ANTHROPIC_API_KEY` in environment (needed for local script runs)
- [ ] Push this repo to GitHub and authorize the Routines connector to it

### Python environment (one-time local setup)

C drive is likely full — create the venv on D:

```powershell
python -m venv D:\recall_venv
D:\recall_venv\Scripts\pip install anthropic --cache-dir D:\pip-cache
$env:ANTHROPIC_API_KEY = "sk-ant-..."   # set in your shell profile for persistence
```

Use `D:\recall_venv\Scripts\python` to run the scripts locally.

### Per session
1. Study in a Claude chat.
2. Paste `/capture` command (from `prompts/capture-command.md`) at the end of the chat.
3. Append the output to `_inbox/digest.md`.
4. `git add _inbox/digest.md && git commit -m "inbox: <topic>" && git push`
5. Next morning: review drafts in `_review/`, move approved to `_approved/`.
6. Run `D:\recall_venv\Scripts\python scripts/import_to_anki.py` (Anki must be open).
7. Do your Anki review.
