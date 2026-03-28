import express from "express";
import fs from "fs";
import axios from "axios";
import { exec } from "child_process";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ✅ TEST ROUTE
app.get("/", (req, res) => {
  res.send("Server is running 🚀");
});

// ================= EXEC =================
function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error("FFMPEG ERROR:", stderr);
        reject(stderr);
      } else {
        console.log("FFMPEG SUCCESS:", stdout);
        resolve(stdout);
      }
    });
  });
}

// ================= DOWNLOAD =================
async function downloadFile(url, path) {
  console.log("Downloading:", url);

  const writer = fs.createWriteStream(path);
  const response = await axios({
    url,
    method: "GET",
    responseType: "stream",
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", () => {
      console.log("Downloaded:", path);
      resolve();
    });
    writer.on("error", reject);
  });
}

// ================= STITCH =================
app.post("/stitch", async (req, res) => {
  try {
    const { videos, voice, music } = req.body;

    if (!videos || videos.length < 3) {
      return res.status(400).json({ error: "Need 3+ videos" });
    }

    console.log("Starting stitching...");

    if (!fs.existsSync("./temp")) fs.mkdirSync("./temp");

    // ================= DOWNLOAD VIDEOS =================
    let videoFiles = [];

    for (let i = 0; i < videos.length; i++) {
      const fullPath = `./temp/video${i}.mp4`;
      await downloadFile(videos[i], fullPath);
      videoFiles.push(`video${i}.mp4`);
    }

    // ================= DOWNLOAD AUDIO =================
    const voicePath = "./temp/voice.mp3";
    await downloadFile(voice, voicePath);

    let musicPath = null;
    if (music) {
      musicPath = "./temp/music.mp3";
      await downloadFile(music, musicPath);
    }

    // ================= MERGE VIDEOS (FINAL FIX) =================
    console.log("Merging videos...");

    const inputs = videoFiles.map(v => `-i ${v}`).join(" ");

    const filterInputs = videoFiles
      .map((_, i) => `[${i}:v:0][${i}:a:0]`)
      .join("");

    const concatFilter = `${filterInputs}concat=n=${videoFiles.length}:v=1:a=1[outv][outa]`;

    await execPromise(`
      cd temp && ffmpeg ${inputs} \
      -filter_complex "${concatFilter}" \
      -map "[outv]" -map "[outa]" \
      -c:v libx264 -c:a aac merged.mp4
    `);

    // ================= ADD VOICE =================
    console.log("Adding voice...");

    await execPromise(`
      cd temp && ffmpeg -i merged.mp4 -i voice.mp3 \
      -c:v copy -c:a aac voice.mp4
    `);

    // ================= ADD MUSIC =================
    console.log("Adding music...");

    if (musicPath) {
      await execPromise(`
        cd temp && ffmpeg -i voice.mp4 -i music.mp3 \
        -filter_complex "[1:a]volume=0.3[a1];[0:a][a1]amix=inputs=2" \
        -c:v copy final.mp4
      `);
    } else {
      fs.copyFileSync("./temp/voice.mp4", "./temp/final.mp4");
    }

    console.log("Sending final video...");

    res.download("./temp/final.mp4");

  } catch (e) {
    console.error("ERROR:", e);
    res.status(500).json({ error: e.toString() });
  }
});

// ================= START =================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});