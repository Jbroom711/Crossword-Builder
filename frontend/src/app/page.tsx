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
  result: CrosswordResult;
  savedAt: string;
  manualGrid?: (string | null)[][];
  manualGridSize?: { rows: number; cols: number };
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

  // Hidden message state
  const [hiddenMessageMode, setHiddenMessageMode] = useState(false);
  const [hiddenMessageCells, setHiddenMessageCells] = useState<{ r: number; c: number }[]>([]);
  const [hiddenMessageText, setHiddenMessageText] = useState("");

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
        // Check for localStorage puzzles to migrate
        const raw = localStorage.getItem("crossword_puzzles");
        if (raw) {
          try {
            const localPuzzles = JSON.parse(raw) as SavedPuzzle[];
            for (const p of localPuzzles) {
              await fetch("/api/puzzles", {
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
            }
            localStorage.removeItem("crossword_puzzles");
          } catch {}
        }
        // Load from API
        try {
          const res = await fetch("/api/puzzles");
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data)) setSavedPuzzles(data);
          }
        } catch {}
      })();
    } else {
      const raw = localStorage.getItem("crossword_puzzles");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setSavedPuzzles(parsed);
      }
    }
  }, [isLoaded, isSignedIn]);

  function updateClue(index: number, field: keyof ClueEntry, value: string) {
    const updated = [...clues];
    updated[index] = { ...updated[index], [field]: value };
    setClues(updated);
  }

  const answerRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

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
    const valid = clues.filter((c) => c.answer.trim() && c.clue.trim());
    if (valid.length < 2) {
      setError("Please enter at least 2 complete clues (answer + clue text).");
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

  // Reorder clue entries to match puzzle order: Across by number, then Down by number
  function reorderClues(data: CrosswordResult) {
    const across = data.placedWords
      .filter((w) => w.direction === "across")
      .sort((a, b) => a.number - b.number);
    const down = data.placedWords
      .filter((w) => w.direction === "down")
      .sort((a, b) => a.number - b.number);
    const ordered = [...across, ...down];
    const clueLookup = new Map<string, string>();
    for (const c of clues) {
      if (c.answer.trim() && c.clue.trim()) {
        clueLookup.set(c.answer.toUpperCase(), c.clue);
      }
    }
    setClues(
      ordered.map((w) => ({
        answer: w.answer,
        clue: clueLookup.get(w.answer) || w.clue || "",
      }))
    );
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
      if (!res.ok) throw new Error("Upload failed");
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
  }

  function handleCellClick(r: number, c: number) {
    if (selectedCell?.r === r && selectedCell?.c === c) {
      // Clicking same cell toggles direction
      setManualDirection((d) => (d === "across" ? "down" : "across"));
    } else {
      setSelectedCell({ r, c });
    }
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
        } else {
          // Move back
          const pr = r - dr;
          const pc = c - dc;
          if (pr >= 0 && pc >= 0) {
            updated[pr][pc] = null;
            setManualGrid(updated);
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

    // Add any truly new words (no clue text found) to the clue list
    const existingAnswers = new Set(clues.map((c) => c.answer.toUpperCase()));
    const newClueEntries: ClueEntry[] = allDetected
      .filter((w) => !existingAnswers.has(w.answer))
      .map((w) => ({ answer: w.answer, clue: "" }));
    if (newClueEntries.length > 0) {
      const existingClues = clues.filter((c) => c.answer.trim());
      setClues([...existingClues, ...newClueEntries]);
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
    if (!result) return;

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
        const saved = await res.json();
        if (saved.id) setCurrentPuzzleId(saved.id);
        // Refresh list
        try {
          const listRes = await fetch("/api/puzzles");
          if (listRes.ok) {
            const list = await listRes.json();
            if (Array.isArray(list)) setSavedPuzzles(list);
          }
        } catch {}
      } catch {}
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
    }
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
      y += 10;
    }

    // Layout: grid flush left, Down clues column to the right, Across clues below grid
    const cols = result.size.cols;
    const rows = result.size.rows;
    const gap = 12; // gap between grid and Down column
    // Reserve right column for Down clues (at least 160pt)
    const downColWidth = Math.max(160, usable * 0.32);
    const gridMaxW = usable - downColWidth - gap;
    const gridMaxH = (bottomLimit - y) * 0.52;
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
              // 285° arc starting from left-center (180°), leaving 75° gap at top-left
              const arcStart = 180 * (Math.PI / 180);
              const arcSweep = 285 * (Math.PI / 180);
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
      .sort((a, b) => a.number - b.number);
    const dwn = result.placedWords
      .filter((w) => w.direction === "down")
      .sort((a, b) => a.number - b.number);

    const lineH = 10;

    // Flowing clue renderer — draws clues across two zones:
    // Zone 1: below the grid (x=margin, width=gridW)
    // Zone 2: right column (x=rightColX, width=rightColW, from gridTopY down)
    // Returns { x, y, colWidth } so the next section can continue in the flow.
    type Zone = { x: number; y: number; w: number };
    let currentZone: Zone = { x: margin, y: gridBottomY + 18, w: gridW };
    let inRightCol = false;

    function jumpToRightCol() {
      currentZone = { x: rightColX, y: gridTopY + 5, w: rightColW };
      inRightCol = true;
    }

    // Use Montserrat if available, fall back to Helvetica
    const clueFont = pdf.getFontList()["Montserrat"] ? "Montserrat" : "helvetica";

    function drawFlowingClueList(title: string, clueList: PlacedWord[]) {
      let { x, y: cy, w: maxWidth } = currentZone;

      pdf.setFont("times", "bold");
      pdf.setFontSize(13);
      pdf.text(title, x, cy);
      cy += 4;
      pdf.setLineWidth(0.5);
      pdf.line(x, cy, x + maxWidth, cy);
      cy += lineH;

      // Pre-calculate the widest number+period width for tab alignment
      pdf.setFont(clueFont, "bold");
      pdf.setFontSize(8);
      let maxNumW = 0;
      for (const cl of clueList) {
        const w = pdf.getTextWidth(`${cl.number}. `);
        if (w > maxNumW) maxNumW = w;
      }
      const textIndent = maxNumW + 2; // small padding after widest number

      for (const cl of clueList) {
        pdf.setFont(clueFont, "normal");
        pdf.setFontSize(8.5);
        const lines = pdf.splitTextToSize(cl.clue || "(no clue)", maxWidth - textIndent);
        const needed = lines.length * lineH;

        // If this clue would overflow and we haven't moved to right col yet, jump there
        if (cy + needed > bottomLimit && !inRightCol) {
          jumpToRightCol();
          x = currentZone.x;
          cy = currentZone.y;
          maxWidth = currentZone.w;
        }

        pdf.setFont(clueFont, "bold");
        pdf.setFontSize(8);
        pdf.text(`${cl.number}.`, x, cy);
        pdf.setFont(clueFont, "normal");
        pdf.setFontSize(8.5);
        for (let l = 0; l < lines.length; l++) {
          if (cy > bottomLimit) {
            if (!inRightCol) {
              jumpToRightCol();
              x = currentZone.x;
              cy = currentZone.y;
              maxWidth = currentZone.w;
            } else {
              pdf.addPage();
              cy = margin;
            }
          }
          pdf.text(lines[l], x + textIndent, cy);
          cy += lineH;
        }
      }

      currentZone = { x, y: cy, w: maxWidth };
    }

    // Across first, then Down continues in the same flow
    drawFlowingClueList("Across", acr);
    // Add a small gap before Down heading
    currentZone.y += 6;
    drawFlowingClueList("Down", dwn);

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
    pdf.save(`Answer Key - ${puzzleTitle || "crossword"}.pdf`);
  }

  async function exportLarge() {
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
      y += 14;
      return y;
    }

    // === PAGE 1: Header + Large Grid ===
    let y = drawHeader(margin);

    if (hiddenMessageCells.length > 0) {
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(7);
      pdf.setTextColor(80);
      pdf.text("The circled letters spell a hidden message when read left to right.", margin, y);
      pdf.setTextColor(0);
      y += 10;
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
          // Hidden message circle
          if (cell !== null && isHiddenMessageCell(r, c)) {
            pdf.setDrawColor(0, 0, 0);
            pdf.setLineWidth(0.5);
            const midX = cx + largeCellSize / 2;
            const midY = cy + largeCellSize / 2;
            const rad = largeCellSize * 0.48;
            if (num > 0) {
              // 285° arc starting from left-center (180°), leaving 75° gap at top-left
              const arcStart = 180 * (Math.PI / 180);
              const arcSweep = 285 * (Math.PI / 180);
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

    // === PAGE 2: Header + Two-column clues ===
    pdf.addPage();
    y = drawHeader(margin);

    const acr = result.placedWords
      .filter((w) => w.direction === "across")
      .sort((a, b) => a.number - b.number);
    const dwn = result.placedWords
      .filter((w) => w.direction === "down")
      .sort((a, b) => a.number - b.number);

    const colGap = 16;
    const colWidth = (usable - colGap) / 2;
    const lineH = 11;

    function drawClueColumn(title: string, clueList: PlacedWord[], x: number, startY: number) {
      let cy = startY;
      pdf.setFont("times", "bold");
      pdf.setFontSize(13);
      pdf.text(title, x, cy);
      cy += 4;
      pdf.setLineWidth(0.5);
      pdf.line(x, cy, x + colWidth, cy);
      cy += lineH;

      // Tab-aligned numbers
      pdf.setFont(clueFont, "bold");
      pdf.setFontSize(9);
      let maxNumW = 0;
      for (const cl of clueList) {
        const w = pdf.getTextWidth(`${cl.number}. `);
        if (w > maxNumW) maxNumW = w;
      }
      const textIndent = maxNumW + 2;

      for (const cl of clueList) {
        pdf.setFont(clueFont, "normal");
        pdf.setFontSize(9.5);
        const lines = pdf.splitTextToSize(cl.clue || "(no clue)", colWidth - textIndent);

        pdf.setFont(clueFont, "bold");
        pdf.setFontSize(9);
        pdf.text(`${cl.number}.`, x, cy);
        pdf.setFont(clueFont, "normal");
        pdf.setFontSize(9.5);
        for (let l = 0; l < lines.length; l++) {
          if (cy > bottomLimit) {
            pdf.addPage();
            cy = margin;
          }
          pdf.text(lines[l], x + textIndent, cy);
          cy += lineH;
        }
      }
    }

    y += 12;
    drawClueColumn("Across", acr, margin, y);
    drawClueColumn("Down", dwn, margin + colWidth + colGap, y);

    pdf.save(`Large Crossword - ${puzzleTitle || "crossword"}.pdf`);
  }

  const acrossClues = (result?.placedWords || [])
    .filter((w) => w.direction === "across")
    .sort((a, b) => a.number - b.number);
  const downClues = (result?.placedWords || [])
    .filter((w) => w.direction === "down")
    .sort((a, b) => a.number - b.number);

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

  // Highlight cells along the current typing direction from the selected cell
  const highlightCells = new Set<string>();
  if (selectedCell && mode === "manual") {
    highlightCells.add(`${selectedCell.r},${selectedCell.c}`);
  }

  return (
    <div className="min-h-screen p-6 max-w-7xl mx-auto">
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

      <div className={`grid grid-cols-1 ${hiddenMessageMode ? "" : "lg:grid-cols-2"} gap-8`}>
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
            </h2>
            <div className="flex gap-2">
              <button
                onClick={() => setShowSaved(!showSaved)}
                className="px-3 py-1.5 text-sm bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 transition"
                style={{ fontFamily: FONT_BODY }}
              >
                {showSaved ? "Hide Saved" : `Saved (${savedPuzzles.length})`}
              </button>
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
              return (
              <div
                key={i}
                className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg p-3"
              >
                <span
                  className="text-xs text-gray-500 w-7 text-right shrink-0 font-semibold"
                  style={{ fontFamily: "'Montserrat', 'Libre Franklin', system-ui, sans-serif" }}
                >
                  {label}
                </span>
                <input
                  ref={(el) => { answerRefs.current[i] = el; }}
                  type="text"
                  placeholder="ANSWER"
                  value={clue.answer}
                  onChange={(e) =>
                    updateClue(i, "answer", e.target.value.toUpperCase())
                  }
                  className="w-32 shrink-0 px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-black uppercase"
                  style={{ fontFamily: "'Montserrat', 'Libre Franklin', system-ui, sans-serif" }}
                />
                <input
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
            className="mt-4 w-full py-3 bg-black text-white font-semibold rounded-lg hover:bg-gray-800 disabled:opacity-50 transition text-base"
            style={{ fontFamily: FONT_BODY }}
          >
            {loading ? "Generating..." : "Generate Crossword"}
          </button>

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

              <div className="mt-3 flex gap-3">
                <button
                  onClick={savePuzzle}
                  className="flex-1 py-2 text-sm border-2 border-black rounded-lg hover:bg-gray-100 transition font-medium"
                  style={{ fontFamily: FONT_BODY }}
                >
                  Save Puzzle
                </button>
                <button
                  onClick={exportPDF}
                  className="flex-1 py-2 text-sm text-white rounded-lg transition font-medium"
                  style={{ fontFamily: FONT_BODY, background: "#56ca23" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#4ab51f")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "#56ca23")}
                >
                  Export / Share PDF
                </button>
                <button
                  onClick={exportAnswerKey}
                  className="flex-1 py-2 text-sm bg-gray-800 text-white rounded-lg hover:bg-gray-700 transition font-medium"
                  style={{ fontFamily: FONT_BODY }}
                >
                  Export Answer Key
                </button>
                <button
                  onClick={exportLarge}
                  className="flex-1 py-2 text-sm text-white rounded-lg transition font-medium"
                  style={{ fontFamily: FONT_BODY, background: "#e88a1a" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#d07a15")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "#e88a1a")}
                >
                  Export Large PDF<br />(2 pages)
                </button>
              </div>
              {saveTimestamp && (
                <p className="mt-1.5 text-xs text-gray-400" style={{ fontFamily: FONT_BODY }}>
                  Saved on {saveTimestamp}
                </p>
              )}
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
                      {puzzleDate}
                    </p>
                  </div>

                  <div
                    ref={manualGridRef}
                    className="grid-scroll-container flex justify-start mb-6 outline-none"
                    tabIndex={0}
                    onKeyDown={handleManualKeyDown}
                  >
                    <div
                      className="inline-grid border-2 border-black"
                      style={{
                        gridTemplateColumns: `repeat(${manualGridSize.cols}, var(--cell-size))`,
                        gap: "1px",
                        background: "#ccc",
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
                                handleCellClick(r, c);
                                manualGridRef.current?.focus();
                              }}
                              className="relative flex items-center justify-center cursor-pointer"
                              style={{
                                width: "var(--cell-size)",
                                height: "var(--cell-size)",
                                background: isSelected
                                  ? "#b8d4f0"
                                  : hasLetter
                                  ? "#fff"
                                  : "#f5f5f0",
                                outline: isSelected ? "2px solid #2563eb" : "none",
                                outlineOffset: "-1px",
                              }}
                            >
                              {hasLetter && (
                                <span
                                  className="text-base font-medium select-none"
                                  style={{
                                    fontFamily: FONT_BODY,
                                    color: isLocked ? "#000" : "#2563eb",
                                  }}
                                >
                                  {cell}
                                </span>
                              )}
                              {hasLetter && isHiddenMessageCell(r, c) && (
                                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
                                  <circle cx="50" cy="50" r="48" fill="none" stroke="#000" strokeWidth="3" />
                                </svg>
                              )}
                            </div>
                          );
                        })
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
                        {puzzleDate}
                      </p>
                    </div>

                    <div className="grid-scroll-container flex justify-start mb-6">
                      <div
                        className="crossword-grid"
                        style={{
                          gridTemplateColumns: `repeat(${result.size.cols}, var(--cell-size))`,
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
                              style={{ cursor: hiddenMessageMode && cell !== null ? "pointer" : undefined }}
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
                                    <path d="M 2,50 A 48,48 0 1,0 43,4" fill="none" stroke="#000" strokeWidth="3" />
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
