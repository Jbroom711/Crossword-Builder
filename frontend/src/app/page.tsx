"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useUser, SignInButton, UserButton } from "@clerk/nextjs";
import jsPDF from "jspdf";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";
const FONT_HEADING = "'Playfair Display', Georgia, serif";
const FONT_BODY = "'Libre Franklin', system-ui, sans-serif";
const MANUAL_PADDING = 5; // extra cells around the grid in manual mode

interface ClueEntry {
  answer: string;
  clue: string;
}

interface PlacedWord {
  answer: string;
  clue: string;
  direction: string;
  row: number;
  col: number;
  number: number;
}

interface CrosswordResult {
  grid: (string | null)[][];
  numberGrid: number[][];
  size: { rows: number; cols: number };
  placedWords: PlacedWord[];
  unplacedWords: { answer: string; clue: string }[];
}

interface SavedPuzzle {
  id: string;
  title: string;
  byline?: string;
  date: string;
  clues: ClueEntry[];
  result: CrosswordResult | null;
  savedAt: string;
  manualGrid?: (string | null)[][];
  manualGridSize?: { rows: number; cols: number };
}

// Full working state autosaved to localStorage so a tab/window close never
// loses unsaved work. Restored via the banner on next load.
interface DraftState {
  savedAt: string;
  puzzleTitle: string;
  puzzleByline: string;
  currentPuzzleId: string | null;
  clues: ClueEntry[];
  result: CrosswordResult | null;
  mode: "auto" | "manual";
  manualGrid: (string | null)[][];
  manualGridSize: { rows: number; cols: number };
  hiddenMessageMode: boolean;
  hiddenMessageCells: { r: number; c: number }[];
  hiddenMessageText: string;
}

const DRAFT_KEY = "crossword_draft";

// User-controlled grid zoom (multiplies the responsive base cell size).
const GRID_ZOOM_KEY = "crossword_grid_zoom";
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.15;
function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
}
// Responsive base cell size by viewport width — MUST match the media-query
// breakpoints in globals.css.
function baseCellSize(width: number): number {
  if (width <= 640) return 28;
  if (width >= 1440) return 54;
  if (width >= 1024) return 46;
  return 38;
}

// A dynamic clue cross-reference, e.g. {11-down} or {3-across}. Lenient parse:
// optional spaces, optional hyphen, full word or single letter, any case.
const CLUE_REF_RE = /\{\s*(\d+)\s*-?\s*(across|down|a|d)\s*\}/gi;

function refDir(token: string): "across" | "down" {
  const s = token.toLowerCase();
  return s === "a" || s === "across" ? "across" : "down";
}

// Re-point {N-dir} references so they follow their ANSWER across a renumber:
// resolve N-dir -> answer via the OLD numbering, then rewrite to that answer's
// number/direction in the NEW numbering. A reference that can't be resolved
// (its answer was removed / is no longer placed, or it points to a slot that
// doesn't exist) becomes {?} so the author can spot and fix it.
function resyncClueRefs(
  clues: ClueEntry[],
  oldWords: PlacedWord[],
  newWords: PlacedWord[]
): ClueEntry[] {
  if (oldWords.length === 0 || newWords.length === 0) return clues;
  const slotToAnswer = new Map<string, string>();
  for (const w of oldWords) {
    slotToAnswer.set(`${w.number}-${w.direction}`, w.answer.toUpperCase());
  }
  const answerToSlot = new Map<string, { number: number; direction: string }>();
  for (const w of newWords) {
    answerToSlot.set(w.answer.toUpperCase(), { number: w.number, direction: w.direction });
  }
  let anyChange = false;
  const out = clues.map((c) => {
    if (c.clue.indexOf("{") === -1) return c;
    const next = c.clue.replace(CLUE_REF_RE, (_whole, numStr, dirTok) => {
      const answer = slotToAnswer.get(`${numStr}-${refDir(dirTok)}`);
      if (!answer) return "{?}"; // no such slot in the old numbering
      const slot = answerToSlot.get(answer);
      if (!slot) return "{?}"; // the referenced answer is no longer placed
      return `{${slot.number}-${slot.direction}}`;
    });
    if (next !== c.clue) anyChange = true;
    return next === c.clue ? c : { ...c, clue: next };
  });
  return anyChange ? out : clues;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// Scan a grid for words (sequences of 2+ letters) and return them as PlacedWord[]
function detectWords(
  grid: (string | null)[][],
  rows: number,
  cols: number,
  existingWords: PlacedWord[]
): PlacedWord[] {
  const existingSet = new Set(
    existingWords.map((w) => `${w.row},${w.col},${w.direction}`)
  );
  const found: PlacedWord[] = [];

  // Scan across
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      if (grid[r][c]) {
        const startC = c;
        let word = "";
        while (c < cols && grid[r][c]) {
          word += grid[r][c];
          c++;
        }
        if (word.length >= 2) {
          const key = `${r},${startC},across`;
          if (!existingSet.has(key)) {
            found.push({
              answer: word,
              clue: "",
              direction: "across",
              row: r,
              col: startC,
              number: 0,
            });
          }
        }
      } else {
        c++;
      }
    }
  }

  // Scan down
  for (let c = 0; c < cols; c++) {
    let r = 0;
    while (r < rows) {
      if (grid[r][c]) {
        const startR = r;
        let word = "";
        while (r < rows && grid[r][c]) {
          word += grid[r][c];
          r++;
        }
        if (word.length >= 2) {
          const key = `${startR},${c},down`;
          if (!existingSet.has(key)) {
            found.push({
              answer: word,
              clue: "",
              direction: "down",
              row: startR,
              col: c,
              number: 0,
            });
          }
        }
      } else {
        r++;
      }
    }
  }

  return found;
}

// Assign clue numbers in newspaper order to all words on a grid
function assignNumbers(
  words: PlacedWord[],
  rows: number,
  cols: number
): { words: PlacedWord[]; numberGrid: number[][] } {
  const numberGrid = Array.from({ length: rows }, () => Array(cols).fill(0));
  const startCells = new Map<string, number>();
  let num = 1;

  // Find all starting cells in reading order
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const isStart = words.some((w) => w.row === r && w.col === c);
      if (isStart && !startCells.has(`${r},${c}`)) {
        startCells.set(`${r},${c}`, num);
        numberGrid[r][c] = num;
        num++;
      }
    }
  }

  const numbered = words.map((w) => ({
    ...w,
    number: startCells.get(`${w.row},${w.col}`) || 0,
  }));

  return { words: numbered, numberGrid };
}

export default function Home() {
  const { isSignedIn, isLoaded } = useUser();
  const [clues, setClues] = useState<ClueEntry[]>([
    { answer: "", clue: "" },
  ]);
  const [puzzleTitle, setPuzzleTitle] = useState("");
  const [puzzleByline, setPuzzleByline] = useState("");
  const [currentPuzzleId, setCurrentPuzzleId] = useState<string | null>(null);
  const [puzzleDate] = useState(formatDate(new Date()));
  const [result, setResult] = useState<CrosswordResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPuzzles, setSavedPuzzles] = useState<SavedPuzzle[]>([]);
  const [showSaved, setShowSaved] = useState(false);
  const [saveTimestamp, setSaveTimestamp] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<{
    message: string;
    onConfirm: () => void;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const printRef = useRef<HTMLDivElement>(null);

  // Manual mode state
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [manualGrid, setManualGrid] = useState<(string | null)[][]>([]);
  const [manualGridSize, setManualGridSize] = useState({ rows: 0, cols: 0 });
  const [selectedCell, setSelectedCell] = useState<{ r: number; c: number } | null>(null);
  const [manualDirection, setManualDirection] = useState<"across" | "down">("across");
  const manualGridRef = useRef<HTMLDivElement>(null);
  // True once the user has edited the grid in manual mode — used to grey out the
  // Generate button (regenerating would discard their manual layout).
  const [manualChanged, setManualChanged] = useState(false);

  // Hidden message state
  const [hiddenMessageMode, setHiddenMessageMode] = useState(false);
  const [hiddenMessageCells, setHiddenMessageCells] = useState<{ r: number; c: number }[]>([]);
  const [hiddenMessageText, setHiddenMessageText] = useState("");

  // Clicking a clue number highlights that word's cells in the grid. Cleared by
  // clicking anywhere that isn't a clue-number link.
  const [highlightRef, setHighlightRef] = useState<{ number: number; direction: string } | null>(null);
  const gridWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function clearOnOutsideClick(e: MouseEvent) {
      const el = e.target as HTMLElement | null;
      if (!el || !el.closest("[data-clue-ref]")) setHighlightRef(null);
    }
    document.addEventListener("click", clearOnOutsideClick);
    return () => document.removeEventListener("click", clearOnOutsideClick);
  }, []);

  function jumpToClueInGrid(number: number, direction: string) {
    setHighlightRef({ number, direction });
    requestAnimationFrame(() => {
      gridWrapRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  // User-controlled grid zoom (display only — does not affect the clue column
  // or PDF export). cellPx is the resolved pixel size (responsive base x zoom)
  // used LITERALLY in the grid templates — a CSS var inside repeat() doesn't
  // reliably resolve, which produced uneven columns.
  const [gridZoom, setGridZoom] = useState(1);
  const [cellPx, setCellPx] = useState(38);
  useEffect(() => {
    const saved = parseFloat(localStorage.getItem(GRID_ZOOM_KEY) || "");
    if (!Number.isNaN(saved) && saved > 0) setGridZoom(clampZoom(saved));
  }, []);
  useEffect(() => {
    localStorage.setItem(GRID_ZOOM_KEY, String(gridZoom));
    function applyCellSize() {
      const px = baseCellSize(window.innerWidth) * gridZoom;
      setCellPx(px);
      // Also expose it as a CSS var for cell widths / font scaling.
      document.documentElement.style.setProperty("--cell-size", `${px}px`);
    }
    applyCellSize();
    window.addEventListener("resize", applyCellSize);
    return () => window.removeEventListener("resize", applyCellSize);
  }, [gridZoom]);

  // Autosave / unsaved-work protection state
  const [draftToRestore, setDraftToRestore] = useState<DraftState | null>(null);
  const [dirty, setDirty] = useState(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftHydrated = useRef(false);
  // Serialized snapshot of the currently saved/loaded puzzle. A draft is only
  // kept when the working content differs from this baseline (i.e. there are
  // genuinely unsaved changes) — so an already-saved puzzle never nags "restore?".
  const savedContentRef = useRef<string>("");
  // Set right after a load/save so the next autosave pass adopts the settled
  // state as the new baseline.
  const pendingBaselineRef = useRef(false);

  // True when the user has entered anything worth protecting.
  function hasEditableContent(
    title: string,
    cl: ClueEntry[],
    res: CrosswordResult | null
  ): boolean {
    return (
      !!res ||
      title.trim().length > 0 ||
      cl.some((c) => c.answer.trim() || c.clue.trim())
    );
  }

  // On first mount, surface any autosaved draft for restoration (don't apply it
  // automatically — let the user choose, so we never clobber a fresh session).
  useEffect(() => {
    if (draftHydrated.current) return;
    draftHydrated.current = true;
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw) as DraftState;
        if (hasEditableContent(d.puzzleTitle || "", d.clues || [], d.result || null)) {
          setDraftToRestore(d);
        }
      }
    } catch {}
  }, []);

  // Continuously autosave the working puzzle to localStorage (debounced) so an
  // accidental close never loses unsaved work.
  useEffect(() => {
    // While a restore banner is pending, only skip autosaving if the current
    // state is still empty — that avoids clobbering the stored draft with a
    // blank session. Once the user actually types, autosave resumes and
    // protects the new work (the pending draft is still held in memory for the
    // Restore button).
    if (draftToRestore && !hasEditableContent(puzzleTitle, clues, result)) return;

    const currentContent = JSON.stringify([
      puzzleTitle,
      puzzleByline,
      clues,
      result,
      manualGrid,
      manualGridSize,
      hiddenMessageCells,
      hiddenMessageText,
    ]);

    // Just loaded or saved a puzzle: adopt the settled state as the saved
    // baseline and drop any draft — there are no unsaved changes yet.
    if (pendingBaselineRef.current) {
      pendingBaselineRef.current = false;
      savedContentRef.current = currentContent;
      localStorage.removeItem(DRAFT_KEY);
      setDirty(false);
      return;
    }

    if (draftTimer.current) clearTimeout(draftTimer.current);

    // Nothing entered, OR content identical to the saved/loaded puzzle → no
    // unsaved work, so keep no draft (this is what stops the "restore?" banner
    // from appearing for a puzzle that's already saved).
    if (
      !hasEditableContent(puzzleTitle, clues, result) ||
      currentContent === savedContentRef.current
    ) {
      localStorage.removeItem(DRAFT_KEY);
      setDirty(false);
      return;
    }
    draftTimer.current = setTimeout(() => {
      const draft: DraftState = {
        savedAt: new Date().toISOString(),
        puzzleTitle,
        puzzleByline,
        currentPuzzleId,
        clues,
        result,
        mode,
        manualGrid,
        manualGridSize,
        hiddenMessageMode,
        hiddenMessageCells,
        hiddenMessageText,
      };
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        setDirty(true);
      } catch {}
    }, 600);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    puzzleTitle,
    puzzleByline,
    currentPuzzleId,
    clues,
    result,
    mode,
    manualGrid,
    manualGridSize,
    hiddenMessageMode,
    hiddenMessageCells,
    hiddenMessageText,
    draftToRestore,
  ]);

  // Warn before leaving the page with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  function restoreDraft() {
    const d = draftToRestore;
    if (!d) return;
    setPuzzleTitle(d.puzzleTitle || "");
    setPuzzleByline(d.puzzleByline || "");
    setCurrentPuzzleId(d.currentPuzzleId ?? null);
    setClues(d.clues && d.clues.length ? d.clues : [{ answer: "", clue: "" }]);
    setResult(d.result || null);
    setMode(d.mode === "manual" ? "manual" : "auto");
    setManualGrid(d.manualGrid || []);
    setManualGridSize(d.manualGridSize || { rows: 0, cols: 0 });
    setHiddenMessageMode(!!d.hiddenMessageMode);
    setHiddenMessageCells(d.hiddenMessageCells || []);
    setHiddenMessageText(d.hiddenMessageText || "");
    setDraftToRestore(null);
    // If the restored work belongs to a saved puzzle, treat it as the baseline
    // so it won't keep re-prompting (it's recoverable from Saved anyway).
    // Genuinely-unsaved new work keeps its draft so it survives future reloads.
    if (d.currentPuzzleId) pendingBaselineRef.current = true;
  }

  function discardDraft() {
    localStorage.removeItem(DRAFT_KEY);
    setDraftToRestore(null);
    setDirty(false);
  }

  function isHiddenMessageCell(r: number, c: number) {
    return hiddenMessageCells.some((cell) => cell.r === r && cell.c === c);
  }

  function toggleHiddenMessageCell(r: number, c: number) {
    if (isHiddenMessageCell(r, c)) {
      setHiddenMessageCells(hiddenMessageCells.filter((cell) => !(cell.r === r && cell.c === c)));
    } else {
      setHiddenMessageCells([...hiddenMessageCells, { r, c }]);
    }
  }

  // Load saved puzzles from API (if signed in) or localStorage (if not)
  // If signed in and localStorage has puzzles, migrate them to the cloud
  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn) {
      (async () => {
        // Check for localStorage puzzles to migrate to the cloud
        const raw = localStorage.getItem("crossword_puzzles");
        if (raw) {
          try {
            const localPuzzles = JSON.parse(raw) as SavedPuzzle[];
            let allMigrated = true;
            for (const p of localPuzzles) {
              try {
                const res = await fetch("/api/puzzles", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    title: p.title,
                    byline: p.byline || "",
                    date: p.date,
                    clues: p.clues,
                    result: p.result,
                    manualGrid: p.manualGrid || null,
                    manualGridSize: p.manualGridSize || null,
                  }),
                });
                if (!res.ok) allMigrated = false;
              } catch {
                allMigrated = false;
              }
            }
            // Only delete the local copy once EVERY puzzle is confirmed in the
            // cloud. A silent failure here used to wipe localStorage anyway,
            // permanently losing puzzles that never uploaded.
            if (allMigrated) {
              localStorage.removeItem("crossword_puzzles");
            } else {
              setError(
                "Some puzzles couldn't be uploaded to your account and are still saved locally in this browser. Please try again."
              );
            }
          } catch {
            // Malformed localStorage — leave it untouched rather than risk loss.
          }
        }
        // Load from API
        try {
          const res = await fetch("/api/puzzles");
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data)) setSavedPuzzles(data);
          } else if (res.status === 401) {
            setError(
              "You appear to be signed in, but your session couldn't be verified. Try refreshing the page."
            );
          } else {
            setError(
              "Couldn't load your saved puzzles (server error). Your puzzles are safe in your account — please try again shortly."
            );
          }
        } catch {
          setError(
            "Couldn't reach the server to load your saved puzzles. Check your connection and try again."
          );
        }
      })();
    } else {
      const raw = localStorage.getItem("crossword_puzzles");
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) setSavedPuzzles(parsed);
        } catch {}
      }
    }
  }, [isLoaded, isSignedIn]);

  function updateClue(index: number, field: keyof ClueEntry, value: string) {
    const updated = [...clues];
    updated[index] = { ...updated[index], [field]: value };
    setClues(updated);
  }

  const answerRefs = useRef<(HTMLInputElement | null)[]>([]);
  const clueRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  // Tracks the last cell double-clicked in manual mode, to alternate between the
  // across and down clue when a cell starts both.
  const lastJumpRef = useRef<{ r: number; c: number; dir: "across" | "down" } | null>(null);

  useEffect(() => {
    if (focusIndex !== null && answerRefs.current[focusIndex]) {
      answerRefs.current[focusIndex]?.focus();
      setFocusIndex(null);
    }
  }, [focusIndex, clues]);

  function addClue() {
    setClues([...clues, { answer: "", clue: "" }]);
    setFocusIndex(clues.length);
  }

  function removeClue(index: number) {
    if (clues.length <= 1) return;
    setClues(clues.filter((_, i) => i !== index));
  }

  async function handleGenerate() {
    if (result) {
      return new Promise<void>((resolve) => {
        setConfirmModal({
          message: "This will replace your current crossword layout.\nAre you sure?",
          onConfirm: () => {
            setConfirmModal(null);
            doGenerate();
            resolve();
          },
        });
      });
    }
    doGenerate();
  }

  async function doGenerate() {
    // Only answers are needed to lay out the grid — clue text can be filled in
    // later. (Previously this required clue text too, so answer-only entries
    // were silently dropped from the request.)
    const valid = clues.filter((c) => c.answer.trim());
    if (valid.length < 2) {
      setError("Please enter at least 2 answers to generate a grid.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clues: valid }),
      });
      if (!res.ok) throw new Error("Generation failed");
      const data: CrosswordResult = await res.json();
      setResult(data);
      reorderClues(data);
      buildManualGrid(data);
    } catch (e: any) {
      setError(e.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  // Reorder clue entries to match puzzle order: Across by number, then Down by
  // number — WITHOUT discarding any of the user's work. Placed words come first
  // (in grid order); every other answer the user entered (unplaced words,
  // answer-only entries, drafts) is kept at the end so nothing is ever lost.
  function reorderClues(data: CrosswordResult) {
    const across = data.placedWords
      .filter((w) => w.direction === "across")
      .sort((a, b) => a.number - b.number);
    const down = data.placedWords
      .filter((w) => w.direction === "down")
      .sort((a, b) => a.number - b.number);
    const ordered = [...across, ...down];
    const placedAnswers = new Set(ordered.map((w) => w.answer.toUpperCase()));

    // Update any {N-dir} cross-references to follow their answers to the new
    // numbering before we reshuffle the clue text.
    const synced = resyncClueRefs(clues, result?.placedWords || [], data.placedWords);

    // Preserve whatever clue text the user already wrote for each answer.
    const clueLookup = new Map<string, string>();
    for (const c of synced) {
      if (c.answer.trim()) {
        clueLookup.set(c.answer.toUpperCase(), c.clue);
      }
    }

    const placedEntries = ordered.map((w) => ({
      answer: w.answer,
      clue: clueLookup.get(w.answer.toUpperCase()) || w.clue || "",
    }));

    // Keep every entry the user typed that didn't get placed — never drop them.
    const leftovers = synced.filter(
      (c) => c.answer.trim() && !placedAnswers.has(c.answer.toUpperCase())
    );

    setClues([...placedEntries, ...leftovers]);
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${API_URL}/api/upload`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        // Prefer the server's specific message (e.g. bad columns).
        let msg = "Upload failed. Expected a CSV with 'answer' and 'clue' columns.";
        try {
          const j = await res.json();
          if (j?.error) msg = j.error;
        } catch {}
        throw new Error(msg);
      }
      const data: CrosswordResult = await res.json();
      setResult(data);
      reorderClues(data);
      buildManualGrid(data);
    } catch (err: any) {
      setError(
        err?.message === "Failed to fetch"
          ? "Couldn't reach the puzzle server. It may be waking up — wait a few seconds and try again."
          : err?.message || "Something went wrong with the upload."
      );
    } finally {
      setLoading(false);
      // Allow re-selecting the same file after a fix.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // Build the expanded manual grid from an auto result
  function buildManualGrid(data: CrosswordResult) {
    const padR = data.size.rows + MANUAL_PADDING * 2;
    const padC = data.size.cols + MANUAL_PADDING * 2;
    const grid: (string | null)[][] = Array.from({ length: padR }, () =>
      Array(padC).fill(null)
    );
    // Copy existing letters with offset
    for (let r = 0; r < data.size.rows; r++) {
      for (let c = 0; c < data.size.cols; c++) {
        grid[r + MANUAL_PADDING][c + MANUAL_PADDING] = data.grid[r][c];
      }
    }
    setManualGrid(grid);
    setManualGridSize({ rows: padR, cols: padC });
    setManualChanged(false); // fresh grid from a (re)generation
  }

  function handleCellClick(r: number, c: number) {
    if (selectedCell?.r === r && selectedCell?.c === c) {
      // Clicking same cell toggles direction
      setManualDirection((d) => (d === "across" ? "down" : "across"));
    } else {
      setSelectedCell({ r, c });
    }
  }

  // If (r,c) is the FIRST letter of a word in the manual grid in the given
  // direction, return that word's answer text; otherwise null.
  function manualWordStartingAt(r: number, c: number, dir: "across" | "down"): string | null {
    const g = manualGrid;
    if (!g[r]?.[c]) return null;
    if (dir === "across") {
      const startsHere = c === 0 || !g[r][c - 1];
      const hasNext = !!g[r][c + 1];
      if (!startsHere || !hasNext) return null;
      let word = "";
      for (let cc = c; g[r]?.[cc]; cc++) word += g[r][cc];
      return word;
    }
    const startsHere = r === 0 || !g[r - 1]?.[c];
    const hasNext = !!g[r + 1]?.[c];
    if (!startsHere || !hasNext) return null;
    let word = "";
    for (let rr = r; g[rr]?.[c]; rr++) word += g[rr][c];
    return word;
  }

  // Double-click the first letter of an answer in the manual grid to jump the
  // clue list to that answer. If the cell starts both an across and a down word,
  // jump to Across first, then Down on a repeat double-click of the same cell.
  function jumpToClue(answer: string) {
    const idx = clues.findIndex((cl) => cl.answer.trim().toUpperCase() === answer.toUpperCase());
    if (idx < 0) return;
    requestAnimationFrame(() => {
      const el = clueRefs.current[idx] || answerRefs.current[idx];
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.focus();
      }
    });
  }

  function handleManualDoubleClick(r: number, c: number) {
    const across = manualWordStartingAt(r, c, "across");
    const down = manualWordStartingAt(r, c, "down");
    let answer: string | null = null;
    let dir: "across" | "down" | null = null;
    if (across && down) {
      const last = lastJumpRef.current;
      if (last && last.r === r && last.c === c && last.dir === "across") {
        answer = down;
        dir = "down";
      } else {
        answer = across;
        dir = "across";
      }
    } else if (across) {
      answer = across;
      dir = "across";
    } else if (down) {
      answer = down;
      dir = "down";
    }
    if (!answer || !dir) return;
    lastJumpRef.current = { r, c, dir };
    jumpToClue(answer);
  }

  const handleManualKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!selectedCell) return;
      const { r, c } = selectedCell;
      const dr = manualDirection === "down" ? 1 : 0;
      const dc = manualDirection === "across" ? 1 : 0;

      if (e.key.length === 1 && /^[A-Za-z]$/.test(e.key)) {
        e.preventDefault();
        const updated = manualGrid.map((row) => [...row]);
        updated[r][c] = e.key.toUpperCase();
        setManualGrid(updated);
        setManualChanged(true);
        // Advance cursor
        const nr = r + dr;
        const nc = c + dc;
        if (nr < manualGridSize.rows && nc < manualGridSize.cols) {
          setSelectedCell({ r: nr, c: nc });
        }
      } else if (e.key === "Backspace") {
        e.preventDefault();
        const updated = manualGrid.map((row) => [...row]);
        if (updated[r][c]) {
          updated[r][c] = null;
          setManualGrid(updated);
          setManualChanged(true);
        } else {
          // Move back
          const pr = r - dr;
          const pc = c - dc;
          if (pr >= 0 && pc >= 0) {
            updated[pr][pc] = null;
            setManualGrid(updated);
            setManualChanged(true);
            setSelectedCell({ r: pr, c: pc });
          }
        }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (c + 1 < manualGridSize.cols) setSelectedCell({ r, c: c + 1 });
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (c - 1 >= 0) setSelectedCell({ r, c: c - 1 });
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (r + 1 < manualGridSize.rows) setSelectedCell({ r: r + 1, c });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (r - 1 >= 0) setSelectedCell({ r: r - 1, c });
      } else if (e.key === "Tab") {
        e.preventDefault();
        setManualDirection((d) => (d === "across" ? "down" : "across"));
      }
    },
    [selectedCell, manualDirection, manualGrid, manualGridSize]
  );

  // Scan the manual grid for ALL words and rebuild the result,
  // Sync clue text from the clues list onto existing placed words — no layout changes.
  function syncClues() {
    if (!result) return;
    const clueLookup = new Map<string, string>();
    for (const c of clues) {
      if (c.answer.trim() && c.clue.trim()) {
        clueLookup.set(c.answer.toUpperCase(), c.clue);
      }
    }
    const updatedWords = result.placedWords.map((w) => ({
      ...w,
      clue: clueLookup.get(w.answer) || w.clue,
    }));
    setResult({ ...result, placedWords: updatedWords });
  }

  // Resolve a placed word's clue from the live clues array (the input panel),
  // falling back to the clue stored on the word. This keeps the on-screen and
  // exported clue lists in sync with edits automatically — without this, a clue
  // typed after generating shows "no clue" until "Sync Clues" is clicked.
  function clueFor(word: PlacedWord): string {
    const answer = word.answer.toUpperCase();
    for (const c of clues) {
      if (c.answer.trim().toUpperCase() === answer && c.clue.trim()) return c.clue;
    }
    return word.clue || "";
  }

  // looking up clue text from both the existing result and the clues list.
  function captureManualWords() {
    if (!result) return;

    // Build a lookup: answer text -> clue text (from placed words + clue list)
    const clueLookup = new Map<string, string>();
    for (const w of result.placedWords) {
      if (w.clue) clueLookup.set(w.answer, w.clue);
    }
    for (const c of clues) {
      if (c.answer.trim() && c.clue.trim()) {
        clueLookup.set(c.answer.toUpperCase(), c.clue);
      }
    }

    // Detect ALL words in the manual grid (pass empty existing list so nothing is filtered)
    const allDetected = detectWords(manualGrid, manualGridSize.rows, manualGridSize.cols, []);

    if (allDetected.length === 0) return;

    // Assign clue text from lookup
    for (const w of allDetected) {
      w.clue = clueLookup.get(w.answer) || "";
    }

    // Trim the manual grid to bounding box
    let minR = manualGridSize.rows, maxR = 0, minC = manualGridSize.cols, maxC = 0;
    for (let r = 0; r < manualGridSize.rows; r++) {
      for (let c = 0; c < manualGridSize.cols; c++) {
        if (manualGrid[r][c]) {
          minR = Math.min(minR, r);
          maxR = Math.max(maxR, r);
          minC = Math.min(minC, c);
          maxC = Math.max(maxC, c);
        }
      }
    }

    const trimRows = maxR - minR + 1;
    const trimCols = maxC - minC + 1;
    const trimmedGrid: (string | null)[][] = Array.from({ length: trimRows }, (_, r) =>
      Array.from({ length: trimCols }, (_, c) => manualGrid[r + minR][c + minC])
    );

    // Adjust coordinates to trimmed grid
    const allWords = allDetected.map((w) => ({
      ...w,
      row: w.row - minR,
      col: w.col - minC,
    }));

    const { words: numberedWords, numberGrid } = assignNumbers(allWords, trimRows, trimCols);

    const updatedResult: CrosswordResult = {
      grid: trimmedGrid,
      numberGrid,
      size: { rows: trimRows, cols: trimCols },
      placedWords: numberedWords,
      unplacedWords: [],
    };
    setResult(updatedResult);
    buildManualGrid(updatedResult);

    // Re-point {N-dir} cross-references to follow their answers to the new
    // numbering produced by the capture.
    const synced = resyncClueRefs(clues, result.placedWords, numberedWords);

    // Add any truly new words (no clue text found) to the clue list
    const existingAnswers = new Set(clues.map((c) => c.answer.toUpperCase()));
    const newClueEntries: ClueEntry[] = allDetected
      .filter((w) => !existingAnswers.has(w.answer))
      .map((w) => ({ answer: w.answer, clue: "" }));
    if (newClueEntries.length > 0) {
      const existingClues = synced.filter((c) => c.answer.trim());
      setClues([...existingClues, ...newClueEntries]);
    } else if (synced !== clues) {
      setClues(synced);
    }
  }

  function toggleMode() {
    if (mode === "auto" && result) {
      // Switching to manual: build padded grid if not already done
      if (manualGrid.length === 0) {
        buildManualGrid(result);
      }
      setMode("manual");
    } else {
      setSelectedCell(null);
      setMode("auto");
    }
  }

  async function savePuzzle() {
    // Allow saving before a grid is generated — the answers/clues are worth
    // protecting on their own. Only bail if there's genuinely nothing entered.
    if (!hasEditableContent(puzzleTitle, clues, result)) {
      setError("Nothing to save yet — enter a title or at least one answer first.");
      return;
    }

    const now = new Date();
    const ts =
      now.toLocaleDateString("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "2-digit",
      }) +
      " " +
      now.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });

    if (isSignedIn) {
      // Save to database
      try {
        const res = await fetch("/api/puzzles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: currentPuzzleId || undefined,
            title: puzzleTitle || "Untitled Puzzle",
            byline: puzzleByline,
            date: puzzleDate,
            clues,
            result,
            manualGrid: manualGrid.length > 0 ? manualGrid : null,
            manualGridSize: manualGrid.length > 0 ? manualGridSize : null,
            hiddenMessageCells,
            hiddenMessageText,
          }),
        });
        if (!res.ok) {
          // Don't set a save timestamp — that would falsely tell the user the
          // puzzle was saved when it wasn't.
          setError(
            "Couldn't save to your account. Your puzzle is NOT saved yet — please try again."
          );
          return;
        }
        const saved = await res.json();
        if (saved.id) setCurrentPuzzleId(saved.id);
        setError(null);
        // Now safely persisted — this becomes the saved baseline; drop the draft.
        pendingBaselineRef.current = true;
        localStorage.removeItem(DRAFT_KEY);
        setDirty(false);
        // Refresh list
        try {
          const listRes = await fetch("/api/puzzles");
          if (listRes.ok) {
            const list = await listRes.json();
            if (Array.isArray(list)) setSavedPuzzles(list);
          }
        } catch {}
      } catch {
        setError(
          "Couldn't reach the server to save. Your puzzle is NOT saved yet — please try again."
        );
        return;
      }
    } else {
      // Fall back to localStorage
      const puzzle: SavedPuzzle = {
        id: Date.now().toString(),
        title: puzzleTitle || "Untitled Puzzle",
        byline: puzzleByline,
        date: puzzleDate,
        clues,
        result,
        savedAt: new Date().toISOString(),
        manualGrid: manualGrid.length > 0 ? manualGrid : undefined,
        manualGridSize: manualGrid.length > 0 ? manualGridSize : undefined,
      };
      const updated = [
        ...savedPuzzles.filter((p) => p.title !== puzzle.title),
        puzzle,
      ];
      setSavedPuzzles(updated);
      localStorage.setItem("crossword_puzzles", JSON.stringify(updated));
      // Saved to the local library — this becomes the baseline; drop the draft.
      pendingBaselineRef.current = true;
      localStorage.removeItem(DRAFT_KEY);
      setDirty(false);
    }

    setSaveTimestamp(ts);
  }

  async function loadPuzzle(puzzle: SavedPuzzle) {
    if (isSignedIn && puzzle.id) {
      // Fetch full puzzle from API
      try {
        const res = await fetch(`/api/puzzles/${puzzle.id}`);
        const full = await res.json();
        if (full.error) throw new Error(full.error);
        setPuzzleTitle(full.title);
        setPuzzleByline(full.byline || "");
        setClues(full.clues || []);
        setResult(full.result || null);
        setCurrentPuzzleId(full.id);
        if (full.manual_grid && full.manual_grid_size) {
          setManualGrid(full.manual_grid);
          setManualGridSize(full.manual_grid_size);
        } else if (full.result) {
          buildManualGrid(full.result);
        }
        setHiddenMessageCells(full.hidden_message_cells || []);
        setHiddenMessageText(full.hidden_message_text || "");
        // This freshly-loaded puzzle is the saved baseline — no unsaved changes.
        pendingBaselineRef.current = true;
      } catch {
        setError("Failed to load puzzle");
      }
    } else {
      // Load from localStorage object
      setPuzzleTitle(puzzle.title);
      setPuzzleByline(puzzle.byline || "");
      setClues(puzzle.clues);
      setResult(puzzle.result);
      setCurrentPuzzleId(null);
      if (puzzle.manualGrid && puzzle.manualGridSize) {
        setManualGrid(puzzle.manualGrid);
        setManualGridSize(puzzle.manualGridSize);
      } else if (puzzle.result) {
        buildManualGrid(puzzle.result);
      }
      pendingBaselineRef.current = true;
    }
    // Dismiss any pending restore banner — the user chose a specific puzzle.
    setDraftToRestore(null);
    setManualChanged(false);
    setShowSaved(false);
  }

  async function deletePuzzle(id: string) {
    if (isSignedIn) {
      try {
        await fetch("/api/puzzles", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        try {
          const listRes = await fetch("/api/puzzles");
          if (listRes.ok) {
            const list = await listRes.json();
            if (Array.isArray(list)) setSavedPuzzles(list);
          }
        } catch {}
      } catch {}
    } else {
      const updated = savedPuzzles.filter((p) => p.id !== id);
      setSavedPuzzles(updated);
      localStorage.setItem("crossword_puzzles", JSON.stringify(updated));
    }
  }

  // Download every saved puzzle as a single JSON file — a portable backup that
  // doesn't depend on the database staying alive.
  async function exportPuzzles() {
    if (savedPuzzles.length === 0) return;
    try {
      let puzzles: unknown[];
      if (isSignedIn) {
        // The list holds only summaries; fetch each puzzle's full contents so
        // the backup is complete (clues, grid, hidden message, etc.).
        puzzles = await Promise.all(
          savedPuzzles.map(async (p) => {
            try {
              const res = await fetch(`/api/puzzles/${p.id}`);
              if (res.ok) return await res.json();
            } catch {}
            return p; // fall back to the summary if the full fetch fails
          })
        );
      } else {
        puzzles = savedPuzzles;
      }
      const payload = {
        app: "Crossword Builder",
        exportedAt: new Date().toISOString(),
        count: puzzles.length,
        puzzles,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `crossword-puzzles-backup-${new Date()
        .toISOString()
        .slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setError(null);
    } catch {
      setError("Couldn't export your puzzles. Please try again.");
    }
  }

  async function buildPDF(showAnswers = false): Promise<jsPDF> {
    const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
    if (!result) return pdf;

    // Embed Montserrat font
    try {
      const [regResp, boldResp] = await Promise.all([
        fetch("/fonts/Montserrat-Regular.ttf"),
        fetch("/fonts/Montserrat-Bold.ttf"),
      ]);
      const regBuf = await regResp.arrayBuffer();
      const boldBuf = await boldResp.arrayBuffer();
      const toBase64 = (buf: ArrayBuffer) => {
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
      };
      pdf.addFileToVFS("Montserrat-Regular.ttf", toBase64(regBuf));
      pdf.addFont("Montserrat-Regular.ttf", "Montserrat", "normal");
      pdf.addFileToVFS("Montserrat-Bold.ttf", toBase64(boldBuf));
      pdf.addFont("Montserrat-Bold.ttf", "Montserrat", "bold");
    } catch {
      // Fall back to Helvetica if font loading fails
    }
    const pw = 612;  // 8.5in
    const ph = 792;  // 11in
    const margin = 21.6; // 0.3in
    const usable = pw - margin * 2;
    const bottomLimit = ph - margin;
    let y = margin;

    // Title
    if (puzzleTitle) {
      pdf.setFont("times", "bold");
      pdf.setFontSize(20);
      pdf.text(puzzleTitle, margin, y);
      y += 17;
    }

    // Byline // Date on one line — use clue font (Montserrat)
    const bylineFont = pdf.getFontList()["Montserrat"] ? "Montserrat" : "helvetica";
    pdf.setFont(bylineFont, "normal");
    pdf.setFontSize(9);
    pdf.setTextColor(80);
    pdf.text(`${puzzleByline}  //  ${puzzleDate}`, margin, y);
    pdf.setTextColor(0);
    y += 10;
    // Hidden message note above grid
    if (hiddenMessageCells.length > 0) {
      pdf.setFont(bylineFont, "normal");
      pdf.setFontSize(7);
      pdf.setTextColor(80);
      pdf.text("The circled letters spell a hidden message when read left to right.", margin, y);
      pdf.setTextColor(0);
      y += 4;
    }

    // Layout: grid flush left, Down clues column to the right, Across clues below grid
    const cols = result.size.cols;
    const rows = result.size.rows;
    const gap = 12; // gap between grid and Down column
    // Reserve right column for Down clues (at least 160pt)
    const downColWidth = Math.max(160, usable * 0.32);
    const gridMaxW = usable - downColWidth - gap;
    const gridMaxH = (bottomLimit - y) * 0.50;
    const cellSize = Math.min(Math.floor(gridMaxW / cols), Math.floor(gridMaxH / rows), 28);
    const gridW = cellSize * cols;
    const gridX = margin; // flush left
    const gridTopY = y;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = gridX + c * cellSize;
        const cy = gridTopY + r * cellSize;
        const cell = result.grid[r][c];
        if (cell === null) {
          pdf.setFillColor(0, 0, 0);
          pdf.rect(cx, cy, cellSize, cellSize, "F");
        } else {
          pdf.setDrawColor(0);
          pdf.setLineWidth(0.375);
          pdf.rect(cx, cy, cellSize, cellSize, "S");
          const num = result.numberGrid[r][c];
          if (num > 0) {
            pdf.setFont("helvetica", "normal");
            pdf.setFontSize(Math.max(4, cellSize * 0.12));
            pdf.text(String(num), cx + 1, cy + Math.max(4, cellSize * 0.14));
          }
          if (showAnswers && cell) {
            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(cellSize * 0.55);
            pdf.text(cell, cx + cellSize / 2, cy + cellSize * 0.72, { align: "center" });
          }
          // Hidden message circle
          if (cell !== null && isHiddenMessageCell(r, c)) {
            pdf.setDrawColor(0, 0, 0);
            pdf.setLineWidth(0.5);
            const midX = cx + cellSize / 2;
            const midY = cy + cellSize / 2;
            const rad = cellSize * 0.48;
            if (num > 0) {
              // 3/4 circle: gap centered on top-left corner (~225° to ~315°)
              // Draw arc as line segments from 315° to 225° going clockwise (the long way)
              // 292° arc starting from 12 o'clock (90°), leaving 68° gap at top-left
              const arcStart = 90 * (Math.PI / 180);
              const arcSweep = 292 * (Math.PI / 180);
              const segments = 40;
              for (let s = 0; s < segments; s++) {
                const a1 = arcStart - (s / segments) * arcSweep;
                const a2 = arcStart - ((s + 1) / segments) * arcSweep;
                const x1 = midX + rad * Math.cos(a1);
                const y1 = midY - rad * Math.sin(a1);
                const x2 = midX + rad * Math.cos(a2);
                const y2 = midY - rad * Math.sin(a2);
                pdf.line(x1, y1, x2, y2);
              }
            } else {
              pdf.circle(midX, midY, rad);
            }
            pdf.setDrawColor(0);
          }
        }
      }
    }
    pdf.setLineWidth(0.375);
    pdf.rect(gridX, gridTopY, gridW, cellSize * rows, "S");

    // Attribution
    const gridBottomY = gridTopY + cellSize * rows;
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(5);
    pdf.setTextColor(150);
    pdf.text("A JSham Crossword Build", gridX + gridW, gridBottomY + 6, { align: "right" });
    pdf.setTextColor(0);
    const rightColX = gridX + gridW + gap;
    const rightColW = pw - margin - rightColX; // stretch to right page edge

    const acr = result.placedWords
      .filter((w) => w.direction === "across")
      .sort((a, b) => a.number - b.number)
      .map((w) => ({ ...w, clue: clueFor(w) }));
    const dwn = result.placedWords
      .filter((w) => w.direction === "down")
      .sort((a, b) => a.number - b.number)
      .map((w) => ({ ...w, clue: clueFor(w) }));

    // Use Montserrat if available, fall back to Helvetica
    const clueFont = pdf.getFontList()["Montserrat"] ? "Montserrat" : "helvetica";

    // Flowing clue renderer across two zones on a SINGLE page:
    //  Zone 1: below the grid (x=margin, width=gridW)
    //  Zone 2: right column (x=rightColX, width=rightColW, from gridTopY down)
    // Across then Down flow continuously. runFlow measures (dryRun) or draws at a
    // given clue font size, returning whether everything fit on this one page.
    function runFlow(fs: number, dryRun: boolean): boolean {
      const lineH = fs * 1.18;
      const numFs = Math.max(4, fs - 0.5);
      let fitsOnePage = true;
      let x = margin;
      let cy = gridBottomY + 18;
      let maxWidth = gridW;
      let inRightCol = false;
      const jumpToRightCol = () => {
        x = rightColX;
        cy = gridTopY + 5;
        maxWidth = rightColW;
        inRightCol = true;
      };

      function drawList(title: string, clueList: PlacedWord[]) {
        if (!dryRun) {
          pdf.setFont("times", "bold");
          pdf.setFontSize(13);
          pdf.text(title, x, cy);
        }
        cy += 4;
        if (!dryRun) {
          pdf.setLineWidth(0.5);
          pdf.line(x, cy, x + maxWidth, cy);
        }
        cy += lineH;

        pdf.setFont(clueFont, "bold");
        pdf.setFontSize(numFs);
        let maxNumW = 0;
        for (const cl of clueList) {
          const w = pdf.getTextWidth(`${cl.number}. `);
          if (w > maxNumW) maxNumW = w;
        }
        const textIndent = maxNumW + 2;

        for (const cl of clueList) {
          pdf.setFont(clueFont, "normal");
          pdf.setFontSize(fs);
          const lines = pdf.splitTextToSize(cl.clue || "(no clue)", maxWidth - textIndent);
          const needed = lines.length * lineH;
          if (cy + needed > bottomLimit && !inRightCol) jumpToRightCol();

          if (!dryRun) {
            pdf.setFont(clueFont, "bold");
            pdf.setFontSize(numFs);
            pdf.text(`${cl.number}.`, x, cy);
            pdf.setFont(clueFont, "normal");
            pdf.setFontSize(fs);
          }
          for (let l = 0; l < lines.length; l++) {
            if (cy > bottomLimit) {
              if (!inRightCol) {
                jumpToRightCol();
              } else {
                fitsOnePage = false;
                if (!dryRun) {
                  pdf.addPage();
                  cy = margin;
                }
              }
            }
            if (!dryRun) pdf.text(lines[l], x + textIndent, cy);
            cy += lineH;
          }
        }
      }

      drawList("Across", acr);
      cy += 6; // small gap before Down heading
      drawList("Down", dwn);
      return fitsOnePage;
    }

    // Shrink the clue font from the ideal size until everything fits one page.
    let clueFS = 8.5;
    while (clueFS > 4.5) {
      if (runFlow(clueFS, true)) break;
      clueFS = Math.round((clueFS - 0.25) * 100) / 100;
    }
    runFlow(clueFS, false);

    return pdf;
  }

  async function exportPDF() {
    if (!result) return;
    const pdf = await buildPDF();
    const filename = `Compact Crossword - ${puzzleTitle || "crossword"}.pdf`;

    // On mobile with Web Share API, offer to share instead of just downloading
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile && navigator.share && navigator.canShare) {
      try {
        const blob = pdf.output("blob");
        const file = new File([blob], filename, { type: "application/pdf" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: puzzleTitle || "Crossword Puzzle",
            text: `Crossword puzzle: ${puzzleTitle || "Untitled"}`,
            files: [file],
          });
          return;
        }
      } catch (err: any) {
        if (err.name === "AbortError") return;
        // Fall through to download
      }
    }

    // Direct download
    pdf.save(filename);
  }

  async function exportAnswerKey() {
    if (!result) return;
    const pdf = await buildPDF(true);
    pdf.save(`Compact Answer Key - ${puzzleTitle || "crossword"}.pdf`);
  }

  async function exportLarge(showAnswers = false, splitCluePages = false) {
    if (!result) return;
    const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
    const pw = 612;
    const ph = 792;
    const margin = 21.6;
    const usable = pw - margin * 2;
    const bottomLimit = ph - margin;

    // Embed Montserrat
    try {
      const [regResp, boldResp] = await Promise.all([
        fetch("/fonts/Montserrat-Regular.ttf"),
        fetch("/fonts/Montserrat-Bold.ttf"),
      ]);
      const regBuf = await regResp.arrayBuffer();
      const boldBuf = await boldResp.arrayBuffer();
      const toBase64 = (buf: ArrayBuffer) => {
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
      };
      pdf.addFileToVFS("Montserrat-Regular.ttf", toBase64(regBuf));
      pdf.addFont("Montserrat-Regular.ttf", "Montserrat", "normal");
      pdf.addFileToVFS("Montserrat-Bold.ttf", toBase64(boldBuf));
      pdf.addFont("Montserrat-Bold.ttf", "Montserrat", "bold");
    } catch {}

    const clueFont = pdf.getFontList()["Montserrat"] ? "Montserrat" : "helvetica";
    const bylineFont = clueFont;

    function drawHeader(y: number): number {
      if (puzzleTitle) {
        pdf.setFont("times", "bold");
        pdf.setFontSize(20);
        pdf.text(puzzleTitle, margin, y);
        y += 17;
      }
      pdf.setFont(bylineFont, "normal");
      pdf.setFontSize(9);
      pdf.setTextColor(80);
      pdf.text(`${puzzleByline}  //  ${puzzleDate}`, margin, y);
      pdf.setTextColor(0);
      y += 8; // tighter gap below the byline (was 14) — reclaimed for the top
      return y;
    }

    // === PAGE 1: Header + Large Grid ===
    // Start the title lower so it clears the printer's non-printable top edge.
    // The 6pt reclaimed from the byline gap above is added here, so the grid's
    // top (and therefore the bottom) stays exactly where it was.
    let y = drawHeader(margin + 24);

    if (hiddenMessageCells.length > 0) {
      // Keep the note ADJACENT to the grid: the reclaimed whitespace sits above
      // the note (below the byline), and the note hugs the grid. Grid top (and
      // therefore the bottom) is unchanged.
      y += 8; // whitespace below the byline
      pdf.setFont(bylineFont, "normal"); // match the byline sub-headline font
      pdf.setFontSize(7);
      pdf.setTextColor(80);
      pdf.text("The circled letters spell a hidden message when read left to right.", margin, y);
      pdf.setTextColor(0);
      y += 4; // small gap — note sits just above the grid
    } else {
      y += 10; // breathing room before the grid
    }

    const cols = result.size.cols;
    const rows = result.size.rows;
    // Fill the page — constrained by whichever dimension hits the margin first
    const largeCellSize = Math.floor(Math.min(usable / cols, (bottomLimit - y) / rows));
    const gridW = largeCellSize * cols;
    const gridX = margin;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = gridX + c * largeCellSize;
        const cy = y + r * largeCellSize;
        const cell = result.grid[r][c];
        if (cell === null) {
          pdf.setFillColor(0, 0, 0);
          pdf.rect(cx, cy, largeCellSize, largeCellSize, "F");
        } else {
          pdf.setDrawColor(0);
          pdf.setLineWidth(0.375);
          pdf.rect(cx, cy, largeCellSize, largeCellSize, "S");
          const num = result.numberGrid[r][c];
          if (num > 0) {
            pdf.setFont("helvetica", "normal");
            pdf.setFontSize(Math.max(5, largeCellSize * 0.12));
            pdf.text(String(num), cx + 1.5, cy + Math.max(5, largeCellSize * 0.14));
          }
          // Answer key: draw the letter centered in the cell
          if (showAnswers && cell) {
            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(largeCellSize * 0.55);
            pdf.text(String(cell), cx + largeCellSize / 2, cy + largeCellSize * 0.72, {
              align: "center",
            });
          }
          // Hidden message circle
          if (cell !== null && isHiddenMessageCell(r, c)) {
            pdf.setDrawColor(0, 0, 0);
            pdf.setLineWidth(0.5);
            const midX = cx + largeCellSize / 2;
            const midY = cy + largeCellSize / 2;
            const rad = largeCellSize * 0.48;
            if (num > 0) {
              // 292° arc starting from 12 o'clock (90°), leaving 68° gap at top-left
              const arcStart = 90 * (Math.PI / 180);
              const arcSweep = 292 * (Math.PI / 180);
              const segments = 40;
              for (let s = 0; s < segments; s++) {
                const a1 = arcStart - (s / segments) * arcSweep;
                const a2 = arcStart - ((s + 1) / segments) * arcSweep;
                const x1 = midX + rad * Math.cos(a1);
                const y1 = midY - rad * Math.sin(a1);
                const x2 = midX + rad * Math.cos(a2);
                const y2 = midY - rad * Math.sin(a2);
                pdf.line(x1, y1, x2, y2);
              }
            } else {
              pdf.circle(midX, midY, rad);
            }
            pdf.setDrawColor(0);
          }
        }
      }
    }
    pdf.setLineWidth(0.375);
    pdf.rect(gridX, y, gridW, largeCellSize * rows, "S");

    // Attribution
    const largeGridBottom = y + largeCellSize * rows;
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(5);
    pdf.setTextColor(150);
    pdf.text("A JSham Crossword Build", gridX + gridW, largeGridBottom + 6, { align: "right" });
    pdf.setTextColor(0);

    // Answer key = the filled grid only, no clues.
    if (showAnswers) {
      pdf.save(`Large Answer Key - ${puzzleTitle || "crossword"}.pdf`);
      return;
    }

    const acr = result.placedWords
      .filter((w) => w.direction === "across")
      .sort((a, b) => a.number - b.number)
      .map((w) => ({ ...w, clue: clueFor(w) }));
    const dwn = result.placedWords
      .filter((w) => w.direction === "down")
      .sort((a, b) => a.number - b.number)
      .map((w) => ({ ...w, clue: clueFor(w) }));

    // Split variant (3-page): the large grid, then Across on its own page and
    // Down on its own page — two columns each, text sized as large as possible
    // to fill the page so the clues are easy to read.
    function drawDirectionPage(title: string, clueList: PlacedWord[]) {
      pdf.addPage();
      let yy = drawHeader(margin + 16);
      yy += 4 + 16; // full blank line between the byline and the direction heading
      pdf.setFont("times", "bold");
      pdf.setFontSize(16);
      pdf.text(title, margin, yy);
      yy += 6;
      pdf.setLineWidth(0.5);
      pdf.line(margin, yy, margin + usable, yy);
      yy += 8;
      const dpCluesTop = yy;
      const dpAvailH = bottomLimit - dpCluesTop;
      const dpColGap = 18;
      const dpColWidth = (usable - dpColGap) / 2;
      const numFs = (fs: number) => Math.max(5, fs - 1);
      const lineH = (fs: number) => fs * 1.2;

      function indentFor(fs: number): number {
        pdf.setFont(clueFont, "bold");
        pdf.setFontSize(numFs(fs));
        let maxNumW = 0;
        for (const cl of clueList) {
          const w = pdf.getTextWidth(`${cl.number}. `);
          if (w > maxNumW) maxNumW = w;
        }
        return maxNumW + 2;
      }

      type Item = { cl: PlacedWord; lines: string[]; h: number };
      type Built = {
        cols: [Item[], Item[]];
        indent: number;
        lh: number;
        fs: number;
        fits: boolean;
      };

      // Lay the clues out at font size fs, split into two BALANCED columns (each
      // roughly half the total height, keeping numeric order left-to-right).
      function build(fs: number): Built {
        const lh = lineH(fs);
        const indent = indentFor(fs);
        pdf.setFont(clueFont, "normal");
        pdf.setFontSize(fs);
        const items: Item[] = clueList.map((cl) => {
          const lines = pdf.splitTextToSize(cl.clue || "(no clue)", dpColWidth - indent);
          return { cl, lines, h: Math.max(1, lines.length) * lh };
        });
        const n = items.length;
        const prefix = [0];
        for (let i = 0; i < n; i++) prefix.push(prefix[i] + items[i].h);
        const total = prefix[n];
        // Split point that balances the two columns best.
        let bestK = Math.ceil(n / 2);
        let bestMax = Infinity;
        for (let k = 1; k <= n; k++) {
          const colMax = Math.max(prefix[k], total - prefix[k]);
          if (colMax < bestMax) {
            bestMax = colMax;
            bestK = k;
          }
        }
        const cols: [Item[], Item[]] = [items.slice(0, bestK), items.slice(bestK)];
        // Fits if the taller column clears the page (a single clue can't be split).
        const fits = n <= 1 || bestMax <= dpAvailH;
        return { cols, indent, lh, fs, fits };
      }

      // Grow the text (capped for readability) to the largest size that still
      // fits two balanced columns on the page.
      let built = build(16);
      for (let fs = 15.5; !built.fits && fs >= 6; fs -= 0.5) built = build(fs);

      const xs = [margin, margin + dpColWidth + dpColGap];
      for (let ci = 0; ci < 2; ci++) {
        let top = dpCluesTop;
        for (const item of built.cols[ci]) {
          const baseline = top + built.fs;
          pdf.setFont(clueFont, "bold");
          pdf.setFontSize(numFs(built.fs));
          pdf.text(`${item.cl.number}.`, xs[ci], baseline);
          pdf.setFont(clueFont, "normal");
          pdf.setFontSize(built.fs);
          for (let l = 0; l < item.lines.length; l++) {
            pdf.text(item.lines[l], xs[ci] + built.indent, baseline + l * built.lh);
          }
          top += item.h;
        }
      }
    }

    if (splitCluePages) {
      drawDirectionPage("Across", acr);
      drawDirectionPage("Down", dwn);
      pdf.save(`Large Crossword + Large Clues - ${puzzleTitle || "crossword"}.pdf`);
      return;
    }

    // === PAGE 2: Header + Two-column clues (Across + Down together) ===
    pdf.addPage();
    // Nudge only the title/byline down so the title clears the top edge, and let
    // the clues start right below the byline (tight) so they keep their size.
    y = drawHeader(margin + 16);

    const colGap = 16;
    const colWidth = (usable - colGap) / 2;

    y += 4 + 16; // full blank line between the byline and the Across/Down headings
    const cluesTop = y;
    const availH = bottomLimit - cluesTop;
    const TITLE_FS = 13;
    const IDEAL_FS = 9.5;
    const MIN_FS = 4.5;

    const numFontSize = (fs: number) => Math.max(4, fs - 0.5);
    const lineHeight = (fs: number) => fs * 1.2;

    // Vertical space one column needs at a given clue font size: divider + gap +
    // every clue (with wrapping recomputed for that size).
    function columnHeight(clueList: PlacedWord[], fs: number): number {
      const lineH = lineHeight(fs);
      pdf.setFont(clueFont, "bold");
      pdf.setFontSize(numFontSize(fs));
      let maxNumW = 0;
      for (const cl of clueList) {
        const w = pdf.getTextWidth(`${cl.number}. `);
        if (w > maxNumW) maxNumW = w;
      }
      const textIndent = maxNumW + 2;
      pdf.setFont(clueFont, "normal");
      pdf.setFontSize(fs);
      let h = 4 + lineH; // divider + gap before first clue
      for (const cl of clueList) {
        const lines = pdf.splitTextToSize(cl.clue || "(no clue)", colWidth - textIndent);
        h += Math.max(1, lines.length) * lineH;
      }
      return h;
    }

    // Shrink from the ideal size until BOTH Across and Down fit on this one page.
    let clueFS = IDEAL_FS;
    while (clueFS > MIN_FS) {
      const need = Math.max(columnHeight(acr, clueFS), columnHeight(dwn, clueFS));
      if (need <= availH) break;
      clueFS = Math.round((clueFS - 0.25) * 100) / 100;
    }

    function drawClueColumn(title: string, clueList: PlacedWord[], x: number) {
      const fs = clueFS;
      const numFs = numFontSize(fs);
      const lineH = lineHeight(fs);
      let cy = cluesTop;
      pdf.setFont("times", "bold");
      pdf.setFontSize(TITLE_FS);
      pdf.text(title, x, cy);
      cy += 4;
      pdf.setLineWidth(0.5);
      pdf.line(x, cy, x + colWidth, cy);
      cy += lineH;

      // Tab-aligned numbers
      pdf.setFont(clueFont, "bold");
      pdf.setFontSize(numFs);
      let maxNumW = 0;
      for (const cl of clueList) {
        const w = pdf.getTextWidth(`${cl.number}. `);
        if (w > maxNumW) maxNumW = w;
      }
      const textIndent = maxNumW + 2;

      for (const cl of clueList) {
        pdf.setFont(clueFont, "normal");
        pdf.setFontSize(fs);
        const lines = pdf.splitTextToSize(cl.clue || "(no clue)", colWidth - textIndent);

        pdf.setFont(clueFont, "bold");
        pdf.setFontSize(numFs);
        pdf.text(`${cl.number}.`, x, cy);
        pdf.setFont(clueFont, "normal");
        pdf.setFontSize(fs);
        for (let l = 0; l < lines.length; l++) {
          pdf.text(lines[l], x + textIndent, cy);
          cy += lineH;
        }
      }
    }

    drawClueColumn("Across", acr, margin);
    drawClueColumn("Down", dwn, margin + colWidth + colGap);

    pdf.save(
      `Large ${showAnswers ? "Answer Key" : "Crossword"} - ${puzzleTitle || "crossword"}.pdf`
    );
  }

  const acrossClues = (result?.placedWords || [])
    .filter((w) => w.direction === "across")
    .sort((a, b) => a.number - b.number)
    .map((w) => ({ ...w, clue: clueFor(w) }));
  const downClues = (result?.placedWords || [])
    .filter((w) => w.direction === "down")
    .sort((a, b) => a.number - b.number)
    .map((w) => ({ ...w, clue: clueFor(w) }));

  // Total number of clues in the puzzle (entries that have an answer).
  const clueCount = clues.filter((c) => c.answer.trim()).length;
  const clueCountLabel = `${clueCount} ${clueCount === 1 ? "clue" : "clues"}`;

  // Cells of the currently-highlighted clue (in the coords of whichever grid is
  // shown — the manual grid is padding-offset from the result coords).
  const highlightCells = new Set<string>();
  if (highlightRef && result) {
    const w = result.placedWords.find(
      (p) => p.number === highlightRef.number && p.direction === highlightRef.direction
    );
    if (w) {
      const dr = w.direction === "down" ? 1 : 0;
      const dc = w.direction === "across" ? 1 : 0;
      const off = mode === "manual" ? MANUAL_PADDING : 0;
      for (let i = 0; i < w.answer.length; i++) {
        highlightCells.add(`${w.row + dr * i + off},${w.col + dc * i + off}`);
      }
    }
  }

  // Tight bounding box of the filled cells in manual mode — drawn as a colored
  // frame so the author sees exactly how much space the answers occupy.
  let manualBBox: { minR: number; maxR: number; minC: number; maxC: number } | null = null;
  if (mode === "manual" && manualGrid.length) {
    let minR = Infinity, maxR = -1, minC = Infinity, maxC = -1;
    for (let r = 0; r < manualGrid.length; r++) {
      for (let c = 0; c < manualGrid[r].length; c++) {
        if (manualGrid[r][c] !== null) {
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
        }
      }
    }
    if (maxR >= 0) manualBBox = { minR, maxR, minC, maxC };
  }

  // Check if any placed words are missing clue text that exists in the clue list
  const needsSync = (() => {
    if (!result?.placedWords) return false;
    const clueLookup = new Map<string, string>();
    for (const c of clues) {
      if (c.answer.trim() && c.clue.trim()) {
        clueLookup.set(c.answer.toUpperCase(), c.clue);
      }
    }
    return result.placedWords.some((w) => {
      const latest = clueLookup.get(w.answer);
      if (!latest) return false;
      return w.clue !== latest;
    });
  })();

  // Determine which cells are "locked" (from auto-placed words) in manual mode
  const lockedCells = new Set<string>();
  if (result?.placedWords) {
    for (const w of result.placedWords) {
      const dr = w.direction === "down" ? 1 : 0;
      const dc = w.direction === "across" ? 1 : 0;
      for (let i = 0; i < w.answer.length; i++) {
        lockedCells.add(`${w.row + MANUAL_PADDING + dr * i},${w.col + MANUAL_PADDING + dc * i}`);
      }
    }
  }

  return (
    <div className="min-h-screen p-6 max-w-7xl xl:max-w-[90rem] 2xl:max-w-[105rem] mx-auto">
      {/* Unsaved-work restore banner */}
      {draftToRestore && (
        <div
          className="mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3"
          style={{ fontFamily: FONT_BODY }}
        >
          <p className="text-sm text-amber-900">
            <strong>Unsaved work found.</strong> You have a puzzle in progress
            {draftToRestore.clues?.filter((c) => c.answer.trim()).length
              ? ` (${draftToRestore.clues.filter((c) => c.answer.trim()).length} answer${
                  draftToRestore.clues.filter((c) => c.answer.trim()).length === 1 ? "" : "s"
                })`
              : ""}
            {" "}from a previous session. Restore it?
          </p>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={restoreDraft}
              className="px-3 py-1.5 text-sm bg-amber-500 text-white rounded hover:bg-amber-600 transition font-medium"
            >
              Restore
            </button>
            <button
              onClick={discardDraft}
              className="px-3 py-1.5 text-sm bg-white border border-amber-300 text-amber-800 rounded hover:bg-amber-100 transition"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.4)" }}>
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4" style={{ fontFamily: FONT_BODY }}>
            <h3 className="text-lg font-bold mb-1" style={{ fontFamily: FONT_HEADING }}>
              Crossword Builder
            </h3>
            <p className="text-sm text-gray-600 mb-5 whitespace-pre-line">{confirmModal.message}</p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmModal(null)}
                className="flex-1 py-2 text-sm border-2 border-gray-300 rounded-lg hover:bg-gray-100 transition font-medium"
              >
                Cancel
              </button>
              <button
                onClick={confirmModal.onConfirm}
                className="flex-1 py-2 text-sm text-white rounded-lg transition font-medium"
                style={{ background: "#56ca23" }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* App Header */}
      <header className="mb-8 border-b-2 border-black pb-4">
        <div className="flex items-center justify-between">
          <h1
            className="text-3xl sm:text-5xl font-bold tracking-tight"
            style={{ fontFamily: FONT_HEADING }}
          >
            Crossword Builder
          </h1>
          <div style={{ fontFamily: FONT_BODY }}>
            {isLoaded && (
              isSignedIn ? (
                <UserButton />
              ) : (
                <SignInButton mode="modal">
                  <button className="px-4 py-2 text-sm bg-black text-white rounded-lg hover:bg-gray-800 transition font-medium">
                    Sign In
                  </button>
                </SignInButton>
              )
            )}
          </div>
        </div>
        <p className="text-gray-500 mt-1 text-sm" style={{ fontFamily: FONT_BODY }}>
          Enter your answers &amp; clues.<br />
          App will create the grid layout and numbering.
        </p>
        <details className="mt-2 text-sm text-gray-400">
          <summary className="cursor-pointer hover:text-gray-600" style={{ fontFamily: FONT_BODY }}>
            Tips for building your crossword
          </summary>
          <ul className="mt-1.5 space-y-1 pl-4 list-disc text-gray-500" style={{ fontFamily: FONT_BODY }}>
            <li>Create an initial layout, then switch to <strong>"Manual"</strong> mode to add your own answers directly into the grid while preserving the current layout.</li>
            <li>This allows you to maximize overlaps and add small words without losing base layout.</li>
            <li>After manual additions to the grid, click <strong>"Capture New Words from Grid"</strong> to update numbering, capture those answers, and allow you to enter the corresponding clues.</li>
            <li>If you edit any clues, click <strong>"Sync Clues (keep layout)"</strong> for the edits to be adopted.</li>
          </ul>
        </details>
        <p className="mt-2 text-xs text-gray-400" style={{ fontFamily: FONT_BODY }}>
          <a
            href="mailto:jshambroom@gmail.com?subject=Feedback%20on%20Crossword%20Builder%20App"
            className="hover:text-gray-600 underline transition"
          >
            Send feedback
          </a>
        </p>
      </header>

      <div className={`grid grid-cols-1 gap-8 ${hiddenMessageMode ? "" : "lg:grid-cols-[minmax(360px,460px)_minmax(0,1fr)]"}`}>
        {/* Left: Input Panel — hidden in Hidden Message mode */}
        <div className={hiddenMessageMode ? "hidden" : ""}>
          {/* Puzzle title + New Puzzle */}
          <div className="mb-5">
            <div className="flex items-center justify-between mb-1">
              <label
                className="block text-xs font-semibold text-gray-500 uppercase tracking-wide"
                style={{ fontFamily: FONT_BODY }}
              >
                Puzzle Title
              </label>
              <button
                onClick={() => {
                  if (result) {
                    setConfirmModal({
                      message: "Start a new puzzle?\nAny unsaved progress will be lost.",
                      onConfirm: () => {
                        setConfirmModal(null);
                        setPuzzleTitle("");
                        setPuzzleByline("");
                        setClues([{ answer: "", clue: "" }]);
                        setResult(null);
                        setCurrentPuzzleId(null);
                        setManualGrid([]);
                        setManualGridSize({ rows: 0, cols: 0 });
                        setSelectedCell(null);
                        setMode("auto");
                        setHiddenMessageMode(false);
                        setHiddenMessageCells([]);
                        setHiddenMessageText("");
                        setError(null);
                        setSaveTimestamp(null);
                        setManualChanged(false);
                        pendingBaselineRef.current = true;
                        setDraftToRestore(null);
                      },
                    });
                  } else {
                    setPuzzleTitle("");
                    setClues([{ answer: "", clue: "" }]);
                    setError(null);
                  }
                }}
                className="text-xs text-blue-600 hover:text-blue-800 transition font-medium"
                style={{ fontFamily: FONT_BODY }}
              >
                + New Puzzle
              </button>
            </div>
            <input
              type="text"
              placeholder="e.g. Sunday Challenge"
              value={puzzleTitle}
              onChange={(e) => setPuzzleTitle(e.target.value)}
              className="w-full px-3 py-2 text-lg border-b-2 border-gray-300 bg-transparent focus:outline-none focus:border-black transition"
              style={{ fontFamily: FONT_HEADING }}
            />
            <input
              type="text"
              placeholder={`e.g. by Jonathan Shambroom // ${puzzleDate}`}
              value={puzzleByline}
              onChange={(e) => setPuzzleByline(e.target.value)}
              className="w-full px-3 py-1.5 text-sm border-b border-gray-200 bg-transparent focus:outline-none focus:border-gray-400 transition mt-1"
              style={{ fontFamily: "'Montserrat', 'Libre Franklin', system-ui, sans-serif" }}
            />
          </div>

          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold" style={{ fontFamily: FONT_HEADING }}>
              Clues
              {clueCount > 0 && (
                <span className="ml-2 text-sm font-normal text-gray-400">
                  ({clueCount})
                </span>
              )}
            </h2>
            <div className="flex gap-2">
              <button
                onClick={() => setShowSaved(!showSaved)}
                className="px-3 py-1.5 text-sm bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 transition"
                style={{ fontFamily: FONT_BODY }}
              >
                {showSaved ? "Hide Saved" : `Saved (${savedPuzzles.length})`}
              </button>
              {savedPuzzles.length > 0 && (
                <button
                  onClick={exportPuzzles}
                  title="Download a JSON backup of all your saved puzzles"
                  className="px-3 py-1.5 text-sm bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 transition"
                  style={{ fontFamily: FONT_BODY }}
                >
                  Export
                </button>
              )}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-1.5 text-sm bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 transition"
                style={{ fontFamily: FONT_BODY }}
              >
                Upload CSV/JSON
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.json"
                className="hidden"
                onChange={handleUpload}
              />
            </div>
          </div>

          {/* Saved puzzles dropdown */}
          {showSaved && (
            <div className="mb-4 border border-gray-200 rounded-lg bg-white divide-y divide-gray-100">
              {savedPuzzles.length === 0 ? (
                <p className="p-3 text-sm text-gray-400">
                  No saved puzzles yet
                </p>
              ) : (
                savedPuzzles.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between p-3"
                  >
                    <button
                      onClick={() => loadPuzzle(p)}
                      className="text-left flex-1 hover:text-blue-600 transition"
                    >
                      <span className="text-sm font-medium">{p.title}</span>
                      <span className="text-xs text-gray-400 ml-2">
                        {p.date}
                      </span>
                    </button>
                    <button
                      onClick={() => deletePuzzle(p.id)}
                      className="text-xs text-red-400 hover:text-red-600 ml-2"
                    >
                      delete
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Clue entries */}
          <div className="space-y-3 mb-4">
            {(() => {
              // Build sorted indices: placed clues sorted by direction then number, unplaced at end
              const indices = clues.map((_, i) => i);
              if (result?.placedWords) {
                indices.sort((a, b) => {
                  const pa = result.placedWords.find((w) => w.answer === clues[a].answer.toUpperCase());
                  const pb = result.placedWords.find((w) => w.answer === clues[b].answer.toUpperCase());
                  if (pa && !pb) return -1;
                  if (!pa && pb) return 1;
                  if (!pa && !pb) return a - b;
                  // Across before Down
                  if (pa!.direction !== pb!.direction) return pa!.direction === "across" ? -1 : 1;
                  return pa!.number - pb!.number;
                });
              }
              return indices;
            })().map((i) => {
              const clue = clues[i];
              const placed = result?.placedWords.find(
                (w) => w.answer === clue.answer.toUpperCase()
              );
              const label = placed
                ? `${placed.number}${placed.direction === "across" ? "A" : "D"}`
                : `${i + 1}`;
              const isHighlighted = !!(
                placed &&
                highlightRef &&
                highlightRef.number === placed.number &&
                highlightRef.direction === placed.direction
              );
              return (
              <div
                key={i}
                className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg p-3"
              >
                {placed ? (
                  <button
                    type="button"
                    data-clue-ref
                    onClick={() => jumpToClueInGrid(placed.number, placed.direction)}
                    title="Show this clue in the grid"
                    className={`text-xs w-7 text-right shrink-0 font-semibold hover:underline cursor-pointer ${
                      placed.direction === "down"
                        ? "text-purple-600 hover:text-purple-800"
                        : "text-blue-600 hover:text-blue-800"
                    }`}
                    style={{ fontFamily: "'Montserrat', 'Libre Franklin', system-ui, sans-serif" }}
                  >
                    {label}
                  </button>
                ) : (
                  <span
                    className="text-xs text-gray-500 w-7 text-right shrink-0 font-semibold"
                    style={{ fontFamily: "'Montserrat', 'Libre Franklin', system-ui, sans-serif" }}
                  >
                    {label}
                  </span>
                )}
                <input
                  ref={(el) => { answerRefs.current[i] = el; }}
                  type="text"
                  placeholder="ANSWER"
                  value={clue.answer}
                  onChange={(e) =>
                    updateClue(i, "answer", e.target.value.toUpperCase())
                  }
                  className="w-32 shrink-0 px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-black uppercase"
                  style={{
                    fontFamily: "'Montserrat', 'Libre Franklin', system-ui, sans-serif",
                    // Answers still needing a clue show in blue on a light-yellow
                    // fill; revert to normal (black, no fill) once a clue exists.
                    color:
                      clue.answer.trim() && !clue.clue.trim() ? "#2563eb" : undefined,
                    fontWeight:
                      clue.answer.trim() && !clue.clue.trim() ? 600 : undefined,
                    // Amber highlight (matches the grid) when this clue's number
                    // is clicked; otherwise the unclued light-yellow, if applicable.
                    backgroundColor: isHighlighted
                      ? "#fde68a"
                      : clue.answer.trim() && !clue.clue.trim()
                      ? "#fef9c3"
                      : undefined,
                  }}
                />
                <input
                  ref={(el) => { clueRefs.current[i] = el; }}
                  type="text"
                  placeholder="Clue text..."
                  value={clue.clue}
                  onChange={(e) => updateClue(i, "clue", e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && clue.answer.trim()) {
                      e.preventDefault();
                      addClue();
                    }
                  }}
                  className="flex-1 px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-black"
                  style={{ fontFamily: "'Montserrat', 'Libre Franklin', system-ui, sans-serif" }}
                />
                <button
                  onClick={() => removeClue(i)}
                  className="px-2 py-1.5 text-sm text-red-500 hover:text-red-700 hover:bg-red-50 rounded transition shrink-0"
                  title="Remove clue"
                >
                  &times;
                </button>
              </div>
              );
            })}
          </div>

          <button
            onClick={addClue}
            className="px-4 py-2 text-sm border-2 border-dashed border-gray-300 rounded-lg hover:border-gray-400 transition w-full"
            style={{ fontFamily: FONT_BODY }}
          >
            + Add Clue
          </button>

          <button
            onClick={handleGenerate}
            disabled={loading}
            className={`mt-4 w-full py-3 font-semibold rounded-lg disabled:opacity-50 transition text-base ${
              mode === "manual" && manualChanged
                ? "bg-gray-200 text-gray-500 hover:bg-gray-300" // de-emphasized after manual edits (still clickable; will confirm before re-laying out)
                : "bg-black text-white hover:bg-gray-800"
            }`}
            style={{ fontFamily: FONT_BODY }}
          >
            {loading ? "Generating..." : "Generate Crossword"}
          </button>

          {/* Save is available at any time — even before generating a grid. */}
          <button
            onClick={savePuzzle}
            className="mt-2 w-full py-2.5 border-2 border-black text-black font-semibold rounded-lg hover:bg-gray-100 transition text-base"
            style={{ fontFamily: FONT_BODY }}
          >
            {currentPuzzleId ? "Save Changes" : "Save Puzzle"}
          </button>
          {(dirty || saveTimestamp) && (
            <p
              className="mt-1.5 text-xs text-center text-gray-400"
              style={{ fontFamily: FONT_BODY }}
            >
              {dirty
                ? "Draft autosaved in this browser — click Save to keep it in your library."
                : `Saved on ${saveTimestamp}`}
            </p>
          )}

          {error && (
            <p className="mt-3 text-red-600 text-sm font-medium">{error}</p>
          )}

          {/* Action buttons */}
          {result && (
            <>
              {/* Mode toggle */}
              <div className="mt-4 flex items-center gap-3">
                <button
                  onClick={toggleMode}
                  className={`flex-1 py-2 text-sm rounded-lg transition font-medium border-2 ${
                    mode === "auto"
                      ? "border-black bg-black text-white"
                      : "border-gray-300 hover:bg-gray-100"
                  }`}
                  style={{ fontFamily: FONT_BODY }}
                >
                  Auto
                </button>
                <button
                  onClick={toggleMode}
                  className={`flex-1 py-2 text-sm rounded-lg transition font-medium border-2 ${
                    mode === "manual"
                      ? "border-black bg-black text-white"
                      : "border-gray-300 hover:bg-gray-100"
                  }`}
                  style={{ fontFamily: FONT_BODY }}
                >
                  Manual
                </button>
              </div>

              {mode === "manual" && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-gray-500" style={{ fontFamily: FONT_BODY }}>
                    Click a cell and type to add letters. Press <strong>Tab</strong> to toggle across/down.
                    Arrow keys to navigate. Currently typing: <strong>{manualDirection}</strong>.
                  </p>
                  <button
                    onClick={captureManualWords}
                    className="w-full py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium"
                    style={{ fontFamily: FONT_BODY }}
                  >
                    Capture New Words from Grid
                  </button>
                  <button
                    onClick={syncClues}
                    disabled={!needsSync}
                    className={`w-full py-2 text-sm border-2 rounded-lg transition font-medium ${
                      needsSync
                        ? "border-blue-600 text-blue-600 hover:bg-blue-50"
                        : "border-gray-300 text-gray-400 cursor-not-allowed"
                    }`}
                    style={{ fontFamily: FONT_BODY }}
                  >
                    Sync Clues (keep layout)
                  </button>
                </div>
              )}

              {/* Hidden Message */}
              <div className="mt-3">
                <button
                  onClick={() => setHiddenMessageMode(!hiddenMessageMode)}
                  className={`w-full py-2 text-sm rounded-lg transition font-medium border-2 ${
                    hiddenMessageMode
                      ? "border-purple-600 bg-purple-600 text-white"
                      : "border-purple-400 text-purple-600 hover:bg-purple-50"
                  }`}
                  style={{ fontFamily: FONT_BODY }}
                >
                  {hiddenMessageMode ? "Done — Save & Exit" : "Add Hidden Message with Circled Letters"}
                </button>
                {hiddenMessageMode && (
                  <div className="mt-2 space-y-2">
                    <p className="text-xs text-gray-500" style={{ fontFamily: FONT_BODY }}>
                      Click cells in the grid to select letters for the hidden message. Click again to deselect.
                    </p>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 shrink-0" style={{ fontFamily: FONT_BODY }}>Message:</span>
                      <span className="text-sm font-mono font-bold text-purple-700 tracking-widest">
                        {hiddenMessageCells.length > 0
                          ? [...hiddenMessageCells].sort((a, b) => a.c - b.c || a.r - b.r).map((cell) => result?.grid?.[cell.r]?.[cell.c] || "?").join("")
                          : "—"}
                      </span>
                    </div>
                    <input
                      type="text"
                      placeholder="Intended message (optional, for reference)"
                      value={hiddenMessageText}
                      onChange={(e) => setHiddenMessageText(e.target.value)}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-purple-400"
                      style={{ fontFamily: FONT_BODY }}
                    />
                    {hiddenMessageCells.length > 0 && (
                      <button
                        onClick={() => { setHiddenMessageCells([]); setHiddenMessageText(""); }}
                        className="text-xs text-red-500 hover:text-red-700 transition"
                      >
                        Clear all selections
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="mt-3">
                <p
                  className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5"
                  style={{ fontFamily: FONT_BODY }}
                >
                  Export PDF&apos;s:
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {/* Left column = answer keys, right column = puzzles; top = compact, bottom = large */}
                  <button
                    onClick={exportAnswerKey}
                    className="py-2 text-sm bg-gray-800 text-white rounded-lg hover:bg-gray-700 transition font-medium"
                    style={{ fontFamily: FONT_BODY }}
                  >
                    Compact Answer Key
                  </button>
                  <button
                    onClick={exportPDF}
                    className="py-2 text-sm text-white rounded-lg transition font-medium"
                    style={{ fontFamily: FONT_BODY, background: "#e88a1a" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#d07a15")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "#e88a1a")}
                  >
                    Compact Puzzle (1 page)
                  </button>
                  <button
                    onClick={() => exportLarge(true)}
                    className="py-2 text-sm bg-gray-800 text-white rounded-lg hover:bg-gray-700 transition font-medium"
                    style={{ fontFamily: FONT_BODY }}
                  >
                    Large Answer Key
                  </button>
                  <button
                    onClick={() => exportLarge()}
                    className="py-2 text-sm text-white rounded-lg transition font-medium"
                    style={{ fontFamily: FONT_BODY, background: "#56ca23" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#4ab51f")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "#56ca23")}
                  >
                    Large Puzzle (2 pages)
                  </button>
                  <button
                    onClick={() => exportLarge(false, true)}
                    className="col-span-2 py-2 text-sm text-white rounded-lg transition font-medium"
                    style={{ fontFamily: FONT_BODY, background: "#9333ea" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#7e22ce")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "#9333ea")}
                  >
                    Large Puzzle &amp; Clues (3 pages) // Across &amp; Down full pages
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Upload format hint */}
          <details className="mt-4 text-sm text-gray-500">
            <summary className="cursor-pointer hover:text-gray-700">
              Upload format
            </summary>
            <div className="mt-2 bg-gray-50 p-3 rounded text-xs font-mono">
              <p className="font-sans text-sm mb-1 font-medium">CSV:</p>
              <pre>
                answer,clue{"\n"}HELLO,A greeting{"\n"}WORLD,The planet
              </pre>
              <p className="font-sans text-sm mt-3 mb-1 font-medium">JSON:</p>
              <pre>
                {JSON.stringify(
                  [
                    { answer: "HELLO", clue: "A greeting" },
                    { answer: "WORLD", clue: "The planet" },
                  ],
                  null,
                  2
                )}
              </pre>
            </div>
          </details>
        </div>

        {/* Right: Crossword Display */}
        <div>
          {result ? (
            <div>
              {/* Grid size control — scales only the grid, not the clue column */}
              <div
                className="flex items-center gap-3 mb-4 flex-wrap"
                style={{ fontFamily: FONT_BODY }}
              >
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Grid size
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setGridZoom((z) => clampZoom(z - ZOOM_STEP))}
                    disabled={gridZoom <= ZOOM_MIN}
                    aria-label="Shrink grid"
                    className="w-8 h-8 flex items-center justify-center text-lg font-bold border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  >
                    &minus;
                  </button>
                  <span className="text-sm tabular-nums w-12 text-center text-gray-600">
                    {Math.round(gridZoom * 100)}%
                  </span>
                  <button
                    onClick={() => setGridZoom((z) => clampZoom(z + ZOOM_STEP))}
                    disabled={gridZoom >= ZOOM_MAX}
                    aria-label="Enlarge grid"
                    className="w-8 h-8 flex items-center justify-center text-lg font-bold border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  >
                    +
                  </button>
                </div>
                {gridZoom !== 1 && (
                  <button
                    onClick={() => setGridZoom(1)}
                    className="text-xs text-blue-600 hover:text-blue-800 transition font-medium"
                  >
                    Reset
                  </button>
                )}
              </div>

              {/* Hidden Message controls — shown at top of grid when active */}
              {hiddenMessageMode && (
                <div className="mb-4 p-4 border-2 border-purple-300 rounded-lg bg-purple-50">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-bold text-purple-800" style={{ fontFamily: FONT_HEADING }}>
                      Hidden Message Mode
                    </h3>
                    <button
                      onClick={() => { setHiddenMessageMode(false); savePuzzle(); }}
                      className="px-3 py-1 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition font-medium"
                      style={{ fontFamily: FONT_BODY }}
                    >
                      Done — Save &amp; Exit
                    </button>
                  </div>
                  <p className="text-xs text-purple-600 mb-2" style={{ fontFamily: FONT_BODY }}>
                    Click cells to select letters for the hidden message when read left to right, regardless of height. Click again to deselect.
                  </p>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs text-purple-600 shrink-0" style={{ fontFamily: FONT_BODY }}>Message:</span>
                    <span className="text-sm font-mono font-bold text-purple-700 tracking-widest">
                      {hiddenMessageCells.length > 0
                        ? [...hiddenMessageCells].sort((a, b) => a.c - b.c || a.r - b.r).map((cell) => result?.grid?.[cell.r]?.[cell.c] || "?").join("")
                        : "—"}
                    </span>
                  </div>
                  <input
                    type="text"
                    placeholder="Intended message (optional, for reference)"
                    value={hiddenMessageText}
                    onChange={(e) => setHiddenMessageText(e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border border-purple-300 rounded focus:outline-none focus:ring-2 focus:ring-purple-400 bg-white"
                    style={{ fontFamily: FONT_BODY }}
                  />
                  {hiddenMessageCells.length > 0 && (
                    <button
                      onClick={() => { setHiddenMessageCells([]); setHiddenMessageText(""); }}
                      className="mt-1 text-xs text-red-500 hover:text-red-700 transition"
                    >
                      Clear all selections
                    </button>
                  )}
                </div>
              )}

              {mode === "manual" ? (
                /* ===== MANUAL MODE GRID ===== */
                <div>
                  <div className="mb-4">
                    <div className="flex items-baseline gap-3">
                      {puzzleTitle && (
                        <h2
                          className="text-2xl font-bold"
                          style={{ fontFamily: FONT_HEADING }}
                        >
                          {puzzleTitle}
                        </h2>
                      )}
                      <span
                        className="text-sm text-gray-600"
                        style={{ fontFamily: FONT_BODY }}
                      >
                        {puzzleByline}
                      </span>
                    </div>
                    <p
                      className="text-sm text-gray-500 mt-0.5"
                      style={{ fontFamily: FONT_BODY }}
                    >
                      {puzzleDate} &middot; {clueCountLabel}
                    </p>
                  </div>

                  <div className="flex justify-end gap-2 mb-2">
                    <button
                      onClick={captureManualWords}
                      className="px-5 py-1.5 text-sm bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition"
                      style={{ fontFamily: FONT_BODY }}
                    >
                      Capture new words from Grid
                    </button>
                    <button
                      onClick={savePuzzle}
                      className="px-5 py-1.5 text-sm bg-black text-white font-semibold rounded-lg hover:bg-gray-800 transition"
                      style={{ fontFamily: FONT_BODY }}
                    >
                      Save
                    </button>
                  </div>

                  {hiddenMessageCells.length > 0 && (
                    <p
                      className="text-xs text-gray-500 mb-2"
                      style={{ fontFamily: FONT_BODY }}
                    >
                      The circled letters spell a hidden message when read left to right.
                    </p>
                  )}

                  <div
                    ref={(el) => { manualGridRef.current = el; gridWrapRef.current = el; }}
                    className="grid-scroll-container flex justify-start mb-6 outline-none"
                    tabIndex={0}
                    onKeyDown={handleManualKeyDown}
                  >
                    <div
                      className="inline-grid border-2 border-black"
                      style={{
                        position: "relative",
                        gridTemplateColumns: `repeat(${manualGridSize.cols}, ${cellPx}px)`,
                        gap: "1px",
                        // Darker gridlines so every cell reads as its own square —
                        // faint (#ccc) lines made adjacent/crossing letters blur
                        // together into "groups".
                        background: "#8a8a8a",
                      }}
                    >
                      {manualGrid.map((row, r) =>
                        row.map((cell, c) => {
                          const isSelected = selectedCell?.r === r && selectedCell?.c === c;
                          const isLocked = lockedCells.has(`${r},${c}`);
                          const hasLetter = cell !== null;
                          return (
                            <div
                              key={`${r}-${c}`}
                              onClick={() => {
                                if (hiddenMessageMode && hasLetter) {
                                  toggleHiddenMessageCell(r - MANUAL_PADDING, c - MANUAL_PADDING);
                                } else {
                                  handleCellClick(r, c);
                                  manualGridRef.current?.focus();
                                }
                              }}
                              onDoubleClick={() => {
                                if (!hiddenMessageMode && hasLetter) handleManualDoubleClick(r, c);
                              }}
                              className="relative flex items-center justify-center cursor-pointer"
                              style={{
                                width: "var(--cell-size)",
                                height: "var(--cell-size)",
                                background: isSelected
                                  ? "#b8d4f0"
                                  : hasLetter && highlightCells.has(`${r},${c}`)
                                  ? "#fde68a"
                                  : hasLetter
                                  ? "#fff"
                                  : "#f5f5f0",
                                outline: isSelected ? "2px solid #2563eb" : "none",
                                outlineOffset: "-1px",
                              }}
                            >
                              {hasLetter && (
                                <span
                                  className="text-lg lg:text-xl font-medium select-none"
                                  style={{
                                    fontFamily: FONT_BODY,
                                    color: isLocked ? "#000" : "#2563eb",
                                  }}
                                >
                                  {cell}
                                </span>
                              )}
                              {hasLetter && isHiddenMessageCell(r - MANUAL_PADDING, c - MANUAL_PADDING) && (
                                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
                                  <circle cx="50" cy="50" r="48" fill="none" stroke="#000" strokeWidth="3" />
                                </svg>
                              )}
                            </div>
                          );
                        })
                      )}
                      {/* Tight frame around the filled cells. Absolutely
                          positioned (into its grid area) so it doesn't displace
                          the auto-placed cells the way an in-flow grid item would. */}
                      {manualBBox && (
                        <div
                          style={{
                            position: "absolute",
                            inset: 0,
                            gridRowStart: manualBBox.minR + 1,
                            gridRowEnd: manualBBox.maxR + 2,
                            gridColumnStart: manualBBox.minC + 1,
                            gridColumnEnd: manualBBox.maxC + 2,
                            border: "3px solid #9333ea",
                            pointerEvents: "none",
                            zIndex: 3,
                          }}
                        />
                      )}
                    </div>
                  </div>

                  {/* Clue lists — hidden in Hidden Message mode */}
                  {!hiddenMessageMode && (
                    <div className="grid grid-cols-2 gap-6">
                      <div>
                        <h3
                          className="font-bold text-lg mb-2 border-b border-gray-300 pb-1"
                          style={{ fontFamily: FONT_HEADING }}
                        >
                          Across
                        </h3>
                        <ol className="space-y-1">
                          {acrossClues?.map((w) => (
                            <li
                              key={w.number}
                              className="text-sm"
                              style={{ fontFamily: FONT_BODY }}
                            >
                              <span className="font-bold mr-1">{w.number}</span>
                              {w.clue || <span className="text-gray-400 italic">no clue yet</span>}
                            </li>
                          ))}
                        </ol>
                      </div>
                      <div>
                        <h3
                          className="font-bold text-lg mb-2 border-b border-gray-300 pb-1"
                          style={{ fontFamily: FONT_HEADING }}
                        >
                          Down
                        </h3>
                        <ol className="space-y-1">
                          {downClues?.map((w) => (
                            <li
                              key={w.number}
                              className="text-sm"
                              style={{ fontFamily: FONT_BODY }}
                            >
                              <span className="font-bold mr-1">{w.number}</span>
                              {w.clue || <span className="text-gray-400 italic">no clue yet</span>}
                            </li>
                          ))}
                        </ol>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                /* ===== AUTO MODE (printable) ===== */
                <div>
                  <div ref={printRef} style={{ background: "#fff", padding: "24px" }}>
                    <div className="mb-4">
                      <div className="flex items-baseline gap-3">
                        {puzzleTitle && (
                          <h2
                            className="text-2xl font-bold"
                            style={{ fontFamily: FONT_HEADING }}
                          >
                            {puzzleTitle}
                          </h2>
                        )}
                        <span
                          className="text-sm text-gray-600"
                          style={{ fontFamily: FONT_BODY }}
                        >
                          by Jonathan Shambroom
                        </span>
                      </div>
                      <p
                        className="text-sm text-gray-500 mt-0.5"
                        style={{ fontFamily: FONT_BODY }}
                      >
                        {puzzleDate} &middot; {clueCountLabel}
                      </p>
                    </div>

                    <div className="flex justify-end mb-2">
                      <button
                        onClick={savePuzzle}
                        className="px-5 py-1.5 text-sm bg-black text-white font-semibold rounded-lg hover:bg-gray-800 transition"
                        style={{ fontFamily: FONT_BODY }}
                      >
                        Save
                      </button>
                    </div>

                    {hiddenMessageCells.length > 0 && (
                      <p
                        className="text-xs text-gray-500 mb-2"
                        style={{ fontFamily: FONT_BODY }}
                      >
                        The circled letters spell a hidden message when read left to right.
                      </p>
                    )}

                    <div ref={gridWrapRef} className="grid-scroll-container flex justify-start mb-6">
                      <div
                        className="crossword-grid"
                        style={{
                          gridTemplateColumns: `repeat(${result.size.cols}, ${cellPx}px)`,
                        }}
                      >
                        {(result.grid || []).map((row, r) =>
                          (row || []).map((cell, c) => (
                            <div
                              key={`${r}-${c}`}
                              className={`crossword-cell ${cell === null ? "black" : ""}`}
                              onClick={() => {
                                if (hiddenMessageMode && cell !== null) toggleHiddenMessageCell(r, c);
                              }}
                              style={{
                                cursor: hiddenMessageMode && cell !== null ? "pointer" : undefined,
                                background:
                                  cell !== null && highlightCells.has(`${r},${c}`)
                                    ? "#fde68a"
                                    : undefined,
                              }}
                            >
                              {cell !== null && result.numberGrid[r][c] > 0 && (
                                <span className="cell-number">
                                  {result.numberGrid[r][c]}
                                </span>
                              )}
                              {cell !== null && hiddenMessageMode && (
                                <span className="cell-letter">{cell}</span>
                              )}
                              {cell !== null && isHiddenMessageCell(r, c) && (
                                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
                                  {result.numberGrid[r][c] > 0 ? (
                                    <path d="M 50,2 A 48,48 0 1,1 6,32" fill="none" stroke="#000" strokeWidth="3" />
                                  ) : (
                                    <circle cx="50" cy="50" r="48" fill="none" stroke="#000" strokeWidth="3" />
                                  )}
                                </svg>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {!hiddenMessageMode && (
                      <div className="grid grid-cols-2 gap-6">
                        <div>
                          <h3
                            className="font-bold text-lg mb-2 border-b border-gray-300 pb-1"
                            style={{ fontFamily: FONT_HEADING }}
                          >
                            Across
                          </h3>
                          <ol className="space-y-1">
                            {acrossClues?.map((w) => (
                              <li
                                key={w.number}
                                className="text-sm"
                                style={{ fontFamily: FONT_BODY }}
                              >
                                <span className="font-bold mr-1">{w.number}</span>
                                {w.clue}
                              </li>
                            ))}
                          </ol>
                        </div>
                        <div>
                          <h3
                            className="font-bold text-lg mb-2 border-b border-gray-300 pb-1"
                            style={{ fontFamily: FONT_HEADING }}
                          >
                            Down
                          </h3>
                          <ol className="space-y-1">
                            {downClues?.map((w) => (
                              <li
                                key={w.number}
                                className="text-sm"
                                style={{ fontFamily: FONT_BODY }}
                              >
                                <span className="font-bold mr-1">{w.number}</span>
                                {w.clue}
                              </li>
                            ))}
                          </ol>
                        </div>
                      </div>
                    )}
                  </div>

                  {result.unplacedWords.length > 0 && (
                    <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm">
                      <p className="font-semibold text-amber-800">
                        Could not place {result.unplacedWords.length} word(s):
                      </p>
                      <ul className="mt-1 text-amber-700">
                        {result.unplacedWords.map((w, i) => (
                          <li key={i}>{w.answer}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-64 bg-white border-2 border-dashed border-gray-200 rounded-lg">
              <p className="text-gray-400 text-lg">
                Your crossword will appear here
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
