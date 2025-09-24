// routes/liveRoutes.js
import express from "express";
import LiveStream from "../models/LiveStream.js";
import authMiddleware from "../middleware/auth.js";

const router = express.Router();

// Generate stream details (replace with actual integration, e.g., Cloudflare, MUX, etc.)
const generateStreamDetails = (streamId, userId) => {
  // This is a placeholder. In production, integrate with a live streaming service to generate unique RTMP URLs and keys.
  return {
    rtmpUrl: `rtmp://theclipstream-backend.onrender.com/live`, // Example RTMP ingest URL
    streamKey: `${streamId}-${userId}`,
    playbackUrl: `https://theclipstream-backend.onrender.com/live/${streamId}-${userId}.m3u8` // Example HLS playback URL
  };
};

// Create a new live stream
router.post("/create", authMiddleware, async (req, res) => {
  try {
    const { title, description, privacy = "public" } = req.body;

    if (!title || title.trim().length === 0) {
      return res.status(400).json({ msg: "Title is required" });
    }

    // Check if user already has an active live stream
    const existingStream = await LiveStream.findOne({
      streamer: req.userId,
      status: "live"
    });

    if (existingStream) {
      return res.status(400).json({ 
        msg: "You already have an active live stream",
        streamId: existingStream._id
      });
    }

    const liveStream = new LiveStream({
      title: title.trim(),
      description: description?.trim() || "",
      streamer: req.userId,
      privacy,
      status: "live",
      startedAt: new Date(),
      streams: []
    });

    const mainStream = generateStreamDetails(liveStream._id, req.userId);
    liveStream.streams.push({
      user: req.userId,
      joinedAt: new Date(),
      rtmpUrl: mainStream.rtmpUrl,
      streamKey: mainStream.streamKey,
      playbackUrl: mainStream.playbackUrl
    });

    await liveStream.save();
    await liveStream.populate("streamer", "username avatar");
    await liveStream.populate("streams.user", "username avatar");

    res.status(201).json({
      streamId: liveStream._id,
      rtmpUrl: mainStream.rtmpUrl,
      streamKey: mainStream.streamKey,
      stream: liveStream
    });
  } catch (error) {
    console.error("Create live stream error:", error);
    res.status(500).json({ msg: "Could not create live stream" });
  }
});

// Add co-host
router.post("/:streamId/add-cohost", authMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    const liveStream = await LiveStream.findById(req.params.streamId);

    if (!liveStream) {
      return res.status(404).json({ msg: "Live stream not found" });
    }

    if (liveStream.streamer.toString() !== req.userId) {
      return res.status(403).json({ msg: "Not authorized" });
    }

    if (liveStream.streams.some(s => s.user.toString() === userId)) {
      return res.status(400).json({ msg: "Already a host" });
    }

    const newStream = generateStreamDetails(liveStream._id, userId);
    liveStream.streams.push({
      user: userId,
      joinedAt: new Date(),
      rtmpUrl: newStream.rtmpUrl,
      streamKey: newStream.streamKey,
      playbackUrl: newStream.playbackUrl
    });

    await liveStream.save();
    await liveStream.populate("streamer", "username avatar");
    await liveStream.populate("streams.user", "username avatar");

    // Emit via socket if integrated (assuming io is global)
    // io.to(liveStream._id.toString()).emit('cohost-joined');

    res.json({ msg: "Co-host added", stream: liveStream });
  } catch (error) {
    console.error("Add co-host error:", error);
    res.status(500).json({ msg: "Could not add co-host" });
  }
});

// End a live stream
router.post("/:streamId/end", authMiddleware, async (req, res) => {
  try {
    const liveStream = await LiveStream.findById(req.params.streamId);
    
    if (!liveStream) {
      return res.status(404).json({ msg: "Live stream not found" });
    }

    if (liveStream.streamer.toString() !== req.userId) {
      return res.status(403).json({ msg: "Not authorized to end this stream" });
    }

    liveStream.status = "ended";
    liveStream.endedAt = new Date();
    liveStream.duration = Math.floor((Date.now() - liveStream.startedAt.getTime()) / 1000);
    
    await liveStream.save();

    res.json({ 
      msg: "Live stream ended successfully",
      duration: liveStream.duration
    });
  } catch (error) {
    console.error("End live stream error:", error);
    res.status(500).json({ msg: "Could not end live stream" });
  }
});

// Get all active live streams
router.get("/", async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    
    const liveStreams = await LiveStream.find({
      status: "live",
      privacy: "public"
    })
      .populate("streamer", "username avatar")
      .populate("streams.user", "username avatar")
      .sort({ startedAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json(liveStreams);
  } catch (error) {
    console.error("Get live streams error:", error);
    res.status(500).json({ msg: "Could not fetch live streams" });
  }
});

// Get a specific live stream
router.get("/:streamId", async (req, res) => {
  try {
    const liveStream = await LiveStream.findById(req.params.streamId)
      .populate("streamer", "username avatar")
      .populate("streams.user", "username avatar");
    
    if (!liveStream) {
      return res.status(404).json({ msg: "Live stream not found" });
    }

    res.json(liveStream);
  } catch (error) {
    console.error("Get live stream error:", error);
    res.status(500).json({ msg: "Could not fetch live stream" });
  }
});

// Get live stream analytics
router.get("/:streamId/analytics", authMiddleware, async (req, res) => {
  try {
    const liveStream = await LiveStream.findById(req.params.streamId)
      .populate("streamer", "username avatar")
      .populate("streams.user", "username avatar");
    
    if (!liveStream) {
      return res.status(404).json({ msg: "Live stream not found" });
    }

    if (liveStream.streamer.toString() !== req.userId) {
      return res.status(403).json({ msg: "Not authorized to view analytics" });
    }

    res.json({
      streamId: liveStream._id,
      title: liveStream.title,
      status: liveStream.status,
      viewerCount: liveStream.viewers.length,
      totalViews: liveStream.totalViews,
      peakViewers: liveStream.peakViewers,
      duration: liveStream.duration,
      heartsReceived: liveStream.heartsReceived,
      commentsCount: liveStream.comments.length,
      startedAt: liveStream.startedAt,
      endedAt: liveStream.endedAt,
      streams: liveStream.streams
    });
  } catch (error) {
    console.error("Get analytics error:", error);
    res.status(500).json({ msg: "Could not fetch analytics" });
  }
});

// Report a live stream
router.post("/:streamId/report", authMiddleware, async (req, res) => {
  try {
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({ msg: "Report reason is required" });
    }

    const liveStream = await LiveStream.findById(req.params.streamId);
    
    if (!liveStream) {
      return res.status(404).json({ msg: "Live stream not found" });
    }

    // Check if user already reported this stream
    const existingReport = liveStream.reports.find(
      report => report.reporter.toString() === req.userId
    );

    if (existingReport) {
      return res.status(400).json({ msg: "You have already reported this stream" });
    }

    liveStream.reports.push({
      reporter: req.userId,
      reason,
      reportedAt: new Date()
    });

    await liveStream.save();

    res.json({ msg: "Live stream reported successfully" });
  } catch (error) {
    console.error("Report live stream error:", error);
    res.status(500).json({ msg: "Could not report live stream" });
  }
});

export default router;