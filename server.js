import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import OpenAI from "openai";

const app = express();

// IMPORTANT: later we can lock this down to only your LeadPages domain.
app.use(cors());
app.use(express.json());

const upload = multer({ dest: "/tmp/uploads" });

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function runFfmpegExtractAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "mp3", outputPath],
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())
    );
  });
}

app.get("/", (req, res) => {
  res.send("OK - Video Transcriber Backend is running");
});

app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  let uploadedPath;
  let audioPath;

  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded. Field name must be 'file'." });

    uploadedPath = req.file.path;
    audioPath = `${uploadedPath}.mp3`;

    // 1) Extract audio from video (or re-encode audio)
    await runFfmpegExtractAudio(uploadedPath, audioPath);

    // 2) Transcribe
    const transcription = await client.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe", // good default
      file: fs.createReadStream(audioPath),
      response_format: "text"
      // language: "es" // optional
    });

    return res.json({ text: transcription });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Transcription failed.", details: String(e?.message || e) });
  } finally {
    // Cleanup temp files
    try { if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath); } catch {}
    try { if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch {}
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on port ${port}`));
