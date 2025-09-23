// models/Recharge.js - Updated with USDT support
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
    enum: ['card', 'paypal', 'apple', 'bank', 'usdt'], // Added USDT
    default: 'bank'
  },
  status: {
    type: String,
    required: true,
    enum: ['pending', 'approved', 'rejected', 'cancelled', 'failed', 'expired'], // Added failed and expired for USDT
    default: 'pending'
  },
  details: {
    // Common user details
    fullName: String,
    email: {
      type: String,
      lowercase: true
    },
    phone: String,
    
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
    
    // USDT Payment details
    usdtAmount: {
      type: Number,
      min: 0
    },
    walletAddress: String, // USDT wallet address for payment
    transactionHash: String, // Blockchain transaction hash
    paymentUrl: String, // Payment gateway URL
    qrCode: String, // QR code for payment
    confirmedAmount: Number, // Actually confirmed amount
    blockchainNetwork: {
      type: String,
      enum: ['TRC20', 'ERC20', 'BEP20'],
      default: 'TRC20'
    },
    contractAddress: {
      type: String,
      default: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' // USDT TRC20 contract address
    },
    confirmationBlocks: {
      type: Number,
      default: 1
    },
    paymentExpiresAt: Date, // When the payment link expires
    
    // Additional metadata
    ipAddress: String,
    userAgent: String,
    geolocation: {
      country: String,
      region: String,
      city: String
    },
    
    // Error handling
    errorMessage: String,
    errorCode: String,
  },
  metadata: {
    exchangeRate: {
      type: Number,
      default: 10 // Default rate (can be different for USDT vs USD)
    },
    bonusPoints: {
      type: Number,
      default: 0
    },
    totalPoints: {
      type: Number,
      default: function() {
        return this.pointsToAdd + this.metadata?.bonusPoints || 0;
      }
    },
    paymentGateway: String, // stripe, paypal, usdt_tron, etc.
    transactionReference: String,
    adminNotes: String,
    rejectionReason: String,
    
    // USDT specific metadata
    usdtGatewayOrderId: String, // Order ID from USDT payment gateway
    blockchainConfirmations: {
      type: Number,
      default: 0
    },
    paymentAttempts: {
      type: Number,
      default: 1
    },
    lastCheckedAt: Date, // Last time we checked payment status
    autoApproved: {
      type: Boolean,
      default: false
    },
    
    // Rate and pricing info
    usdtRateAtTime: Number, // USDT to points rate when order was created
    usdPriceAtTime: Number, // USD equivalent price when order was created
  },
  requestedAt: {
    type: Date,
    default: Date.now
  },
  approvedAt: Date,
  rejectedAt: Date,
  cancelledAt: Date,
  failedAt: Date,
  expiredAt: Date,
  cancelledBy: {
    type: String,
    enum: ['user', 'admin', 'system'],
    default: 'user'
  },
  
  // Approval workflow
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User' // Admin who approved
  },
  rejectedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User' // Admin who rejected
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
rechargeSchema.index({ method: 1, status: 1 });
rechargeSchema.index({ requestId: 1 });
rechargeSchema.index({ 'details.transactionHash': 1 }); // For USDT transaction lookups
rechargeSchema.index({ 'details.walletAddress': 1 }); // For USDT wallet lookups
rechargeSchema.index({ 'metadata.usdtGatewayOrderId': 1 }); // For USDT gateway lookups

// Pre-save middleware to update updatedAt
rechargeSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  
  // Set appropriate timestamp based on status change
  if (this.isModified('status')) {
    const now = new Date();
    switch (this.status) {
      case 'approved':
        if (!this.approvedAt) this.approvedAt = now;
        break;
      case 'rejected':
        if (!this.rejectedAt) this.rejectedAt = now;
        break;
      case 'cancelled':
        if (!this.cancelledAt) this.cancelledAt = now;
        break;
      case 'failed':
        if (!this.failedAt) this.failedAt = now;
        break;
      case 'expired':
        if (!this.expiredAt) this.expiredAt = now;
        break;
    }
  }
  
  next();
});

// Static method to get user's pending recharges count
rechargeSchema.statics.getPendingCount = async function(userId, method = null) {
  const query = { 
    userId, 
    status: 'pending' 
  };
  
  if (method) {
    query.method = method;
  }
  
  return await this.countDocuments(query);
};

// Static method to get recharge summary for user
rechargeSchema.statics.getUserSummary = async function(userId, method = null) {
  const matchQuery = { userId: mongoose.Types.ObjectId(userId) };
  if (method) {
    matchQuery.method = method;
  }
  
  const aggregate = [
    { $match: matchQuery },
    {
      $group: {
        _id: null,
        totalRequested: { $sum: '$amount' },
        totalPointsRequested: { $sum: '$pointsToAdd' },
        totalApproved: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, '$amount', 0] } },
        totalApprovedPoints: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, '$pointsToAdd', 0] } },
        totalRejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
        totalCancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
        totalFailed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        totalExpired: { $sum: { $cond: [{ $eq: ['$status', 'expired'] }, 1, 0] } },
        pendingCount: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
        
        // Method-specific totals
        usdtTotal: { $sum: { $cond: [{ $eq: ['$method', 'usdt'] }, '$amount', 0] } },
        bankTotal: { $sum: { $cond: [{ $eq: ['$method', 'bank'] }, '$amount', 0] } },
        cardTotal: { $sum: { $cond: [{ $eq: ['$method', 'card'] }, '$amount', 0] } },
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
    totalFailed: 0,
    totalExpired: 0,
    pendingCount: 0,
    usdtTotal: 0,
    bankTotal: 0,
    cardTotal: 0
  };
};

// Static method to get USDT statistics
rechargeSchema.statics.getUsdtStats = async function() {
  const aggregate = [
    { $match: { method: 'usdt' } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalAmount: { $sum: '$amount' },
        totalPoints: { $sum: '$pointsToAdd' }
      }
    }
  ];
  
  const results = await this.aggregate(aggregate);
  const stats = {
    pending: { count: 0, totalAmount: 0, totalPoints: 0 },
    approved: { count: 0, totalAmount: 0, totalPoints: 0 },
    failed: { count: 0, totalAmount: 0, totalPoints: 0 },
    expired: { count: 0, totalAmount: 0, totalPoints: 0 },
    rejected: { count: 0, totalAmount: 0, totalPoints: 0 },
    cancelled: { count: 0, totalAmount: 0, totalPoints: 0 }
  };
  
  results.forEach(result => {
    if (stats[result._id]) {
      stats[result._id] = {
        count: result.count,
        totalAmount: result.totalAmount,
        totalPoints: result.totalPoints
      };
    }
  });
  
  return stats;
};

// Instance method to get formatted transaction ID
rechargeSchema.methods.getTransactionId = function() {
  return this.requestId;
};

// Instance method to check if payment is expired
rechargeSchema.methods.isExpired = function() {
  if (this.method === 'usdt' && this.details.paymentExpiresAt) {
    return new Date() > this.details.paymentExpiresAt;
  }
  return false;
};

// Instance method to get remaining time for payment
rechargeSchema.methods.getRemainingTime = function() {
  if (this.method === 'usdt' && this.details.paymentExpiresAt) {
    const now = new Date();
    const expires = new Date(this.details.paymentExpiresAt);
    return Math.max(0, expires.getTime() - now.getTime());
  }
  return 0;
};

// Instance method to format payment method display
rechargeSchema.methods.getMethodDisplay = function() {
  const methodMap = {
    'usdt': 'USDT (TRC20)',
    'bank': 'Bank Transfer',
    'card': 'Credit/Debit Card',
    'paypal': 'PayPal',
    'apple': 'Apple Pay'
  };
  return methodMap[this.method] || this.method.toUpperCase();
};

// Virtual for full points amount (including bonus)
rechargeSchema.virtual('totalPoints').get(function() {
  return this.pointsToAdd + (this.metadata?.bonusPoints || 0);
});

// Virtual for status badge class (for frontend)
rechargeSchema.virtual('statusBadge').get(function() {
  const status = this.status;
  switch(status) {
    case 'pending': return 'bg-yellow-100 text-yellow-800';
    case 'approved': return 'bg-green-100 text-green-800';
    case 'rejected': return 'bg-red-100 text-red-800';
    case 'cancelled': return 'bg-gray-100 text-gray-800';
    case 'failed': return 'bg-red-100 text-red-800';
    case 'expired': return 'bg-orange-100 text-orange-800';
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

// Virtual for USDT payment URL
rechargeSchema.virtual('usdtPaymentUrl').get(function() {
  if (this.method === 'usdt' && this.details?.paymentUrl) {
    return this.details.paymentUrl;
  }
  return null;
});

// Virtual for blockchain explorer URL
rechargeSchema.virtual('blockchainExplorerUrl').get(function() {
  if (this.method === 'usdt' && this.details?.transactionHash) {
    const network = this.details.blockchainNetwork || 'TRC20';
    switch (network) {
      case 'TRC20':
        return `https://tronscan.org/#/transaction/${this.details.transactionHash}`;
      case 'ERC20':
        return `https://etherscan.io/tx/${this.details.transactionHash}`;
      case 'BEP20':
        return `https://bscscan.com/tx/${this.details.transactionHash}`;
      default:
        return null;
    }
  }
  return null;
});

// Ensure virtuals are included in toJSON/toObject
rechargeSchema.set('toJSON', { virtuals: true });
rechargeSchema.set('toObject', { virtuals: true });

export default mongoose.model('Recharge', rechargeSchema);