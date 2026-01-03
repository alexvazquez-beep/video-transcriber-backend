import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import { Agent, fetch as undiciFetch, FormData, File } from "undici";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---- Upload storage ----
const UPLOAD_DIR = "/tmp/stored_uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const uploads = new Map(); // uploadId -> { path, originalName, createdAt }
const jobs = new Map();    // jobId -> { status, progress, resultText, error }

const upload = multer({
  dest: "/tmp/incoming",
  limits: { fileSize: 300 * 1024 * 1024 }
});

// ---- Force IPv4 + keepalive ----
const dispatcher = new Agent({
  connect: { family: 4 },
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 30_000
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
        msg.includes("socket hang up");

      if (!retryable || i === tries - 1) throw e;
      await sleep(1200 * (i + 1));
    }
  }
  throw lastErr;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout, stderr });
    });
  });
}

async function extractAudioToMp3(inputPath, outputPath) {
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

// ✅ OpenAI transcription using undici FormData + File (NO SDK, NO node-fetch)
async function openaiTranscribeMp3(mp3Path) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const buf = fs.readFileSync(mp3Path);

  // undici File ensures correct multipart encoding
  const file = new File([buf], "audio.mp3", { type: "audio/mpeg" });

  const form = new FormData();
  form.set("model", "gpt-4o-mini-transcribe");
  form.set("response_format", "text");
  form.set("file", file);

  console.log("[TRANSCRIBE] USING UNDICI DIRECT HTTP (NO OPENAI SDK)");

  return await withRetry(async () => {
    const r = await undiciFetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: form,
      dispatcher
    });

    const text = await r.text();
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${text.slice(0, 400)}`);
    return text; // plain text
  }, 3);
}

// ---- Routes ----
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/ping-openai", async (req, res) => {
  try {
    const r = await undiciFetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      dispatcher
    });
    const t = await r.text();
    res.status(r.status).send(t.slice(0, 400));
  } catch (e) {
    res.status(500).json({ error: "ping failed", details: String(e?.message || e) });
  }
});

// 1) Upload first
app.post("/api/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field name: file)" });

    const uploadId = crypto.randomBytes(10).toString("hex");
    const storedPath = path.join(UPLOAD_DIR, `${uploadId}_${req.file.originalname}`);
    fs.renameSync(req.file.path, storedPath);

    uploads.set(uploadId, { path: storedPath, originalName: req.file.originalname, createdAt: Date.now() });
    res.json({ uploadId, originalName: req.file.originalname });
  } catch (e) {
    res.status(500).json({ error: "Upload failed", details: String(e?.message || e) });
  }
});

// 2) Start job second
app.post("/api/jobs", async (req, res) => {
  try {
    const { uploadId } = req.body || {};
    if (!uploadId) return res.status(400).json({ error: "Missing uploadId" });

    const u = uploads.get(uploadId);
    if (!u) return res.status(404).json({ error: "Upload not found or expired" });

    const jobId = crypto.randomBytes(10).toString("hex");
    jobs.set(jobId, { id: jobId, status: "queued", progress: { pct: 0, message: "Queued" }, resultText: "", error: "" });

    processJob(jobId, u.path).catch((e) => {
      jobs.set(jobId, { ...jobs.get(jobId), status: "error", error: String(e?.message || e) });
    });

    res.json({ jobId });
  } catch (e) {
    res.status(500).json({ error: "Failed to start job", details: String(e?.message || e) });
  }
});

// 3) Poll
app.get("/api/jobs/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: "Job not found" });
  res.json(j);
});

async function processJob(jobId, storedVideoPath) {
  const setProgress = (pct, message) => {
    const j = jobs.get(jobId);
    if (!j) return;
    jobs.set(jobId, { ...j, status: "processing", progress: { pct, message } });
  };

  let mp3Path = null;

  try {
    setProgress(10, "Extracting audio…");
    mp3Path = `/tmp/${jobId}.mp3`;
    await extractAudioToMp3(storedVideoPath, mp3Path);

    setProgress(60, "Transcribing…");
    const text = await openaiTranscribeMp3(mp3Path);

    jobs.set(jobId, { ...jobs.get(jobId), status: "done", progress: { pct: 100, message: "Done" }, resultText: text });
  } catch (e) {
    jobs.set(jobId, { ...jobs.get(jobId), status: "error", error: String(e?.message || e), progress: { pct: 0, message: "Error" } });
  } finally {
    try { if (mp3Path && fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path); } catch {}
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
