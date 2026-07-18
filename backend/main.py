import os
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from crossword_engine import generate_crossword
import json
import csv
import io

# Column-name synonyms so an uploaded file's headers don't have to be exact.
ANSWER_KEYS = {"answer", "answers", "word", "words", "entry", "solution"}
CLUE_KEYS = {"clue", "clues", "question", "questions", "hint", "definition", "prompt"}

app = FastAPI(title="Crossword Builder API")

# Allow localhost for dev + any deployed frontend via CORS_ORIGINS env var
allowed_origins = [
    "http://localhost:3030",
    "http://localhost:3000",
    "https://crossword-builder-jsham.vercel.app",
]
extra_origins = os.environ.get("CORS_ORIGINS", "")
if extra_origins:
    allowed_origins.extend(extra_origins.split(","))

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Clue(BaseModel):
    answer: str
    clue: str


class CrosswordRequest(BaseModel):
    clues: list[Clue]


@app.post("/api/generate")
def generate(request: CrosswordRequest):
    entries = [
        {"answer": c.answer.upper().strip(), "clue": c.clue}
        for c in request.clues
    ]
    result = generate_crossword(entries)
    return result


def _err(message: str, status: int = 400):
    # Return (not raise) so the CORS middleware still adds its headers — an
    # unhandled exception would produce a 500 with NO CORS headers, which the
    # browser misreports as a generic "Failed to fetch".
    return JSONResponse(status_code=status, content={"error": message})


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    try:
        content = await file.read()
        try:
            text = content.decode("utf-8-sig")  # utf-8, tolerating a BOM
        except UnicodeDecodeError:
            text = content.decode("latin-1")

        name = (file.filename or "").lower()
        clues = []

        if name.endswith(".json"):
            data = json.loads(text)
            if isinstance(data, dict):
                data = data.get("clues", [])
            for item in data:
                answer = (item.get("answer") or item.get("word") or "").upper().strip()
                clue = item.get("clue") or item.get("question") or ""
                if answer:
                    clues.append({"answer": answer, "clue": clue})
        else:
            # Treat everything else as CSV. Match columns by name,
            # case-insensitively, in any order.
            reader = csv.DictReader(io.StringIO(text))
            fields = reader.fieldnames or []
            norm = {(fn or "").strip().lower(): fn for fn in fields}
            answer_key = next((norm[k] for k in norm if k in ANSWER_KEYS), None)
            clue_key = next((norm[k] for k in norm if k in CLUE_KEYS), None)
            if answer_key is None:
                return _err(
                    "The CSV needs an 'answer' column (also accepts 'word'). "
                    "Found columns: " + (", ".join(fields) if fields else "(none)")
                )
            for row in reader:
                answer = (row.get(answer_key) or "").upper().strip()
                clue = (row.get(clue_key) or "") if clue_key else ""
                if answer:
                    clues.append({"answer": answer, "clue": clue.strip()})

        if len(clues) < 2:
            return _err(
                "Need at least 2 answers to build a crossword — parsed "
                + str(len(clues)) + "."
            )

        return generate_crossword(clues)
    except Exception as e:  # noqa: BLE001 — surface a clean error, keep CORS headers
        return _err("Couldn't read that file: " + str(e))


@app.get("/api/health")
def health():
    return {"status": "ok"}
