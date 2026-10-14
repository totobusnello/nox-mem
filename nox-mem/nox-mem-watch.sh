#!/bin/bash
# File watcher for nox-mem auto-indexation.
#
# Events (2026-10-14, write path without loss):
#   close_write, moved_to  → ingest. close_write fires once per completed write
#                            (modify fired per write() call, hence the old debounce);
#                            moved_to catches editors that save by renaming a temp
#                            file over the target, which modify,create never saw.
#   delete, moved_from     → tombstone: the chunks stay, marked for review
#                            (nox-mem tombstones). Never deleted from here.
#
# Directories: inotify reports `mv dir/ elsewhere/` as ONE event on the
# directory, not one per file. So no --include filter (it would drop directory
# events, whose names have no .md/.json): a directory leaving → tombstone --dir;
# a directory arriving → ingest every file inside (rename keeps ids by adoption).
#
# No debounce: ingest is a per-chunk diff, so re-ingesting an unchanged file
# writes nothing. The old leading-edge debounce dropped the LAST write when two
# landed inside the window — a file created empty and filled a second later was
# indexed empty.

WORKSPACE="${OPENCLAW_WORKSPACE:-$(openclaw config get workspace 2>/dev/null || echo "$HOME/.openclaw/workspace")}"
WATCH_DIRS=(
    "$WORKSPACE/memory"
    "$WORKSPACE/shared"
)

NOX=/usr/local/bin/nox-mem

inotifywait -m -r -e close_write,moved_to,delete,moved_from \
    "${WATCH_DIRS[@]}" \
    --format '%e|%w%f' 2>/dev/null | while IFS='|' read -r events file; do

    if [[ "$events" == *ISDIR* ]]; then
        case "$events" in
            *DELETE*|*MOVED_FROM*)
                "$NOX" tombstone --dir "$file" 2>&1 | logger -t nox-mem-watcher ;;
            *MOVED_TO*)
                find "$file" -type f \( -name '*.md' -o -name '*.json' \) \
                    ! -name MEMORY.md ! -name SESSION-STATE.md -print0 |
                    while IFS= read -r -d '' f; do
                        "$NOX" ingest "$f" 2>&1 | logger -t nox-mem-watcher
                    done ;;
        esac
        continue
    fi

    [[ "$file" =~ \.(md|json)$ ]] || continue
    # Skip MEMORY.md and SESSION-STATE.md
    [[ "$file" == *"/MEMORY.md" ]] && continue
    [[ "$file" == *"/SESSION-STATE.md" ]] && continue

    case "$events" in
        *DELETE*|*MOVED_FROM*)
            "$NOX" tombstone "$file" 2>&1 | logger -t nox-mem-watcher
            ;;
        *)
            if [[ -f "$file" ]]; then
                "$NOX" ingest "$file" 2>&1 | logger -t nox-mem-watcher
            fi
            ;;
    esac
done
