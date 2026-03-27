import express from "express";
import fs from "fs";
import axios from "axios";
import { exec } from "child_process";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ✅ TEST ROUTE (VERY IMPORTANT)
app.get("/", (req, res) => {
  res.send("Server is running 🚀");
});

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

app.post("/stitch", async (req, res) => {
  try {
    const { videos, voice, music } = req.body;

    if (!videos || videos.length < 3) {
      return res.status(400).json({ error: "Need 3+ videos" });
    }

    console.log("Starting stitching...");

    // create temp folder
    if (!fs.existsSync("./temp")) fs.mkdirSync("./temp");

    // download videos
    let videoFiles = [];

	for (let i = 0; i < videos.length; i++) {
	  const fullPath = `./temp/video${i}.mp4`;

	  await downloadFile(videos[i], fullPath);

	  videoFiles.push(`video${i}.mp4`); // ✅ ONLY filename
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

    // create concat list
    const list = videoFiles.map(v => `file '${v}'`).join("\n");
    fs.writeFileSync("./temp/list.txt", list);

    console.log("Merging videos...");

   // merge videos
	await execPromise(
	  `cd temp && ffmpeg -f concat -safe 0 -i list.txt -vf "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2" -c:v libx264 -c:a aac merged.mp4`
	);
	console.log("Adding voice...");

	// add voice
	await execPromise(
	  `cd temp && ffmpeg -i merged.mp4 -i voice.mp3 -c:v copy -c:a aac voice.mp4`
	);

	console.log("Adding music...");

	// add music
	if (musicPath) {
	  await execPromise(
		`cd temp && ffmpeg -i voice.mp4 -i music.mp3 -filter_complex "[1:a]volume=0.3[a1];[0:a][a1]amix=inputs=2" -c:v copy final.mp4`
	  );
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

// ✅ IMPORTANT (Railway needs this)
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});