// routes/pointsRoutes.js
import express from 'express';
import authMiddleware from '../middleware/auth.js';
import { PointsBalance, PointsTransaction, RechargePackage } from '../models/Points.js';
import Transaction from '../models/Transaction.js';
import User from '../models/User.js';

const router = express.Router();

// Get user's points balance and stats
router.get('/balance', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    
    let pointsBalance = await PointsBalance.findOne({ userId });
    
    if (!pointsBalance) {
      // Create initial balance record
      pointsBalance = new PointsBalance({ 
        userId, 
        balance: 0,
        totalEarned: 0,
        totalSpent: 0,
        totalRecharged: 0
      });
      await pointsBalance.save();
    }
    
    res.json({
      balance: pointsBalance.balance,
      totalEarned: pointsBalance.totalEarned,
      totalSpent: pointsBalance.totalSpent,
      totalRecharged: pointsBalance.totalRecharged,
      lifetimeStats: pointsBalance.lifetimeStats,
      status: pointsBalance.status
    });
  } catch (error) {
    console.error('Get points balance error:', error);
    res.status(500).json({ msg: 'Server error while fetching points balance' });
  }
});

// Get points transaction history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { 
      page = 1, 
      limit = 20, 
      category, 
      type,
      startDate,
      endDate 
    } = req.query;
    
    // Build query
    const query = { userId };
    if (category) query.category = category;
    if (type) query.type = type;
    
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }
    
    const pointsTransactions = await PointsTransaction.find(query)
      .populate('metadata.relatedTransaction', 'transactionId amount status paymentMethod paymentGateway')
      .populate('metadata.videoId', 'title thumbnail')
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit));
    
    const total = await PointsTransaction.countDocuments(query);
    
    // Format response for frontend
    const history = pointsTransactions.map(txn => ({
      _id: txn._id,
      transactionId: txn.transactionId,
      type: txn.type,
      category: txn.category,
      amount: txn.amount,
      balanceBefore: txn.balanceBefore,
      balanceAfter: txn.balanceAfter,
      description: txn.description,
      createdAt: txn.createdAt,
      metadata: {
        relatedTransaction: txn.metadata?.relatedTransaction,
        videoId: txn.metadata?.videoId,
        notes: txn.metadata?.notes
      }
    }));
    
    res.json({
      history,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get points history error:', error);
    res.status(500).json({ msg: 'Server error while fetching points history' });
  }
});

// Spend points (for gifts, boosts, etc.)
router.post('/spend', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { 
      amount, 
      category, 
      description, 
      metadata = {} 
    } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ msg: 'Invalid amount' });
    }

    if (!category || !['gift', 'boost', 'premium', 'other'].includes(category)) {
      return res.status(400).json({ msg: 'Invalid spending category' });
    }

    if (!description) {
      return res.status(400).json({ msg: 'Description is required' });
    }

    const session = await PointsTransaction.startSession();
    
    try {
      await session.withTransaction(async () => {
        // Get current balance
        const pointsBalance = await PointsBalance.findOne({ userId }).session(session);
        
        if (!pointsBalance) {
          throw new Error('Points balance not found');
        }

        if (pointsBalance.balance < amount) {
          throw new Error('Insufficient points balance');
        }

        if (pointsBalance.status !== 'active') {
          throw new Error('Points account is not active');
        }

        const oldBalance = pointsBalance.balance;
        
        // Deduct points
        pointsBalance.balance -= amount;
        pointsBalance.totalSpent += amount;
        pointsBalance.lifetimeStats.totalTransactions += 1;
        
        await pointsBalance.save({ session });

        // Create transaction log
        const transactionId = `spend_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const pointsLog = new PointsTransaction({
          userId,
          transactionId,
          type: 'debit',
          category,
          amount: -amount, // Negative for debit
          balanceBefore: oldBalance,
          balanceAfter: pointsBalance.balance,
          description,
          metadata
        });
        
        await pointsLog.save({ session });

        // Update user model
        await User.findByIdAndUpdate(
          userId,
          { $set: { pointsBalance: pointsBalance.balance } },
          { session }
        );

        res.json({
          msg: 'Points spent successfully',
          transaction: {
            transactionId,
            amount: -amount,
            category,
            newBalance: pointsBalance.balance,
            description
          }
        });
      });
    } catch (txnError) {
      if (txnError.message === 'Insufficient points balance') {
        return res.status(400).json({ msg: 'Insufficient points balance' });
      }
      if (txnError.message === 'Points account is not active') {
        return res.status(400).json({ msg: 'Points account is suspended' });
      }
      throw txnError;
    } finally {
      await session.endSession();
    }

  } catch (error) {
    console.error('Spend points error:', error);
    res.status(500).json({ msg: 'Server error while spending points' });
  }
});

// Award points (for admin or system rewards)
router.post('/award', authMiddleware, async (req, res) => {
  try {
    const { 
      targetUserId, 
      amount, 
      reason, 
      category = 'reward',
      metadata = {}
    } = req.body;

    // Check if requesting user is admin (implement your admin logic)
    const requestingUser = await User.findById(req.userId);
    if (!requestingUser.isAdmin) {
      return res.status(403).json({ msg: 'Access denied' });
    }

    if (!targetUserId || !amount || amount <= 0) {
      return res.status(400).json({ msg: 'Invalid parameters' });
    }

    if (!reason) {
      return res.status(400).json({ msg: 'Reason is required' });
    }

    const session = await PointsTransaction.startSession();
    
    try {
      await session.withTransaction(async () => {
        // Get or create target user's balance
        let pointsBalance = await PointsBalance.findOne({ userId: targetUserId }).session(session);
        
        if (!pointsBalance) {
          pointsBalance = new PointsBalance({ userId: targetUserId, balance: 0 });
        }

        const oldBalance = pointsBalance.balance;
        
        // Add points
        pointsBalance.balance += amount;
        pointsBalance.totalEarned += amount;
        pointsBalance.lifetimeStats.totalTransactions += 1;
        
        await pointsBalance.save({ session });

        // Create transaction log
        const transactionId = `award_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const pointsLog = new PointsTransaction({
          userId: targetUserId,
          transactionId,
          type: 'credit',
          category,
          amount,
          balanceBefore: oldBalance,
          balanceAfter: pointsBalance.balance,
          description: `Admin Award: ${reason}`,
          metadata: {
            ...metadata,
            adminUserId: req.userId,
            notes: reason
          }
        });
        
        await pointsLog.save({ session });

        // Update user model
        await User.findByIdAndUpdate(
          targetUserId,
          { $set: { pointsBalance: pointsBalance.balance } },
          { session }
        );

        res.json({
          msg: 'Points awarded successfully',
          transaction: {
            transactionId,
            amount,
            targetUserId,
            newBalance: pointsBalance.balance,
            reason
          }
        });
      });
    } finally {
      await session.endSession();
    }

  } catch (error) {
    console.error('Award points error:', error);
    res.status(500).json({ msg: 'Server error while awarding points' });
  }
});

// Transfer points between users
router.post('/transfer', authMiddleware, async (req, res) => {
  try {
    const fromUserId = req.userId;
    const { toUserId, amount, message } = req.body;

    if (!toUserId || !amount || amount <= 0) {
      return res.status(400).json({ msg: 'Invalid parameters' });
    }

    if (fromUserId.toString() === toUserId.toString()) {
      return res.status(400).json({ msg: 'Cannot transfer points to yourself' });
    }

    // Check if recipient exists
    const recipientUser = await User.findById(toUserId);
    if (!recipientUser) {
      return res.status(404).json({ msg: 'Recipient user not found' });
    }

    const session = await PointsTransaction.startSession();
    
    try {
      await session.withTransaction(async () => {
        // Get sender's balance
        const senderBalance = await PointsBalance.findOne({ userId: fromUserId }).session(session);
        
        if (!senderBalance || senderBalance.balance < amount) {
          throw new Error('Insufficient points balance');
        }

        if (senderBalance.status !== 'active') {
          throw new Error('Sender account is not active');
        }

        // Get or create recipient's balance
        let recipientBalance = await PointsBalance.findOne({ userId: toUserId }).session(session);
        
        if (!recipientBalance) {
          recipientBalance = new PointsBalance({ userId: toUserId, balance: 0 });
        }

        const senderOldBalance = senderBalance.balance;
        const recipientOldBalance = recipientBalance.balance;
        
        // Transfer points
        senderBalance.balance -= amount;
        senderBalance.totalSpent += amount;
        senderBalance.lifetimeStats.totalTransactions += 1;
        
        recipientBalance.balance += amount;
        recipientBalance.totalEarned += amount;
        recipientBalance.lifetimeStats.totalTransactions += 1;
        
        await senderBalance.save({ session });
        await recipientBalance.save({ session });

        const transferId = `transfer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Create sender transaction log
        const senderLog = new PointsTransaction({
          userId: fromUserId,
          transactionId: `${transferId}_out`,
          type: 'debit',
          category: 'gift',
          amount: -amount,
          balanceBefore: senderOldBalance,
          balanceAfter: senderBalance.balance,
          description: `Points transfer to ${recipientUser.username}`,
          metadata: {
            transferId,
            recipientUserId: toUserId,
            recipientUsername: recipientUser.username,
            message: message || ''
          }
        });
        
        // Create recipient transaction log
        const recipientLog = new PointsTransaction({
          userId: toUserId,
          transactionId: `${transferId}_in`,
          type: 'credit',
          category: 'gift',
          amount,
          balanceBefore: recipientOldBalance,
          balanceAfter: recipientBalance.balance,
          description: `Points received from ${requestingUser.username}`,
          metadata: {
            transferId,
            senderUserId: fromUserId,
            senderUsername: requestingUser.username,
            message: message || ''
          }
        });
        
        await senderLog.save({ session });
        await recipientLog.save({ session });

        // Update user models
        await User.findByIdAndUpdate(
          fromUserId,
          { $set: { pointsBalance: senderBalance.balance } },
          { session }
        );
        
        await User.findByIdAndUpdate(
          toUserId,
          { $set: { pointsBalance: recipientBalance.balance } },
          { session }
        );

        res.json({
          msg: 'Points transferred successfully',
          transfer: {
            transferId,
            amount,
            recipient: {
              userId: toUserId,
              username: recipientUser.username
            },
            newBalance: senderBalance.balance,
            message
          }
        });
      });
    } catch (txnError) {
      if (txnError.message === 'Insufficient points balance') {
        return res.status(400).json({ msg: 'Insufficient points balance' });
      }
      if (txnError.message === 'Sender account is not active') {
        return res.status(400).json({ msg: 'Your points account is suspended' });
      }
      throw txnError;
    } finally {
      await session.endSession();
    }

  } catch (error) {
    console.error('Transfer points error:', error);
    res.status(500).json({ msg: 'Server error while transferring points' });
  }
});

// Get points leaderboard
router.get('/leaderboard', authMiddleware, async (req, res) => {
  try {
    const { 
      period = 'all', // all, month, week
      limit = 20 
    } = req.query;

    let dateFilter = {};
    
    if (period === 'month') {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);
      dateFilter = { createdAt: { $gte: startOfMonth } };
    } else if (period === 'week') {
      const startOfWeek = new Date();
      startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
      startOfWeek.setHours(0, 0, 0, 0);
      dateFilter = { createdAt: { $gte: startOfWeek } };
    }

    const leaderboard = await PointsBalance.find({ status: 'active' })
      .populate('userId', 'username avatar isVerified')
      .sort({ balance: -1 })
      .limit(parseInt(limit));

    const formattedLeaderboard = leaderboard.map((entry, index) => ({
      rank: index + 1,
      userId: entry.userId._id,
      username: entry.userId.username,
      avatar: entry.userId.avatar,
      isVerified: entry.userId.isVerified,
      balance: entry.balance,
      totalEarned: entry.totalEarned,
      lifetimeStats: entry.lifetimeStats
    }));

    res.json({
      leaderboard: formattedLeaderboard,
      period,
      total: leaderboard.length
    });

  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({ msg: 'Server error while fetching leaderboard' });
  }
});

export default router;