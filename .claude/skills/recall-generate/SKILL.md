---
name: recall-generate
description: Generates a RECALL flashcard JSON block from the current conversation or provided source text. Outputs only the JSON — no file writes, no git. Use when working in Claude.ai chat; paste the output into the PWA Import tab. Invoke when the user says /recall-generate, "make cards", "kart üret", or similar.
---

# /recall-generate — card JSON generator (copy-paste workflow)

Output a single JSON block that can be pasted into the RECALL PWA Import tab.
No file I/O, no git operations. Works in any Claude context (Claude Code or Claude.ai chat).

## Inputs

Parse from the invocation:
- `deck:` — e.g. `CS::OSTEP::ch28-locks`. If absent, infer from the topic and state it in one line before the JSON.
- `src:` — source label, e.g. `OSTEP-ch28`. If absent, use `claude-study`.
- Topic — infer from the conversation if not stated.

**Slug:** `deck.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/, "")`

## Card generation rules

Follow all rules in `prompts/RECALL-Generate.md` exactly:
- Grounding: source-grounded answers only; `note` may elaborate.
- Atomic: one fact per card.
- Dense: every distinct fact, mechanism, edge case, and procedure.
- Type mix: definition, mechanism, why, distinction, procedure, edge-case, trace, etc.
- Domain rules (CS / Language / Finance) apply.

## Output

Emit exactly:
1. One JSON block (no preamble, no commentary):

```json
{
  "deck": "CS::OSTEP::ch28-locks",
  "domain": "cs",
  "cards": [
    {
      "id": "<slug>-001",
      "front": "...",
      "answer": "...",
      "note": null,
      "code": null,
      "math": null,
      "ipa": null,
      "example": null,
      "audio": null,
      "application": null,
      "application_url": null,
      "source": "OSTEP ch28 §locks",
      "source_text": null,
      "tags": ["recall::mechanism", "diff::2", "grounding::model"]
    }
  ]
}
```

2. One summary line immediately after the closing `}`:

```
Generated N cards · types:{definition:X, mechanism:Y, …} · deck <DECK>
```

## Next step (remind the user)

After the JSON, add one line:
> Paste this into the RECALL PWA → Import tab → Import button.
