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

/* ES modules __dirname */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* Middleware */
app.use(cors());
app.use(express.json());

/* Serve frontend */
app.use(express.static(path.join(__dirname, "public")));

/**
 * Upload limits:
 * - If you expect very large videos, you’ll want a storage-first approach (S3/R2),
 *   but this is fine for MVP.
 */
const upload = multer({
  dest: "/tmp/uploads",
  limits: {
    fileSize: 250 * 1024 * 1024 // 250MB
  }
});

/* OpenAI client: retries + longer timeout */
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 3,
  timeout: 180000 // 180 seconds
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

      // backoff
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

/* Run a command */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Extract audio from video/audio into mp3 (small bitrate)
 */
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
    "48k", // smaller than 64k to reduce upload size further
    "-c:a",
    "mp3",
    outputPath
  ]);
}

/**
 * Split mp3 into chunks (segment_time seconds)
 * Produces files like chunk_000.mp3, chunk_001.mp3, ...
 */
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
    "-c",
    "copy",
    outPattern
  ]);

  const files = fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith("chunk_") && f.endsWith(".mp3"))
    .sort(); // chunk_000, chunk_001 ...

  if (!files.length) throw new Error("Chunking produced no output files.");

  return files.map((f) => path.join(outDir, f));
}

/* Root: serve app */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/**
 * POST /api/transcribe
 * Accepts: multipart/form-data with field "file" (video or audio)
 * Returns: { text }
 */
app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  const jobId = crypto.randomBytes(8).toString("hex");
  let uploadedPath;
  let mp3Path;
  let chunksDir;

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "Server misconfigured.",
        details: "Missing OPENAI_API_KEY in Render environment variables."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "No file uploaded. Field name must be 'file'."
      });
    }

    uploadedPath = req.file.path;
    mp3Path = `${uploadedPath}_${jobId}.mp3`;
    chunksDir = path.join("/tmp", `chunks_${jobId}`);

    // 1) Extract audio (works for video uploads)
    await extractAudioToMp3(uploadedPath, mp3Path);

    // 2) Chunk it (5 minutes default)
    const chunkFiles = await splitAudioIntoChunks(mp3Path, chunksDir, 300);

    // Safety cap (prevents huge jobs on free hosting)
    const MAX_CHUNKS = 24; // 24 * 5min = 2 hours
    const usedChunks = chunkFiles.slice(0, MAX_CHUNKS);

    // 3) Transcribe each chunk and stitch
    let fullText = "";
    for (let i = 0; i < usedChunks.length; i++) {
      const chunkPath = usedChunks[i];

      const chunkText = await withRetry(async () => {
        const t = await client.audio.transcriptions.create({
          model: "gpt-4o-mini-transcribe",
          file: fs.createReadStream(chunkPath),
          response_format: "text"
        });
        return t;
      }, 3);

      // Separator between chunks (keeps text readable)
      fullText += (i === 0 ? "" : "\n\n") + chunkText;
    }

    if (chunkFiles.length > MAX_CHUNKS) {
      fullText += `\n\n[Note: Transcription truncated after ${MAX_CHUNKS * 5} minutes due to server limits.]`;
    }

    return res.json({ text: fullText });
  } catch (e) {
    console.error("TRANSCRIBE ERROR:", e);
    return res.status(500).json({
      error: "Transcription failed.",
      details: String(e?.message || e)
    });
  } finally {
    // Cleanup
    try {
      if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
    } catch {}
    try {
      if (mp3Path && fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
    } catch {}
    try {
      if (chunksDir && fs.existsSync(chunksDir)) {
        for (const f of fs.readdirSync(chunksDir)) {
          try { fs.unlinkSync(path.join(chunksDir, f)); } catch {}
        }
        try { fs.rmdirSync(chunksDir); } catch {}
      }
    } catch {}
  }
});

/* Start server */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
