"""
Crossword layout engine.

Takes a list of answers (with clues) and automatically places them on a grid,
choosing direction (across/down) to maximise overlap and interweaving.

Algorithm:
1. Sort words longest-first.
2. Place the first word across at the centre.
3. For every remaining word, try BOTH across and down at every position,
   pick the placement with the highest intersection score.
4. Multiple passes so later words get a second chance after the grid fills in.
5. Trim the grid and assign clue numbers in newspaper order.
"""

from __future__ import annotations
from dataclasses import dataclass

GRID_SIZE = 80  # working grid – trimmed later


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
    """Check whether *word* can be placed without conflicts."""
    dr, dc = (0, 1) if direction == "across" else (1, 0)
    length = len(word)

    end_row = row + dr * (length - 1)
    end_col = col + dc * (length - 1)
    if end_row >= size or end_col >= size or row < 0 or col < 0:
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
    """Count how many letters overlap with already-placed letters."""
    dr, dc = (0, 1) if direction == "across" else (1, 0)
    return sum(1 for i, ch in enumerate(word)
               if grid[row + dr * i][col + dc * i] == ch)


def _find_best_placement_both_dirs(grid, word, size):
    """Try every position in BOTH directions; return (row, col, direction, score) or None."""
    best = None
    for direction in ("across", "down"):
        for r in range(size):
            for c in range(size):
                if _can_place(grid, word, r, c, direction, size):
                    score = _score_placement(grid, word, r, c, direction)
                    if score > 0 and (best is None or score > best[3]):
                        best = (r, c, direction, score)
    return best


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
        return {"grid": [], "placedWords": [], "unplacedWords": [], "size": {"rows": 0, "cols": 0}}

    # Sort longest-first for better placement
    words = sorted(entries, key=lambda e: len(e["answer"]), reverse=True)

    grid = _empty_grid(GRID_SIZE)
    placed: list[PlacedWord] = []

    # Place the first word across at the centre
    first = words[0]
    mid = GRID_SIZE // 2
    start_col = mid - len(first["answer"]) // 2
    _place(grid, first["answer"], mid, start_col, "across")
    placed.append(PlacedWord(
        answer=first["answer"], clue=first["clue"],
        direction="across", row=mid, col=start_col,
    ))

    remaining = words[1:]

    # Multiple passes – later words may fit after others are placed
    for _pass in range(3):
        still_remaining = []
        for entry in remaining:
            result = _find_best_placement_both_dirs(grid, entry["answer"], GRID_SIZE)
            if result:
                r, c, direction, _ = result
                _place(grid, entry["answer"], r, c, direction)
                placed.append(PlacedWord(
                    answer=entry["answer"], clue=entry["clue"],
                    direction=direction, row=r, col=c,
                ))
            else:
                still_remaining.append(entry)
        remaining = still_remaining
        if not remaining:
            break

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
