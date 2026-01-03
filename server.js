import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- OpenAI ----------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, "public")));

// ---------- Upload config ----------
const uploadDir = path.join(__dirname, "uploads");
const audioDir = path.join(__dirname, "audio");

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const safe = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
    cb(null, safe);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 200 }, // 200MB
});

// ---------- In-memory jobs ----------
const jobs = new Map();

// ---------- Routes ----------

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// Upload file
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const uploadId = Date.now().toString();

  jobs.set(uploadId, {
    status: "uploaded",
    filePath: req.file.path,
    progress: { pct: 0, message: "Uploaded" },
  });

  res.json({
    uploadId,
    originalName: req.file.originalname,
  });
});

// Start transcription job
app.post("/api/jobs", async (req, res) => {
  const { uploadId } = req.body;

  const job = jobs.get(uploadId);
  if (!job) {
    return res.status(404).json({ error: "Upload not found" });
  }

  const jobId = "job-" + Date.now();
  jobs.set(jobId, {
    status: "processing",
    progress: { pct: 5, message: "Starting…" },
  });

  res.json({ jobId });

  // Run transcription async
  transcribeFile(jobId, job.filePath);
});

// Poll job
app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  res.json(job);
});

// ---------- Transcription logic ----------
async function transcribeFile(jobId, videoPath) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    job.progress = { pct: 15, message: "Extracting audio…" };

    const audioPath = path.join(
      audioDir,
      path.basename(videoPath) + ".mp3"
    );

    await new Promise((resolve, reject) => {
      exec(
        `ffmpeg -y -i "${videoPath}" -vn -acodec mp3 "${audioPath}"`,
        (err) => (err ? reject(err) : resolve())
      );
    });

    job.progress = { pct: 40, message: "Sending to OpenAI…" };

    const transcript = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "whisper-1",
    });

    job.progress = { pct: 90, message: "Finalizing…" };

    job.status = "done";
    job.resultText = transcript.text;
    job.progress = { pct: 100, message: "Done" };

    // Cleanup
    fs.unlink(videoPath, () => {});
    fs.unlink(audioPath, () => {});
  } catch (err) {
    console.error("Transcription error:", err);

    job.status = "error";
    job.error = err.message || "Transcription failed";
    job.progress = { pct: 0, message: "Error" };
  }
}

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
