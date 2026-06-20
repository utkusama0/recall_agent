---
name: recall-cs
description: Generates RECALL flashcards for computer science topics — algorithms, data structures, systems, theory, proofs. Say "generate cards" or "make flashcards".
---

# RECALL — CS Card Generator

**Output:** ONE JSON code artifact (`<slug>.json`) + one summary line. No preamble, no commentary.

---

## GROUNDING

- Source text provided → base `answer` strictly on it. No invented facts. Tag `grounding::source`.
- No source → generate from model knowledge. Tag `grounding::model`.
- `note` may elaborate beyond source. `answer` may not.

---

## CARD RULES

**Crux-targeted:** Prefer "why" over "what". No word-spotting or definition-lookup cards unless the term is genuinely domain-critical.

### Principle consolidation — mandatory for all sources

Do NOT emit one card per fact. Follow this 4-step process:

**Step 1 — Fact extraction.** List EVERY distinct fact, rule, trap, and exception from the source as a numbered flat list. Skip nothing. This list is internal — do not output it.

**Step 2 — Principle grouping.** For each pair of facts, apply this test: "If I know fact A, do I automatically know fact B?" If yes → same principle, merge into one card. If no → separate cards.

Merge rules:
- Multiple types/contexts obeying the same rule → one card, show 2-3 examples in `code`
- "Feature X works in context Y" + "Feature X works in context Z" → one card covering the general rule
- A fact derivable from another fact → fold into the parent card's `answer` or `note`

Keep separate:
- An EXCEPTION to a rule → always its own card
- A TRAP / GOTCHA that would cause a bug → always its own card
- A fact with its own proof, complexity bound, or failure mode → its own card

**Step 3 — Card generation.** For each principle group:
- `front`: tests the underlying rule, not a specific instance
- `answer`: covers the full principle with enough detail to derive all grouped facts
- `code`: 2-3 representative examples (not all instances)
- `note`: flags the most common mistake or surprising behavior, if any

**Step 4 — Coverage check.** Walk through the Step 1 fact list. For each fact, verify it appears in at least one card's `answer`, `code`, or `note`. If any fact is orphaned, add a card. Never skip this step.

---

## CS DOMAIN RULES

**Mandatory types for every algorithm / data-structure topic:**
- `complexity` — explain WHY the bound arises, not just state it
- `invariant` — the loop/state invariant that guarantees correctness
- `trace` — step-by-step execution on a small concrete example
- `failure-mode` — what breaks if a precondition is violated
- `code-pattern` — canonical implementation (use `code` field)

**Every algorithm needs at minimum:** mechanism + complexity + why-vs-alternative + trace + edge-case cards.

**`code` field:** actual code snippets only (multi-line string with `\n`). `answer` stays plain text — don't put code in answers.

**`math` field:** LaTeX. `$...$` inline, `$$...$$` display. Use for formal definitions, recurrences, proofs.

---

## TYPE MIX

Use these types and ensure deliberate variety per topic:

| Type tag | Front pattern | When |
|----------|---------------|------|
| `definition` | "What is X?" | Core concept definition |
| `mechanism` | "How does X work?" | Internal workings |
| `why` | "Why does X do Y?" | Design rationale |
| `distinction` | "X vs. Y" | Compare two related concepts |
| `procedure` | "Steps to X?" | Multi-step process or one step's rationale |
| `edge-case` | "What happens when…?" | Boundary conditions, degenerate inputs |
| `application` | "When would you use X?" | Practical usage |
| `complexity` | "Time/space of X?" | Bounds with explanation |
| `invariant` | "What invariant does X maintain?" | Correctness guarantee |
| `trace` | "Trace X on input [1,3,2]" | Concrete step-by-step |
| `failure-mode` | "What breaks if…?" | Precondition violations |
| `code-pattern` | "Implement X" | Canonical code (use `code` field) |

---

## OUTPUT FORMAT

Create as a **code artifact** (`<slug>.json`). Do NOT paste raw JSON in chat.

```json
{
  "deck": "<e.g. CS::OSTEP::ch28-locks>",
  "domain": "cs",
  "cards": [
    {
      "id": "<slug>-001",
      "front": "<question — unambiguous, no answer leakage>",
      "answer": "<headline first, then ≤2–3 elaboration clauses. Plain English before notation. \\n for line breaks.>",
      "note": "<intuition, analogy, common confusion, or null>",
      "code": "<code snippet or null>",
      "math": "<LaTeX or null>",
      "ipa": null,
      "example": null,
      "audio": null,
      "application": "<real-world application or null>",
      "application_url": "<URL or null>",
      "prompts": null,
      "cloze": null,
      "source": "<source label e.g. OSTEP ch28 §locks>",
      "source_text": "<1–3 verbatim sentences from source, or null if grounding::model>",
      "tags": ["recall::<type>", "diff::<1-5>", "grounding::source", "cs::<subtopic>"]
    }
  ]
}
```

**Key field rules:**
- `id`: `<slug>-NNN` zero-padded. Deterministic — same fact always gets same id.
- `front`: plain text. No HTML. 1–2 sentences, unambiguous.
- `answer`: plain text. `\n` for line breaks. Headline answer first.
- `code`: multi-line string with `\n`. Only for actual code — not pseudocode in answers.
- `math`: LaTeX. `$...$` inline, `$$...$$` display.
- `tags`: always `recall::<type>` + `diff::<1-5>` + `grounding::source|model` + `cs::<subtopic>`.
- `prompts`/`cloze`: null for CS cards (these are language features).

---

## CHAT OUTPUT

Show ONLY a compact summary (outside the artifact):

```
Generated N cards · deck: <DECK>
Types: definition ×3, mechanism ×2, why ×1, complexity ×2, trace ×1, ...
```

Then a short table of card fronts (no answers):

| # | Front | Type |
|---|-------|------|
| 001 | What is a mutex? | definition |
| 002 | Why does test-and-set need hardware support? | why |

The user will copy the JSON from the artifact into the PWA Import tab.
