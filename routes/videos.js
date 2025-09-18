import express from "express";
import s3 from "../utils/s3.js";
import Video from "../models/Video.js";
import Comment from "../models/Comment.js"; // You'll need to create this model
import User from "../models/User.js"; // Assuming you have a User model
import authMiddleware from "../middleware/auth.js";
import jwt from 'jsonwebtoken';


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
      Expires: 60, // 1 min for upload
      ContentType: fileType,
    });

    res.json({ uploadUrl, key });
  } catch (err) {
    console.error("Signed URL error:", err);
    res.status(500).json({ msg: "Could not create signed URL" });
  }
});

// 2. Save Video Metadata
router.post("/save", authMiddleware, async (req, res) => {
  try {
    const { description, hashtags, privacy, allowComments, allowDuet, key } = req.body;

    if (!key) return res.status(400).json({ msg: "key is required" });

    const video = await Video.create({
      description,
      key, // store only S3 object key instead of public URL
      user: req.userId,
      hashtags: hashtags?.split(" ").filter((tag) => tag.trim().startsWith("#")) || [],
      privacy: privacy || "public",
      allowComments: allowComments ?? true,
      allowDuet: allowDuet ?? true,
    });

    res.status(201).json({ video });
  } catch (err) {
    console.error("Save video error:", err);
    res.status(500).json({ msg: "Could not save video" });
  }
});

// 3. Get Signed GET URL for Viewing
router.get("/stream/:id", authMiddleware, async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ msg: "Video not found" });

    const signedUrl = s3.getSignedUrl("getObject", {
      Bucket: process.env.WASABI_BUCKET,
      Key: video.key,
      Expires: 60 * 60 * 24 * 7, // 1 week
    });

    res.json({ url: signedUrl });
  } catch (err) {
    console.error("Stream video error:", err);
    res.status(500).json({ msg: "Could not generate playback URL" });
  }
});

// 4. Get All Videos (Feed)
router.get("/", async (req, res) => {
  try {
    let userId = null;
    
    // Properly extract userId from authorization header
    if (req.headers.authorization) {
      try {
        const token = req.headers.authorization.split(' ')[1]; // Extract token after 'Bearer '
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userId = decoded.id || decoded.userId;
        console.log('Decoded userId from token:', userId); // Debug log
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
        // Generate signed URL
        let signedUrl = null;
        if (video.key && process.env.WASABI_BUCKET) {
          signedUrl = s3.getSignedUrl("getObject", {
            Bucket: process.env.WASABI_BUCKET,
            Key: video.key,
            Expires: 3600,
          });
        }

        // Get comment count
        const commentsCount = await Comment.countDocuments({ video: video._id });

        // Check if user has liked/saved this video (if authenticated)
        let isLiked = false;
        let isSaved = false;
        
        if (userId) {
          // Check if user liked this video
          isLiked = video.likes.some(likeId => {
            const likeIdStr = likeId.toString();
            const userIdStr = userId.toString();
            console.log('Checking like:', likeIdStr, 'against user:', userIdStr, 'match:', likeIdStr === userIdStr);
            return likeIdStr === userIdStr;
          });
          
          // Check if user saved this video
          const user = await User.findById(userId);
          if (user && user.savedVideos) {
            isSaved = user.savedVideos.some(savedId => savedId.toString() === video._id.toString());
          }
        }

        console.log(`Video ${video._id}: isLiked = ${isLiked}, userId = ${userId}`); // Debug log

        return {
          ...video.toObject(),
          url: signedUrl,
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

// 5. Like/Unlike Video
router.post("/:id/like", authMiddleware, async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ msg: "Video not found" });

    const userId = req.userId;
    const isLiked = video.likes.includes(userId);

    if (isLiked) {
      // Unlike
      video.likes = video.likes.filter(id => id.toString() !== userId);
    } else {
      // Like
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

// 6. Save/Unsave Video
router.post("/:id/save", authMiddleware, async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ msg: "Video not found" });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ msg: "User not found" });

    // Initialize savedVideos array if it doesn't exist
    if (!user.savedVideos) {
      user.savedVideos = [];
    }

    const isSaved = user.savedVideos.includes(req.params.id);

    if (isSaved) {
      // Unsave
      user.savedVideos = user.savedVideos.filter(id => id.toString() !== req.params.id);
    } else {
      // Save
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

// 7. Get Comments for a Video
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

// 8. Add Comment to Video
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

    // Update video's comment count
    await Video.findByIdAndUpdate(req.params.id, {
      $inc: { commentsCount: 1 }
    });

    // Populate user info for the response
    const populatedComment = await Comment.findById(comment._id)
      .populate("user", "username avatar");

    res.status(201).json(populatedComment);
  } catch (err) {
    console.error("Add comment error:", err);
    res.status(500).json({ msg: "Could not add comment" });
  }
});

// 9. Delete Comment (Optional - for comment owner or video owner)
router.delete("/:videoId/comments/:commentId", authMiddleware, async (req, res) => {
  try {
    const { videoId, commentId } = req.params;
    
    const comment = await Comment.findById(commentId);
    if (!comment) return res.status(404).json({ msg: "Comment not found" });

    const video = await Video.findById(videoId);
    if (!video) return res.status(404).json({ msg: "Video not found" });

    // Check if user is comment owner or video owner
    if (comment.user.toString() !== req.userId && video.user.toString() !== req.userId) {
      return res.status(403).json({ msg: "Not authorized to delete this comment" });
    }

    await Comment.findByIdAndDelete(commentId);

    // Update video's comment count
    await Video.findByIdAndUpdate(videoId, {
      $inc: { commentsCount: -1 }
    });

    res.json({ msg: "Comment deleted successfully" });
  } catch (err) {
    console.error("Delete comment error:", err);
    res.status(500).json({ msg: "Could not delete comment" });
  }
});

// 10. Get User's Saved Videos
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
        isSaved: true
      };
    });

    res.json(videosWithUrls);
  } catch (err) {
    console.error("Get saved videos error:", err);
    res.status(500).json({ msg: "Could not fetch saved videos" });
  }
});

// 11. Get Video Statistics (Optional - for analytics)
router.get("/:id/stats", authMiddleware, async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ msg: "Video not found" });

    const commentsCount = await Comment.countDocuments({ video: req.params.id });
    const likesCount = video.likes.length;
    
    // You could add more stats like views, shares, etc.
    
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

router.get("/user/:userId", authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    const userVideos = await Video.find({ user: userId })
      .populate("user", "username avatar")
      .sort({ createdAt: -1 });

    const videosWithUrls = await Promise.all(
      userVideos.map(async (video) => {
        // Generate signed URL
        let signedUrl = null;
        if (video.key && process.env.WASABI_BUCKET) {
          signedUrl = s3.getSignedUrl("getObject", {
            Bucket: process.env.WASABI_BUCKET,
            Key: video.key,
            Expires: 3600,
          });
        }

        // Get comment count
        const commentsCount = await Comment.countDocuments({ video: video._id });

        // Check if current user has liked/saved this video
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
          url: signedUrl,
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

router.get("/liked", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    console.log('Fetching liked videos for user:', userId);
    
    // Find videos that the current user has liked
    const likedVideos = await Video.find({
      likes: { $in: [userId] }
    })
    .populate("user", "username avatar")
    .sort({ createdAt: -1 });

    console.log('Found liked videos:', likedVideos.length);

    const videosWithUrls = await Promise.all(
      likedVideos.map(async (video) => {
        // Generate signed URL
        let signedUrl = null;
        if (video.key && process.env.WASABI_BUCKET) {
          signedUrl = s3.getSignedUrl("getObject", {
            Bucket: process.env.WASABI_BUCKET,
            Key: video.key,
            Expires: 3600,
          });
        }

        // Get comment count
        const commentsCount = await Comment.countDocuments({ video: video._id });

        // Check if user saved this video
        const user = await User.findById(userId);
        const isSaved = user?.savedVideos?.some(savedId => savedId.toString() === video._id.toString()) || false;

        return {
          ...video.toObject(),
          url: signedUrl,
          commentsCount,
          isLiked: true, // Always true for liked videos
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


export default router;