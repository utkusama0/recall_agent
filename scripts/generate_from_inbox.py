"""
generate_from_inbox.py — RECALL card generator (cloud-safe, no Anki access)

Reads unprocessed digest blocks from _inbox/digest.md, calls Claude Sonnet 4.6
to generate Anki TSV cards, writes one draft TSV per block into _review/, and
marks processed blocks so they are never re-processed.

Run: python scripts/generate_from_inbox.py
Requires: ANTHROPIC_API_KEY in environment.
Must NOT be run on cloud infra that cannot reach localhost — this script never
touches Anki; import is handled separately by import_to_anki.py.
"""

import os
import re
import sys
import datetime
import pathlib
import anthropic

# Force UTF-8 stdout/stderr so non-ASCII status chars (→, —) don't crash on
# Windows when output is redirected to a file (default cp1254 codec is strict).
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

REPO_ROOT = pathlib.Path(__file__).parent.parent
INBOX_FILE = REPO_ROOT / "_inbox" / "digest.md"
REVIEW_DIR = REPO_ROOT / "_review"
PROCESSED_FILE = REPO_ROOT / "_inbox" / "processed.md"
GENERATOR_PROMPT = (REPO_ROOT / "prompts" / "RECALL-Anki-Generate.md").read_text(encoding="utf-8")

MODEL = "claude-sonnet-4-6"

BLOCK_START = re.compile(r"^## .+·.+deck:.+·.+src:", re.MULTILINE)


def load_blocks(text: str) -> list[tuple[str, int, int]]:
    """Return list of (block_text, start_pos, end_pos) for unprocessed blocks."""
    blocks = []
    for m in BLOCK_START.finditer(text):
        # Skip if this block is already marked processed
        preceding = text[max(0, m.start() - 20) : m.start()]
        if "<!--PROCESSED" in preceding:
            continue
        # Find end: next block header or EOF
        next_m = BLOCK_START.search(text, m.end())
        end = next_m.start() if next_m else len(text)
        # Also stop before a <!--PROCESSED comment that belongs to the next block
        chunk = text[m.start() : end].rstrip()
        blocks.append((chunk, m.start(), m.start() + len(chunk)))
    return blocks


def extract_deck(block: str) -> str:
    m = re.search(r"deck:([^\s·\n]+)", block)
    return m.group(1) if m else "RECALL::Unknown"


def deck_to_slug(deck: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", deck.lower()).strip("-")


def generate_cards(block: str, deck: str) -> str:
    client = anthropic.Anthropic()
    system = GENERATOR_PROMPT
    user = f"Generate Anki cards for the following digest block.\n\nDeck: {deck}\n\n{block}"
    message = client.messages.create(
        model=MODEL,
        max_tokens=4096,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    return message.content[0].text


def write_draft(slug: str, content: str) -> pathlib.Path:
    date = datetime.date.today().isoformat()
    filename = f"{slug}-{date}.txt"
    out_path = REVIEW_DIR / filename
    # If file already exists for today, append with separator
    if out_path.exists():
        existing = out_path.read_text(encoding="utf-8")
        # Merge: keep headers from first, append data rows from new
        out_path.write_text(existing.rstrip() + "\n" + content, encoding="utf-8")
    else:
        out_path.write_text(content, encoding="utf-8")
    return out_path


def mark_processed(inbox_text: str, start: int, end: int, block: str) -> str:
    """Comment-out the processed block in the inbox text."""
    timestamp = datetime.datetime.now().isoformat(timespec="seconds")
    marker = f"<!--PROCESSED {timestamp}-->\n"
    return inbox_text[:start] + marker + inbox_text[start:]


def append_to_processed(block: str) -> None:
    timestamp = datetime.datetime.now().isoformat(timespec="seconds")
    with PROCESSED_FILE.open("a", encoding="utf-8") as f:
        f.write(f"\n<!-- Moved from inbox {timestamp} -->\n{block}\n")


def run() -> None:
    if not INBOX_FILE.exists():
        print("No digest.md found. Nothing to process.")
        return

    inbox_text = INBOX_FILE.read_text(encoding="utf-8")
    blocks = load_blocks(inbox_text)

    if not blocks:
        print("No unprocessed blocks found in digest.md.")
        return

    print(f"Found {len(blocks)} unprocessed block(s).")

    # Process in reverse order so position offsets stay valid when we insert markers
    offset = 0
    results = []
    for block_text, start, end in blocks:
        deck = extract_deck(block_text)
        slug = deck_to_slug(deck)
        print(f"  Generating cards for deck: {deck} ...")
        try:
            tsv_output = generate_cards(block_text, deck)
            draft_path = write_draft(slug, tsv_output)
            print(f"  → Draft written: {draft_path.name}")
            results.append((block_text, start + offset, end + offset, True, str(draft_path)))
        except Exception as e:
            print(f"  ERROR generating cards: {e}", file=sys.stderr)
            results.append((block_text, start + offset, end + offset, False, str(e)))

    # Mark processed blocks in inbox (insert markers, do not delete)
    modified = inbox_text
    cumulative_offset = 0
    for block_text, start, end, success, info in results:
        if success:
            timestamp = datetime.datetime.now().isoformat(timespec="seconds")
            marker = f"<!--PROCESSED {timestamp} → {pathlib.Path(info).name}-->\n"
            insert_at = start + cumulative_offset
            modified = modified[:insert_at] + marker + modified[insert_at:]
            cumulative_offset += len(marker)
            append_to_processed(block_text)

    INBOX_FILE.write_text(modified, encoding="utf-8")

    succeeded = sum(1 for _, _, _, ok, _ in results if ok)
    print(f"\nDone. {succeeded}/{len(results)} block(s) processed. Drafts in _review/.")
    if succeeded < len(results):
        print("Some blocks failed — check stderr. They remain unprocessed in digest.md.")


if __name__ == "__main__":
    run()
