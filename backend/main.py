import os
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from crossword_engine import generate_crossword
import json
import csv
import io

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


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    content = await file.read()
    text = content.decode("utf-8")

    clues = []
    if file.filename.endswith(".json"):
        clues = json.loads(text)
    elif file.filename.endswith(".csv"):
        reader = csv.DictReader(io.StringIO(text))
        for row in reader:
            clues.append({
                "answer": row["answer"].upper().strip(),
                "clue": row["clue"],
            })

    result = generate_crossword(clues)
    return result


@app.get("/api/health")
def health():
    return {"status": "ok"}
