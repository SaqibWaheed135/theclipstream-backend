import express from "express";
import adminAuth from "../middleware/adminAuth.js";
import Video from "../models/Video.js";
import Admin from "../models/Admin.js";
import jwt from 'jsonwebtoken'
import s3 from "../utils/s3.js";
const router = express.Router();

// Generate JWT
function generateToken(admin) {
  return jwt.sign(
    { id: admin._id, role: admin.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

// Admin login
router.post("/admin-login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ message: "All fields are required" });

    const admin = await Admin.findOne({ email });
    if (!admin)
      return res.status(400).json({ message: "Invalid credentials" });

    const isMatch = await admin.matchPassword(password);
    if (!isMatch)
      return res.status(400).json({ message: "Invalid credentials" });

    const token = generateToken(admin);

    res.json({
      success: true,
      token,
      admin: {
        id: admin._id,
        email: admin.email,
        role: admin.role,
      },
    });
  } catch (err) {
    console.error("Admin login error:", err);
    res.status(500).json({ message: "Server error" });
  }
});
// GET all videos (admin)
// GET /api/admin/videos (all videos, with signed URLs)
router.get("/videos", async (req, res) => {
  try {
    const videos = await Video.find()
      .populate("user", "username avatar email")
      .sort({ createdAt: -1 });

    const videosWithUrls = await Promise.all(
      videos.map(async (video) => {
        // Generate signed URL for playback
        let signedUrl = null;
        if (video.key && process.env.WASABI_BUCKET) {
          signedUrl = s3.getSignedUrl("getObject", {
            Bucket: process.env.WASABI_BUCKET,
            Key: video.key,
            Expires: 3600, // 1 hour
          });
        }

        return {
          ...video.toObject(),
          url: signedUrl,
          username: video.user?.username || "Unknown",
          avatar: video.user?.avatar || null,
          email: video.user?.email || null,
          likesCount: video.likes.length,
        };
      })
    );

    res.json({ success: true, data: videosWithUrls });
  } catch (err) {
    console.error("Error fetching videos (admin):", err);
    res.status(500).json({ msg: "Could not fetch videos" });
  }
});

// POST /api/admin/videos/approve
router.post("/videos/approve",  async (req, res) => {
  try {
    const { videoId } = req.body;
    if (!videoId) return res.status(400).json({ msg: "videoId required" });

    let video = await Video.findByIdAndUpdate(
      videoId,
      { isApproved: true },
      { new: true }
    ).populate("user", "username avatar email");

    if (!video) return res.status(404).json({ msg: "Video not found" });

    // Generate signed URL
    let signedUrl = null;
    if (video.key && process.env.WASABI_BUCKET) {
      signedUrl = s3.getSignedUrl("getObject", {
        Bucket: process.env.WASABI_BUCKET,
        Key: video.key,
        Expires: 3600, // 1 hour
      });
    }

    // Return enriched object
    const enrichedVideo = {
      ...video.toObject(),
      url: signedUrl,
      username: video.user?.username || "Unknown",
      avatar: video.user?.avatar || null,
      email: video.user?.email || null,
      likesCount: video.likes.length,
    };

    res.json({
      success: true,
      msg: "Video approved",
      video: enrichedVideo,
    });
  } catch (err) {
    console.error("Error approving video:", err);
    res.status(500).json({ msg: "Could not approve video" });
  }
});

// GET /api/admin/videos/approved
router.get("/videos/approved",  async (req, res) => {
  try {
    const videos = await Video.find({ isApproved: true })
      .populate("user", "username avatar email")
      .sort({ createdAt: -1 });

    const videosWithUrls = await Promise.all(
      videos.map(async (video) => {
        let signedUrl = null;
        if (video.key && process.env.WASABI_BUCKET) {
          signedUrl = s3.getSignedUrl("getObject", {
            Bucket: process.env.WASABI_BUCKET,
            Key: video.key,
            Expires: 3600,
          });
        }

        return {
          ...video.toObject(),
          url: signedUrl,
          username: video.user?.username || "Unknown",
          avatar: video.user?.avatar || null,
          email: video.user?.email || null,
          likesCount: video.likes.length,
        };
      })
    );

    res.json({ success: true, data: videosWithUrls });
  } catch (err) {
    console.error("Error fetching approved videos (admin):", err);
    res.status(500).json({ msg: "Could not fetch approved videos" });
  }
});

// Delete video
router.delete("/videos/:id", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const video = await Video.findByIdAndDelete(id);

    if (!video) return res.status(404).json({ msg: "Video not found" });

    res.json({ success: true, msg: "Video deleted" });
  } catch (err) {
    console.error("Error deleting video:", err);
    res.status(500).json({ msg: "Could not delete video" });
  }
});

export default router;
