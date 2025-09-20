// routes/paymentRoutes.js
import express from 'express';
import Stripe from 'stripe';
import authMiddleware from '../middleware/auth.js';
import Transaction from '../models/Transaction.js';
import { PointsBalance, RechargePackage, PointsTransaction } from '../models/Points.js';
import User from '../models/User.js';
import crypto from 'crypto';
import axios from 'axios';

const router = express.Router();

// Initialize payment gateways
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Helper function to generate unique transaction ID
const generateTransactionId = () => {
  return `txn_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
};

// Helper function to calculate points and bonus
const calculatePoints = (amount, packageData = null) => {
  let basePoints = amount * 10; // 1 dollar = 10 points base rate
  let bonusPoints = 0;
  
  if (packageData) {
    basePoints = packageData.points;
    bonusPoints = packageData.bonusPoints || 0;
  } else {
    // Apply bonus tiers for custom amounts
    if (amount >= 100) bonusPoints = amount * 4; // 40% bonus for $100+
    else if (amount >= 50) bonusPoints = amount * 3; // 30% bonus for $50+
    else if (amount >= 25) bonusPoints = amount * 2; // 20% bonus for $25+
    else if (amount >= 10) bonusPoints = amount * 1; // 10% bonus for $10+
  }
  
  return { basePoints, bonusPoints, totalPoints: basePoints + bonusPoints };
};

// Get available recharge packages
router.get('/packages', authMiddleware, async (req, res) => {
  try {
    const packages = await RechargePackage.find({ isActive: true })
      .sort({ amount: 1, isPopular: -1 });
    
    res.json(packages);
  } catch (error) {
    console.error('Get packages error:', error);
    res.status(500).json({ msg: 'Server error while fetching packages' });
  }
});

// Get user's points balance
router.get('/balance', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    
    let pointsBalance = await PointsBalance.findOne({ userId });
    
    if (!pointsBalance) {
      pointsBalance = new PointsBalance({ userId, balance: 0 });
      await pointsBalance.save();
    }
    
    res.json({
      balance: pointsBalance.balance,
      totalEarned: pointsBalance.totalEarned,
      totalSpent: pointsBalance.totalSpent,
      totalRecharged: pointsBalance.totalRecharged,
      lifetimeStats: pointsBalance.lifetimeStats
    });
  } catch (error) {
    console.error('Get balance error:', error);
    res.status(500).json({ msg: 'Server error while fetching balance' });
  }
});

// Get transaction history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { page = 1, limit = 20, type, status } = req.query;
    
    const query = { userId };
    if (type) query.type = type;
    if (status) query.status = status;
    
    const transactions = await Transaction.find(query)
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .select('-webhookData -paymentDetails -userInfo.phone -metadata');
    
    // Also get points transaction log for detailed history
    const pointsTransactions = await PointsTransaction.find({ userId })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .populate('metadata.relatedTransaction', 'transactionId amount status paymentMethod');
    
    res.json({
      transactions,
      pointsTransactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: await Transaction.countDocuments(query)
      }
    });
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ msg: 'Server error while fetching history' });
  }
});

// Initialize payment (Step 1: Create payment intent/order)
router.post('/initialize', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const {
      amount,
      packageId,
      paymentMethod,
      userInfo,
      metadata = {}
    } = req.body;

    // Validation
    if (!amount || amount <= 0) {
      return res.status(400).json({ msg: 'Invalid amount' });
    }

    if (amount < 1 || amount > 1000) {
      return res.status(400).json({ msg: 'Amount must be between $1 and $1000' });
    }

    if (!paymentMethod || !['stripe', 'paypal', 'razorpay'].includes(paymentMethod)) {
      return res.status(400).json({ msg: 'Invalid payment method' });
    }

    if (!userInfo?.fullName || !userInfo?.email) {
      return res.status(400).json({ msg: 'User information is required' });
    }

    // Get package info if packageId provided
    let packageData = null;
    if (packageId) {
      packageData = await RechargePackage.findById(packageId);
      if (!packageData || !packageData.isActive) {
        return res.status(400).json({ msg: 'Invalid package' });
      }
    }

    // Calculate points
    const { basePoints, bonusPoints, totalPoints } = calculatePoints(amount, packageData);

    // Generate transaction ID
    const transactionId = generateTransactionId();

    // Calculate fees (example: 2.9% + $0.30 for Stripe)
    const processingFee = paymentMethod === 'stripe' ? (amount * 0.029) + 0.30 : 0;
    const totalFees = processingFee;

    // Create transaction record
    const transaction = new Transaction({
      userId,
      type: 'recharge',
      amount,
      pointsAmount: totalPoints,
      currency: 'USD',
      status: 'pending',
      paymentMethod: paymentMethod === 'stripe' ? 'card' : paymentMethod,
      paymentGateway: paymentMethod,
      transactionId,
      basePoints,
      bonusPoints,
      description: packageData ? `${packageData.name} Package` : `Custom Recharge - $${amount}`,
      userInfo: {
        ...userInfo,
        // Hash sensitive info
        email: crypto.createHash('sha256').update(userInfo.email).digest('hex')
      },
      fees: {
        processingFee,
        totalFees
      },
      metadata: {
        ...metadata,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent')
      }
    });

    let paymentData = {};

    // Initialize payment based on method
    switch (paymentMethod) {
      case 'stripe':
        try {
          const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100), // Convert to cents
            currency: 'usd',
            metadata: {
              transactionId,
              userId: userId.toString(),
              type: 'points_recharge'
            },
            description: transaction.description
          });

          transaction.paymentIntentId = paymentIntent.id;
          paymentData = {
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id
          };
        } catch (stripeError) {
          console.error('Stripe payment intent creation error:', stripeError);
          return res.status(400).json({ msg: 'Payment initialization failed' });
        }
        break;

      case 'paypal':
        try {
          // PayPal implementation would go here
          // For now, return mock data
          const paypalOrderId = `PAYPAL_${transactionId}`;
          transaction.paypalOrderId = paypalOrderId;
          paymentData = {
            orderID: paypalOrderId,
            approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${paypalOrderId}`
          };
        } catch (paypalError) {
          console.error('PayPal order creation error:', paypalError);
          return res.status(400).json({ msg: 'PayPal initialization failed' });
        }
        break;

      case 'razorpay':
        try {
          // Razorpay implementation would go here
          const razorpayOrderId = `RAZORPAY_${transactionId}`;
          transaction.razorpayOrderId = razorpayOrderId;
          paymentData = {
            orderId: razorpayOrderId,
            amount: amount * 100, // Convert to paise
            currency: 'INR'
          };
        } catch (razorpayError) {
          console.error('Razorpay order creation error:', razorpayError);
          return res.status(400).json({ msg: 'Razorpay initialization failed' });
        }
        break;
    }

    await transaction.save();

    res.json({
      msg: 'Payment initialized successfully',
      transactionId,
      paymentData,
      transaction: {
        id: transactionId,
        amount,
        pointsAmount: totalPoints,
        basePoints,
        bonusPoints,
        fees: totalFees,
        description: transaction.description
      }
    });

  } catch (error) {
    console.error('Payment initialization error:', error);
    res.status(500).json({ msg: 'Server error during payment initialization' });
  }
});

// Confirm payment (Step 2: After payment is completed)
router.post('/confirm', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { transactionId, paymentData } = req.body;

    if (!transactionId) {
      return res.status(400).json({ msg: 'Transaction ID is required' });
    }

    // Find the transaction
    const transaction = await Transaction.findOne({ 
      transactionId, 
      userId,
      status: 'pending'
    });

    if (!transaction) {
      return res.status(404).json({ msg: 'Transaction not found or already processed' });
    }

    let isPaymentValid = false;

    // Verify payment based on method
    switch (transaction.paymentGateway) {
      case 'stripe':
        try {
          const paymentIntent = await stripe.paymentIntents.retrieve(transaction.paymentIntentId);
          isPaymentValid = paymentIntent.status === 'succeeded';
          
          if (isPaymentValid) {
            transaction.webhookData = {
              paymentIntent: {
                id: paymentIntent.id,
                status: paymentIntent.status,
                amount: paymentIntent.amount,
                created: paymentIntent.created
              }
            };
          }
        } catch (stripeError) {
          console.error('Stripe payment verification error:', stripeError);
          await transaction.markAsFailed('Stripe verification failed');
          return res.status(400).json({ msg: 'Payment verification failed' });
        }
        break;

      case 'paypal':
        // PayPal verification logic would go here
        // For demo purposes, assuming success if paymentData provided
        isPaymentValid = paymentData && paymentData.paymentID;
        break;

      case 'razorpay':
        // Razorpay verification logic would go here
        isPaymentValid = paymentData && paymentData.razorpay_payment_id;
        break;
    }

    if (!isPaymentValid) {
      await transaction.markAsFailed('Payment verification failed');
      return res.status(400).json({ msg: 'Payment verification failed' });
    }

    // Payment is valid, process the transaction
    try {
      // Start database transaction
      const session = await Transaction.startSession();
      
      await session.withTransaction(async () => {
        // Mark transaction as completed
        await transaction.markAsCompleted();

        // Get or create points balance
        let pointsBalance = await PointsBalance.findOne({ userId }).session(session);
        
        if (!pointsBalance) {
          pointsBalance = new PointsBalance({ userId, balance: 0 });
        }

        const oldBalance = pointsBalance.balance;
        
        // Add points to user's balance
        pointsBalance.balance += transaction.pointsAmount;
        pointsBalance.totalEarned += transaction.pointsAmount;
        pointsBalance.totalRecharged += transaction.amount;
        pointsBalance.lifetimeStats.totalTransactions += 1;
        pointsBalance.lifetimeStats.lastRechargeAmount = transaction.amount;
        pointsBalance.lifetimeStats.lastRechargeDate = new Date();
        
        if (!pointsBalance.lifetimeStats.firstRechargeDate) {
          pointsBalance.lifetimeStats.firstRechargeDate = new Date();
        }
        
        pointsBalance.lifetimeStats.averageRecharge = 
          pointsBalance.totalRecharged / pointsBalance.lifetimeStats.totalTransactions;
        
        await pointsBalance.save({ session });

        // Create points transaction log entry
        const pointsLog = new PointsTransaction({
          userId,
          transactionId: `pts_${transactionId}`,
          type: 'credit',
          category: 'recharge',
          amount: transaction.pointsAmount,
          balanceBefore: oldBalance,
          balanceAfter: pointsBalance.balance,
          description: `Points recharge: ${transaction.description}`,
          metadata: {
            relatedTransaction: transaction._id,
            basePoints: transaction.basePoints,
            bonusPoints: transaction.bonusPoints
          }
        });
        
        await pointsLog.save({ session });

        // Update user's points balance in User model (for quick access)
        await User.findByIdAndUpdate(
          userId,
          { $set: { pointsBalance: pointsBalance.balance } },
          { session }
        );

        // Update package stats if applicable
        if (req.body.packageId) {
          await RechargePackage.findByIdAndUpdate(
            req.body.packageId,
            {
              $inc: {
                'stats.totalPurchases': 1,
                'stats.totalRevenue': transaction.amount
              },
              $set: {
                'stats.lastPurchased': new Date()
              }
            },
            { session }
          );
        }
      });

      await session.endSession();

      res.json({
        msg: 'Payment confirmed and points added successfully',
        transaction: {
          id: transactionId,
          status: 'completed',
          pointsAdded: transaction.pointsAmount,
          newBalance: pointsBalance.balance,
          completedAt: transaction.completedAt
        }
      });

    } catch (dbError) {
      console.error('Database transaction error:', dbError);
      await transaction.markAsFailed('Database processing failed');
      res.status(500).json({ msg: 'Failed to process payment completion' });
    }

  } catch (error) {
    console.error('Payment confirmation error:', error);
    res.status(500).json({ msg: 'Server error during payment confirmation' });
  }
});

// Webhook endpoint for Stripe
router.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object;
        const transactionId = paymentIntent.metadata.transactionId;
        
        if (transactionId) {
          const transaction = await Transaction.findOne({ transactionId });
          if (transaction && transaction.status === 'pending') {
            // Auto-confirm the transaction
            await confirmTransactionFromWebhook(transaction, paymentIntent);
          }
        }
        break;

      case 'payment_intent.payment_failed':
        const failedPayment = event.data.object;
        const failedTransactionId = failedPayment.metadata.transactionId;
        
        if (failedTransactionId) {
          const transaction = await Transaction.findOne({ transactionId: failedTransactionId });
          if (transaction) {
            await transaction.markAsFailed('Payment failed via webhook');
          }
        }
        break;

      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Helper function to confirm transaction from webhook
async function confirmTransactionFromWebhook(transaction, paymentData) {
  const session = await Transaction.startSession();
  
  try {
    await session.withTransaction(async () => {
      // Mark transaction as completed
      transaction.status = 'completed';
      transaction.completedAt = new Date();
      transaction.webhookData = paymentData;
      await transaction.save({ session });

      // Get points balance
      let pointsBalance = await PointsBalance.findOne({ userId: transaction.userId }).session(session);
      
      if (!pointsBalance) {
        pointsBalance = new PointsBalance({ userId: transaction.userId, balance: 0 });
      }

      const oldBalance = pointsBalance.balance;
      
      // Add points
      pointsBalance.balance += transaction.pointsAmount;
      pointsBalance.totalEarned += transaction.pointsAmount;
      pointsBalance.totalRecharged += transaction.amount;
      pointsBalance.lifetimeStats.totalTransactions += 1;
      pointsBalance.lifetimeStats.lastRechargeAmount = transaction.amount;
      pointsBalance.lifetimeStats.lastRechargeDate = new Date();
      
      if (!pointsBalance.lifetimeStats.firstRechargeDate) {
        pointsBalance.lifetimeStats.firstRechargeDate = new Date();
      }
      
      await pointsBalance.save({ session });

      // Create points log
      const pointsLog = new PointsTransaction({
        userId: transaction.userId,
        transactionId: `pts_webhook_${transaction.transactionId}`,
        type: 'credit',
        category: 'recharge',
        amount: transaction.pointsAmount,
        balanceBefore: oldBalance,
        balanceAfter: pointsBalance.balance,
        description: `Automatic recharge confirmation: ${transaction.description}`,
        metadata: {
          relatedTransaction: transaction._id,
          source: 'webhook'
        }
      });
      
      await pointsLog.save({ session });

      // Update user model
      await User.findByIdAndUpdate(
        transaction.userId,
        { $set: { pointsBalance: pointsBalance.balance } },
        { session }
      );
    });
  } catch (error) {
    console.error('Webhook transaction confirmation error:', error);
    throw error;
  } finally {
    await session.endSession();
  }
}

// Cancel/refund transaction
router.post('/cancel/:transactionId', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { transactionId } = req.params;
    const { reason } = req.body;

    const transaction = await Transaction.findOne({ 
      transactionId, 
      userId,
      status: { $in: ['pending', 'completed'] }
    });

    if (!transaction) {
      return res.status(404).json({ msg: 'Transaction not found' });
    }

    // Can only cancel pending transactions or refund completed ones within 24 hours
    const canCancel = transaction.status === 'pending';
    const canRefund = transaction.status === 'completed' && 
                     (new Date() - transaction.completedAt) < 24 * 60 * 60 * 1000;

    if (!canCancel && !canRefund) {
      return res.status(400).json({ msg: 'Transaction cannot be cancelled or refunded' });
    }

    if (transaction.status === 'pending') {
      // Cancel pending transaction
      transaction.status = 'cancelled';
      transaction.notes = reason || 'Cancelled by user';
      await transaction.save();

      // Cancel payment intent if exists
      if (transaction.paymentIntentId) {
        try {
          await stripe.paymentIntents.cancel(transaction.paymentIntentId);
        } catch (stripeError) {
          console.error('Stripe cancellation error:', stripeError);
        }
      }

      res.json({ msg: 'Transaction cancelled successfully' });
    } else {
      // Process refund for completed transaction
      const session = await Transaction.startSession();
      
      try {
        await session.withTransaction(async () => {
          // Create refund in payment gateway
          let refundId = null;
          
          if (transaction.paymentGateway === 'stripe' && transaction.paymentIntentId) {
            const refund = await stripe.refunds.create({
              payment_intent: transaction.paymentIntentId,
              reason: 'requested_by_customer'
            });
            refundId = refund.id;
          }

          // Update transaction
          transaction.status = 'refunded';
          transaction.refundInfo = {
            refundId,
            refundAmount: transaction.amount,
            refundReason: reason || 'User requested refund',
            refundedAt: new Date()
          };
          await transaction.save({ session });

          // Deduct points from user's balance
          const pointsBalance = await PointsBalance.findOne({ userId }).session(session);
          
          if (pointsBalance && pointsBalance.balance >= transaction.pointsAmount) {
            const oldBalance = pointsBalance.balance;
            
            pointsBalance.balance -= transaction.pointsAmount;
            pointsBalance.totalSpent += transaction.pointsAmount;
            await pointsBalance.save({ session });

            // Create refund log
            const refundLog = new PointsTransaction({
              userId,
              transactionId: `refund_${transactionId}`,
              type: 'debit',
              category: 'refund',
              amount: -transaction.pointsAmount,
              balanceBefore: oldBalance,
              balanceAfter: pointsBalance.balance,
              description: `Refund: ${transaction.description}`,
              metadata: {
                relatedTransaction: transaction._id,
                refundReason: reason
              }
            });
            
            await refundLog.save({ session });

            // Update user model
            await User.findByIdAndUpdate(
              userId,
              { $set: { pointsBalance: pointsBalance.balance } },
              { session }
            );
          }
        });

        res.json({ msg: 'Refund processed successfully' });
      } catch (refundError) {
        console.error('Refund processing error:', refundError);
        res.status(500).json({ msg: 'Refund processing failed' });
      } finally {
        await session.endSession();
      }
    }

  } catch (error) {
    console.error('Transaction cancellation error:', error);
    res.status(500).json({ msg: 'Server error during cancellation' });
  }
});

// Admin: Get all transactions
router.get('/admin/transactions', authMiddleware, async (req, res) => {
  try {
    // Check if user is admin (implement your admin check logic)
    const user = await User.findById(req.userId);
    if (!user.isAdmin) {
      return res.status(403).json({ msg: 'Access denied' });
    }

    const {
      page = 1,
      limit = 50,
      status,
      paymentMethod,
      startDate,
      endDate,
      userId: filterUserId
    } = req.query;

    const query = {};
    if (status) query.status = status;
    if (paymentMethod) query.paymentGateway = paymentMethod;
    if (filterUserId) query.userId = filterUserId;
    
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const transactions = await Transaction.find(query)
      .populate('userId', 'username email avatar')
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit));

    const total = await Transaction.countDocuments(query);

    // Get revenue stats
    const revenueStats = await Transaction.getRevenueStats(
      startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      endDate ? new Date(endDate) : new Date()
    );

    res.json({
      transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      },
      stats: revenueStats[0] || {
        totalRevenue: 0,
        totalTransactions: 0,
        totalFees: 0,
        totalPointsIssued: 0
      }
    });

  } catch (error) {
    console.error('Admin transactions error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

export default router;