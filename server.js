import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import { Agent, fetch as undiciFetch } from "undici";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- Storage (simple MVP) ----------
const UPLOAD_DIR = "/tmp/stored_uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Keep uploads for 2 hours
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const uploads = new Map(); // uploadId -> { path, originalName, createdAt }

// In-memory jobs
const jobs = new Map(); // jobId -> {status, progress, resultText, error}

// ---------- Multer (upload only) ----------
const upload = multer({
  dest: "/tmp/incoming",
  limits: { fileSize: 300 * 1024 * 1024 } // 300MB
});

// ---------- Force IPv4 + keepalive for all outbound OpenAI calls ----------
const dispatcher = new Agent({
  connect: { family: 4 },
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 30_000
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

// Convert video/audio → MP3 (small)
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

// ✅ DIRECT OpenAI call with undici + FormData (no SDK, no node-fetch)
async function openaiTranscribeMp3(mp3Path) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const buf = fs.readFileSync(mp3Path);

  // Node 20 has global FormData/Blob
  const form = new FormData();
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("response_format", "text");
  form.append("file", new Blob([buf], { type: "audio/mpeg" }), "audio.mp3");

  return await withRetry(async () => {
    const r = await undiciFetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
        // NOTE: do NOT set Content-Type manually; FormData will handle boundary
      },
      body: form,
      dispatcher
    });

    const text = await r.text();

    if (!r.ok) {
      // Return server error text for debugging
      throw new Error(`OpenAI ${r.status}: ${text.slice(0, 300)}`);
    }

    // response_format=text returns plain text
    return text;
  }, 3);
}

// Cleanup old uploads (best effort)
setInterval(() => {
  const now = Date.now();
  for (const [id, u] of uploads.entries()) {
    if (now - u.createdAt > UPLOAD_TTL_MS) {
      try { if (fs.existsSync(u.path)) fs.unlinkSync(u.path); } catch {}
      uploads.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Ping OpenAI
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

// 1) Upload only (stores file, returns uploadId)
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field name: file)" });

    const uploadId = crypto.randomBytes(10).toString("hex");
    const storedPath = path.join(UPLOAD_DIR, `${uploadId}_${req.file.originalname}`);

    // Move from incoming → stored
    fs.renameSync(req.file.path, storedPath);

    uploads.set(uploadId, {
      path: storedPath,
      originalName: req.file.originalname,
      createdAt: Date.now()
    });

    return res.json({ uploadId, originalName: req.file.originalname });
  } catch (e) {
    return res.status(500).json({ error: "Upload failed", details: String(e?.message || e) });
  }
});

// 2) Start transcription job (returns jobId immediately)
app.post("/api/jobs", async (req, res) => {
  try {
    const { uploadId } = req.body || {};
    if (!uploadId) return res.status(400).json({ error: "Missing uploadId" });

    const u = uploads.get(uploadId);
    if (!u) return res.status(404).json({ error: "Upload not found or expired" });

    const jobId = crypto.randomBytes(10).toString("hex");
    jobs.set(jobId, {
      id: jobId,
      status: "queued",
      progress: { pct: 0, message: "Queued" },
      resultText: "",
      error: ""
    });

    // Background work
    processJob(jobId, u.path).catch((e) => {
      jobs.set(jobId, {
        ...jobs.get(jobId),
        status: "error",
        error: String(e?.message || e),
        progress: { pct: 0, message: "Error" }
      });
    });

    return res.json({ jobId });
  } catch (e) {
    return res.status(500).json({ error: "Failed to start job", details: String(e?.message || e) });
  }
});

// 3) Poll job
app.get("/api/jobs/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: "Job not found" });
  return res.json(j);
});

// Background worker
async function processJob(jobId, storedVideoPath) {
  const setProgress = (pct, message) => {
    const j = jobs.get(jobId);
    if (!j) return;
    jobs.set(jobId, { ...j, progress: { pct, message } });
  };

  const setStatus = (status) => {
    const j = jobs.get(jobId);
    if (!j) return;
    jobs.set(jobId, { ...j, status });
  };

  let mp3Path = null;

  try {
    setStatus("processing");
    setProgress(10, "Extracting audio…");

    mp3Path = `/tmp/${jobId}.mp3`;
    await extractAudioToMp3(storedVideoPath, mp3Path);

    setProgress(55, "Uploading audio to OpenAI…");
    const text = await openaiTranscribeMp3(mp3Path);

    setProgress(100, "Done");
    const j = jobs.get(jobId);
    jobs.set(jobId, { ...j, status: "done", resultText: text });
  } catch (e) {
    const j = jobs.get(jobId);
    jobs.set(jobId, {
      ...j,
      status: "error",
      error: String(e?.message || e),
      progress: { pct: 0, message: "Error" }
    });
  } finally {
    try { if (mp3Path && fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path); } catch {}
  }
}

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
