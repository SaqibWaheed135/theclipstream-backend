import mongoose from "mongoose";

const VideoSchema = new mongoose.Schema(
  {
    title: { type: String, default: "" },
    description: { type: String, default: "" },
    key: { type: String, required: true }, // Wasabi raw MP4 key

    // 🔹 HLS playlist (after FFmpeg worker processes video)
    hlsUrl: { type: String, default: "" },  // 👈 NEW FIELD

    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    // Engagement
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    commentsCount: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    shares: { type: Number, default: 0 },

    // Metadata
    hashtags: [{ type: String }],

    // Privacy
    privacy: {
      type: String,
      enum: ["public", "friends", "private"],
      default: "public",
    },
    allowComments: { type: Boolean, default: true },
    allowDuet: { type: Boolean, default: true },
    allowDownload: { type: Boolean, default: true },

    // Video technical details
    duration: { type: Number },
    fileSize: { type: Number },
    resolution: { type: String },
    format: { type: String },

    // Moderation
    isReported: { type: Boolean, default: false },
    reportCount: { type: Number, default: 0 },
    isBlocked: { type: Boolean, default: false },

    // Featured
    isFeatured: { type: Boolean, default: false },

    // 🔹 Approval field
    isApproved: { type: Boolean, default: false },  // ✅

    // Location
    location: { type: String, default: "" }
  },
  { 
    timestamps: true,
    indexes: [
      { user: 1, createdAt: -1 },
      { hashtags: 1 },
      { privacy: 1, createdAt: -1 },
      { likes: 1 },
      { views: -1 },
      { isFeatured: 1, createdAt: -1 },
      { isApproved: 1, createdAt: -1 }
    ]
  }
);

// Virtuals
VideoSchema.virtual("likesCount").get(function() {
  return this.likes ? this.likes.length : 0;
});

VideoSchema.virtual("engagementRate").get(function() {
  if (this.views === 0) return 0;
  return (((this.likesCount + this.commentsCount) / this.views) * 100).toFixed(2);
});

// Increment helpers
VideoSchema.methods.incrementViews = function() {
  this.views += 1;
  return this.save();
};
VideoSchema.methods.incrementShares = function() {
  this.shares += 1;
  return this.save();
};

// Static queries
VideoSchema.statics.getTrending = function(limit = 10) {
  return this.find({ privacy: "public", isApproved: true })
    .sort({ views: -1, likes: -1, createdAt: -1 })
    .limit(limit)
    .populate("user", "username avatar");
};

VideoSchema.statics.getByHashtag = function(hashtag, limit = 20) {
  return this.find({ hashtags: hashtag, privacy: "public", isApproved: true })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate("user", "username avatar");
};

// Ensure virtuals included
VideoSchema.set("toJSON", { virtuals: true });
VideoSchema.set("toObject", { virtuals: true });

// Hooks for user video count
VideoSchema.post("save", async function(doc) {
  if (doc.isNew) {
    await mongoose.model("User").findByIdAndUpdate(doc.user, {
      $inc: { totalVideos: 1 }
    });
  }
});
VideoSchema.post("findOneAndDelete", async function(doc) {
  if (doc) {
    await mongoose.model("User").findByIdAndUpdate(doc.user, {
      $inc: { totalVideos: -1 }
    });
  }
});

const Video = mongoose.model("Video", VideoSchema);
export default Video;
