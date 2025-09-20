// models/Withdrawal.js
import mongoose from "mongoose";

const withdrawalSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  requestId: {
    type: String,
    required: true,
    unique: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  pointsToDeduct: {
    type: Number,
    required: true,
    min: 0
  },
  method: {
    type: String,
    required: true,
    enum: ['paypal', 'bank', 'card']
  },
  status: {
    type: String,
    required: true,
    enum: ['pending', 'approved', 'rejected', 'cancelled', 'completed'],
    default: 'pending'
  },
  details: {
    fullName: {
      type: String,
      required: true
    },
    email: {
      type: String,
      required: true
    },
    phone: {
      type: String,
      required: true
    },
    paypalEmail: {
      type: String,
      required: function() { return this.method === 'paypal'; }
    },
    bankDetails: {
      bankName: String,
      accountNumber: String,
      routingNumber: String,
      accountHolderName: String,
      swiftCode: String
    },
    cardDetails: {
      cardNumber: String,
      cardholderName: String,
      expiryDate: String
    },
    address: {
      street: String,
      city: String,
      state: String,
      zipCode: String,
      country: String
    }
  },
  // Request timestamps
  requestedAt: {
    type: Date,
    default: Date.now
  },
  // Approval/Rejection timestamps and info
  approvedAt: {
    type: Date
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  rejectedAt: {
    type: Date
  },
  rejectedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  rejectionReason: {
    type: String
  },
  // Cancellation info
  cancelledAt: {
    type: Date
  },
  cancelledBy: {
    type: String,
    enum: ['user', 'admin']
  },
  // Completion info
  completedAt: {
    type: Date
  },
  // Admin notes
  adminNotes: {
    type: String
  },
  // Metadata
  metadata: {
    userBalance: Number, // User's balance at time of request
    exchangeRate: Number, // Points per dollar at time of request
    fees: {
      percentage: Number,
      fixed: Number,
      total: Number
    },
    paymentProvider: String,
    paymentTransactionId: String,
    ipAddress: String,
    userAgent: String
  }
}, {
  timestamps: true
});

// Indexes for performance
withdrawalSchema.index({ userId: 1, status: 1 });
withdrawalSchema.index({ requestId: 1 });
withdrawalSchema.index({ status: 1, requestedAt: -1 });
withdrawalSchema.index({ method: 1, status: 1 });

// Virtual for formatted amount
withdrawalSchema.virtual('formattedAmount').get(function() {
  return `$${this.amount.toFixed(2)}`;
});

// Method to calculate processing time
withdrawalSchema.methods.getProcessingTime = function() {
  if (this.status === 'pending') {
    const now = new Date();
    const requestTime = this.requestedAt;
    const diffHours = Math.floor((now - requestTime) / (1000 * 60 * 60));
    return `${diffHours} hours ago`;
  }
  
  if (this.approvedAt) {
    const diffHours = Math.floor((this.approvedAt - this.requestedAt) / (1000 * 60 * 60));
    return `Processed in ${diffHours} hours`;
  }
  
  return 'N/A';
};

// Static method to get withdrawal statistics
withdrawalSchema.statics.getStatistics = async function(dateRange = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - dateRange);
  
  return await this.aggregate([
    {
      $match: {
        requestedAt: { $gte: startDate }
      }
    },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalAmount: { $sum: '$amount' },
        totalPoints: { $sum: '$pointsToDeduct' }
      }
    }
  ]);
};

const Withdrawal = mongoose.model("Withdrawal", withdrawalSchema);

export default Withdrawal;