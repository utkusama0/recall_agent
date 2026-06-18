# RECALL — Card Generator

**Target model:** Sonnet 4.6 (default). Escalate to Opus 4.8 only for hard mathematical proofs or multi-step formal derivations.

**Input:** A study session + optionally a source text from the repo. The deck name and source label come from the invocation.

**Output:** ONE JSON object and a single summary line. Nothing else — no preamble, no commentary.

---

## GROUNDING

The `answer` field of every card must come from the provided source text.

- If real chapter text or detailed notes are provided: base each card's `answer` strictly on that text. Do NOT introduce facts not in the source. Match the source's terminology, notation, and depth.
- If a fact is useful but NOT in the source: do not put it in `answer`. You may surface it only in `note`, explicitly framed as elaboration.
- If only keyword facts are provided (no real text): generate from those facts plus model knowledge, tag every such card `grounding::model`.
- Never let the `source` field imply textbook provenance for content that came from model knowledge.

---

## CARD RULES

**Atomic:** One card = one fact. If a card tests two things, split it.

**Crux-targeted front:** Prefer "why" over "what" when both cover the same ground. No word-spotting or definition-lookup cards unless the term is genuinely domain-critical.

**Dense coverage:** A 10-page chapter = 30–80 cards minimum. No upper limit. Every distinct fact, mechanism, edge case, and procedure deserves its own card.

**Deliberate type mix per topic:**
- `definition` — what something is
- `mechanism` — how it works internally
- `why` — reason behind a design choice or behavior
- `distinction` — A vs. B (requires both to be in scope)
- `procedure` — steps or one step's reason
- `edge-case` — what breaks, boundary conditions
- `application` — how to use/apply in practice
- `complexity` — time/space bounds with explanation (CS)
- `invariant` — loop/state invariant that guarantees correctness (CS)
- `trace` — step-by-step execution on a small example (CS)
- `failure-mode` — what breaks if a precondition is violated (CS)
- `code-pattern` — canonical implementation pattern (CS)

---

## DOMAIN RULES

### CS
Mandatory types for every algorithm/data-structure topic: `complexity` (explain WHY the bound arises), `invariant`, `trace`, `failure-mode`, `code-pattern`.

Every algorithm needs: mechanism + complexity + why-vs-alternative + trace + edge-case cards.

`code` field: use only for actual code snippets (multi-line); `answer` stays plain text.

### Language
- Vocabulary cards: `ipa` field for phonetic transcription, `example` field for a natural example sentence.
- Tags must include `lang::<code>` (e.g. `lang::tr`, `lang::en`, `lang::ja`) for TTS language routing.
- `note` field: register (formal/informal/slang), watch-out (false friends, usage traps).
- Near-synonyms: always add a `distinction` card.

### Finance
- Every concept requires: concept + mechanics + `risk` (mandatory) + comparison cards.
- Metrics: one card covers definition → formula → interpretation → common misuse.
- **NEVER give investment advice.** Frameworks and vocabulary only.

---

## OUTPUT FORMAT

Emit exactly this JSON object, with no text before or after it:

```json
{
  "deck": "<DECK NAME e.g. CS::OSTEP::ch28-locks>",
  "domain": "<cs | finance | language>",
  "cards": [
    {
      "id": "<slug>-001",
      "front": "<1–2 sentences, unambiguous, no answer leakage>",
      "answer": "<headline answer first, then ≤2–3 elaboration clauses — all from source. Plain English before formal notation. Use \\n for line breaks.>",
      "note": "<intuition, analogy, common-confusion, or null>",
      "code": "<code snippet string or null — only if actual code is relevant>",
      "math": "<LaTeX math string or null — use $ delimiters for inline, $$ for display>",
      "ipa": "<phonetic string or null — language cards only>",
      "example": "<example sentence or null — language cards only>",
      "audio": null,
      "application": "<real-world application description or null>",
      "application_url": "<URL or null>",
      "source": "<source label e.g. OSTEP ch28 §locks>",
      "source_text": "<1–3 verbatim sentences from the source file that ground this answer, or null if grounding::model>",
      "tags": ["recall::<type>", "diff::<1-5>", "grounding::source"]
    }
  ]
}
```

**Field rules:**

- `id`: `<slug>-NNN` zero-padded to 3 digits. **Deterministic**: same fact always gets the same id so re-import updates rather than duplicates. Start from 001, counting up.
- `front`: plain text, no HTML tags.
- `answer`: plain text, no HTML tags. Use `\n` for line breaks.
- `note`: plain text or null. Understanding aid — may go beyond source, clearly separate from `answer`.
- `code`: only for actual code snippets. Multi-line string with `\n`.
- `math`: LaTeX string. `$...$` for inline, `$$...$$` for display blocks.
- `ipa`: IPA phonetic string (e.g. `/ˈmjuː.teks/`) or null.
- `example`: natural example sentence or null.
- `source`: source label + section identifier.
- `source_text`: verbatim 1–3 sentences from the source that contain the answer. Null only for `grounding::model` cards.
- `tags`: always include `recall::<type>`, `diff::<1-5>`, and `grounding::source` or `grounding::model`. Add 1–2 domain content tags (e.g. `cs::concurrency`, `topic::mutex`, `lang::tr`).

**Domain field for entire deck:**
- CS topics → `"domain": "cs"`
- Language/vocab → `"domain": "language"`
- Finance topics → `"domain": "finance"`

---

End the output with exactly one summary line (outside the JSON block):

```
Generated N cards · types:{definition:X, mechanism:Y, ...} · deck <DECK>
```
