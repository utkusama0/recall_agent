"""
import_to_anki.py — RECALL local importer (LOCAL ONLY — never run in the cloud)

Reads approved TSV files from _approved/, imports each note into Anki via
AnkiConnect (localhost:8765) using stable GUIDs for idempotency:
  - If a note with tag guid::<id> exists → update fields in place.
  - If not → add as a new note.
On success, moves the file to _archive/ and appends a log entry.

Run: python scripts/import_to_anki.py
Requires: Anki open with AnkiConnect add-on (code 2055492159) running on :8765.
"""

import sys
import json
import pathlib
import re
import shutil
import datetime
import urllib.request
import urllib.error

# Force UTF-8 stdout/stderr so non-ASCII status chars (→, —) don't crash on
# Windows when output is redirected to a file (default cp1254 codec is strict).
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

REPO_ROOT = pathlib.Path(__file__).parent.parent
APPROVED_DIR = REPO_ROOT / "_approved"
ARCHIVE_DIR = REPO_ROOT / "_archive"
LOG_FILE = REPO_ROOT / "_archive" / "import.log"
ANKICONNECT_URL = "http://localhost:8765"


# ── AnkiConnect helpers ──────────────────────────────────────────────────────

def ac_request(action: str, **params) -> object:
    payload = json.dumps({"action": action, "version": 6, "params": params}).encode()
    req = urllib.request.Request(ANKICONNECT_URL, data=payload,
                                  headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"Cannot reach AnkiConnect at {ANKICONNECT_URL}. "
            "Is Anki open with the AnkiConnect add-on installed?\n"
            f"Original error: {e}"
        ) from e
    if result.get("error"):
        raise RuntimeError(f"AnkiConnect error: {result['error']}")
    return result["result"]


def ensure_deck(deck_name: str) -> None:
    ac_request("createDeck", deck=deck_name)


def find_note_by_guid(guid: str) -> int | None:
    query = f"tag:guid::{guid}"
    ids = ac_request("findNotes", query=query)
    return ids[0] if ids else None


def add_note(deck: str, notetype: str, front: str, back: str,
             source: str, tags: list[str]) -> int:
    note = {
        "deckName": deck,
        "modelName": notetype,
        "fields": {"Front": front, "Back": back},
        "tags": tags,
        "options": {"allowDuplicate": False},
    }
    return ac_request("addNote", note=note)


def update_note(note_id: int, front: str, back: str, tags: list[str]) -> None:
    ac_request("updateNoteFields", note={
        "id": note_id,
        "fields": {"Front": front, "Back": back},
    })
    ac_request("updateNoteTags", note=note_id, tags=" ".join(tags))


# ── TSV parsing ──────────────────────────────────────────────────────────────

def parse_tsv(text: str) -> tuple[str, str, list[dict]]:
    """Return (deck_name, notetype, list of note dicts)."""
    deck = "RECALL::Unknown"
    notetype = "Basic"
    notes = []

    lines = text.splitlines()
    data_lines = []
    for line in lines:
        if line.startswith("#deck:"):
            deck = line[6:].strip()
        elif line.startswith("#notetype:"):
            notetype = line[10:].strip()
        elif line.startswith("#") or not line.strip():
            continue
        else:
            data_lines.append(line)

    for line in data_lines:
        parts = line.split("\t")
        if len(parts) < 5:
            continue
        guid, front, back, source, tags_raw = parts[0], parts[1], parts[2], parts[3], parts[4]
        tags = tags_raw.strip().split() if tags_raw.strip() else []
        notes.append({
            "guid": guid,
            "front": front,
            "back": back,
            "source": source,
            "tags": tags,
        })

    return deck, notetype, notes


# ── Main import logic ────────────────────────────────────────────────────────

def import_file(tsv_path: pathlib.Path) -> tuple[int, int]:
    """Return (added, updated) counts."""
    text = tsv_path.read_text(encoding="utf-8")
    deck, notetype, notes = parse_tsv(text)

    if not notes:
        print(f"  No valid notes found in {tsv_path.name}, skipping.")
        return 0, 0

    ensure_deck(deck)
    added = updated = 0

    for note in notes:
        guid_tag = f"guid::{note['guid']}"
        all_tags = note["tags"] + [guid_tag]

        existing_id = find_note_by_guid(note["guid"])
        if existing_id is None:
            add_note(deck, notetype, note["front"], note["back"], note["source"], all_tags)
            added += 1
        else:
            update_note(existing_id, note["front"], note["back"], all_tags)
            updated += 1

    return added, updated


def log_import(filename: str, deck: str, added: int, updated: int) -> None:
    timestamp = datetime.datetime.now().isoformat(timespec="seconds")
    entry = f"{timestamp}\t{filename}\t{deck}\tadded:{added}\tupdated:{updated}\n"
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(entry)


def run() -> None:
    tsv_files = list(APPROVED_DIR.glob("*.txt")) + list(APPROVED_DIR.glob("*.tsv"))
    if not tsv_files:
        print("No approved files found in _approved/. Nothing to import.")
        return

    print(f"Found {len(tsv_files)} file(s) to import.")

    # Probe AnkiConnect before processing any files
    try:
        version = ac_request("version")
        print(f"AnkiConnect version {version} — connected.")
    except RuntimeError as e:
        print(f"\nFATAL: {e}", flush=True)
        raise SystemExit(1)

    total_added = total_updated = 0
    for tsv_path in tsv_files:
        print(f"\n  Importing {tsv_path.name} ...")
        text = tsv_path.read_text(encoding="utf-8")
        deck, notetype, _ = parse_tsv(text)
        try:
            added, updated = import_file(tsv_path)
            print(f"  → {added} added, {updated} updated into deck '{deck}'")
            log_import(tsv_path.name, deck, added, updated)
            dest = ARCHIVE_DIR / tsv_path.name
            shutil.move(str(tsv_path), str(dest))
            print(f"  → Moved to _archive/{tsv_path.name}")
            total_added += added
            total_updated += updated
        except Exception as e:
            print(f"  ERROR importing {tsv_path.name}: {e}")
            print("  File left in _approved/ for retry.")

    print(f"\nDone. Total: {total_added} added, {total_updated} updated.")


if __name__ == "__main__":
    run()
