// models/FollowRequest.js
import mongoose from 'mongoose';

const followRequestSchema = new mongoose.Schema({
  requester: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'rejected'],
    default: 'pending'
  },
  message: {
    type: String,
    maxLength: 200,
    default: ''
  }
}, {
  timestamps: true
});

// Compound index to prevent duplicate requests
followRequestSchema.index({ requester: 1, recipient: 1, status: 1 });

// Index for efficient queries
followRequestSchema.index({ recipient: 1, status: 1, createdAt: -1 });
followRequestSchema.index({ requester: 1, status: 1, createdAt: -1 });

// Prevent users from sending follow requests to themselves
followRequestSchema.pre('save', function(next) {
  if (this.requester.equals(this.recipient)) {
    const error = new Error('Users cannot send follow requests to themselves');
    return next(error);
  }
  next();
});

const FollowRequest = mongoose.model('FollowRequest', followRequestSchema);
export default FollowRequest;