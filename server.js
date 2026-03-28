import express from "express";
import fs from "fs";
import axios from "axios";
import { exec } from "child_process";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Boogatu Stitch Server 🚀");
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) {
        console.error("FFmpeg ERROR:\n", stderr);
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function downloadFile(url, path) {
  console.log("⬇️  Downloading:", url);
  const writer = fs.createWriteStream(path);
  const response = await axios({ url, method: "GET", responseType: "stream" });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on("finish", () => { console.log("✅ Downloaded:", path); resolve(); });
    writer.on("error", reject);
  });
}

// ─────────────────────────────────────────────
// Check if a video file has an audio stream
// ─────────────────────────────────────────────
function hasAudioStream(filePath) {
  return new Promise((resolve) => {
    exec(
      `ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${filePath}"`,
      (err, stdout) => {
        // If stdout contains "audio", the stream exists
        resolve(!err && stdout.trim().length > 0);
      }
    );
  });
}

// ─────────────────────────────────────────────
// Add a silent audio track to a video that has none
// ─────────────────────────────────────────────
async function ensureAudio(inputPath, outputPath) {
  const hasAudio = await hasAudioStream(inputPath);
  if (hasAudio) {
    // Already has audio — just copy it
    fs.copyFileSync(inputPath, outputPath);
    console.log(`✅ ${inputPath} already has audio`);
  } else {
    // Add a silent audio track so concat doesn't fail
    console.log(`🔇 ${inputPath} has no audio — adding silence`);
    await execPromise(
      `ffmpeg -y -i "${inputPath}" -f lavfi -i anullsrc=r=44100:cl=stereo ` +
      `-c:v copy -c:a aac -shortest "${outputPath}"`
    );
  }
}

// ─────────────────────────────────────────────
// STITCH endpoint
// ─────────────────────────────────────────────
app.post("/stitch", async (req, res) => {
  const tmp = `./temp_${Date.now()}`;

  try {
    const { videos, voice, music } = req.body;

    if (!videos || videos.length < 3) {
      return res.status(400).json({ error: "Need at least 3 video URLs" });
    }

    fs.mkdirSync(tmp, { recursive: true });

    // ── 1. Download all videos ────────────────────────────────────────────────
    console.log("\n📥 Downloading videos...");
    for (let i = 0; i < videos.length; i++) {
      await downloadFile(videos[i], `${tmp}/raw_${i}.mp4`);
    }

    // ── 2. Ensure every video has an audio track ──────────────────────────────
    console.log("\n🎵 Checking audio streams...");
    for (let i = 0; i < videos.length; i++) {
      await ensureAudio(`${tmp}/raw_${i}.mp4`, `${tmp}/video${i}.mp4`);
    }

    // ── 3. Re-encode each clip to same resolution/fps/codec ──────────────────
    // This is critical — mismatched resolutions (480x480 vs 720x1264) break concat
    console.log("\n🎬 Normalizing video specs...");
    for (let i = 0; i < videos.length; i++) {
      await execPromise(
        `ffmpeg -y -i "${tmp}/video${i}.mp4" ` +
        `-vf "scale=720:1280:force_original_aspect_ratio=decrease,` +
        `pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black,fps=30" ` +
        `-c:v libx264 -preset fast -crf 23 ` +
        `-c:a aac -ar 44100 -ac 2 ` +
        `"${tmp}/norm${i}.mp4"`
      );
    }

    // ── 4. Write concat list ──────────────────────────────────────────────────
    console.log("\n🔗 Concatenating videos...");
    const concatList = videos.map((_, i) => `file 'norm${i}.mp4'`).join("\n");
    fs.writeFileSync(`${tmp}/concat.txt`, concatList);

    // Use the concat demuxer (much simpler than filter_complex for same-spec clips)
    await execPromise(
      `cd "${tmp}" && ffmpeg -y ` +
      `-f concat -safe 0 -i concat.txt ` +
      `-c:v libx264 -preset fast -crf 23 ` +
      `-c:a aac ` +
      `merged.mp4`
    );

    // ── 5. Download voice ─────────────────────────────────────────────────────
    let currentVideo = "merged.mp4";

    if (voice) {
      console.log("\n🎤 Downloading voiceover...");
      await downloadFile(voice, `${tmp}/voice.mp3`);

      console.log("🎤 Mixing voiceover...");
      // Duck original audio to 20%, mix with voiceover
      await execPromise(
        `cd "${tmp}" && ffmpeg -y ` +
        `-i merged.mp4 -i voice.mp3 ` +
        `-filter_complex ` +
        `"[0:a]volume=0.2[orig];[1:a]volume=1.0[voice];` +
        `[orig][voice]amix=inputs=2:duration=first:dropout_transition=2[aout]" ` +
        `-map 0:v -map "[aout]" ` +
        `-c:v copy -c:a aac -shortest ` +
        `voiced.mp4`
      );
      currentVideo = "voiced.mp4";
    }

    // ── 6. Add background music ───────────────────────────────────────────────
    if (music) {
      console.log("\n🎵 Downloading background music...");
      await downloadFile(music, `${tmp}/music.mp3`);

      console.log("🎵 Mixing background music...");
      await execPromise(
        `cd "${tmp}" && ffmpeg -y ` +
        `-i ${currentVideo} -i music.mp3 ` +
        `-filter_complex ` +
        `"[1:a]volume=0.15[music];` +
        `[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]" ` +
        `-map 0:v -map "[aout]" ` +
        `-c:v copy -c:a aac -shortest ` +
        `final.mp4`
      );
    } else {
      fs.copyFileSync(`${tmp}/${currentVideo}`, `${tmp}/final.mp4`);
    }

    // ── 7. Send result ────────────────────────────────────────────────────────
    console.log("\n✅ Sending final video!");
    res.download(`${tmp}/final.mp4`, "stitched.mp4", (err) => {
      if (err) console.error("Send error:", err);
      // Cleanup temp folder after sending
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log("🧹 Cleaned up temp files");
    });

  } catch (e) {
    console.error("\n❌ STITCH ERROR:", e.message || e);
    // Cleanup on error too
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    res.status(500).json({ error: e.message || e.toString() });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
});