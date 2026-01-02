import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import crypto from "crypto";
import OpenAI from "openai";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  dest: "/tmp/uploads",
  limits: { fileSize: 250 * 1024 * 1024 }
});

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 3,
  timeout: 180000
});

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout, stderr });
    });
  });
}

async function extractAudioToMp3(inputPath, outputPath) {
  // ultra light audio for speech
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
    "32k",        // smaller to reduce upload time
    "-c:a",
    "mp3",
    outputPath
  ]);
}

async function getDurationSeconds(mediaPath) {
  // Use ffprobe to get duration (fast + light)
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    mediaPath
  ]);
  const sec = Number(String(stdout).trim());
  return Number.isFinite(sec) ? sec : null;
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

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
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
        details: "Missing OPENAI_API_KEY in Render env vars."
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

    const dur = await getDurationSeconds(mp3Path);
    console.log(`[${jobId}] extracted mp3 duration=${dur}s`);

    // ✅ For short videos (like 42s), DO NOT chunk — it just adds overhead.
    if (!dur || dur <= 600) {
      console.log(`[${jobId}] transcribing single file...`);
      const text = await transcribeFile(mp3Path);
      console.log(`[${jobId}] done`);
      return res.json({ text });
    }

    // If longer than 10 minutes, we’ll chunk later (next step)
    return res.status(400).json({
      error: "Video too long for current setup.",
      details: "Please upload <= 10 minutes, or enable chunking mode."
    });

  } catch (e) {
    console.error(`[${jobId}] ERROR:`, e);
    return res.status(500).json({
      error: "Transcription failed.",
      details: String(e?.message || e)
    });
  } finally {
    try { if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath); } catch {}
    try { if (mp3Path && fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path); } catch {}
    console.log(`[${jobId}] cleanup complete`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
