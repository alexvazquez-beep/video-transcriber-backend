import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const app = express();

/* Needed for ES modules (__dirname replacement) */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* Middleware */
app.use(cors()); // later we can restrict to your domain
app.use(express.json());

/* Serve frontend */
app.use(express.static(path.join(__dirname, "public")));

/* File uploads (Render supports /tmp) */
const upload = multer({ dest: "/tmp/uploads" });

/* OpenAI client with retries + longer timeout (helps ECONNRESET) */
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 3,
  timeout: 120000 // 120 seconds
});

/* Retry wrapper for transient network errors */
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

      // simple backoff
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

/* Extract audio from uploaded video/audio into a small mp3 */
function runFfmpegExtractAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-y",
        "-i",
        inputPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "64k",
        "-c:a",
        "mp3",
        outputPath
      ],
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve();
      }
    );
  });
}

/* Root route */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* Transcription API */
app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  let uploadedPath;
  let audioPath;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded. Field name must be 'file'." });
    }

    uploadedPath = req.file.path;
    audioPath = `${uploadedPath}.mp3`;

    // 1) Extract/convert to mp3 (smaller payload helps stability)
    await runFfmpegExtractAudio(uploadedPath, audioPath);

    // 2) Transcribe with retries for transient connection drops
    const transcription = await withRetry(() =>
      client.audio.transcriptions.create({
        model: "gpt-4o-mini-transcribe",
        file: fs.createReadStream(audioPath),
        response_format: "text"
        // language: "es" // optional
      }),
      3
    );

    return res.json({ text: transcription });
  } catch (e) {
    console.error("TRANSCRIBE ERROR:", e);
    return res.status(500).json({
      error: "Transcription failed.",
      details: String(e?.message || e)
    });
  } finally {
    // cleanup temp files
    try {
      if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
    } catch {}
    try {
      if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    } catch {}
  }
});

/* Start server */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
