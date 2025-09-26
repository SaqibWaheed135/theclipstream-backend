import fs from "fs";
import path from "path";
import s3 from "../utils/s3.js";
import Video from "../models/Video.js";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const TMP_DIR = "C:\\temp"; // Windows temp dir

// Helper: normalize paths to forward slashes for FFmpeg
const toSafePath = (p) => p.replace(/\\/g, "/");

async function transcodeToHLS(videoId, key) {
  try {
    // Ensure temp dir exists
    if (!fs.existsSync(TMP_DIR)) {
      fs.mkdirSync(TMP_DIR, { recursive: true });
    }

    const video = await Video.findById(videoId);
    if (!video) throw new Error("Video not found");

    // 1. Download MP4
    const localFile = path.join(TMP_DIR, `${Date.now()}_input.mp4`);
    console.log("📡 Downloading from Wasabi:", key);

    await new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(localFile);
      s3.getObject({ Bucket: process.env.WASABI_BUCKET, Key: key })
        .createReadStream()
        .on("error", reject)
        .pipe(fileStream)
        .on("finish", resolve)
        .on("error", reject);
    });

    console.log("✅ File downloaded to:", localFile);

    // 2. Transcode → HLS
    const outputDir = path.join(TMP_DIR, `${Date.now()}_hls`);
    fs.mkdirSync(outputDir, { recursive: true });

    const outputFile = path.join(outputDir, "index.m3u8");

    // Normalize for FFmpeg
    const safeInput = toSafePath(localFile);
    const safeOutput = toSafePath(outputFile);

    console.log("🎬 Starting FFmpeg transcoding...");

    await new Promise((resolve, reject) => {
      ffmpeg(safeInput)
        .outputOptions([
          "-profile:v baseline",
          "-level 3.0",
          "-start_number 0",
          "-hls_time 6",
          "-hls_list_size 0",
          "-f hls"
        ])
        .output(safeOutput)
        .on("start", (cmd) => console.log("▶️ FFmpeg command:", cmd))
        .on("stderr", (line) => console.log("⚠️", line))
        .on("end", () => {
          console.log("✅ FFmpeg finished transcoding");
          resolve();
        })
        .on("error", (err) => {
          console.error("❌ FFmpeg error:", err.message);
          reject(err);
        })
        .run();
    });

    // 3. Upload HLS files
    const files = fs.readdirSync(outputDir);
    for (const file of files) {
      const filePath = path.join(outputDir, file);
      const fileKey = `hls/${videoId}/${file}`;

      await s3
        .upload({
          Bucket: process.env.WASABI_BUCKET,
          Key: fileKey,
          Body: fs.createReadStream(filePath),
          ContentType: file.endsWith(".m3u8")
            ? "application/vnd.apple.mpegurl"
            : "video/MP2T",
          ACL: "public-read",
        })
        .promise();
    }

    // 4. Save HLS URL in DB
    const hlsUrl = `https://${process.env.WASABI_BUCKET}.${process.env.WASABI_ENDPOINT}/hls/${videoId}/index.m3u8`;
    video.hlsUrl = hlsUrl;
    await video.save();

    console.log("✅ HLS ready for video:", hlsUrl);
    return hlsUrl;
  } catch (err) {
    console.error("❌ Transcode error:", err);
  }
}

export default transcodeToHLS;
