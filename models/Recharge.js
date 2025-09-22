// models/Recharge.js
import mongoose from 'mongoose';

const rechargeSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  requestId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  amount: {
    type: Number,
    required: true,
    min: 1
  },
  pointsToAdd: {
    type: Number,
    required: true,
    min: 1
  },
  method: {
    type: String,
    required: true,
    enum: ['card', 'paypal', 'apple', 'bank'], // Add more methods as needed
    default: 'bank'
  },
  status: {
    type: String,
    required: true,
    enum: ['pending', 'approved', 'rejected', 'cancelled'],
    default: 'pending'
  },
  details: {
    fullName: {
      type: String,
      required: true
    },
    email: {
      type: String,
      required: true,
      lowercase: true
    },
    phone: {
      type: String,
      required: true
    },
    // Card details (for card payments)
    cardNumber: String, // Masked or last 4 digits
    expiryDate: String,
    cvv: String, // Should be encrypted or not stored
    cardholderName: String,
    // Billing address
    address: String,
    city: String,
    state: String,
    zipCode: String,
    country: String,
    // PayPal details
    paypalEmail: String,
    // Bank transfer details
    transactionId: String,
    transactionScreenshot: {
      filename: String,
      originalName: String,
      path: String,
      size: Number,
      mimetype: String,
      uploadedAt: { type: Date, default: Date.now }
    },
    // Additional metadata
    ipAddress: String,
    userAgent: String,
    geolocation: {
      country: String,
      region: String,
      city: String
    }
  },
  metadata: {
    exchangeRate: {
      type: Number,
      default: 10 // 1 dollar = 10 points base rate
    },
    bonusPoints: {
      type: Number,
      default: 0
    },
    totalPoints: {
      type: Number,
      default: function() {
        return this.pointsToAdd + this.metadata.bonusPoints;
      }
    },
    paymentGateway: String, // stripe, paypal, etc.
    transactionReference: String,
    adminNotes: String,
    rejectionReason: String
  },
  requestedAt: {
    type: Date,
    default: Date.now
  },
  approvedAt: Date,
  rejectedAt: Date,
  cancelledAt: Date,
  cancelledBy: {
    type: String,
    enum: ['user', 'admin', 'system'],
    default: 'user'
  },
  // Timestamps for audit trail
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Indexes for better performance
rechargeSchema.index({ userId: 1, status: 1 });
rechargeSchema.index({ status: 1, requestedAt: -1 });
rechargeSchema.index({ method: 1 });
rechargeSchema.index({ requestId: 1 });

// Pre-save middleware to update updatedAt
rechargeSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Static method to get user's pending recharges count
rechargeSchema.statics.getPendingCount = async function(userId) {
  return await this.countDocuments({ 
    userId, 
    status: 'pending' 
  });
};

// Static method to get recharge summary for user
rechargeSchema.statics.getUserSummary = async function(userId) {
  const aggregate = [
    { $match: { userId: mongoose.Types.ObjectId(userId) } },
    {
      $group: {
        _id: null,
        totalRequested: { $sum: '$amount' },
        totalPointsRequested: { $sum: '$pointsToAdd' },
        totalApproved: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, '$amount', 0] } },
        totalApprovedPoints: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, '$pointsToAdd', 0] } },
        totalRejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
        totalCancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
        pendingCount: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } }
      }
    }
  ];
  
  const result = await this.aggregate(aggregate);
  return result[0] || {
    totalRequested: 0,
    totalPointsRequested: 0,
    totalApproved: 0,
    totalApprovedPoints: 0,
    totalRejected: 0,
    totalCancelled: 0,
    pendingCount: 0
  };
};

// Instance method to get formatted transaction ID
rechargeSchema.methods.getTransactionId = function() {
  return this.requestId;
};

// Virtual for full points amount (including bonus)
rechargeSchema.virtual('totalPoints').get(function() {
  return this.pointsToAdd + (this.metadata.bonusPoints || 0);
});

// Virtual for status badge class (for frontend)
rechargeSchema.virtual('statusBadge').get(function() {
  const status = this.status;
  switch(status) {
    case 'pending': return 'bg-yellow-100 text-yellow-800';
    case 'approved': return 'bg-green-100 text-green-800';
    case 'rejected': return 'bg-red-100 text-red-800';
    case 'cancelled': return 'bg-gray-100 text-gray-800';
    default: return 'bg-gray-100 text-gray-800';
  }
});

// Virtual for screenshot URL (full path)
rechargeSchema.virtual('screenshotUrl').get(function() {
  if (this.details?.transactionScreenshot?.path) {
    return `${process.env.BASE_URL || 'http://localhost:5000'}${this.details.transactionScreenshot.path}`;
  }
  return null;
});

// Ensure virtuals are included in toJSON/toObject
rechargeSchema.set('toJSON', { virtuals: true });
rechargeSchema.set('toObject', { virtuals: true });

export default mongoose.model('Recharge', rechargeSchema);