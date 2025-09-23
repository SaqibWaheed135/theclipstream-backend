// models/Points.js
import mongoose from 'mongoose';

// Points Balance Schema
const pointsBalanceSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true
  },
  balance: {
    type: Number,
    default: 0,
    min: 0,
    required: true
  },
  totalEarned: {
    type: Number,
    default: 0,
    min: 0
  },
  totalSpent: {
    type: Number,
    default: 0,
    min: 0
  },
  totalRecharged: {
    type: Number,
    default: 0,
    min: 0
  },
  // Lifetime statistics
  lifetimeStats: {
    totalTransactions: {
      type: Number,
      default: 0
    },
    averageRecharge: {
      type: Number,
      default: 0
    },
    lastRechargeAmount: Number,
    lastRechargeDate: Date,
    firstRechargeDate: Date
  },
  // Account status
  status: {
    type: String,
    enum: ['active', 'frozen', 'suspended'],
    default: 'active'
  },
  freezeReason: String,
  
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

// Pre-save middleware to update timestamp
pointsBalanceSchema.pre('save', function(next) {
  if (this.isModified() && !this.isNew) {
    this.updatedAt = new Date();
  }
  next();
});

// Instance methods
pointsBalanceSchema.methods.addPoints = function(amount, transactionId) {
  this.balance += amount;
  this.totalEarned += amount;
  this.lifetimeStats.totalTransactions += 1;
  return this.save();
};

pointsBalanceSchema.methods.deductPoints = function(amount, transactionId) {
  if (this.balance < amount) {
    throw new Error('Insufficient points balance');
  }
  this.balance -= amount;
  this.totalSpent += amount;
  this.lifetimeStats.totalTransactions += 1;
  return this.save();
};

pointsBalanceSchema.methods.addRecharge = function(amount) {
  this.totalRecharged += amount;
  this.lifetimeStats.lastRechargeAmount = amount;
  this.lifetimeStats.lastRechargeDate = new Date();
  if (!this.lifetimeStats.firstRechargeDate) {
    this.lifetimeStats.firstRechargeDate = new Date();
  }
  this.lifetimeStats.averageRecharge = this.totalRecharged / this.lifetimeStats.totalTransactions;
  return this.save();
};

// Recharge Packages Schema
const rechargePackageSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  points: {
    type: Number,
    required: true,
    min: 0
  },
  bonusPoints: {
    type: Number,
    default: 0,
    min: 0
  },
  currency: {
    type: String,
    default: 'USD',
    required: true
  },
  isPopular: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  },
  discount: {
    percentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    validUntil: Date,
    description: String
  },
  // Regional pricing
  regionalPricing: [{
    country: String,
    currency: String,
    amount: Number,
    exchangeRate: Number
  }],
  description: String,
  icon: String,
  color: String,
  
  // Analytics
  stats: {
    totalPurchases: {
      type: Number,
      default: 0
    },
    totalRevenue: {
      type: Number,
      default: 0
    },
    lastPurchased: Date
  },
  
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

// Indexes for performance
rechargePackageSchema.index({ isActive: 1, amount: 1 });
rechargePackageSchema.index({ isPopular: -1, amount: 1 });

// Virtual for total points (including bonus)
rechargePackageSchema.virtual('totalPoints').get(function() {
  return this.points + this.bonusPoints;
});

// Virtual for discounted amount
rechargePackageSchema.virtual('discountedAmount').get(function() {
  if (this.discount.percentage > 0 && this.discount.validUntil > new Date()) {
    return this.amount * (1 - this.discount.percentage / 100);
  }
  return this.amount;
});

// Points Transaction Log Schema (for audit trail)
const pointsTransactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  transactionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  type: {
    type: String,
    enum: ['credit', 'debit'],
    required: true
  },
 // models/Points.js - Update your existing category enum
category: {
  type: String,
  enum: [
    // Existing categories
    'recharge',
    'gift',
    'boost',
    'reward',
    'refund',
    'bonus',
    'admin_adjustment',
    // Withdrawal categories
    'withdrawal_request',
    'withdrawal_approved',
    'withdrawal_rejected',
    
    // ✅ ADD THESE NEW RECHARGE CATEGORIES
    'recharge_request',
    'recharge_approved',
    'recharge_rejected',
    'recharge_cancelled',
    'points_transfer',
    "usdt_recharge_approved"
  ],
  required: true,
  index: true
},

  amount: {
    type: Number,
    required: true
  },
  balanceBefore: {
    type: Number,
    required: true
  },
  balanceAfter: {
    type: Number,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  metadata: {
     recipientId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User' 
    },
    senderId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User' 
    },
    relatedTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction'
    },
    videoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Video'
    },
    giftId: String,
    adminUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    notes: String
  },
  
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: { createdAt: true, updatedAt: false }
});

// Indexes for audit queries
pointsTransactionSchema.index({ userId: 1, createdAt: -1 });
pointsTransactionSchema.index({ category: 1, createdAt: -1 });
pointsTransactionSchema.index({ 'metadata.relatedTransaction': 1 });

// Payment Method Configuration Schema
const paymentMethodSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true
  },
  identifier: {
    type: String,
    required: true,
    unique: true
  },
  provider: {
    type: String,
    enum: ['stripe', 'paypal', 'razorpay', 'apple_pay', 'google_pay', 'bank_transfer'],
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  supportedCountries: [String],
  supportedCurrencies: [String],
  
  // Processing fees (passed to user or absorbed)
  fees: {
    fixed: {
      type: Number,
      default: 0
    },
    percentage: {
      type: Number,
      default: 0
    },
    currency: {
      type: String,
      default: 'USD'
    }
  },
  
  // Configuration for each provider
  config: {
    stripe: {
      publishableKey: String,
      webhookEndpoint: String
    },
    paypal: {
      clientId: String,
      webhookId: String,
      environment: {
        type: String,
        enum: ['sandbox', 'production'],
        default: 'sandbox'
      }
    },
    razorpay: {
      keyId: String,
      webhookSecret: String
    }
  },
  
  // UI Configuration
  ui: {
    icon: String,
    color: String,
    order: {
      type: Number,
      default: 0
    },
    description: String
  },
  
  // Analytics
  stats: {
    totalTransactions: {
      type: Number,
      default: 0
    },
    successRate: {
      type: Number,
      default: 100
    },
    averageProcessingTime: Number, // in seconds
    lastUsed: Date
  },
  
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

// Export all models
export const PointsBalance = mongoose.model('PointsBalance', pointsBalanceSchema);
export const RechargePackage = mongoose.model('RechargePackage', rechargePackageSchema);
export const PointsTransaction = mongoose.model('PointsTransaction', pointsTransactionSchema);
export const PaymentMethod = mongoose.model('PaymentMethod', paymentMethodSchema);