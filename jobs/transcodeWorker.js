import fs from "fs";
import path from "path";
import { exec } from "child_process";
import util from "util";
import s3 from "../utils/s3.js";
import Video from "../models/Video.js";

const execPromise = util.promisify(exec);
const TMP_DIR = "C:/temp"; // ✅ Windows-friendly temp folder

async function transcodeToHLS(videoId, key) {
  try {
    const video = await Video.findById(videoId);
    if (!video) throw new Error("Video not found");

    // 1. Download MP4 from Wasabi → local temp
    const localFile = path.join(TMP_DIR, `${Date.now()}_input.mp4`);
    const fileStream = fs.createWriteStream(localFile);
  await new Promise((resolve, reject) => {
  console.log("📡 Downloading from Wasabi:", key);

  const s3Stream = s3.getObject({
    Bucket: process.env.WASABI_BUCKET,
    Key: key
  }).createReadStream();

  s3Stream.on("error", (err) => {
    console.error("❌ S3 stream error:", err);
    reject(err);
  });

  fileStream.on("error", (err) => {
    console.error("❌ File write error:", err);
    reject(err);
  });

  fileStream.on("finish", () => {
    console.log("✅ File downloaded to:", localFile);
    resolve();
  });

  s3Stream.pipe(fileStream);
});


    // 2. Transcode → HLS
    const outputDir = path.join(TMP_DIR, `${Date.now()}_hls`);
    fs.mkdirSync(outputDir, { recursive: true });

    const command = `
      ffmpeg -i "${localFile}" -profile:v baseline -level 3.0 -start_number 0 \
      -hls_time 6 -hls_list_size 0 -f hls "${outputDir}/index.m3u8"
    `;

    await execPromise(command);

    // 3. Upload generated files (.m3u8 + .ts)
    const files = fs.readdirSync(outputDir);
    for (const file of files) {
      const filePath = path.join(outputDir, file);
      const fileKey = `hls/${videoId}/${file}`;

      await s3.upload({
        Bucket: process.env.WASABI_BUCKET,
        Key: fileKey,
        Body: fs.createReadStream(filePath),
        ContentType: file.endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : "video/MP2T",
        ACL: "public-read"
      }).promise();
    }

    // 4. Save HLS URL to DB
    const hlsUrl = `https://${process.env.WASABI_BUCKET}.${process.env.WASABI_ENDPOINT}/hls/${videoId}/index.m3u8`;
    video.hlsUrl = hlsUrl;
    await video.save();

    // 5. Cleanup
    fs.rmSync(localFile, { force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });

    console.log("✅ HLS ready for video:", hlsUrl);
    return hlsUrl;
  } catch (err) {
    console.error("❌ Transcode error:", err);
  }
  // Ensure TMP_DIR exists
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}
}

export default transcodeToHLS;
