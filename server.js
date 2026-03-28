import express from "express";
import fs from "fs";
import path from "path";
import axios from "axios";
import { exec } from "child_process";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("Boogatu Stitch Server 🚀"));

// ─────────────────────────────────────────────
// Flutter name → FFmpeg xfade name
// ─────────────────────────────────────────────
const TRANSITION_MAP = {
  none:        null,
  fade:        "fade",
  fadeblack:   "fadeblack",
  fadewhite:   "fadewhite",
  slide_left:  "slideleft",
  slide_right: "slideright",
  slide_up:    "slideup",
  slide_down:  "slidedown",
  zoom_in:     "zoomin",
  zoom_out:    "fadefast",
  wipe_left:   "wipeleft",
  wipe_right:  "wiperight",
  diamond:     "diagtl",
  heart:       "hlwind",
  cone:        "coverleft",
  pixelize:    "pixelize",
  radial:      "radial",
  hlslice:     "hlslice",
  hrslice:     "hrslice",
  vuslice:     "vuslice",
  vdslice:     "vdslice",
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 100, timeout: 600_000 }, (err, stdout, stderr) => {
      if (err) {
        console.error("❌ FFmpeg ERROR:\n", (stderr || "").slice(-2000));
        reject(new Error((stderr || err.message).slice(-1500)));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function downloadFile(url, dest) {
  console.log("⬇️  Downloading:", url.slice(0, 80) + "...");
  const writer = fs.createWriteStream(dest);
  const response = await axios({
    url, method: "GET", responseType: "stream", timeout: 120_000
  });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on("finish", () => { console.log("✅ Done:", path.basename(dest)); resolve(); });
    writer.on("error", reject);
  });
}

// Check if file has an audio stream
function hasAudio(filePath) {
  return new Promise((resolve) => {
    exec(
      `ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${filePath}"`,
      (err, stdout) => resolve(!err && stdout.trim().length > 0)
    );
  });
}

// Get duration in seconds
function getDuration(filePath) {
  return new Promise((resolve) => {
    exec(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
      (err, stdout) => resolve(Math.max(1, parseFloat(stdout.trim()) || 5))
    );
  });
}

// Add silent audio if missing
async function ensureAudio(input, output) {
  if (await hasAudio(input)) {
    fs.copyFileSync(input, output);
    console.log(`✅ Audio OK: ${path.basename(input)}`);
  } else {
    console.log(`🔇 Adding silence to: ${path.basename(input)}`);
    await execPromise(
      `ffmpeg -y -i "${input}" -f lavfi -i anullsrc=r=44100:cl=stereo ` +
      `-c:v copy -c:a aac -shortest "${output}"`
    );
  }
}

// ─────────────────────────────────────────────
// Normalize clip:
//  - Scale to 540x960 (lower than 720p → saves ~40% RAM)
//  - Force yuv420p (NOT 444p — this was the RAM killer)
//  - 25fps, fast preset, threads=2 (cap CPU on Railway)
// ─────────────────────────────────────────────
async function normalizeClip(input, output) {
  console.log(`📐 Normalizing: ${path.basename(input)}`);
  await execPromise(
    `ffmpeg -y -i "${input}" ` +
    `-vf "scale=540:960:force_original_aspect_ratio=decrease,` +
    `pad=540:960:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `fps=25,` +
    `format=yuv420p" ` +
    `-c:v libx264 -preset ultrafast -crf 26 -threads 2 ` +
    `-c:a aac -ar 44100 -ac 2 -b:a 128k ` +
    `"${output}"`
  );
}

// ─────────────────────────────────────────────
// Apply ONE xfade transition between two clips.
// Processes pairs one-at-a-time → constant low RAM.
// ─────────────────────────────────────────────
async function applyTransition(clipA, clipB, output, transition, duration) {
  const td = Math.max(0.1, Math.min(1.5, duration || 0.5));
  const ffTrans = TRANSITION_MAP[transition] || "fade";

  // For "none" → use simple concat demuxer (no re-encode, fastest)
  if (!ffTrans) {
    const listFile = output + "_list.txt";
    fs.writeFileSync(listFile, `file '${clipA}'\nfile '${clipB}'\n`);
    await execPromise(
      `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${output}"`
    );
    fs.unlinkSync(listFile);
    return;
  }

  const dur = await getDuration(clipA);
  const offset = Math.max(0.1, dur - td);

  // xfade for video + acrossfade for audio, one pair at a time
  await execPromise(
    `ffmpeg -y -i "${clipA}" -i "${clipB}" ` +
    `-filter_complex ` +
    `"[0:v][1:v]xfade=transition=${ffTrans}:duration=${td}:offset=${offset.toFixed(3)}[vout];` +
    `[0:a][1:a]acrossfade=d=${td}[aout]" ` +
    `-map "[vout]" -map "[aout]" ` +
    `-c:v libx264 -preset ultrafast -crf 26 -threads 2 ` +
    `-pix_fmt yuv420p ` +
    `-c:a aac -ar 44100 -ac 2 -b:a 128k ` +
    `"${output}"`
  );
}

// ─────────────────────────────────────────────
// Stitch N clips sequentially (pair-by-pair)
// Memory stays constant regardless of clip count
// ─────────────────────────────────────────────
async function stitchAllClips(normFiles, transitions, transitionDuration, tmp) {
  if (normFiles.length === 1) return normFiles[0];

  let currentFile = normFiles[0];

  for (let i = 0; i < normFiles.length - 1; i++) {
    const nextFile  = normFiles[i + 1];
    const trans     = transitions[i] || "fade";
    const outputFile = path.join(tmp, `stitched_${i + 1}.mp4`);

    console.log(`✂️  Clip ${i + 1} → ${i + 2}: transition="${trans}"`);
    await applyTransition(currentFile, nextFile, outputFile, trans, transitionDuration);

    // Delete the intermediate file from the previous step to free disk space
    if (i > 0 && currentFile !== normFiles[0]) {
      try { fs.unlinkSync(currentFile); } catch {}
    }

    currentFile = outputFile;
  }

  return currentFile;
}

// ─────────────────────────────────────────────
// STITCH endpoint
// ─────────────────────────────────────────────
app.post("/stitch", async (req, res) => {
  const tmp = path.join("/tmp", `stitch_${Date.now()}`);

  try {
    const {
      videos,
      voice,
      music,
      voiceVolume        = 1.0,
      musicVolume        = 0.15,
      transitions        = [],
      transitionDuration = 0.5,
    } = req.body;

    // ── Validate ──────────────────────────────────────────────────────────────
    if (!Array.isArray(videos) || videos.length < 3) {
      return res.status(400).json({ error: "Need at least 3 video URLs" });
    }
    if (videos.length > 6) {
      return res.status(400).json({ error: "Max 6 videos" });
    }

    fs.mkdirSync(tmp, { recursive: true });
    console.log(`\n🎬 New job — ${videos.length} clips — tmp: ${tmp}`);

    // ── 1. Download videos ───────────────────────────────────────────────────
    console.log("\n📥 Step 1: Downloading videos...");
    for (let i = 0; i < videos.length; i++) {
      await downloadFile(videos[i], path.join(tmp, `raw_${i}.mp4`));
    }

    // ── 2. Ensure every clip has audio ────────────────────────────────────────
    console.log("\n🎵 Step 2: Checking audio streams...");
    for (let i = 0; i < videos.length; i++) {
      await ensureAudio(
        path.join(tmp, `raw_${i}.mp4`),
        path.join(tmp, `withAudio_${i}.mp4`)
      );
    }

    // ── 3. Normalize all clips ────────────────────────────────────────────────
    console.log("\n📐 Step 3: Normalizing clips (540x960, yuv420p, 25fps)...");
    for (let i = 0; i < videos.length; i++) {
      await normalizeClip(
        path.join(tmp, `withAudio_${i}.mp4`),
        path.join(tmp, `norm_${i}.mp4`)
      );
      // Free raw files immediately
      try {
        fs.unlinkSync(path.join(tmp, `raw_${i}.mp4`));
        fs.unlinkSync(path.join(tmp, `withAudio_${i}.mp4`));
      } catch {}
    }

    const normFiles   = videos.map((_, i) => path.join(tmp, `norm_${i}.mp4`));
    const transArr    = videos.map((_, i) => transitions[i] || "fade");

    // ── 4. Stitch with transitions (pair by pair) ─────────────────────────────
    console.log("\n✂️  Step 4: Stitching with transitions...");
    let currentPath = await stitchAllClips(normFiles, transArr, transitionDuration, tmp);

    // ── 5. Mix voiceover ──────────────────────────────────────────────────────
    if (voice) {
      console.log("\n🎤 Step 5: Mixing voiceover...");
      const voiceFile = path.join(tmp, "voice.mp3");
      await downloadFile(voice, voiceFile);

      const vVol      = Math.min(Math.max(parseFloat(voiceVolume) || 1.0, 0), 2);
      const voicedOut = path.join(tmp, "voiced.mp4");

      await execPromise(
        `ffmpeg -y -i "${currentPath}" -i "${voiceFile}" ` +
        `-filter_complex ` +
        `"[0:a]volume=0.2[orig];` +
        `[1:a]volume=${vVol}[voice];` +
        `[orig][voice]amix=inputs=2:duration=first:dropout_transition=2[aout]" ` +
        `-map 0:v -map "[aout]" ` +
        `-c:v copy -c:a aac -b:a 128k -shortest ` +
        `"${voicedOut}"`
      );

      try { fs.unlinkSync(currentPath); } catch {}
      currentPath = voicedOut;
    }

    // ── 6. Mix background music ───────────────────────────────────────────────
    if (music) {
      console.log("\n🎵 Step 6: Mixing background music...");
      const musicFile = path.join(tmp, "music.mp3");
      await downloadFile(music, musicFile);

      const mVol     = Math.min(Math.max(parseFloat(musicVolume) || 0.15, 0), 1);
      const finalOut = path.join(tmp, "final.mp4");

      await execPromise(
        `ffmpeg -y -i "${currentPath}" -i "${musicFile}" ` +
        `-filter_complex ` +
        `"[1:a]volume=${mVol}[music];` +
        `[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]" ` +
        `-map 0:v -map "[aout]" ` +
        `-c:v copy -c:a aac -b:a 128k -shortest ` +
        `"${finalOut}"`
      );

      try { fs.unlinkSync(currentPath); } catch {}
      currentPath = finalOut;
    }

    // ── 7. Stream result to client ────────────────────────────────────────────
    const stat = fs.statSync(currentPath);
    console.log(`\n✅ Sending ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

    res.setHeader("Content-Type",        "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="stitched.mp4"');
    res.setHeader("Content-Length",      stat.size);

    const stream = fs.createReadStream(currentPath);
    stream.pipe(res);

    stream.on("end", () => {
      setTimeout(() => {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
        console.log("🧹 Temp cleaned");
      }, 5000);
    });

    stream.on("error", (err) => {
      console.error("Stream error:", err.message);
      res.end();
    });

  } catch (e) {
    console.error("\n❌ STITCH FAILED:", e.message);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    if (!res.headersSent) {
      res.status(500).json({ error: e.message || e.toString() });
    }
  }
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Boogatu Stitch Server on port ${PORT}`);
});