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

// Get video dimensions (width x height)
function getResolution(filePath) {
  return new Promise((resolve) => {
    exec(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${filePath}"`,
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve({ width: 540, height: 960 }); // default 9:16
        } else {
          const parts = stdout.trim().split(",");
          const width = parseInt(parts[0]) || 540;
          const height = parseInt(parts[1]) || 960;
          resolve({ width, height });
        }
      }
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
// Detect dominant aspect ratio from all clips
// Returns target width/height that matches input
// ─────────────────────────────────────────────
async function detectTargetResolution(files) {
  let totalWidth = 0;
  let totalHeight = 0;

  for (const file of files) {
    const res = await getResolution(file);
    totalWidth += res.width;
    totalHeight += res.height;
  }

  const avgWidth = totalWidth / files.length;
  const avgHeight = totalHeight / files.length;
  const ratio = avgWidth / avgHeight;

  // Determine aspect ratio bucket
  if (ratio > 1.3) {
    // Landscape (16:9)
    return { width: 960, height: 540, label: "16:9 landscape" };
  } else if (ratio > 0.9) {
    // Square-ish (1:1)
    return { width: 720, height: 720, label: "1:1 square" };
  } else {
    // Portrait (9:16)
    return { width: 540, height: 960, label: "9:16 portrait" };
  }
}

// ─────────────────────────────────────────────
// Normalize clip to match target resolution
// Uses scale+pad to fit without cropping
// ─────────────────────────────────────────────
async function normalizeClip(input, output, targetWidth, targetHeight) {
  console.log(`📐 Normalizing: ${path.basename(input)} → ${targetWidth}x${targetHeight}`);
  await execPromise(
    `ffmpeg -y -i "${input}" ` +
    `-vf "scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,` +
    `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `fps=25,` +
    `format=yuv420p" ` +
    `-c:v libx264 -preset ultrafast -crf 26 -threads 2 ` +
    `-c:a aac -ar 44100 -ac 2 -b:a 128k ` +
    `"${output}"`
  );
}

// ─────────────────────────────────────────────
// Apply ONE xfade transition between two clips.
// Fixed: uses actual clip duration for proper offset
// ─────────────────────────────────────────────
async function applyTransition(clipA, clipB, output, transition, duration) {
  const durA = await getDuration(clipA);
  const durB = await getDuration(clipB);
  const maxTd = Math.min(durA, durB) * 0.3;
  const td = Math.max(0.2, Math.min(maxTd, duration || 0.5));
  const ffTrans = TRANSITION_MAP[transition] || "fade";

  if (!ffTrans) {
    const listFile = output + "_list.txt";
    fs.writeFileSync(listFile, `file '${clipA}'\nfile '${clipB}'\n`);
    await execPromise(
      `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${output}"`
    );
    fs.unlinkSync(listFile);
    return;
  }

  const offset = Math.max(0.5, durA - td);

  console.log(`  🔄 Transition "${ffTrans}" | clipA: ${durA.toFixed(2)}s | clipB: ${durB.toFixed(2)}s | td: ${td.toFixed(2)}s | offset: ${offset.toFixed(2)}s`);

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

    // ── Validate (minimum 1 video now) ────────────────────────────────────
    if (!Array.isArray(videos) || videos.length < 1) {
      return res.status(400).json({ error: "Need at least 1 video URL" });
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

    // ── 2. Detect target resolution from input videos ─────────────────────
    console.log("\n📏 Step 2: Detecting aspect ratio...");
    const rawFiles = videos.map((_, i) => path.join(tmp, `raw_${i}.mp4`));
    const target = await detectTargetResolution(rawFiles);
    console.log(`   Target: ${target.width}x${target.height} (${target.label})`);

    // ── 3. Ensure every clip has audio ────────────────────────────────────
    console.log("\n🎵 Step 3: Checking audio streams...");
    for (let i = 0; i < videos.length; i++) {
      await ensureAudio(
        path.join(tmp, `raw_${i}.mp4`),
        path.join(tmp, `withAudio_${i}.mp4`)
      );
    }

    // ── 4. Normalize all clips to detected resolution ─────────────────────
    console.log(`\n📐 Step 4: Normalizing clips (${target.width}x${target.height}, yuv420p, 25fps)...`);
    for (let i = 0; i < videos.length; i++) {
      await normalizeClip(
        path.join(tmp, `withAudio_${i}.mp4`),
        path.join(tmp, `norm_${i}.mp4`),
        target.width,
        target.height
      );
      // Free raw files immediately
      try {
        fs.unlinkSync(path.join(tmp, `raw_${i}.mp4`));
        fs.unlinkSync(path.join(tmp, `withAudio_${i}.mp4`));
      } catch {}
    }

    const normFiles = videos.map((_, i) => path.join(tmp, `norm_${i}.mp4`));
    const transArr  = videos.map((_, i) => transitions[i] || "fade");

    // ── 5. Stitch with transitions (pair by pair) ─────────────────────────
    let currentPath;
    if (normFiles.length === 1) {
      // Single video — no stitching needed
      console.log("\n📎 Step 5: Single video — skipping stitch...");
      currentPath = normFiles[0];
    } else {
      console.log("\n✂️  Step 5: Stitching with transitions...");
      currentPath = await stitchAllClips(normFiles, transArr, transitionDuration, tmp);
    }
	
	// ── 5b. Add fade-to-black at the end ──────────────────────────────────
	const lastTransition = transArr[transArr.length - 1] || "fadeblack";
	if (lastTransition === "fadeblack" || lastTransition === "fade") {
	  console.log("\n🎬 Step 5b: Adding fade-to-black ending...");
	  const finalDur = await getDuration(currentPath);
	  const fadeOutStart = Math.max(0, finalDur - 1.5); // 1.5s fade at end
	  const fadedOut = path.join(tmp, "faded_end.mp4");

	  await execPromise(
		`ffmpeg -y -i "${currentPath}" ` +
		`-vf "fade=t=out:st=${fadeOutStart.toFixed(3)}:d=1.5:color=black" ` +
		`-af "afade=t=out:st=${fadeOutStart.toFixed(3)}:d=1.5" ` +
		`-c:v libx264 -preset ultrafast -crf 26 -threads 2 ` +
		`-pix_fmt yuv420p ` +
		`-c:a aac -ar 44100 -ac 2 -b:a 128k ` +
		`"${fadedOut}"`
	  );

	  try { fs.unlinkSync(currentPath); } catch {}
	  currentPath = fadedOut;
	}

    // ── 6. Mix voiceover (auto-trim to fit video) ─────────────────────────
    if (voice) {
	  console.log("\n🎤 Step 6: Mixing voiceover (auto-trimmed)...");
	  
	  const voiceExt = voice.toLowerCase().includes(".m4a") ? "m4a" : "mp3";
	  const voiceRaw = path.join(tmp, `voice_raw.${voiceExt}`);
	  await downloadFile(voice, voiceRaw);

	  // Get video duration
	  const videoDur = await getDuration(currentPath);
	  const voiceDur = await getDuration(voiceRaw);
	  
	  console.log(`   Video: ${videoDur.toFixed(2)}s | Voice: ${voiceDur.toFixed(2)}s`);

	  // Trim/pad voice to match video duration
	  const voiceTrimmed = path.join(tmp, "voice_trimmed.aac");
	  
	  if (voiceDur > videoDur) {
		// Voice is LONGER than video → trim + fade out
		const fadeStart = Math.max(0, videoDur - 1.0); // 1s fade at end
		console.log(`   Trimming voice from ${voiceDur.toFixed(1)}s → ${videoDur.toFixed(1)}s`);
		await execPromise(
		  `ffmpeg -y -i "${voiceRaw}" ` +
		  `-t ${videoDur.toFixed(3)} ` +
		  `-af "afade=t=out:st=${fadeStart.toFixed(3)}:d=1.0" ` +
		  `-c:a aac -ar 44100 -ac 2 -b:a 128k ` +
		  `"${voiceTrimmed}"`
		);
	  } else if (voiceDur < videoDur - 0.5) {
		// Voice is SHORTER than video → pad with silence at end
		const padDur = videoDur - voiceDur;
		console.log(`   Padding voice with ${padDur.toFixed(1)}s silence`);
		await execPromise(
		  `ffmpeg -y -i "${voiceRaw}" ` +
		  `-af "apad=pad_dur=${padDur.toFixed(3)}" ` +
		  `-t ${videoDur.toFixed(3)} ` +
		  `-c:a aac -ar 44100 -ac 2 -b:a 128k ` +
		  `"${voiceTrimmed}"`
		);
	  } else {
		// Duration matches closely → just convert format
		await execPromise(
		  `ffmpeg -y -i "${voiceRaw}" ` +
		  `-c:a aac -ar 44100 -ac 2 -b:a 128k ` +
		  `"${voiceTrimmed}"`
		);
	  }

	  const vVol = Math.min(Math.max(parseFloat(voiceVolume) || 1.0, 0), 2);
	  const voicedOut = path.join(tmp, "voiced.mp4");

	  await execPromise(
		`ffmpeg -y -i "${currentPath}" -i "${voiceTrimmed}" ` +
		`-filter_complex ` +
		`"[0:a]volume=0.2[orig];` +
		`[1:a]volume=${vVol}[voice];` +
		`[orig][voice]amix=inputs=2:duration=first:dropout_transition=2[aout]" ` +
		`-map 0:v -map "[aout]" ` +
		`-c:v copy -c:a aac -b:a 128k -shortest ` +
		`"${voicedOut}"`
	  );

	  try { fs.unlinkSync(currentPath); } catch {}
	  try { fs.unlinkSync(voiceRaw); } catch {}
	  try { fs.unlinkSync(voiceTrimmed); } catch {}
	  currentPath = voicedOut;
	}

    // ── 7. Mix background music (auto-trim + loop) ───────────────────────
	if (music) {
	  console.log("\n🎵 Step 7: Mixing background music (auto-trimmed)...");
	  
	  const musicExt = music.toLowerCase().includes(".m4a") ? "m4a" : "mp3";
	  const musicRaw = path.join(tmp, `music_raw.${musicExt}`);
	  await downloadFile(music, musicRaw);

	  const videoDur = await getDuration(currentPath);
	  const musicDur = await getDuration(musicRaw);
	  
	  console.log(`   Video: ${videoDur.toFixed(2)}s | Music: ${musicDur.toFixed(2)}s`);

	  const musicTrimmed = path.join(tmp, "music_trimmed.aac");

	  if (musicDur > videoDur) {
		// Music longer → trim + fade out
		const fadeStart = Math.max(0, videoDur - 2.0); // 2s fade for music
		console.log(`   Trimming music from ${musicDur.toFixed(1)}s → ${videoDur.toFixed(1)}s`);
		await execPromise(
		  `ffmpeg -y -i "${musicRaw}" ` +
		  `-t ${videoDur.toFixed(3)} ` +
		  `-af "afade=t=in:st=0:d=1.0,afade=t=out:st=${fadeStart.toFixed(3)}:d=2.0" ` +
		  `-c:a aac -ar 44100 -ac 2 -b:a 128k ` +
		  `"${musicTrimmed}"`
		);
	  } else if (musicDur < videoDur - 1.0) {
		// Music shorter → loop to fill video duration + fade out
		const loopCount = Math.ceil(videoDur / musicDur);
		const fadeStart = Math.max(0, videoDur - 2.0);
		console.log(`   Looping music ${loopCount}x to fill ${videoDur.toFixed(1)}s`);
		await execPromise(
		  `ffmpeg -y -stream_loop ${loopCount - 1} -i "${musicRaw}" ` +
		  `-t ${videoDur.toFixed(3)} ` +
		  `-af "afade=t=in:st=0:d=1.0,afade=t=out:st=${fadeStart.toFixed(3)}:d=2.0" ` +
		  `-c:a aac -ar 44100 -ac 2 -b:a 128k ` +
		  `"${musicTrimmed}"`
		);
	  } else {
		await execPromise(
		  `ffmpeg -y -i "${musicRaw}" ` +
		  `-af "afade=t=in:st=0:d=1.0" ` +
		  `-c:a aac -ar 44100 -ac 2 -b:a 128k ` +
		  `"${musicTrimmed}"`
		);
	  }

	  const mVol = Math.min(Math.max(parseFloat(musicVolume) || 0.15, 0), 1);
	  const finalOut = path.join(tmp, "final.mp4");

	  await execPromise(
		`ffmpeg -y -i "${currentPath}" -i "${musicTrimmed}" ` +
		`-filter_complex ` +
		`"[1:a]volume=${mVol}[music];` +
		`[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]" ` +
		`-map 0:v -map "[aout]" ` +
		`-c:v copy -c:a aac -b:a 128k -shortest ` +
		`"${finalOut}"`
	  );

	  try { fs.unlinkSync(currentPath); } catch {}
	  try { fs.unlinkSync(musicRaw); } catch {}
	  try { fs.unlinkSync(musicTrimmed); } catch {}
	  currentPath = finalOut;
	}

    // ── 8. Stream result to client ────────────────────────────────────────
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
