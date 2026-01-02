import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { fileURLToPath } from "url";

import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";
import { toFile } from "openai/uploads";

const app = express();

/* ES modules __dirname */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* Middleware */
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* Uploads */
const upload = multer({
  dest: "/tmp/uploads",
  limits: { fileSize: 300 * 1024 * 1024 } // 300MB
});

/* Force IPv4 + keep-alive */
const dispatcher = new Agent({
  connect: { family: 4 },
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 30_000
});
const customFetch = (url, options = {}) => undiciFetch(url, { ...options, dispatcher });

/* OpenAI client */
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  fetch: customFetch,
  maxRetries: 2,
  timeout: 180000
});

/* In-memory job store */
const jobs = new Map();
/**
 * job = {
 *   id, status: "queued"|"processing"|"done"|"error",
 *   progress: { step, pct, message },
 *   resultText, error,
 *   createdAt
 * }
 */

/* Helpers */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout, stderr });
    });
  });
}

async function extractAudioToMp3(inputPath, outputPath) {
  // Light speech-focused MP3 to keep outbound payload smaller
  await run("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "32k",
    "-c:a",
    "mp3",
    outputPath
  ]);
}

async function getDurationSeconds(mediaPath) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    mediaPath
  ]);
  const sec = Number(String(stdout).trim());
  return Number.isFinite(sec) ? sec : null;
}

async function splitAudioIntoChunks(mp3Path, outDir, segmentSeconds = 300) {
  fs.mkdirSync(outDir, { recursive: true });
  const outPattern = path.join(outDir, "chunk_%03d.mp3");

  await run("ffmpeg", [
    "-y",
    "-i",
    mp3Path,
    "-f",
    "segment",
    "-segment_time",
    String(segmentSeconds),
    "-reset_timestamps",
    "1",
    "-c",
    "copy",
    outPattern
  ]);

  const files = fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith("chunk_") && f.endsWith(".mp3"))
    .sort();

  if (!files.length) throw new Error("Chunking produced no output files.");
  return files.map((f) => path.join(outDir, f));
}

async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      const retryable =
        msg.includes("ECONNRESET") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("EAI_AGAIN") ||
        msg.includes("socket hang up") ||
        msg.includes("APIConnectionError");
      if (!retryable || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * IMPORTANT: Use `toFile(...)` so we send a proper multipart file body
 * and avoid flaky stream behavior in some hosts.
 */
async function transcribeMp3File(mp3Path) {
  const buf = fs.readFileSync(mp3Path);
  const file = await toFile(buf, path.basename(mp3Path), { type: "audio/mpeg" });

  return await withRetry(async () => {
    return await client.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file,
      response_format: "text"
    });
  }, 3);
}

function setJob(jobId, patch) {
  const j = jobs.get(jobId);
  if (!j) return;
  jobs.set(jobId, { ...j, ...patch });
}

function setProgress(jobId, pct, step, message) {
  setJob(jobId, { progress: { pct, step, message } });
}

/* Routes */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* Diagnostic: proves server can reach OpenAI */
app.get("/api/ping-openai", async (req, res) => {
  try {
    const r = await customFetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    });
    const text = await r.text();
    res.status(r.status).send(text.slice(0, 400));
  } catch (e) {
    res.status(500).json({ error: "ping failed", details: String(e?.message || e) });
  }
});

/**
 * Create job: upload file and return jobId immediately
 * POST /api/jobs  (multipart form field name "file")
 */
app.post("/api/jobs", upload.single("file"), async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "Missing OPENAI_API_KEY in host variables."
    });
  }
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded. Field must be 'file'." });
  }

  const jobId = crypto.randomBytes(8).toString("hex");

  jobs.set(jobId, {
    id: jobId,
    status: "queued",
    progress: { pct: 0, step: "queued", message: "Queued" },
    resultText: "",
    error: "",
    createdAt: Date.now()
  });

  // Start background processing (do NOT await)
  processJob(jobId, req.file.path, req.file.originalname).catch((e) => {
    console.error(`[${jobId}] job crash:`, e);
    setJob(jobId, {
      status: "error",
      error: String(e?.message || e)
    });
  });

  return res.json({ jobId });
});

/**
 * Poll job status:
 * GET /api/jobs/:id
 */
app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  return res.json(job);
});

/* Background job worker */
async function processJob(jobId, uploadedPath, originalName) {
  let mp3Path = null;
  let chunksDir = null;

  try {
    setJob(jobId, { status: "processing" });

    setProgress(jobId, 10, "extract", "Extracting audio from your video…");
    mp3Path = `${uploadedPath}_${jobId}.mp3`;
    await extractAudioToMp3(uploadedPath, mp3Path);

    const dur = await getDurationSeconds(mp3Path);
    const size = fs.statSync(mp3Path).size;

    // If short (<= 10 min), do single file
    if (!dur || dur <= 600) {
      setProgress(jobId, 55, "upload", `Uploading audio to OpenAI… (${Math.round(dur || 0)}s)`);
      const text = await transcribeMp3File(mp3Path);

      setProgress(jobId, 100, "done", "Done");
      setJob(jobId, { status: "done", resultText: text });
      return;
    }

    // If longer, chunk into 5-min segments
    setProgress(jobId, 35, "chunk", "Splitting long audio into chunks…");
    chunksDir = path.join("/tmp", `chunks_${jobId}`);
    const chunkFiles = await splitAudioIntoChunks(mp3Path, chunksDir, 300);

    const MAX_CHUNKS = 24; // 2 hours cap
    const used = chunkFiles.slice(0, MAX_CHUNKS);

    let full = "";
    for (let i = 0; i < used.length; i++) {
      const pct = 55 + Math.round((40 * (i / used.length)));
      setProgress(jobId, pct, "transcribe", `Transcribing chunk ${i + 1} of ${used.length}…`);
      const part = await transcribeMp3File(used[i]);
      full += (i === 0 ? "" : "\n\n") + part;
    }

    if (chunkFiles.length > MAX_CHUNKS) {
      full += `\n\n[Note: truncated after ${MAX_CHUNKS * 5} minutes due to server limits.]`;
    }

    setProgress(jobId, 100, "done", "Done");
    setJob(jobId, { status: "done", resultText: full });
  } catch (e) {
    console.error(`[${jobId}] ERROR:`, e);
    setJob(jobId, {
      status: "error",
      error: String(e?.message || e)
    });
  } finally {
    // Cleanup
    try { if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath); } catch {}
    try { if (mp3Path && fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path); } catch {}
    try {
      if (chunksDir && fs.existsSync(chunksDir)) {
        for (const f of fs.readdirSync(chunksDir)) {
          try { fs.unlinkSync(path.join(chunksDir, f)); } catch {}
        }
        try { fs.rmdirSync(chunksDir); } catch {}
      }
    } catch {}
  }
}

/* Start */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
