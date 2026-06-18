"""
migrate_tsv_to_json.py — one-time RECALL v1 → v2 migration.

Converts the legacy Anki-TSV decks in _archive/*.txt into the v2 data model:
  - cards/<deck-slug>.json   (content as data, not raw HTML)
  - state/scheduler.json     (seeded with empty FSRS cards, one per card id)

The legacy Back field looks like:
    <answer ... with <br> and maybe <code>...</code>><hr><div ...><b>💡 Note:</b> ...</div>
We split it into:
    answer  — text before <hr>, <br> → newlines, <code> lifted into `code`
    note    — text inside the trailing div, wrapper + "💡 Note:" stripped

source_text is left null: the original grounding passage isn't present in the
TSV, so we can't recover it honestly. The generator fills it going forward.

Run:  python scripts/migrate_tsv_to_json.py
Idempotent: re-running rebuilds cards/ from _archive/ and merges scheduler
entries (existing FSRS state for a known id is preserved).
"""

import datetime
import html
import json
import pathlib
import re
import sys

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

REPO_ROOT = pathlib.Path(__file__).parent.parent
ARCHIVE_DIR = REPO_ROOT / "_archive"
CARDS_DIR = REPO_ROOT / "cards"
STATE_DIR = REPO_ROOT / "state"
SCHEDULER_FILE = STATE_DIR / "scheduler.json"


def deck_to_slug(deck: str) -> str:
    """CS::OSTEP::ch28-locks -> cs-ostep-ch28-locks  (reused from the v1 pipeline)."""
    return re.sub(r"[^a-z0-9]+", "-", deck.lower()).strip("-")


def domain_from(deck: str, tags: list[str]) -> str:
    top = deck.split("::", 1)[0].lower()
    if top in ("cs", "finance", "language"):
        return top
    for t in tags:
        if t.startswith("cs::"):
            return "cs"
        if t.startswith("finance::"):
            return "finance"
        if t.startswith(("lang::", "language::")):
            return "language"
    return top or "general"


_CODE_RE = re.compile(r"<code>(.*?)</code>", re.DOTALL | re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")


def _detag(text: str) -> str:
    """<br> -> newline, &nbsp; -> space, strip remaining tags, unescape entities."""
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = text.replace("&nbsp;", " ")
    text = _TAG_RE.sub("", text)
    return html.unescape(text).strip()


def split_back(back: str) -> tuple[str, str | None, str | None]:
    """Return (answer, note, code) from a legacy Back field."""
    parts = re.split(r"<hr\s*/?>", back, maxsplit=1, flags=re.IGNORECASE)
    answer_html = parts[0]
    note = None
    if len(parts) == 2:
        # Drop the "💡 Note:" label and the surrounding div.
        note_html = re.sub(
            r"<b>\s*💡\s*Note:\s*</b>", "", parts[1], flags=re.IGNORECASE
        )
        note = _detag(note_html) or None

    code = None
    m = _CODE_RE.search(answer_html)
    if m:
        code = _detag(m.group(1)) or None
        answer_html = _CODE_RE.sub("", answer_html)

    answer = _detag(answer_html)
    return answer, note, code


def parse_tsv(text: str) -> tuple[str, list[dict]]:
    """Return (deck_name, [card dicts]) from a legacy TSV file."""
    deck = "RECALL::Unknown"
    cards = []
    for line in text.splitlines():
        if line.startswith("#deck:"):
            deck = line[len("#deck:"):].strip()
            continue
        if not line.strip() or line.startswith("#"):
            continue
        cols = line.split("\t")
        if len(cols) < 5:
            continue
        guid, front, back, source, tags_str = cols[0], cols[1], cols[2], cols[3], cols[4]
        tags = tags_str.split()
        answer, note, code = split_back(back)
        cards.append(
            {
                "id": guid.strip(),
                "front": _detag(front),
                "answer": answer,
                "note": note,
                "code": code,
                "math": None,
                "ipa": None,
                "example": None,
                "audio": None,
                "application": None,
                "application_url": None,
                "source": source.strip(),
                "source_text": None,
                "tags": tags,
            }
        )
    return deck, cards


def empty_fsrs_card() -> dict:
    """A ts-fsrs createEmptyCard() equivalent (state 0 = New)."""
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    return {
        "due": now,
        "stability": 0,
        "difficulty": 0,
        "elapsed_days": 0,
        "scheduled_days": 0,
        "learning_steps": 0,
        "reps": 0,
        "lapses": 0,
        "state": 0,
        "last_review": None,
    }


def main() -> None:
    archives = sorted(ARCHIVE_DIR.glob("*.txt"))
    if not archives:
        print("No _archive/*.txt files to migrate.")
        return

    CARDS_DIR.mkdir(exist_ok=True)
    STATE_DIR.mkdir(exist_ok=True)

    scheduler = {}
    if SCHEDULER_FILE.exists():
        scheduler = json.loads(SCHEDULER_FILE.read_text(encoding="utf-8"))

    total_cards = 0
    for path in archives:
        deck, cards = parse_tsv(path.read_text(encoding="utf-8"))
        if not cards:
            print(f"  {path.name}: no cards parsed, skipping.")
            continue
        slug = deck_to_slug(deck)
        domain = domain_from(deck, cards[0]["tags"])
        out = {"deck": deck, "domain": domain, "cards": cards}
        (CARDS_DIR / f"{slug}.json").write_text(
            json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        for c in cards:
            scheduler.setdefault(c["id"], empty_fsrs_card())  # preserve existing state
        total_cards += len(cards)
        with_note = sum(1 for c in cards if c["note"])
        with_code = sum(1 for c in cards if c["code"])
        print(
            f"  {path.name} → cards/{slug}.json  "
            f"({len(cards)} cards, {with_note} notes, {with_code} code)"
        )

    SCHEDULER_FILE.write_text(
        json.dumps(scheduler, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    # index.json — lets the PWA load decks over plain HTTP (public Pages / local
    # dev) without needing the GitHub API to list the cards/ directory.
    slugs = sorted(p.stem for p in CARDS_DIR.glob("*.json") if p.name != "index.json")
    (CARDS_DIR / "index.json").write_text(
        json.dumps({"decks": slugs}, indent=2) + "\n", encoding="utf-8"
    )

    print(f"\nDone. {total_cards} cards across {len(archives)} deck(s).")
    print(f"Scheduler seeded: {len(scheduler)} entries → state/scheduler.json")
    print(f"Index: {len(slugs)} deck(s) → cards/index.json")


if __name__ == "__main__":
    main()
