import express from "express";
import { body, validationResult } from "express-validator";
import mongoose from "mongoose";
import authMiddleware from "../middleware/auth.js";
import User from "../models/User.js";
import { PointsBalance, PointsTransaction } from "../models/Points.js";
import Notification from "../models/Notification.js";

const router = express.Router();

/**
 * Transfer Points
 * POST /api/points/transfer
 * Requires authentication
 */
router.post(
  "/transfer",
  [
    authMiddleware,
    [
      body("recipient", "Recipient username or email is required").not().isEmpty(),
      body("points", "Points to transfer is required").isNumeric().isFloat({ min: 1 }),
      body("message", "Transfer message").optional().isString().isLength({ max: 200 }),
    ],
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        await session.abortTransaction();
        return res.status(400).json({ errors: errors.array() });
      }

      const { recipient, points, message } = req.body;
      const senderId = req.userId; // Fixed: should be req.userId not req.user.id

      // Get sender user info
      const senderUser = await User.findById(senderId).session(session);
      if (!senderUser) {
        await session.abortTransaction();
        return res.status(404).json({ msg: "Sender not found" });
      }

      // Find sender's points balance
      let senderPoints = await PointsBalance.findOne({ userId: senderId }).session(session);
      if (!senderPoints) {
        // Create initial balance if doesn't exist
        senderPoints = new PointsBalance({
          userId: senderId,
          balance: 0,
          totalEarned: 0,
          totalSpent: 0,
          totalRecharged: 0
        });
        await senderPoints.save({ session });
      }

      if (senderPoints.balance < points) {
        await session.abortTransaction();
        return res.status(400).json({ msg: "Insufficient points for transfer" });
      }

      if (senderPoints.status !== 'active') {
        await session.abortTransaction();
        return res.status(400).json({ msg: "Your points account is suspended" });
      }

      // Find recipient by username or email
      const recipientUser = await User.findOne({
        $or: [
          { username: { $regex: new RegExp(`^${recipient}$`, 'i') } }, // Case insensitive
          { email: { $regex: new RegExp(`^${recipient}$`, 'i') } }
        ],
      }).session(session);

      if (!recipientUser) {
        await session.abortTransaction();
        return res.status(404).json({ msg: "Recipient not found" });
      }

      if (recipientUser._id.toString() === senderId.toString()) {
        await session.abortTransaction();
        return res.status(400).json({ msg: "Cannot transfer points to yourself" });
      }

      // Find or create recipient's points balance
      let recipientPoints = await PointsBalance.findOne({ userId: recipientUser._id }).session(session);
      if (!recipientPoints) {
        recipientPoints = new PointsBalance({
          userId: recipientUser._id,
          balance: 0,
          totalEarned: 0,
          totalSpent: 0,
          totalRecharged: 0
        });
      }

      // Store balance states for transaction logs
      const senderBalanceBefore = senderPoints.balance;
      const recipientBalanceBefore = recipientPoints.balance;

      // Update balances
      senderPoints.balance -= points;
      senderPoints.totalSpent += points;
      senderPoints.lifetimeStats = senderPoints.lifetimeStats || { totalTransactions: 0 };
      senderPoints.lifetimeStats.totalTransactions += 1;

      recipientPoints.balance += points;
      recipientPoints.totalEarned += points;
      recipientPoints.lifetimeStats = recipientPoints.lifetimeStats || { totalTransactions: 0 };
      recipientPoints.lifetimeStats.totalTransactions += 1;

      await senderPoints.save({ session });
      await recipientPoints.save({ session });

      // Update user points field (if exists in User model)
      await User.findByIdAndUpdate(
        senderId,
        { 
          $inc: { points: -points },
          $set: { pointsBalance: senderPoints.balance }
        },
        { session }
      );
      
      await User.findByIdAndUpdate(
        recipientUser._id,
        { 
          $inc: { points: points },
          $set: { pointsBalance: recipientPoints.balance }
        },
        { session }
      );

      // Create transaction records
      const transferId = `PT${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
      
      const senderTx = new PointsTransaction({
        userId: senderId,
        transactionId: `${transferId}_SENDER`,
        type: "debit",
        category: "points_transfer",
        amount: -points, // Negative for debit
        balanceBefore: senderBalanceBefore,
        balanceAfter: senderPoints.balance,
        description: `Transferred ${points} points to ${recipientUser.username}`,
        metadata: { 
          recipientId: recipientUser._id,
          recipientUsername: recipientUser.username,
          status: "completed",
          transferId,
          message: message || ''
        },
      });
      await senderTx.save({ session });

      const recipientTx = new PointsTransaction({
        userId: recipientUser._id,
        transactionId: `${transferId}_RECIPIENT`,
        type: "credit",
        category: "points_transfer",
        amount: points, // Positive for credit
        balanceBefore: recipientBalanceBefore,
        balanceAfter: recipientPoints.balance,
        description: `Received ${points} points from ${senderUser.username}`,
        metadata: { 
          senderId: senderId,
          senderUsername: senderUser.username,
          status: "completed",
          transferId,
          message: message || ''
        },
      });
      await recipientTx.save({ session });

      // Create notifications
      try {
        const senderNotification = new Notification({
          userId: senderId,
          type: "points_transfer_sent",
          message: `You transferred ${points} points to ${recipientUser.username}`,
          pointsAmount: points,
          createdAt: new Date(),
        });
        await senderNotification.save({ session });

        const recipientNotification = new Notification({
          userId: recipientUser._id,
          type: "points_transfer_received",
          message: `You received ${points} points from ${senderUser.username}`,
          pointsAmount: points,
          createdAt: new Date(),
        });
        await recipientNotification.save({ session });
      } catch (notificationError) {
        console.warn("Notification creation failed:", notificationError);
        // Don't fail the entire transaction for notification errors
      }

      await session.commitTransaction();
      
      res.json({
        msg: "Points transferred successfully",
        transfer: {
          transferId,
          points,
          recipient: {
            username: recipientUser.username,
            email: recipientUser.email
          },
          sender: {
            username: senderUser.username,
            newBalance: senderPoints.balance
          },
          status: "completed",
          message: message || '',
          createdAt: new Date(),
        },
      });
    } catch (err) {
      await session.abortTransaction();
      console.error("Points transfer error:", err);
      
      if (err.name === 'ValidationError') {
        return res.status(400).json({ msg: "Validation error", details: err.message });
      }
      
      res.status(500).json({ msg: "Server error during points transfer" });
    } finally {
      session.endSession();
    }
  }
);

router.get("/history", authMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100); // Max 100 items per page
    const skip = (page - 1) * limit;
    const userId = req.userId;

    // Build query
    const query = {
      userId,
      category: "points_transfer",
    };

    // Optional filters
    if (req.query.type && ['credit', 'debit'].includes(req.query.type)) {
      query.type = req.query.type;
    }

    if (req.query.startDate || req.query.endDate) {
      query.createdAt = {};
      if (req.query.startDate) {
        query.createdAt.$gte = new Date(req.query.startDate);
      }
      if (req.query.endDate) {
        query.createdAt.$lte = new Date(req.query.endDate);
      }
    }

    const transfers = await PointsTransaction.find(query)
      .populate("metadata.recipientId", "username email avatar")
      .populate("metadata.senderId", "username email avatar")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(); // Use lean for better performance

    const total = await PointsTransaction.countDocuments(query);

    // Format transfers for frontend
    const formattedTransfers = transfers.map(transfer => ({
      _id: transfer._id,
      transactionId: transfer.transactionId,
      type: transfer.type,
      amount: Math.abs(transfer.amount), // Always show positive amount
      description: transfer.description,
      status: transfer.metadata?.status || 'completed',
      createdAt: transfer.createdAt,
      message: transfer.metadata?.message || '',
      // Show recipient for sent transfers, sender for received transfers
      counterparty: transfer.type === 'debit' 
        ? {
            username: transfer.metadata?.recipientId?.username || transfer.metadata?.recipientUsername || 'Unknown',
            email: transfer.metadata?.recipientId?.email || '',
            avatar: transfer.metadata?.recipientId?.avatar || null
          }
        : {
            username: transfer.metadata?.senderId?.username || transfer.metadata?.senderUsername || 'Unknown', 
            email: transfer.metadata?.senderId?.email || '',
            avatar: transfer.metadata?.senderId?.avatar || null
          }
    }));

    res.json({
      transfers: formattedTransfers,
      pagination: {
        page,
        pages: Math.ceil(total / limit),
        total,
        limit,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1,
      },
    });
  } catch (err) {
    console.error("Get transfer history error:", err);
    res.status(500).json({ msg: "Server error while fetching transfer history" });
  }
});

/**
 * Get transfer statistics
 * GET /api/points/transfer/stats
 * Requires authentication
 */
router.get("/stats", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    
    const stats = await PointsTransaction.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(userId),
          category: "points_transfer"
        }
      },
      {
        $group: {
          _id: "$type",
          totalAmount: { $sum: { $abs: "$amount" } },
          count: { $sum: 1 }
        }
      }
    ]);

    const formattedStats = {
      sent: { amount: 0, count: 0 },
      received: { amount: 0, count: 0 }
    };

    stats.forEach(stat => {
      if (stat._id === 'debit') {
        formattedStats.sent = { amount: stat.totalAmount, count: stat.count };
      } else if (stat._id === 'credit') {
        formattedStats.received = { amount: stat.totalAmount, count: stat.count };
      }
    });

    res.json(formattedStats);
  } catch (err) {
    console.error("Get transfer stats error:", err);
    res.status(500).json({ msg: "Server error while fetching transfer statistics" });
  }
});
/**
 * Get User's Friends
 * GET /api/points/friends
 * Requires authentication
 */
router.get("/friends", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { page = 1, limit = 20 } = req.query;

    const user = await User.findById(userId)
      .populate('followers', '_id username email avatar')
      .populate('following', '_id username email avatar')
      .lean();

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // Find mutual friends (users who follow each other)
    const friends = user.following.filter(followedUser =>
      user.followers.some(follower => 
        follower._id.toString() === followedUser._id.toString()
      )
    );

    // Apply pagination
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + parseInt(limit);
    const paginatedFriends = friends.slice(startIndex, endIndex);

    res.json({
      friends: paginatedFriends,
      totalCount: friends.length,
      page: parseInt(page),
      totalPages: Math.ceil(friends.length / limit)
    });
  } catch (err) {
    console.error("Get friends error:", err);
    res.status(500).json({ msg: "Server error while fetching friends" });
  }
});


/**
 * Search Users for Transfer
 * GET /api/points/users/search
 * Requires authentication
 */
router.get("/users/search", authMiddleware, async (req, res) => {
  try {
    const { query } = req.query;
    if (!query || query.length < 3) {
      return res.json({ users: [] });
    }

    const users = await User.find({
      $and: [
        { _id: { $ne: req.userId } },
        {
          $or: [
            { username: { $regex: query, $options: 'i' } },
            { email: { $regex: query, $options: 'i' } }
          ]
        }
      ]
    }).select('username email avatar').limit(10).lean();

    res.json({ users });
  } catch (err) {
    console.error("User search error:", err);
    res.status(500).json({ msg: "Server error while searching users" });
  }
});

export default router;
