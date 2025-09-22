import express from "express";
import AWS from "aws-sdk";
import dotenv from "dotenv";
import Video from "../models/Video.js";

dotenv.config();
const router = express.Router();

// Configure Wasabi/S3
const s3 = new AWS.S3({
  endpoint: process.env.WASABI_ENDPOINT, // e.g. "https://s3.ap-southeast-1.wasabisys.com"
  region: process.env.WASABI_REGION,     // e.g. "ap-southeast-1"
  accessKeyId: process.env.WASABI_KEY,
  secretAccessKey: process.env.WASABI_SECRET,
  signatureVersion: "v4",
});

// 1️⃣ Get signed URL for upload
// 1️⃣ Get signed URL for upload
router.post("/uploadVideo", async (req, res) => {
  try {
    const { fileName, fileType } = req.body;

    if (!fileName || !fileType) {
      return res.status(400).json({ error: "Missing fileName or fileType" });
    }

    const key = `videos/${Date.now()}-${fileName}`;

    const params = {
      Bucket: process.env.WASABI_BUCKET,
      Key: key,
      Expires: 60 * 5, // 5 minutes upload window
      ContentType: fileType,
    };

    const uploadUrl = await s3.getSignedUrlPromise("putObject", params);

    // Optional: full URL if you want it
    const fileUrl = `https://${process.env.WASABI_BUCKET}.${process.env.WASABI_ENDPOINT.replace("https://", "")}/${key}`;

    // ✅ Return both
    res.json({ uploadUrl, key, fileUrl });
  } catch (err) {
    console.error("Signed URL error:", err);
    res.status(500).json({ error: "Failed to generate signed URL" });
  }
});


// 2️⃣ Save video metadata
router.post("/add", async (req, res) => {
  try {
    const { key, description, title, avatar } = req.body;

    if (!key) {
      return res.status(400).json({ success: false, msg: "key is required" });
    }

    // ✅ Use a fixed admin ObjectId or create/find an admin user
    const adminUserId = "670fa59f9f2a9d6b8a1c1234"; // replace with real admin _id

    const video = await Video.create({
      key,
      description,
      title: title || "",
      avatar,
      user: adminUserId,      // must be ObjectId
      likes: [],              // default empty array
      isApproved: true,       // auto approved
    });

    res.status(201).json({ success: true, video });
  } catch (err) {
    console.error("Admin add video error:", err);
    res.status(500).json({ success: false, msg: "Could not save admin video" });
  }
});

export default router;
