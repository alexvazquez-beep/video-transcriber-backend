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

/* Force IPv4 + stable keep-alive via undici */
const dispatcher = new Agent({
  connect: { family: 4 }, // ✅ IPv4 only
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 10_000
});

const customFetch = (url, options = {}) => {
  return undiciFetch(url, { ...options, dispatcher });
};

/* OpenAI client */
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  fetch: customFetch,
  maxRetries: 3,
  timeout: 180000 // 180s
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

async function extractAudioToMp3(inputPath, outputPath) {
  // Very small speech-focused mp3 to reduce upload time/risk
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
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function transcribeFile(audioPath) {
  return await withRetry(async () => {
    return await client.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: fs.createReadStream(audioPath),
      response_format: "text"
    });
  }, 3);
}

/* Routes */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/**
 * Diagnostic: checks if THIS server can reach OpenAI at all.
 * Open: https://your-domain/api/ping-openai
 */
app.get("/api/ping-openai", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "Missing OPENAI_API_KEY",
        details: "Set it in your host variables (Railway/Render)."
      });
    }

    const r = await customFetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    });
    const text = await r.text();
    res.status(r.status).send(text.slice(0, 500));
  } catch (e) {
    res.status(500).json({ error: "ping failed", details: String(e?.message || e) });
  }
});

app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  const jobId = crypto.randomBytes(6).toString("hex");
  let uploadedPath;
  let mp3Path;

  try {
    console.log(`[${jobId}] /api/transcribe start`);

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "Server misconfigured.",
        details: "Missing OPENAI_API_KEY in environment variables."
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded. Field name must be 'file'." });
    }

    uploadedPath = req.file.path;
    mp3Path = `${uploadedPath}_${jobId}.mp3`;

    console.log(`[${jobId}] uploaded size=${req.file.size} type=${req.file.mimetype}`);
    console.log(`[${jobId}] extracting audio...`);
    await extractAudioToMp3(uploadedPath, mp3Path);

    console.log(`[${jobId}] transcribing...`);
    const text = await transcribeFile(mp3Path);

    console.log(`[${jobId}] done`);
    return res.json({ text });
  } catch (e) {
    console.error(`[${jobId}] ERROR:`, e);
    return res.status(500).json({
      error: "Transcription failed.",
      details: String(e?.message || e)
    });
  } finally {
    try {
      if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
    } catch {}
    try {
      if (mp3Path && fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
    } catch {}
    console.log(`[${jobId}] cleanup complete`);
  }
});

/* Start */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
