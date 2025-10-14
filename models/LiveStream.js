import mongoose from 'mongoose';
const { Schema } = mongoose;


const liveStreamSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
  },
  description: {
    type: String,
    trim: true,
    maxlength: 500,
  },
  streamer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  privacy: {
    type: String,
    enum: ['public', 'private', 'unlisted'],
    default: 'public',
  },
  status: {
    type: String,
    enum: ['live', 'ended'],
    default: 'live',
  },
  startedAt: {
    type: Date,
    default: Date.now,
  },
  endedAt: {
    type: Date,
  },
  duration: {
    type: Number,
    default: 0, // in seconds
  },
  viewers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  currentViewers: {
    type: Number,
    default: 0,
  },
  totalViews: {
    type: Number,
    default: 0,
  },
  peakViewers: {
    type: Number,
    default: 0,
  },
  comments: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    text: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  }],
  heartsReceived: {
    type: Number,
    default: 0,
  },
  streams: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
    roomUrl: {
      type: String,
      required: true, // WebRTC URL
    },
    roomSid: {
      type: String, // For LiveKit room cleanup
    },
  }],
  reports: [{
    reporter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
    },
    reportedAt: {
      type: Date,
      default: Date.now,
    },
  }],
  points: {
    type: Number,
    default: 0
  },
  products: [{
  type: {
    type: String,
    enum: ['product', 'ad'],
    required: true
  },
  name: {
    type: String,
    required: true
  },
  description: {
    type: String
  },
  price: {
    type: Number,
    required: true
  },
  imageUrl: {
    type: String
  },
  link: {  // For ads, this could be external link; for products, purchase link or ID
    type: String
  },
  addedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  addedAt: {
    type: Date,
    default: Date.now
  }
}],
orders: [{
  productIndex: {  // Index in products array for reference
    type: Number,
    required: true
  },
  buyer: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  quantity: {
    type: Number,
    default: 1
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'cancelled'],
    default: 'pending'
  },
  orderedAt: {
    type: Date,
    default: Date.now
  }
}],
}, {
  timestamps: true,
  indexes: [
    { key: { streamer: 1, status: 1 } },
    { key: { status: 1, createdAt: -1 } },
    { key: { privacy: 1, status: 1 } },
  ],
});

// Virtual for formatted duration
liveStreamSchema.virtual('formattedDuration').get(function () {
  const hours = Math.floor(this.duration / 3600);
  const minutes = Math.floor((this.duration % 3600) / 60);
  const seconds = this.duration % 60;
  return `${hours > 0 ? hours + 'h ' : ''}${minutes > 0 ? minutes + 'm ' : ''}${seconds}s`;
});

// Methods for viewer and comment management
liveStreamSchema.methods.addViewer = async function (userId) {
  if (userId && !this.viewers.includes(userId)) {
    this.viewers.push(userId);
    this.currentViewers += 1;
    this.totalViews += 1;
    if (this.currentViewers > this.peakViewers) {
      this.peakViewers = this.currentViewers;
    }
    await this.save();
  }
};

liveStreamSchema.methods.removeViewer = async function (userId) {
  if (userId) {
    this.viewers = this.viewers.filter((id) => id.toString() !== userId.toString());
    this.currentViewers = Math.max(0, this.currentViewers - 1);
    await this.save();
  }
};

liveStreamSchema.methods.addComment = async function (userId, text) {
  this.comments.push({
    user: userId || null,
    text,
    timestamp: new Date(),
  });
  await this.save();
};

liveStreamSchema.methods.addHeart = async function () {
  this.heartsReceived += 1;
  await this.save();
};

liveStreamSchema.set('toJSON', { virtuals: true });
liveStreamSchema.set('toObject', { virtuals: true });

const LiveStream = mongoose.model('LiveStream', liveStreamSchema);
export default LiveStream;