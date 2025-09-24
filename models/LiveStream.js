// models/LiveStream.js
import mongoose from "mongoose";

const liveStreamSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    maxLength: 100
  },
  description: {
    type: String,
    trim: true,
    maxLength: 500,
    default: ""
  },
  streamer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  status: {
    type: String,
    enum: ["waiting", "live", "ended", "paused"],
    default: "waiting"
  },
  privacy: {
    type: String,
    enum: ["public", "private"],
    default: "public"
  },
  // Streams array for main streamer and co-hosts
  streams: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    joinedAt: {
      type: Date,
      default: Date.now
    },
    rtmpUrl: {
      type: String,
      required: true
    },
    streamKey: {
      type: String,
      required: true
    },
    playbackUrl: {
      type: String,
      required: true
    }
  }],
  // Viewer management
  viewers: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },
    joinedAt: {
      type: Date,
      default: Date.now
    }
  }],
  // Analytics
  totalViews: {
    type: Number,
    default: 0
  },
  peakViewers: {
    type: Number,
    default: 0
  },
  heartsReceived: {
    type: Number,
    default: 0
  },
  // Timing
  startedAt: Date,
  endedAt: Date,
  duration: {
    type: Number, // in seconds
    default: 0
  },
  // Interactions
  comments: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },
    text: {
      type: String,
      required: true,
      maxLength: 200
    },
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  // Moderation
  reports: [{
    reporter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },
    reason: {
      type: String,
      required: true
    },
    reportedAt: {
      type: Date,
      default: Date.now
    }
  }],
  isBlocked: {
    type: Boolean,
    default: false
  },
  blockedReason: String,
  // Technical details
  streamKey: String,
  rtmpUrl: String,
  // Thumbnail for ended streams
  thumbnail: String,
  // Save as video after stream ends
  saveAsVideo: {
    type: Boolean,
    default: true
  },
  savedVideoId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Video"
  }
}, {
  timestamps: true,
  indexes: [
    { key: { streamer: 1, status: 1 } },
    { key: { status: 1, createdAt: -1 } },
    { key: { privacy: 1, status: 1 } }
  ]
});

// Virtual for current viewer count
liveStreamSchema.virtual('currentViewers').get(function() {
  return this.viewers ? this.viewers.length : 0;
});

// Virtual for stream duration in real-time
liveStreamSchema.virtual('currentDuration').get(function() {
  if (this.status === 'live' && this.startedAt) {
    return Math.floor((Date.now() - this.startedAt.getTime()) / 1000);
  }
  return this.duration || 0;
});

// Method to add viewer
liveStreamSchema.methods.addViewer = function(userId) {
  const existingViewer = this.viewers.find(v => 
    v.user && v.user.toString() === userId
  );
  
  if (!existingViewer) {
    this.viewers.push({
      user: userId,
      joinedAt: new Date()
    });
    
    this.totalViews += 1;
    
    // Update peak viewers
    if (this.viewers.length > this.peakViewers) {
      this.peakViewers = this.viewers.length;
    }
  }
  
  return this.save();
};

// Method to remove viewer
liveStreamSchema.methods.removeViewer = function(userId) {
  this.viewers = this.viewers.filter(v => 
    !v.user || v.user.toString() !== userId
  );
  
  return this.save();
};

// Method to add comment
liveStreamSchema.methods.addComment = function(userId, text) {
  this.comments.push({
    user: userId,
    text: text.trim(),
    timestamp: new Date()
  });
  
  return this.save();
};

// Method to increment hearts
liveStreamSchema.methods.addHeart = function() {
  this.heartsReceived += 1;
  return this.save();
};

// Static method to get active streams
liveStreamSchema.statics.getActiveStreams = function(limit = 20) {
  return this.find({ 
    status: 'live', 
    privacy: 'public',
    isBlocked: false
  })
    .populate('streamer', 'username avatar')
    .populate('streams.user', 'username avatar')
    .sort({ startedAt: -1 })
    .limit(limit);
};

// Pre-save hook to calculate duration on stream end
liveStreamSchema.pre('save', function(next) {
  if (this.isModified('status') && this.status === 'ended' && this.startedAt && !this.duration) {
    this.duration = Math.floor((Date.now() - this.startedAt.getTime()) / 1000);
    this.endedAt = new Date();
  }
  next();
});

// Ensure virtual fields are serialized
liveStreamSchema.set('toJSON', { virtuals: true });
liveStreamSchema.set('toObject', { virtuals: true });

const LiveStream = mongoose.model("LiveStream", liveStreamSchema);
export default LiveStream;