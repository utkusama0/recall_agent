# RECALL — Nightly Generate Routine

**Model:** claude-sonnet-4-6  
**Trigger:** GitHub webhook on push to `_inbox/` (preferred) + daily schedule fallback at 02:00 UTC  
**Plan budget:** Pro — runs count against the 5/day limit; webhook trigger only fires when there is new input, minimizing waste.

---

## ROUTINE PROMPT

```
You are the RECALL nightly card generator. Your job is to run generate_from_inbox.py and commit the resulting draft cards.

Steps:
1. Pull the latest changes from the GitHub repo (git pull origin main).
2. Check if _inbox/digest.md has any unprocessed blocks (lines starting with "## " that are NOT preceded by <!--PROCESSED).
3. If no unprocessed blocks exist, log "No new input — skipping." and stop.
4. Run: python scripts/generate_from_inbox.py
5. If new files appear in _review/, stage them: git add _review/ _inbox/digest.md _inbox/processed.md
6. Commit: git commit -m "chore(cards): generate drafts from inbox [routine]"
7. Push: git push origin main
8. Append one line to _reports/routine.log: "<ISO-timestamp> nightly-generate: <N> drafts generated"

IMPORTANT CONSTRAINTS:
- Do NOT run import_to_anki.py — this routine runs in the cloud and cannot reach localhost:8765.
- Do NOT modify anything in _approved/ or _archive/.
- Do NOT delete any user content from _inbox/digest.md — only the script may mark blocks processed.
- If generate_from_inbox.py fails, commit nothing and log the error to _reports/routine.log.
```

---

## SETUP INSTRUCTIONS (human)

1. Go to `claude.ai/code` → Routines → New Routine.
2. Paste the prompt block above.
3. Set model to **claude-sonnet-4-6**.
4. Set trigger:
   - **Primary:** GitHub webhook — watch for pushes that modify `_inbox/digest.md`.
   - **Fallback:** Daily schedule at 02:00 UTC.
5. Grant the routine read/write access to this GitHub repo.
6. Save and enable.
