import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

// Default avatar generator function
function generateDefaultAvatar(username) {
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&color=fff&size=200&bold=true`;
}

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 30
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    minlength: 6 // Only required for non-Google users
  },
  googleId: {
    type: String,
    default: null,
    unique: true,
    sparse: true // Allows multiple null values
  },
  avatar: {
    type: String,
    default: function () {
      return generateDefaultAvatar(this.username || 'User');
    }
  },
  points: {
    type: Number,
    default: 5
  },

  // Video-related fields
  savedVideos: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "Video"
  }],

  // Follow system
  followers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  }],

  following: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  }],

  // Profile fields
  bio: {
    type: String,
    maxLength: 160,
    default: '',
    trim: true
  },

  isVerified: {
    type: Boolean,
    default: false
  },

  isPrivate: {
    type: Boolean,
    default: false
  },

  // Analytics
  totalLikes: {
    type: Number,
    default: 0
  },

  totalVideos: {
    type: Number,
    default: 0
  },

  // Messaging settings
  allowMessagesFrom: {
    type: String,
    enum: ['everyone', 'followers', 'mutual', 'none'],
    default: 'mutual' // Both must follow each other
  },

  // Notification settings
  emailNotifications: {
    type: Boolean,
    default: true
  },

  pushNotifications: {
    type: Boolean,
    default: true
  },

  followRequestNotifications: {
    type: Boolean,
    default: true
  },

  messageNotifications: {
    type: Boolean,
    default: true
  },

  // Privacy settings
  showEmail: {
    type: Boolean,
    default: false
  },

  showOnlineStatus: {
    type: Boolean,
    default: true
  },

  showLastSeen: {
    type: Boolean,
    default: true
  },

  // Activity tracking
  lastLogin: {
    type: Date,
    default: Date.now
  },

  lastSeen: {
    type: Date,
    default: Date.now
  },

  isOnline: {
    type: Boolean,
    default: false
  },

  // Account status
  isActive: {
    type: Boolean,
    default: true
  },

  // Additional security fields
  loginAttempts: {
    type: Number,
    default: 0
  },

  // Add these fields to your User schema
  inviteCode: {
    type: String,
    unique: true,
    sparse: true,
    default: function () {
      return this._id.toString();
    }
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  totalInvites: {
    type: Number,
    default: 0
  },
  inviteRewardEarned: {
    type: Number,
    default: 0
  },

  lockUntil: Date,

  // Social media links (optional)
  socialLinks: {
    instagram: {
      type: String,
      default: ''
    },
    twitter: {
      type: String,
      default: ''
    },
    youtube: {
      type: String,
      default: ''
    },
    website: {
      type: String,
      default: ''
    }
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Pre-save middleware to hash password and set default avatar
userSchema.pre('save', async function (next) {
  // Hash password only if modified and present
  if (this.isModified('password') && this.password) {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  }

  // Set default avatar if not provided
  if (this.isNew && !this.avatar) {
    this.avatar = generateDefaultAvatar(this.username);
  }

  // Update lastLogin on save for new users
  if (this.isNew) {
    this.lastLogin = new Date();
    this.lastSeen = new Date();
  }

  next();
});

// Compare password method
userSchema.methods.matchPassword = async function (password) {
  if (!this.password) return false;
  return bcrypt.compare(password, this.password);
};

// Method to update avatar
userSchema.methods.updateAvatar = function (newAvatarUrl) {
  this.avatar = newAvatarUrl || generateDefaultAvatar(this.username);
  return this.save();
};

// Method to check if user can login with password
userSchema.methods.hasPassword = function () {
  return !!this.password;
};

// Method to check if user is Google user
userSchema.methods.isGoogleUser = function () {
  return !!this.googleId;
};

// Method to check if user can receive messages from another user
userSchema.methods.canReceiveMessageFrom = function (senderId) {
  const senderIdStr = senderId.toString();

  switch (this.allowMessagesFrom) {
    case 'everyone':
      return true;
    case 'followers':
      return this.followers.some(follower => follower.toString() === senderIdStr);
    case 'mutual':
      return this.followers.some(follower => follower.toString() === senderIdStr) &&
        this.following.some(following => following.toString() === senderIdStr);
    case 'none':
      return false;
    default:
      return false;
  }
};

// Method to check if users are mutually following
userSchema.methods.isMutualWith = function (userId) {
  const userIdStr = userId.toString();
  return this.followers.some(follower => follower.toString() === userIdStr) &&
    this.following.some(following => following.toString() === userIdStr);
};

// Method to check if user is following another user
userSchema.methods.isFollowing = function (userId) {
  return this.following.some(following => following.toString() === userId.toString());
};

// Method to check if user is followed by another user
userSchema.methods.isFollowedBy = function (userId) {
  return this.followers.some(follower => follower.toString() === userId.toString());
};

// Method to update online status
userSchema.methods.setOnlineStatus = function (isOnline) {
  this.isOnline = isOnline;
  if (!isOnline) {
    this.lastSeen = new Date();
  }
  return this.save();
};

// Method to increment login attempts
userSchema.methods.incLoginAttempts = function () {
  // If we have a previous lock that has expired, restart at 1
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({
      $unset: {
        lockUntil: 1
      },
      $set: {
        loginAttempts: 1
      }
    });
  }

  const updates = { $inc: { loginAttempts: 1 } };

  // Lock account after 5 attempts for 2 hours
  if (this.loginAttempts + 1 >= 5 && !this.isLocked) {
    updates.$set = {
      lockUntil: Date.now() + 2 * 60 * 60 * 1000 // 2 hours
    };
  }

  return this.updateOne(updates);
};

// Method to reset login attempts
userSchema.methods.resetLoginAttempts = function () {
  return this.updateOne({
    $unset: {
      loginAttempts: 1,
      lockUntil: 1
    }
  });
};

// Virtual for account lock status
userSchema.virtual('isLocked').get(function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

// Virtual for follower count
userSchema.virtual('followersCount').get(function () {
  return this.followers ? this.followers.length : 0;
});

// Virtual for following count
userSchema.virtual('followingCount').get(function () {
  return this.following ? this.following.length : 0;
});

// Virtual for saved videos count
userSchema.virtual('savedVideosCount').get(function () {
  return this.savedVideos ? this.savedVideos.length : 0;
});

// Virtual for online status display
userSchema.virtual('onlineStatus').get(function () {
  if (!this.showOnlineStatus) return 'hidden';
  if (this.isOnline) return 'online';

  if (!this.showLastSeen) return 'offline';

  const now = new Date();
  const lastSeen = new Date(this.lastSeen);
  const diffMs = now - lastSeen;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 5) return 'recently';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return 'offline';
});

// Virtual for full profile (useful for API responses)
userSchema.virtual('profile').get(function () {
  return {
    id: this._id,
    username: this.username,
    email: this.showEmail ? this.email : undefined,
    avatar: this.avatar,
    bio: this.bio,
    points: this.points,
    isVerified: this.isVerified,
    isPrivate: this.isPrivate,
    followersCount: this.followersCount,
    followingCount: this.followingCount,
    totalLikes: this.totalLikes,
    totalVideos: this.totalVideos,
    onlineStatus: this.onlineStatus,
    isOnline: this.showOnlineStatus ? this.isOnline : undefined,
    lastSeen: this.showLastSeen ? this.lastSeen : undefined,
    socialLinks: this.socialLinks,
    createdAt: this.createdAt
  };
});

// Static method to find users for search
userSchema.statics.searchUsers = function (query, limit = 20) {
  return this.find({
    $or: [
      { username: { $regex: query, $options: 'i' } },
      { bio: { $regex: query, $options: 'i' } }
    ],
    isActive: true
  })
    .select('username avatar bio isVerified followersCount')
    .limit(limit)
    .sort({ followersCount: -1, createdAt: -1 });
};

// Static method to get suggested users (users with most followers)
userSchema.statics.getSuggestedUsers = function (excludeIds = [], limit = 10) {
  return this.find({
    _id: { $nin: excludeIds },
    isActive: true,
    isPrivate: false
  })
    .select('username avatar bio isVerified followersCount')
    .sort({ followersCount: -1, createdAt: -1 })
    .limit(limit);
};

// Indexes for better performance
userSchema.index({ username: 1 });
userSchema.index({ email: 1 });
userSchema.index({ googleId: 1 });
userSchema.index({ createdAt: -1 });
userSchema.index({ lastLogin: -1 });
userSchema.index({ followers: 1 });
userSchema.index({ following: 1 });
userSchema.index({ isOnline: 1, lastSeen: -1 });
userSchema.index({ isActive: 1, isPrivate: 1 });
userSchema.index({ followersCount: -1 });

// Compound indexes
userSchema.index({ username: 'text', bio: 'text' });
userSchema.index({ isActive: 1, followersCount: -1, createdAt: -1 });

// Ensure virtual fields are included in JSON output
userSchema.set('toJSON', {
  virtuals: true,
  transform: function (doc, ret) {
    // Remove sensitive fields from JSON output
    delete ret.password;
    delete ret.loginAttempts;
    delete ret.lockUntil;
    delete ret.__v;
    return ret;
  }
});

const User = mongoose.model('User', userSchema);
export default User;