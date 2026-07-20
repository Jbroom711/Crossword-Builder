"""
Crossword layout engine.

Takes a list of answers (with clues) and places them on a grid, choosing
across/down to maximise interweaving.

Strategy:
1. Placement is intersection-driven: a word can only be placed where it crosses
   an already-placed letter, so we enumerate exactly those candidate spots
   (fast) and validate each with the conflict checker.
2. One layout = greedy fill in a (randomised) word order, several passes so
   later words get a second chance.
3. We build MANY layouts with different random orders / tie-breaking and keep
   the densest one — ranked by (most words placed, then most intersections,
   then smallest bounding-box area). This maximises interweaving and shrinks
   the grid for the same set of answers.
4. Trim to the bounding box and assign clue numbers in newspaper order.
"""

from __future__ import annotations
from dataclasses import dataclass
import random
import time

GRID_SIZE = 80          # working grid – trimmed later
TIME_BUDGET_SEC = 2.0   # wall-clock budget for the multi-restart search
MAX_ATTEMPTS = 600      # hard cap on layouts tried
SEED = 1234567          # fixed seed -> same answers give the same (dense) grid


@dataclass
class PlacedWord:
    answer: str
    clue: str
    direction: str  # "across" | "down"
    row: int
    col: int
    number: int = 0


def _empty_grid(size: int) -> list[list[str]]:
    return [["" for _ in range(size)] for _ in range(size)]


def _can_place(grid: list[list[str]], word: str, row: int, col: int,
               direction: str, size: int) -> bool:
    """Check whether *word* can be placed without conflicts (must intersect)."""
    dr, dc = (0, 1) if direction == "across" else (1, 0)
    length = len(word)

    end_row = row + dr * (length - 1)
    end_col = col + dc * (length - 1)
    if row < 0 or col < 0 or end_row >= size or end_col >= size:
        return False

    before_r, before_c = row - dr, col - dc
    if 0 <= before_r < size and 0 <= before_c < size:
        if grid[before_r][before_c] != "":
            return False

    after_r = row + dr * length
    after_c = col + dc * length
    if 0 <= after_r < size and 0 <= after_c < size:
        if grid[after_r][after_c] != "":
            return False

    has_intersection = False
    for i, ch in enumerate(word):
        r = row + dr * i
        c = col + dc * i
        cell = grid[r][c]
        if cell == ch:
            has_intersection = True
        elif cell != "":
            return False
        else:
            if direction == "across":
                if r - 1 >= 0 and grid[r - 1][c] != "":
                    return False
                if r + 1 < size and grid[r + 1][c] != "":
                    return False
            else:
                if c - 1 >= 0 and grid[r][c - 1] != "":
                    return False
                if c + 1 < size and grid[r][c + 1] != "":
                    return False

    return has_intersection


def _place(grid: list[list[str]], word: str, row: int, col: int,
           direction: str) -> None:
    dr, dc = (0, 1) if direction == "across" else (1, 0)
    for i, ch in enumerate(word):
        grid[row + dr * i][col + dc * i] = ch


def _score_placement(grid: list[list[str]], word: str, row: int, col: int,
                     direction: str) -> int:
    """Count how many letters overlap already-placed letters."""
    dr, dc = (0, 1) if direction == "across" else (1, 0)
    return sum(1 for i, ch in enumerate(word)
               if grid[row + dr * i][col + dc * i] == ch)


def _candidate_spots(by_char: dict, word: str):
    """Every (row, col, direction) where *word* crosses an existing letter.

    For each letter i of the word and each existing cell (r, c) holding that
    same letter, aligning them gives one across and one down candidate.
    """
    spots = []
    for i, ch in enumerate(word):
        for (r, c) in by_char.get(ch, ()):
            spots.append((r, c - i, "across"))
            spots.append((r - i, c, "down"))
    return spots


def _build_layout(entries: list[dict], rng: random.Random):
    """Greedily fill one layout in a randomised order. Returns (grid, placed, remaining)."""
    grid = _empty_grid(GRID_SIZE)
    placed: list[PlacedWord] = []
    by_char: dict[str, list[tuple[int, int]]] = {}

    def _remember(word: str, row: int, col: int, direction: str) -> None:
        dr, dc = (0, 1) if direction == "across" else (1, 0)
        for i, ch in enumerate(word):
            by_char.setdefault(ch, []).append((row + dr * i, col + dc * i))

    # Longest-first, with random tie-breaks (and occasional shuffle via the key).
    order = sorted(entries, key=lambda e: (len(e["answer"]), rng.random()), reverse=True)

    first = order[0]
    mid = GRID_SIZE // 2
    start_col = mid - len(first["answer"]) // 2
    _place(grid, first["answer"], mid, start_col, "across")
    _remember(first["answer"], mid, start_col, "across")
    placed.append(PlacedWord(first["answer"], first["clue"], "across", mid, start_col))

    remaining = order[1:]
    for _pass in range(3):
        still_remaining = []
        for entry in remaining:
            word = entry["answer"]
            spots = _candidate_spots(by_char, word)
            rng.shuffle(spots)  # randomise tie-breaking between equal-overlap spots
            best = None  # (overlaps, row, col, direction)
            tried = set()
            for (r, c, direction) in spots:
                key = (r, c, direction)
                if key in tried:
                    continue
                tried.add(key)
                if _can_place(grid, word, r, c, direction, GRID_SIZE):
                    ov = _score_placement(grid, word, r, c, direction)
                    if best is None or ov > best[0]:
                        best = (ov, r, c, direction)
            if best:
                _, r, c, direction = best
                _place(grid, word, r, c, direction)
                _remember(word, r, c, direction)
                placed.append(PlacedWord(word, entry["clue"], direction, r, c))
            else:
                still_remaining.append(entry)
        remaining = still_remaining
        if not remaining:
            break

    return grid, placed, remaining


def _quality(placed: list[PlacedWord]):
    """Rank a layout: more words placed, then more intersections, then smaller area."""
    if not placed:
        return (0, 0, 0)
    min_r = min(p.row for p in placed)
    max_r = max(p.row + (len(p.answer) - 1 if p.direction == "down" else 0) for p in placed)
    min_c = min(p.col for p in placed)
    max_c = max(p.col + (len(p.answer) - 1 if p.direction == "across" else 0) for p in placed)
    area = (max_r - min_r + 1) * (max_c - min_c + 1)

    across_cells = set()
    down_cells = set()
    for p in placed:
        dr, dc = (0, 1) if p.direction == "across" else (1, 0)
        for i in range(len(p.answer)):
            cell = (p.row + dr * i, p.col + dc * i)
            (across_cells if p.direction == "across" else down_cells).add(cell)
    intersections = len(across_cells & down_cells)

    return (len(placed), intersections, -area)


def generate_crossword(entries: list[dict]) -> dict:
    """
    Parameters
    ----------
    entries : list of {"answer": str, "clue": str}
              (direction is optional and ignored – the engine decides)

    Returns
    -------
    dict with keys: grid, numberGrid, size, placedWords, unplacedWords
    """
    if not entries:
        return {"grid": [], "numberGrid": [], "placedWords": [], "unplacedWords": [],
                "size": {"rows": 0, "cols": 0}}

    if len(entries) == 1:
        # Single word – nothing to interweave.
        entries = list(entries)

    rng = random.Random(SEED)
    best_placed: list[PlacedWord] | None = None
    best_remaining: list[dict] = entries
    best_q = None

    start = time.time()
    attempts = 0
    while attempts < MAX_ATTEMPTS and (time.time() - start) < TIME_BUDGET_SEC:
        attempts += 1
        _, placed, remaining = _build_layout(entries, rng)
        q = _quality(placed)
        if best_q is None or q > best_q:
            best_q = q
            best_placed = placed
            best_remaining = remaining
        # Can't do better than "all placed, tight" — but keep exploring within budget.

    placed = best_placed or []
    remaining = best_remaining

    # Rebuild the grid for the winning layout (for trimming + rendering).
    grid = _empty_grid(GRID_SIZE)
    for p in placed:
        _place(grid, p.answer, p.row, p.col, p.direction)

    # --- Trim grid to bounding box ---
    min_r = min(p.row for p in placed)
    max_r = max(p.row + (len(p.answer) - 1 if p.direction == "down" else 0) for p in placed)
    min_c = min(p.col for p in placed)
    max_c = max(p.col + (len(p.answer) - 1 if p.direction == "across" else 0) for p in placed)

    for p in placed:
        p.row -= min_r
        p.col -= min_c

    rows = max_r - min_r + 1
    cols = max_c - min_c + 1

    trimmed = [
        [grid[r][c] if grid[r][c] != "" else None
         for c in range(min_c, max_c + 1)]
        for r in range(min_r, max_r + 1)
    ]

    # --- Assign clue numbers (newspaper order) ---
    number_grid = [[0] * cols for _ in range(rows)]
    num = 1
    for r in range(rows):
        for c in range(cols):
            if trimmed[r][c] is None:
                continue
            starts_across = any(
                p.direction == "across" and p.row == r and p.col == c
                for p in placed
            )
            starts_down = any(
                p.direction == "down" and p.row == r and p.col == c
                for p in placed
            )
            if starts_across or starts_down:
                number_grid[r][c] = num
                for p in placed:
                    if p.row == r and p.col == c:
                        p.number = num
                num += 1

    placed_dicts = [
        {
            "answer": p.answer,
            "clue": p.clue,
            "direction": p.direction,
            "row": p.row,
            "col": p.col,
            "number": p.number,
        }
        for p in placed
    ]

    unplaced_dicts = [
        {"answer": e["answer"], "clue": e["clue"]}
        for e in remaining
    ]

    return {
        "grid": trimmed,
        "numberGrid": number_grid,
        "size": {"rows": rows, "cols": cols},
        "placedWords": placed_dicts,
        "unplacedWords": unplaced_dicts,
    }
