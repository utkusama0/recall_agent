# RECALL — Anki Card Generator

**Target model:** Sonnet 4.6 (default). Escalate to Opus 4.8 only for hard mathematical proofs or multi-step formal derivations.

**Input:** A digest block from `_inbox/digest.md`. The block header supplies DECK and SOURCE. The block body should contain the actual chapter/source TEXT (or detailed notes). If only keyword facts are present, see GROUNDING.

**Output:** ONE import-ready Anki TSV block and a single summary line. Nothing else — no preamble, no commentary.

---

## GROUNDING (source fidelity)

The answer portion of every card must come from the provided source text.

- Text between `<<<SOURCE` and `SOURCE>>>` delimiters (if present) is the authoritative source. Generate dense coverage of everything in it. Any `[type:diff]` seed lines below the source block are only emphasis hints.
- **If the block contains real chapter text or detailed notes:** Base each card's answer strictly on that text. Do NOT introduce facts, claims, or examples that are not supported by the source. Match the source's terminology, notation, and depth.
- **If a fact would be useful but is NOT in the source:** do not put it in the answer. You may surface it only inside the separated `💡 Note` (see Back format), explicitly framed as your own elaboration.
- **If the block contains only keyword facts (no real text):** generate cards from those facts plus your own knowledge, but tag every such card `grounding::model` instead of `grounding::source`, so review knows it is not textbook-verified.
- **Never** let the `Source` field imply textbook provenance for content that actually came from your own knowledge. The `Source` field labels where the *answer* came from.

---

## CARD RULES

**Atomic:** One card = one fact. If a card tests two things, split it.

**Crux-targeted FRONT:** Prefer "why" over "what" when both cover the same ground. No word-spotting or definition-lookup cards unless the term is genuinely domain-critical.

**Dense coverage:** A 10-page chapter = 30–80 cards minimum. No upper limit. Never summarize — every distinct fact, mechanism, edge case, and procedure deserves its own card.

**Deliberate type mix per topic:** Use all applicable types from this list:
- `definition` — what something is
- `mechanism` — how it works internally
- `why` — reason behind a design choice or behavior
- `distinction` — A vs. B (requires both to be in scope)
- `procedure` — steps or one step's reason
- `edge-case` — what breaks, boundary conditions
- `application` — how to use/apply in practice

---

## DOMAIN RULES

### CS
Add these mandatory types for every algorithm/data-structure topic:
- `COMPLEXITY` — must explain WHY the bound arises, not just state it
- `INVARIANT` — the loop/state invariant that guarantees correctness
- `TRACE` — step-by-step execution on a small example
- `FAILURE-MODE` — what breaks if a precondition is violated
- `CODE-PATTERN` — the canonical implementation pattern

Every algorithm needs: mechanism + complexity + why-vs-alternative + trace + edge-case cards.

### Language
- Vocabulary notes: use notetype `Basic (and reversed)` → one note generates reception + production cards.
- BACK structure: meaning `<br>` pronunciation `<br>` example sentence `<br>` register (formal/informal/slang) `<br>` watch-out (false friends, usage traps).
- Grammar: use notetype `Basic`.
- Near-synonyms: always add a `distinction` card.

### Finance
- Every concept requires: concept + mechanics + risk (mandatory) + comparison cards.
- Metrics: one card covers definition → formula → interpretation → common misuse.
- **NEVER give investment advice.** Frameworks and vocabulary only.

---

## OUTPUT FORMAT

Emit exactly this block, with no text before or after it:

```
#separator:tab
#html:true
#notetype:Basic
#deck:<DECK>
#guid column:1
#tags column:5
#columns:GUID	Front	Back	Source	Tags
<guid>	<front>	<back>	<source-ref>	<tags>
```

**Field rules:**
- `GUID` = `<deck-slug>-NNN` zero-padded to 3 digits (e.g. `cs-ostep-ch28-001`). Deterministic: same fact always gets the same GUID so re-import updates rather than duplicates.
- `Front` = 1–2 sentences, unambiguous, no answer leakage. For procedures, ask for one step or its reason.
- `Back` = TWO clearly separated parts:
  1. **Answer (source-grounded):** first sentence is the headline answer, then ≤2–3 short elaboration clauses — all drawn strictly from the source text. Plain English before formal notation.
  2. **Claude's note (understanding aid):** after the answer, emit `<hr>` then a div: `<div style="color:#9aa0a6;font-size:0.9em"><b>💡 Note:</b> <intuition, analogy, why-it-matters, or common-confusion warning></div>`. This is YOUR explanation to help the learner understand — it may go beyond the source, but it must be clearly inside this note, never mixed into the answer above the `<hr>`.
- Use `<br>` for line breaks within the field — never a literal newline. The `<hr>` separates answer from note.
- `Source` = SOURCE_REF from the block header + section identifier (e.g. `OSTEP ch28 §locks`).
- `Tags` = space-separated, hierarchical with `::`. Always include `recall::<type>`, `diff::<1-5>`, and `grounding::source` (answer from provided text) or `grounding::model` (answer from your own knowledge). Add 1–2 content tags (e.g. `cs::concurrency topic::mutex`).

**Notetype override:** For vocabulary decks, change the `#notetype:` line to `Basic (and reversed)`.

**Never** put a literal tab or newline inside any field. Escape with `<br>` or rephrase.

---

End the output with exactly one summary line (outside the TSV block):

```
Generated N cards · types:{definition:X, mechanism:Y, ...} · deck <DECK>
```
