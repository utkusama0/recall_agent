# RECALL — Capture Command

Paste this command into any Claude chat after a study session to convert the conversation into a structured digest.

---

## THE COMMAND

```
/capture deck:<DECK> src:<SOURCE> date:<YYYY-MM-DD>

Scan our conversation above. Extract every distinct fact, mechanism, rule, distinction, procedure, edge case, or application worth a flashcard. Output ONLY the digest block below — no prose, no commentary.

Format each line as:
[type:diff] fact

Where:
- type = one of: def | mech | why | dist | proc | edge | app | complex | invar | trace | fail | code
- diff = difficulty 1–5 (1 = trivial recall, 5 = hard derivation or subtle distinction)
- fact = the atomic fact in one sentence, plain English, no answer embedded

Header line (emit first):
## <TOPIC> · <YYYY-MM-DD> · deck:<DECK> · src:<SOURCE>

Then one fact per line. Stop after the last fact — no summary.
```

---

## USAGE

1. Replace `<DECK>` with the target Anki deck path, e.g. `CS::OSTEP::ch28-locks`.
2. Replace `<SOURCE>` with the source label, e.g. `OSTEP-ch28` or `Claude-study`.
3. Replace `<YYYY-MM-DD>` with today's date.
4. Paste the filled command at the end of your study chat.
5. Copy the output block and append it to `_inbox/digest.md`.
6. Push to GitHub — the nightly-generate routine picks it up.

---

## EXAMPLE OUTPUT

```
## Mutex Locks · 2026-06-15 · deck:CS::OSTEP::ch28-locks · src:OSTEP-ch28

[def:1] A mutex lock is a synchronization primitive that grants exclusive access to a critical section.
[mech:2] Test-and-set atomically writes 1 and returns the old value, enabling spin-lock implementation.
[why:3] Spin locks waste CPU cycles while waiting; OS-based sleep locks avoid this at the cost of a syscall.
[dist:4] Spin locks are preferred when the critical section is shorter than the cost of a context switch.
[edge:3] A spin lock on a uniprocessor without preemption will deadlock because the lock-holder never runs.
[invar:2] The lock invariant: exactly one thread holds the lock at any time while it is acquired.
[fail:4] Test-and-set without memory barriers allows the compiler to reorder critical-section accesses.
```
