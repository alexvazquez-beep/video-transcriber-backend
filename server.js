import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import crypto from "crypto";
import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";

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
  limits: { fileSize: 250 * 1024 * 1024 } // 250MB
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

/* Helpers */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Convert input (video or audio) -> WAV PCM (16kHz mono)
 * This is the most compatible format for transcription.
 */
async function extractAudioToWav(inputPath, outputPath) {
  await run("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    outputPath
  ]);
}

/* Optional: get duration for debugging */
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

async function withRetry(fn, tries = 2) {
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

async function transcribeFile(wavPath) {
  return await withRetry(async () => {
    // Ensure the stream is fresh each attempt (important!)
    const stream = fs.createReadStream(wavPath);
    const text = await client.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: stream,
      response_format: "text"
    });
    return text;
  }, 2);
}

/* Routes */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* Connectivity test */
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

app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  const jobId = crypto.randomBytes(6).toString("hex");
  let uploadedPath;
  let wavPath;

  try {
    console.log(`[${jobId}] transcribe start`);

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "Server misconfigured.",
        details: "Missing OPENAI_API_KEY in Railway variables."
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded. Field name must be 'file'." });
    }

    uploadedPath = req.file.path;
    wavPath = `${uploadedPath}_${jobId}.wav`;

    console.log(`[${jobId}] uploaded size=${req.file.size} type=${req.file.mimetype}`);
    console.log(`[${jobId}] ffmpeg -> wav...`);
    await extractAudioToWav(uploadedPath, wavPath);

    const dur = await getDurationSeconds(wavPath);
    const wavSize = fs.statSync(wavPath).size;
    console.log(`[${jobId}] wav duration=${dur}s size=${wavSize} bytes`);

    console.log(`[${jobId}] sending to OpenAI...`);
    const text = await transcribeFile(wavPath);

    console.log(`[${jobId}] done`);
    return res.json({ text });
  } catch (e) {
    console.error(`[${jobId}] ERROR:`, e);
    return res.status(500).json({
      error: "Transcription failed.",
      details: String(e?.message || e)
    });
  } finally {
    try { if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath); } catch {}
    try { if (wavPath && fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch {}
    console.log(`[${jobId}] cleanup complete`);
  }
});

/* Start */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
