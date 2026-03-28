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
// Supported xfade transitions
// ─────────────────────────────────────────────
const VALID_TRANSITIONS = new Set([
  "fade", "fadeblack", "fadewhite",
  "slide_left", "slide_right", "slide_up", "slide_down",
  "zoom_in", "zoom_out",
  "wipe_left", "wipe_right",
  "diamond", "heart", "cone", "pixelize", "radial",
  "hlslice", "hrslice", "vuslice", "vdslice",
  "none",
]);

// Map Flutter names → FFmpeg xfade names
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
  zoom_out:    "fadegrays",   // closest available for zoom_out
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
    exec(cmd, { maxBuffer: 1024 * 1024 * 100, timeout: 300_000 }, (err, stdout, stderr) => {
      if (err) {
        console.error("❌ FFmpeg ERROR:\n", stderr?.slice(-3000));
        reject(new Error(stderr?.slice(-2000) || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function downloadFile(url, dest) {
  console.log("⬇️  Downloading:", url.slice(0, 80));
  const writer = fs.createWriteStream(dest);
  const response = await axios({ url, method: "GET", responseType: "stream", timeout: 120_000 });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on("finish", () => { console.log("✅ Downloaded:", path.basename(dest)); resolve(); });
    writer.on("error", reject);
  });
}

// Check if file has audio stream
function hasAudio(filePath) {
  return new Promise((resolve) => {
    exec(
      `ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${filePath}"`,
      (err, stdout) => resolve(!err && stdout.trim().length > 0)
    );
  });
}

// Get video duration in seconds
function getDuration(filePath) {
  return new Promise((resolve) => {
    exec(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
      (err, stdout) => resolve(parseFloat(stdout.trim()) || 5)
    );
  });
}

// Add silent audio to video that has no audio stream
async function ensureAudio(input, output) {
  const has = await hasAudio(input);
  if (has) {
    fs.copyFileSync(input, output);
  } else {
    console.log(`🔇 Adding silence to: ${path.basename(input)}`);
    await execPromise(
      `ffmpeg -y -i "${input}" -f lavfi -i anullsrc=r=44100:cl=stereo ` +
      `-c:v copy -c:a aac -shortest "${output}"`
    );
  }
}

// Normalize all clips to same resolution, fps, codec
async function normalizeClip(input, output) {
  await execPromise(
    `ffmpeg -y -i "${input}" ` +
    `-vf "scale=720:1280:force_original_aspect_ratio=decrease,` +
    `pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,` +
    `format=yuv420p" ` +
    `-c:v libx264 -preset fast -crf 23 ` +
    `-c:a aac -ar 44100 -ac 2 ` +
    `-movflags +faststart ` +
    `"${output}"`
  );
}

// ─────────────────────────────────────────────
// Build xfade filter for N clips with transitions
// ─────────────────────────────────────────────
async function buildXfadeFilter(normFiles, transitions, transitionDuration, tmp) {
  const n = normFiles.length;
  const td = Math.max(0.1, Math.min(2.0, transitionDuration || 0.5));

  // Get durations
  const durations = [];
  for (const f of normFiles) {
    durations.push(await getDuration(f));
  }

  // Check if ALL transitions are "none" → use simple concat demuxer (faster)
  const allNone = transitions.every(t => !t || t === "none");
  if (allNone || n === 1) {
    console.log("📎 Using simple concat (no transitions)");

    const concatFile = path.join(tmp, "concat.txt");
    fs.writeFileSync(concatFile, normFiles.map(f => `file '${f}'`).join("\n"));

    const concatOut = path.join(tmp, "concat_out.mp4");
    await execPromise(
      `ffmpeg -y -f concat -safe 0 -i "${concatFile}" ` +
      `-c:v libx264 -preset fast -crf 22 -c:a aac "${concatOut}"`
    );
    return concatOut;
  }

  // Build xfade filter_complex for clips with transitions
  // Input args: -i clip0 -i clip1 -i clip2 ...
  const inputArgs = normFiles.map(f => `-i "${f}"`).join(" ");

  // filter_complex builds a chain:
  // [0:v][1:v]xfade=...[v01]; [v01][2:v]xfade=...[v012]; ...
  // [0:a][1:a]acrossfade=...[a01]; [a01][2:a]acrossfade=...[a012]; ...
  let vChain = "[0:v]";
  let aChain = "[0:a]";
  let filterParts = [];

  let cumulativeOffset = 0; // running video offset in seconds

  for (let i = 0; i < n - 1; i++) {
    const trans = transitions[i];
    const ffTrans = TRANSITION_MAP[trans] || "fade";
    const vIn  = i === 0 ? "[0:v]" : `[v${i}]`;
    const aIn  = i === 0 ? "[0:a]" : `[a${i}]`;
    const vNext = `[${i + 1}:v]`;
    const aNext = `[${i + 1}:a]`;
    const vOut  = `[v${i + 1}]`;
    const aOut  = `[a${i + 1}]`;

    // Offset = sum of all previous durations minus transition overlap
    cumulativeOffset += durations[i] - td;

    if (trans === "none") {
      // No xfade — just concat these two with no transition
      filterParts.push(`${vIn}${vNext}concat=n=2:v=1:a=0${vOut}`);
      filterParts.push(`${aIn}${aNext}concat=n=2:v=0:a=1${aOut}`);
    } else {
      // xfade transition
      filterParts.push(
        `${vIn}${vNext}xfade=transition=${ffTrans}:duration=${td}:offset=${cumulativeOffset.toFixed(3)}${vOut}`
      );
      // acrossfade for audio
      filterParts.push(
        `${aIn}${aNext}acrossfade=d=${td}${aOut}`
      );
    }
  }

  const lastV = `[v${n - 1}]`;
  const lastA = `[a${n - 1}]`;
  const filterComplex = filterParts.join(";");

  const xfadeOut = path.join(tmp, "xfade_out.mp4");
  await execPromise(
    `ffmpeg -y ${inputArgs} ` +
    `-filter_complex "${filterComplex}" ` +
    `-map "${lastV}" -map "${lastA}" ` +
    `-c:v libx264 -preset fast -crf 22 ` +
    `-c:a aac -ar 44100 -ac 2 ` +
    `"${xfadeOut}"`
  );

  return xfadeOut;
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
      voiceVolume       = 1.0,
      musicVolume       = 0.15,
      transitions       = [],
      transitionDuration = 0.5,
    } = req.body;

    // Validate
    if (!Array.isArray(videos) || videos.length < 3) {
      return res.status(400).json({ error: "Need at least 3 video URLs" });
    }
    if (videos.length > 6) {
      return res.status(400).json({ error: "Max 6 videos" });
    }

    fs.mkdirSync(tmp, { recursive: true });
    console.log(`\n🎬 Job started in ${tmp}`);

    // ── 1. Download videos ───────────────────────────────────────────────────
    console.log("\n📥 Downloading videos...");
    for (let i = 0; i < videos.length; i++) {
      await downloadFile(videos[i], path.join(tmp, `raw_${i}.mp4`));
    }

    // ── 2. Ensure audio on every clip ────────────────────────────────────────
    console.log("\n🎵 Ensuring audio streams...");
    for (let i = 0; i < videos.length; i++) {
      await ensureAudio(
        path.join(tmp, `raw_${i}.mp4`),
        path.join(tmp, `audio_${i}.mp4`)
      );
    }

    // ── 3. Normalize all clips to same spec ──────────────────────────────────
    console.log("\n📐 Normalizing clips to 720x1280 @ 30fps...");
    for (let i = 0; i < videos.length; i++) {
      await normalizeClip(
        path.join(tmp, `audio_${i}.mp4`),
        path.join(tmp, `norm_${i}.mp4`)
      );
    }

    const normFiles = videos.map((_, i) => path.join(tmp, `norm_${i}.mp4`));

    // Pad transitions array to correct length
    const transArr = videos.map((_, i) => transitions[i] || "fade");

    // ── 4. Concat with xfade transitions ─────────────────────────────────────
    console.log("\n✂️  Applying transitions...");
    const mergedPath = await buildXfadeFilter(
      normFiles, transArr, transitionDuration, tmp
    );

    let currentPath = mergedPath;

    // ── 5. Mix voiceover ─────────────────────────────────────────────────────
    if (voice) {
      console.log("\n🎤 Mixing voiceover...");
      await downloadFile(voice, path.join(tmp, "voice.mp3"));

      const voicedPath = path.join(tmp, "voiced.mp4");
      const vVol = Math.min(Math.max(parseFloat(voiceVolume) || 1.0, 0), 2);

      await execPromise(
        `ffmpeg -y -i "${currentPath}" -i "${path.join(tmp, "voice.mp3")}" ` +
        `-filter_complex ` +
        `"[0:a]volume=0.2[orig];` +
        `[1:a]volume=${vVol}[voice];` +
        `[orig][voice]amix=inputs=2:duration=first:dropout_transition=2[aout]" ` +
        `-map 0:v -map "[aout]" ` +
        `-c:v copy -c:a aac -b:a 192k -shortest ` +
        `"${voicedPath}"`
      );
      currentPath = voicedPath;
    }

    // ── 6. Mix background music ───────────────────────────────────────────────
    if (music) {
      console.log("\n🎵 Mixing background music...");
      await downloadFile(music, path.join(tmp, "music.mp3"));

      const finalPath = path.join(tmp, "final.mp4");
      const mVol = Math.min(Math.max(parseFloat(musicVolume) || 0.15, 0), 1);

      await execPromise(
        `ffmpeg -y -i "${currentPath}" -i "${path.join(tmp, "music.mp3")}" ` +
        `-filter_complex ` +
        `"[1:a]volume=${mVol}[music];` +
        `[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]" ` +
        `-map 0:v -map "[aout]" ` +
        `-c:v copy -c:a aac -b:a 192k -shortest ` +
        `"${finalPath}"`
      );
      currentPath = finalPath;
    }

    // ── 7. Send file ──────────────────────────────────────────────────────────
    const outputPath = currentPath;
    const stat = fs.statSync(outputPath);

    console.log(`\n✅ Done! Sending ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="stitched.mp4"');
    res.setHeader("Content-Length", stat.size);

    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);

    readStream.on("end", () => {
      // Cleanup after send
      setTimeout(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log("🧹 Temp files cleaned");
      }, 5000);
    });

    readStream.on("error", (err) => {
      console.error("Stream error:", err);
      res.end();
    });

  } catch (e) {
    console.error("\n❌ ERROR:", e.message);
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
  console.log(`   Transitions supported: ${[...VALID_TRANSITIONS].join(", ")}`);
});