// models/Transaction.js
import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: ['recharge', 'spend', 'award', 'refund', 'bonus'],
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true
  },
  pointsAmount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    default: 'USD',
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'cancelled', 'refunded'],
    default: 'pending',
    required: true,
    index: true
  },
  paymentMethod: {
    type: String,
    enum: ['card', 'paypal', 'apple', 'google', 'bank', 'crypto', 'manual'],
    required: true
  },
  paymentGateway: {
    type: String,
    enum: ['stripe', 'paypal', 'razorpay', 'apple_pay', 'google_pay', 'manual'],
    required: true
  },
  // External payment reference IDs
  transactionId: {
    type: String,
    unique: true,
    required: true,
    index: true
  },
  paymentIntentId: String, // Stripe Payment Intent ID
  paypalOrderId: String,   // PayPal Order ID
  razorpayOrderId: String, // Razorpay Order ID
  
  // Payment details (encrypted/hashed)
  paymentDetails: {
    last4: String,           // Last 4 digits of card
    cardBrand: String,       // visa, mastercard, etc.
    paypalEmail: String,     // PayPal email (hashed)
    bankName: String,        // Bank name for bank transfers
    // Never store full card details, CVV, or sensitive info
  },
  
  // User information at time of transaction
  userInfo: {
    fullName: String,
    email: String,
    phone: String,
    // Billing address for tax/compliance
    address: {
      street: String,
      city: String,
      state: String,
      zipCode: String,
      country: String
    }
  },
  
  // Financial details
  fees: {
    processingFee: {
      type: Number,
      default: 0
    },
    platformFee: {
      type: Number,
      default: 0
    },
    totalFees: {
      type: Number,
      default: 0
    }
  },
  
  // Exchange rates (if applicable)
  exchangeRate: {
    type: Number,
    default: 1
  },
  
  // Bonus points calculation
  bonusPoints: {
    type: Number,
    default: 0
  },
  basePoints: {
    type: Number,
    required: true
  },
  
  // Transaction metadata
  description: {
    type: String,
    required: true
  },
  notes: String,
  
  // IP and device info for fraud detection
  metadata: {
    ipAddress: String,
    userAgent: String,
    deviceId: String,
    location: {
      country: String,
      region: String,
      city: String
    }
  },
  
  // Webhook data from payment providers
  webhookData: mongoose.Schema.Types.Mixed,
  
  // Refund information
  refundInfo: {
    refundId: String,
    refundAmount: Number,
    refundReason: String,
    refundedAt: Date
  },
    refundReason: String,
 refundedAt: Date,
 
  
  // Admin actions
  adminNotes: String,
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  completedAt: Date,
  failedAt: Date
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for performance
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ status: 1, createdAt: -1 });
transactionSchema.index({ transactionId: 1 });
transactionSchema.index({ type: 1, status: 1 });
transactionSchema.index({ 'userInfo.email': 1 });

// Virtual for net amount (after fees)
transactionSchema.virtual('netAmount').get(function() {
  return this.amount - (this.fees?.totalFees || 0);
});

// Pre-save middleware to update timestamps
transactionSchema.pre('save', function(next) {
  if (this.isModified() && !this.isNew) {
    this.updatedAt = new Date();
  }
  next();
});

// Static methods for analytics
transactionSchema.statics.getRevenueStats = function(startDate, endDate) {
  return this.aggregate([
    {
      $match: {
        status: 'completed',
        type: 'recharge',
        createdAt: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        totalRevenue: { $sum: '$amount' },
        totalTransactions: { $sum: 1 },
        totalFees: { $sum: '$fees.totalFees' },
        totalPointsIssued: { $sum: '$pointsAmount' }
      }
    }
  ]);
};

transactionSchema.statics.getUserTransactionHistory = function(userId, options = {}) {
  const {
    page = 1,
    limit = 20,
    type = null,
    status = null,
    startDate = null,
    endDate = null
  } = options;

  const match = { userId };
  
  if (type) match.type = type;
  if (status) match.status = status;
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = startDate;
    if (endDate) match.createdAt.$lte = endDate;
  }

  return this.find(match)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .select('-webhookData -paymentDetails -userInfo.phone -metadata');
};

// Instance methods
transactionSchema.methods.markAsCompleted = function() {
  this.status = 'completed';
  this.completedAt = new Date();
  return this.save();
};

transactionSchema.methods.markAsFailed = function(reason) {
  this.status = 'failed';
  this.failedAt = new Date();
  this.notes = reason;
  return this.save();
};

const Transaction = mongoose.model('Transaction', transactionSchema);
export default Transaction;