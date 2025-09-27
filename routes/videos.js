import express from "express";
import s3 from "../utils/s3.js";
import Video from "../models/Video.js";
import Comment from "../models/Comment.js";
import User from "../models/User.js";
import authMiddleware from "../middleware/auth.js";
import jwt from 'jsonwebtoken';
import transcodeToHLS from "../jobs/transcodeWorker.js";

const router = express.Router();

// 1. Generate Signed URL for UPLOAD
router.post("/signed-url", authMiddleware, async (req, res) => {
  try {
    const { fileName, fileType } = req.body;
    if (!fileName || !fileType) {
      return res.status(400).json({ msg: "Missing fileName or fileType" });
    }

    const key = `videos/${Date.now()}_${fileName}`;

    const uploadUrl = await s3.getSignedUrlPromise("putObject", {
      Bucket: process.env.WASABI_BUCKET,
      Key: key,
      Expires: 60,
      ContentType: fileType,
    });

    res.json({ uploadUrl, key });
  } catch (err) {
    console.error("Signed URL error:", err);
    res.status(500).json({ msg: "Could not create signed URL" });
  }
});

// 2. Save Video Metadata with thumbnail generation
router.post("/save", authMiddleware, async (req, res) => {
  try {
    const { description, hashtags, privacy, allowComments, allowDuet, key } = req.body;

    if (!key) return res.status(400).json({ msg: "key is required" });

    const video = await Video.create({
      description,
      key,
      user: req.userId,
      hashtags: hashtags?.split(" ").filter((tag) => tag.trim().startsWith("#")) || [],
      privacy: privacy || "public",
      allowComments: allowComments ?? true,
      allowDuet: allowDuet ?? true,
    });

    // Queue thumbnail generation (optional)
    // generateThumbnail(key);

    res.status(201).json({ video });
  } catch (err) {
    console.error("Save video error:", err);
    res.status(500).json({ msg: "Could not save video" });
  }
});

// 3. STREAMING ENDPOINT - Supports range requests for progressive loading
router.get("/stream/:id", async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ msg: "Video not found" });

    // Get video metadata from S3
    const headParams = {
      Bucket: process.env.WASABI_BUCKET,
      Key: video.key,
    };

    const headResult = await s3.headObject(headParams).promise();
    const fileSize = headResult.ContentLength;
    const contentType = headResult.ContentType || 'video/mp4';

    // Parse range header
    const range = req.headers.range;
    
    if (!range) {
      // No range requested, serve entire file
      const streamParams = {
        Bucket: process.env.WASABI_BUCKET,
        Key: video.key,
      };
      
      const stream = s3.getObject(streamParams).createReadStream();
      
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range',
      });
      
      stream.pipe(res);
      return;
    }

    // Parse range header (e.g., "bytes=200-1000" or "bytes=200-")
    const CHUNK_SIZE = 1024 * 1024; // 1MB chunks
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + CHUNK_SIZE - 1, fileSize - 1);
    
    if (start >= fileSize || end >= fileSize) {
      return res.status(416).send('Range Not Satisfiable');
    }

    const chunksize = (end - start) + 1;
    
    // Create S3 stream with range
    const streamParams = {
      Bucket: process.env.WASABI_BUCKET,
      Key: video.key,
      Range: `bytes=${start}-${end}`,
    };
    
    const stream = s3.getObject(streamParams).createReadStream();
    
    // Set partial content headers
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
    });
    
    stream.pipe(res);
    
  } catch (err) {
    console.error("Stream video error:", err);
    res.status(500).json({ msg: "Could not stream video" });
  }
});

// 4. PROXY STREAMING - Direct proxy to S3 with range support
router.get("/proxy/:id", async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ msg: "Video not found" });

    // Generate a short-lived signed URL for the proxy
    const signedUrl = s3.getSignedUrl("getObject", {
      Bucket: process.env.WASABI_BUCKET,
      Key: video.key,
      Expires: 300, // 5 minutes
    });

    // Extract the range header from the original request
    const range = req.headers.range;
    const headers = {
      'User-Agent': 'VideoStreamProxy/1.0',
    };
    
    if (range) {
      headers.Range = range;
    }

    // Proxy the request to S3
    const fetch = await import('node-fetch').then(m => m.default);
    const response = await fetch(signedUrl, { headers });
    
    // Forward S3 response headers
    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (['content-length', 'content-type', 'content-range', 'accept-ranges', 'cache-control'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    
    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    
    // Stream the response
    response.body.pipe(res);
    
  } catch (err) {
    console.error("Proxy video error:", err);
    res.status(500).json({ msg: "Could not proxy video" });
  }
});

// 5. Get All Videos with optimized URLs
router.get("/", async (req, res) => {
  try {
    let userId = null;
    
    if (req.headers.authorization) {
      try {
        const token = req.headers.authorization.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userId = decoded.id || decoded.userId;
      } catch (tokenError) {
        console.log('Invalid token, proceeding without authentication');
        userId = null;
      }
    }
    
    const videos = await Video.find()
      .populate("user", "username avatar")
      .sort({ createdAt: -1 });

    const videosWithUrls = await Promise.all(
      videos.map(async (video) => {
        // Use streaming endpoint instead of direct S3 URL
        const streamUrl = `${req.protocol}://${req.get('host')}/api/videos/stream/${video._id}`;
        
        // Generate thumbnail URL if available
        const thumbnailKey = video.key.replace(/\.[^/.]+$/, '_thumb.jpg');
        let thumbnailUrl = null;
        
        try {
          await s3.headObject({
            Bucket: process.env.WASABI_BUCKET,
            Key: thumbnailKey,
          }).promise();
          
          thumbnailUrl = s3.getSignedUrl("getObject", {
            Bucket: process.env.WASABI_BUCKET,
            Key: thumbnailKey,
            Expires: 3600,
          });
        } catch (error) {
          // Thumbnail doesn't exist, use placeholder or generate
          thumbnailUrl = `https://via.placeholder.com/400x600/000000/FFFFFF?text=Loading`;
        }

        const commentsCount = await Comment.countDocuments({ video: video._id });

        let isLiked = false;
        let isSaved = false;
        
        if (userId) {
          isLiked = video.likes.some(likeId => {
            const likeIdStr = likeId.toString();
            const userIdStr = userId.toString();
            return likeIdStr === userIdStr;
          });
          
          const user = await User.findById(userId);
          if (user && user.savedVideos) {
            isSaved = user.savedVideos.some(savedId => savedId.toString() === video._id.toString());
          }
        }

        return {
          ...video.toObject(),
          url: streamUrl, // Use streaming URL instead of direct S3
          thumbnailUrl, // Add thumbnail for better UX
          commentsCount,
          isLiked,
          isSaved,
          likesCount: video.likes.length
        };
      })
    );

    res.json(videosWithUrls);
  } catch (err) {
    console.error("Get videos error:", err);
    res.status(500).json({ msg: "Could not fetch videos" });
  }
});

// 6. Generate video thumbnail (utility endpoint)
router.post("/:id/thumbnail", authMiddleware, async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ msg: "Video not found" });

    // Check if user owns the video
    if (video.user.toString() !== req.userId) {
      return res.status(403).json({ msg: "Not authorized" });
    }

    // Queue thumbnail generation job
    const thumbnailKey = video.key.replace(/\.[^/.]+$/, '_thumb.jpg');
    
    // You would implement actual thumbnail generation here
    // For now, return the key where thumbnail will be stored
    res.json({ 
      msg: "Thumbnail generation queued",
      thumbnailKey 
    });
    
  } catch (err) {
    console.error("Thumbnail generation error:", err);
    res.status(500).json({ msg: "Could not generate thumbnail" });
  }
});

// OPTIONS handler for CORS preflight
router.options("/stream/:id", (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Range');
  res.sendStatus(200);
});

router.options("/proxy/:id", (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Range');
  res.sendStatus(200);
});

// Rest of your existing routes remain the same...
// Like/Unlike Video
router.post("/:id/like", authMiddleware, async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ msg: "Video not found" });

    const userId = req.userId;
    const isLiked = video.likes.includes(userId);

    if (isLiked) {
      video.likes = video.likes.filter(id => id.toString() !== userId);
    } else {
      video.likes.push(userId);
    }

    await video.save();

    res.json({
      isLiked: !isLiked,
      likes: video.likes,
      likesCount: video.likes.length
    });
  } catch (err) {
    console.error("Like video error:", err);
    res.status(500).json({ msg: "Could not like/unlike video" });
  }
});

// Save/Unsave Video
router.post("/:id/save", authMiddleware, async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ msg: "Video not found" });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ msg: "User not found" });

    if (!user.savedVideos) {
      user.savedVideos = [];
    }

    const isSaved = user.savedVideos.includes(req.params.id);

    if (isSaved) {
      user.savedVideos = user.savedVideos.filter(id => id.toString() !== req.params.id);
    } else {
      user.savedVideos.push(req.params.id);
    }

    await user.save();

    res.json({
      isSaved: !isSaved,
      message: isSaved ? "Video removed from saved" : "Video saved successfully"
    });
  } catch (err) {
    console.error("Save video error:", err);
    res.status(500).json({ msg: "Could not save/unsave video" });
  }
});

// Get Comments for a Video
router.get("/:id/comments", async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    
    const comments = await Comment.find({ video: req.params.id })
      .populate("user", "username avatar")
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json(comments);
  } catch (err) {
    console.error("Get comments error:", err);
    res.status(500).json({ msg: "Could not fetch comments" });
  }
});

// Add Comment to Video
router.post("/:id/comments", authMiddleware, async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text || text.trim().length === 0) {
      return res.status(400).json({ msg: "Comment text is required" });
    }

    if (text.trim().length > 500) {
      return res.status(400).json({ msg: "Comment too long (max 500 characters)" });
    }

    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ msg: "Video not found" });

    if (!video.allowComments) {
      return res.status(403).json({ msg: "Comments are disabled for this video" });
    }

    const comment = await Comment.create({
      text: text.trim(),
      user: req.userId,
      video: req.params.id
    });

    await Video.findByIdAndUpdate(req.params.id, {
      $inc: { commentsCount: 1 }
    });

    const populatedComment = await Comment.findById(comment._id)
      .populate("user", "username avatar");

    res.status(201).json(populatedComment);
  } catch (err) {
    console.error("Add comment error:", err);
    res.status(500).json({ msg: "Could not add comment" });
  }
});

// Delete Comment
router.delete("/:videoId/comments/:commentId", authMiddleware, async (req, res) => {
  try {
    const { videoId, commentId } = req.params;
    
    const comment = await Comment.findById(commentId);
    if (!comment) return res.status(404).json({ msg: "Comment not found" });

    const video = await Video.findById(videoId);
    if (!video) return res.status(404).json({ msg: "Video not found" });

    if (comment.user.toString() !== req.userId && video.user.toString() !== req.userId) {
      return res.status(403).json({ msg: "Not authorized to delete this comment" });
    }

    await Comment.findByIdAndDelete(commentId);

    await Video.findByIdAndUpdate(videoId, {
      $inc: { commentsCount: -1 }
    });

    res.json({ msg: "Comment deleted successfully" });
  } catch (err) {
    console.error("Delete comment error:", err);
    res.status(500).json({ msg: "Could not delete comment" });
  }
});

// Get User's Saved Videos
router.get("/saved", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).populate({
      path: 'savedVideos',
      populate: {
        path: 'user',
        select: 'username avatar'
      }
    });

    if (!user) return res.status(404).json({ msg: "User not found" });

    const videosWithUrls = user.savedVideos.map((video) => {
      const streamUrl = `${req.protocol}://${req.get('host')}/api/videos/stream/${video._id}`;

      return {
        ...video.toObject(),
        url: streamUrl,
        isSaved: true
      };
    });

    res.json(videosWithUrls);
  } catch (err) {
    console.error("Get saved videos error:", err);
    res.status(500).json({ msg: "Could not fetch saved videos" });
  }
});

// Get Video Statistics
router.get("/:id/stats", authMiddleware, async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ msg: "Video not found" });

    const commentsCount = await Comment.countDocuments({ video: req.params.id });
    const likesCount = video.likes.length;
    
    res.json({
      videoId: video._id,
      likesCount,
      commentsCount,
      createdAt: video.createdAt,
      privacy: video.privacy
    });
  } catch (err) {
    console.error("Get video stats error:", err);
    res.status(500).json({ msg: "Could not fetch video statistics" });
  }
});

// Get user's videos
router.get("/user/:userId", authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    const userVideos = await Video.find({ user: userId })
      .populate("user", "username avatar")
      .sort({ createdAt: -1 });

    const videosWithUrls = await Promise.all(
      userVideos.map(async (video) => {
        const streamUrl = `${req.protocol}://${req.get('host')}/api/videos/stream/${video._id}`;
        const commentsCount = await Comment.countDocuments({ video: video._id });

        let isLiked = false;
        let isSaved = false;
        
        if (req.userId) {
          isLiked = video.likes.some(likeId => likeId.toString() === req.userId.toString());
          
          const currentUser = await User.findById(req.userId);
          if (currentUser && currentUser.savedVideos) {
            isSaved = currentUser.savedVideos.some(savedId => savedId.toString() === video._id.toString());
          }
        }

        return {
          ...video.toObject(),
          url: streamUrl,
          commentsCount,
          isLiked,
          isSaved,
          likesCount: video.likes.length
        };
      })
    );

    res.json(videosWithUrls);
  } catch (err) {
    console.error("Get user videos error:", err);
    res.status(500).json({ msg: "Could not fetch user videos" });
  }
});

// Get liked videos
router.get("/liked", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    
    const likedVideos = await Video.find({
      likes: { $in: [userId] }
    })
    .populate("user", "username avatar")
    .sort({ createdAt: -1 });

    const videosWithUrls = await Promise.all(
      likedVideos.map(async (video) => {
        const streamUrl = `${req.protocol}://${req.get('host')}/api/videos/stream/${video._id}`;
        const commentsCount = await Comment.countDocuments({ video: video._id });

        const user = await User.findById(userId);
        const isSaved = user?.savedVideos?.some(savedId => savedId.toString() === video._id.toString()) || false;

        return {
          ...video.toObject(),
          url: streamUrl,
          commentsCount,
          isLiked: true,
          isSaved,
          likesCount: video.likes.length
        };
      })
    );

    res.json(videosWithUrls);
  } catch (err) {
    console.error("Get liked videos error:", err);
    res.status(500).json({ msg: "Could not fetch liked videos" });
  }
});

// Admin Upload Video
router.post("/admin/add", async (req, res) => {
  try {
    const { uri, description, title, avatar, adminUserId } = req.body;

    if (!uri || !description) {
      return res.status(400).json({ msg: "Video URI and description are required" });
    }

    const userId = adminUserId || process.env.DEFAULT_ADMIN_USER_ID;

    const video = await Video.create({
      key: uri,
      description,
      title: title || "",
      user: userId,
      avatar: avatar || "https://cdn-icons-png.flaticon.com/128/7641/7641727.png",
      privacy: "public",
      allowComments: true,
      allowDuet: true,
      isApproved: true,
    });

    res.status(201).json({
      success: true,
      msg: "Admin video uploaded successfully",
      video,
    });
  } catch (err) {
    console.error("Admin add video error:", err);
    res.status(500).json({ msg: "Server error while uploading admin video" });
  }
});

export default router;