import fs from "fs";
import path from "path";
import { exec } from "child_process";
import util from "util";
import s3 from "../utils/s3.js";
import Video from "../models/Video.js";

const execPromise = util.promisify(exec);
const TMP_DIR = "C:\\temp"; // ✅ Windows safe

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

        // Normalize paths for ffmpeg (forward slashes)
        const safeLocalFile = localFile.replace(/\\/g, "/");
        const safeOutputDir = outputDir.replace(/\\/g, "/");

        // Prepend file:///
        const inputFile = `file:///${safeLocalFile}`;
        const outputFile = `file:///${safeOutputDir}/index.m3u8`;

        const command = `
  ffmpeg -y -i "${inputFile}" -profile:v baseline -level 3.0 -start_number 0 \
  -hls_time 6 -hls_list_size 0 -f hls "${outputFile}"
`;

        console.log("🎬 Running FFmpeg command:\n", command);

        try {
            const { stdout, stderr } = await execPromise(command);
            if (stdout) console.log("📤 FFmpeg stdout:", stdout);
            if (stderr) console.log("⚠️ FFmpeg stderr:", stderr);
        } catch (ffmpegErr) {
            console.error("❌ FFmpeg failed!");
            console.error("📤 stdout:", ffmpegErr.stdout || "");
            console.error("⚠️ stderr:", ffmpegErr.stderr || "");
            throw ffmpegErr; // rethrow so it's caught below
        }

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
