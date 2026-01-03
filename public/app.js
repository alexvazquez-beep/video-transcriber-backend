// ===== TranscriberPro UI logic (two-phase progress: Upload 0→100, reset, Transcribe 0→100) =====

const fileInput = document.getElementById("file");
const uploadBtn = document.getElementById("uploadBtn");
const transcribeBtn = document.getElementById("transcribeBtn");
const statusText = document.getElementById("statusText");
const pct = document.getElementById("pct");
const fill = document.getElementById("fill");
const out = document.getElementById("out");
const dropzone = document.getElementById("dropzone");

const copyBtn = document.getElementById("copyBtn");
const downloadBtn = document.getElementById("downloadBtn");
const clearBtn = document.getElementById("clearBtn");

let uploadId = null;

// ---------- UI helpers ----------
function setProgress(p) {
  const v = Math.max(0, Math.min(100, Number(p) || 0));
  pct.textContent = v + "%";
  fill.style.width = v + "%";
}

function setStatus(msg, isErr = false) {
  statusText.textContent = msg;
  statusText.className = isErr ? "err" : "";
}

function resetProgress() {
  setProgress(0);
}

// ---------- API helpers ----------
async function apiUpload(file) {
  const form = new FormData();
  form.append("file", file);

  const r = await fetch("/api/upload", { method: "POST", body: form });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error || "Upload failed");
  return d;
}

async function apiStartJob(uploadId) {
  const r = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadId }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error || "Failed to start job");
  return d.jobId;
}

async function pollJob(jobId) {
  // Ensure transcription phase starts from 0
  resetProgress();

  while (true) {
    await new Promise((r) => setTimeout(r, 1200));

    const r = await fetch(`/api/jobs/${jobId}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error || "Job status failed");

    const msg = j?.progress?.message || "Processing…";
    const p = typeof j?.progress?.pct === "number" ? j.progress.pct : 10;

    setStatus(msg);
    setProgress(p);

    if (j.status === "done") {
      out.value = j.resultText || "";
      setStatus("Done.");
      setProgress(100);
      return;
    }

    if (j.status === "error") {
      throw new Error(j.error || "Transcription failed.");
    }
  }
}

// ---------- One button flow: click upload -> choose file -> auto upload ----------
uploadBtn.addEventListener("click", () => fileInput.click());

// Two-phase Upload progress: 0→100 then reset to 0 and show "Ready to transcribe"
fileInput.addEventListener("change", async () => {
  const f = fileInput.files?.[0];
  if (!f) return;

  uploadBtn.disabled = true;
  transcribeBtn.disabled = true;
  out.value = "";
  uploadId = null;

  resetProgress();
  setStatus("Uploading…");

  // Smooth fake upload progress (browser fetch doesn't expose upload progress)
  let up = 0;
  const uploadTicker = setInterval(() => {
    up = Math.min(95, up + Math.random() * 8);
    setProgress(up);
  }, 120);

  try {
    const res = await apiUpload(f);
    uploadId = res.uploadId;

    clearInterval(uploadTicker);
    setProgress(100);
    setStatus(`Upload complete: ${res.originalName || f.name}`);

    // Reset bar for transcription phase so it doesn't continue from upload
    setTimeout(() => {
      resetProgress();
      setStatus("Ready to transcribe.");
      transcribeBtn.disabled = false;
    }, 450);
  } catch (e) {
    clearInterval(uploadTicker);
    resetProgress();
    setStatus("Error: " + e.message, true);
  } finally {
    uploadBtn.disabled = false;
    // allow selecting the same file again
    fileInput.value = "";
  }
});

// ---------- Drag & drop upload (same behavior) ----------
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.style.borderColor = "#b8c0ff";
});

dropzone.addEventListener("dragleave", () => {
  dropzone.style.borderColor = "var(--border)";
});

dropzone.addEventListener("drop", async (e) => {
  e.preventDefault();
  dropzone.style.borderColor = "var(--border)";

  const f = e.dataTransfer.files?.[0];
  if (!f) return;

  uploadBtn.disabled = true;
  transcribeBtn.disabled = true;
  out.value = "";
  uploadId = null;

  resetProgress();
  setStatus("Uploading…");

  let up = 0;
  const uploadTicker = setInterval(() => {
    up = Math.min(95, up + Math.random() * 8);
    setProgress(up);
  }, 120);

  try {
    const res = await apiUpload(f);
    uploadId = res.uploadId;

    clearInterval(uploadTicker);
    setProgress(100);
    setStatus(`Upload complete: ${res.originalName || f.name}`);

    setTimeout(() => {
      resetProgress();
      setStatus("Ready to transcribe.");
      transcribeBtn.disabled = false;
    }, 450);
  } catch (e2) {
    clearInterval(uploadTicker);
    resetProgress();
    setStatus("Error: " + e2.message, true);
  } finally {
    uploadBtn.disabled = false;
  }
});

// ---------- Transcription flow: reset -> 0→100 ----------
transcribeBtn.addEventListener("click", async () => {
  if (!uploadId) return;

  transcribeBtn.disabled = true;

  resetProgress();
  setStatus("Starting transcription…");

  try {
    const jobId = await apiStartJob(uploadId);
    setStatus("Transcribing…");
    await pollJob(jobId);
  } catch (e) {
    resetProgress();
    setStatus("Error: " + e.message, true);
  } finally {
    transcribeBtn.disabled = false;
  }
});

// ---------- Tools ----------
copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(out.value || "");
    setStatus("Copied.");
    setProgress(100);
  } catch {
    setStatus("Copy failed. Copy manually.", true);
    setProgress(100);
  }
});

downloadBtn.addEventListener("click", () => {
  const text = out.value || "";
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "transcript.txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  setStatus("Downloaded.");
  setProgress(100);
});

clearBtn.addEventListener("click", () => {
  out.value = "";
  setStatus("Cleared.");
  resetProgress();
});

// Init
setStatus("Waiting for upload…");
resetProgress();
