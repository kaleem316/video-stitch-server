import express from "express";
import fs from "fs";
import axios from "axios";
import { exec } from "child_process";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) reject(stderr);
      else resolve(stdout);
    });
  });
}

async function downloadFile(url, path) {
  const writer = fs.createWriteStream(path);
  const response = await axios({
    url,
    method: "GET",
    responseType: "stream",
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

app.post("/stitch", async (req, res) => {
  try {
    const { videos, voice, music } = req.body;

    if (!videos || videos.length < 3) {
      return res.status(400).json({ error: "Need 3+ videos" });
    }

    // create temp folder
    if (!fs.existsSync("./temp")) fs.mkdirSync("./temp");

    // download videos
    let videoFiles = [];
    for (let i = 0; i < videos.length; i++) {
      const path = `./temp/video${i}.mp4`;
      await downloadFile(videos[i], path);
      videoFiles.push(path);
    }

    // download voice
    const voicePath = "./temp/voice.mp3";
    await downloadFile(voice, voicePath);

    // download music (optional)
    let musicPath = null;
    if (music) {
      musicPath = "./temp/music.mp3";
      await downloadFile(music, musicPath);
    }

    // create concat file
    const list = videoFiles.map(v => `file '${v}'`).join("\n");
    fs.writeFileSync("./temp/list.txt", list);

    // merge videos
    await execPromise(
      `ffmpeg -f concat -safe 0 -i ./temp/list.txt -c copy ./temp/merged.mp4`
    );

    // add voice
    await execPromise(
      `ffmpeg -i ./temp/merged.mp4 -i ${voicePath} -c:v copy -c:a aac ./temp/voice.mp4`
    );

    // add music
    if (musicPath) {
      await execPromise(
        `ffmpeg -i ./temp/voice.mp4 -i ${musicPath} -filter_complex "[1:a]volume=0.3[a1];[0:a][a1]amix=inputs=2" -c:v copy ./temp/final.mp4`
      );
    } else {
      fs.copyFileSync("./temp/voice.mp4", "./temp/final.mp4");
    }

    res.download("./temp/final.mp4");

  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

app.listen(PORT, () => {
  console.log("Server running...");
});
