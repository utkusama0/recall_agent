---
name: recall-generate
description: Generates RECALL flashcards as a JSON artifact from a study session. Use after studying a topic — say "generate cards" or "make flashcards".
---

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

**THE USER IS A BEGINNER LEARNING THIS LANGUAGE. THEY CANNOT READ THE TARGET LANGUAGE YET.**

Every field the user reads must be primarily in English. The only places where the target language appears are:
1. `front` — the word/phrase itself (what TTS reads)
2. `example` — one sentence in the target language, always followed by `(English translation)`
3. `ipa` — phonetic transcription

Everything else — `answer`, `note`, `application`, `prompts` — is written **entirely in English**.

---

#### HARD RULES — violations make the card useless

**`front` — ONLY the target-language word:**
- Noun: `die Küche`
- Verb: `abfahren`
- Adjective: `schnell`
- NEVER a German question. NEVER a German sentence. NEVER "Wie sagt man..." or "Was bedeutet...".
- The front is what TTS reads — it must be one clean word/phrase.

**`answer` — English explanation that TEACHES:**
- Start with the English meaning, then grammar details in English.
- The answer must be useful to someone who knows ZERO German.
- German words may appear as inline references but the explanation is English.

✅ GOOD answer for `dreißig`:
"Thirty. Note: spelled with ß (sharp S). Unlike English 'thirty' from 'three', German 'dreißig' is irregular — it does NOT follow the regular -zig pattern (it would be *dreizig if regular). All other tens are regular: vierzig (40), fünfzig (50), sechzig (60), siebzig (70), achtzig (80), neunzig (90)."

❌ BAD answer for `dreißig`:
"30=dreissig, 40=vierzig, 50=fuenfzig, 60=sechzig..."
(This is a lookup table, not an explanation. It doesn't teach anything.)

✅ GOOD answer for `einundzwanzig`:
"Twenty-one. German builds two-digit numbers in reverse: ones + 'und' + tens. So 21 = ein·und·zwanzig (one-and-twenty). This is the opposite of English word order. Applies to all numbers 21–99: 45 = fünf·und·vierzig, 99 = neun·und·neunzig."

❌ BAD answer for `einundzwanzig`:
"Pattern: [ones-unit] + und + [tens-unit]\n21=einundzwanzig, 45=fuenfundvierzig..."
(Cryptic formula + German dump. Useless to a beginner.)

**`note` — English teaching insight:**
- WHY something is the way it is, common mistakes, mnemonics, comparison with English.
- ✅ "Dreißig is the only irregular tens number — every other tens word just adds -zig to the digit. A mnemonic: 'drei' changes its vowel like English 'three'→'thirty'."
- ❌ "dreissig is irregular (not dreizig). sechzig and siebzig drop letters."

**`example` — target-language sentence + (English translation):**
- Always end with the English translation in parentheses.
- ✅ `"Das kostet dreißig Euro. (That costs thirty euros.)"`
- ❌ `"Das kostet dreissig Euro."` (no translation — useless to a beginner)

**`prompts` — English recall challenges:**
- Short English questions the user should try to answer before flipping.
- ✅ `["Meaning?", "Is it regular or irregular?", "How do you say 35?"]`
- ❌ `["Wie schreibt man das?"]` (German — the user can't read this)

**`ipa`:** always filled for every vocabulary card.

**One card = one word.** Do not combine multiple words into one card (e.g. "numbers 30–90" is NOT a card — make separate cards for dreißig, vierzig, fünfzig, etc.). Each word gets its own card, its own explanation, its own example.

---

#### Card types for language

| Type tag | Front | When to use |
|----------|-------|-------------|
| `recall::vocab` | the word (+ article) | Every vocabulary word. One word per card. |
| `recall::article-rule` | English question | Major suffix/category patterns (generate once, not per word) |
| `recall::grammar-rule` | English question | Case rules, word order, tense formation |
| `recall::grammar-pattern` | English question | Conjugation tables, declension (use `code` field for table layout) |
| `recall::distinction` | `word A vs. word B` | Near-synonyms, easily confused pairs |
| `recall::preposition` | the preposition | Which case it governs, with examples |
| `recall::usage` | English question | Situational phrases (ordering food, at the doctor) |
| `recall::word-formation` | the compound word | How compound nouns are built (B1+) |

**Near-synonyms:** always add a `distinction` card.

#### Level calibration

| Level | Grammar focus | Example complexity |
|-------|---------------|-------------------|
| A1 | Präsens, Nom/Akk, sein/haben, modals, basic word order | Short sentences, present tense, ≤8 words |
| A2 | Perfekt, Dativ, Wechselpräpositionen, Nebensatz (weil/dass) | Compound sentences, past tense |
| B1 | Präteritum, Passiv, Konjunktiv II, relative clauses, Genitiv | Complex sentences, mixed tenses |
| B2 | Konjunktiv I, Partizip as adjective, advanced connectors | Formal/informal contrast, nuance |
| C1 | Nominalisierung, extended attributes, stylistic variation | Authentic text, subtle distinctions |

#### Batch strategy for wordlists

When given a large wordlist (e.g. 650 Goethe A1 words):
- **40 words per batch** → ~50–70 cards. User specifies `batch:1`, `batch:2`, etc.
- Article pattern rules (~12 cards): generate only in batch 1. Do not repeat.
- Target ~1.5 cards per word on average. Simple nouns = 1 card; irregular verbs or synonym pairs = 2–3 cards.
- Each batch becomes one deck: `Language::German::A1-batch-01` or themed (`Language::German::A1-food`).
- **One word = one card.** Never combine multiple vocabulary words into a single card.

### Finance
- Every concept requires: concept + mechanics + `risk` (mandatory) + comparison cards.
- Metrics: one card covers definition → formula → interpretation → common misuse.
- **NEVER give investment advice.** Frameworks and vocabulary only.

---

## OUTPUT FORMAT

**Create the JSON as a code artifact** (named `<slug>.json`) so the user can copy or download it without scrolling through a wall of text in chat. Do NOT paste the raw JSON inline into the conversation.

The JSON structure:

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
      "prompts": ["Article?", "Plural?", "Auxiliary?"],
      "cloze": "<sentence with ___ blanks or null>",
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
- `prompts`: array of short recall-challenge strings shown below the word on the front side, or null. Language vocab cards should always have prompts tailored to the word type. Examples by word type:
  - Noun: `["Article?", "Plural?", "Meaning?"]`
  - Verb: `["Meaning?", "Auxiliary: sein/haben?", "Past participle?"]`
  - Separable verb: `["Meaning?", "Separated form?", "Auxiliary?"]`
  - Adjective: `["Meaning?", "Opposite?"]`
  - Preposition: `["Which case?", "Meaning?"]`
  - Add word-specific prompts when relevant: `"Irregular?"`, `"Register?"`, `"Reflexive?"`, `"Which verb pairs with this?"`
- `cloze`: a sentence with `___` replacing the target word, or null. The app shows this as a fill-in-the-blank challenge. Use for vocab and grammar cards where testing in context adds value. E.g. `"Der Zug ___ um 8 Uhr ___."` for *abfahren*. Include the answer in the `answer` field.
- `source_text`: verbatim 1–3 sentences from the source that contain the answer. Null only for `grounding::model` cards.
- `tags`: always include `recall::<type>`, `diff::<1-5>`, and `grounding::source` or `grounding::model`. Add 1–2 domain content tags (e.g. `cs::concurrency`, `topic::mutex`, `lang::tr`).

**Reverse cards (language only):** Do NOT generate separate reverse cards. The app automatically creates reverse reviews (English→German) from every language vocab card with independent FSRS scheduling. One card in the JSON = two review directions in the app.

**Domain field for entire deck:**
- CS topics → `"domain": "cs"`
- Language/vocab → `"domain": "language"`
- Finance topics → `"domain": "finance"`

---

## CHAT OUTPUT

In the chat message (outside the artifact), show ONLY a compact summary:

```
Generated N cards · deck: <DECK>
Types: definition ×3, mechanism ×2, why ×1, ...
```

Then a short table of card fronts (no answers):

| # | Front | Type |
|---|-------|------|
| 001 | What is a mutex? | definition |
| 002 | Why does test-and-set need ... | why |

The user will copy the JSON from the artifact and paste it into the PWA Import tab.
