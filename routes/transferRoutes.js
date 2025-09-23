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
  "/points/transfer",
  [
    authMiddleware,
    [
      body("recipient", "Recipient username or email is required").not().isEmpty(),
      body("points", "Points to transfer is required").isNumeric().isFloat({ min: 1 }),
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

      const { recipient, points } = req.body;
      const senderId = req.user.id;

      // Find sender's points balance
      const senderPoints = await PointsBalance.findOne({ userId: senderId }).session(session);
      if (!senderPoints || senderPoints.balance < points) {
        await session.abortTransaction();
        return res.status(400).json({ msg: "Insufficient points for transfer" });
      }

      // Find recipient by username or email
      const recipientUser = await User.findOne({
        $or: [{ username: recipient }, { email: recipient }],
      }).session(session);
      if (!recipientUser) {
        await session.abortTransaction();
        return res.status(404).json({ msg: "Recipient not found" });
      }
      if (recipientUser._id.toString() === senderId) {
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
        });
      }

      // Update balances
      const senderBalanceBefore = senderPoints.balance;
      const recipientBalanceBefore = recipientPoints.balance;
      senderPoints.balance -= points;
      senderPoints.totalSpent += points;
      recipientPoints.balance += points;
      recipientPoints.totalEarned += points;

      await senderPoints.save({ session });
      await recipientPoints.save({ session });

      // Update user points
      await User.findByIdAndUpdate(
        senderId,
        { $inc: { points: -points } },
        { session }
      );
      await User.findByIdAndUpdate(
        recipientUser._id,
        { $inc: { points: points } },
        { session }
      );

      // Create transaction records
      const transactionId = `PT${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
      const senderTx = new PointsTransaction({
        userId: senderId,
        transactionId: `${transactionId}_SENDER`,
        type: "debit",
        category: "points_transfer",
        amount: points,
        balanceBefore: senderBalanceBefore,
        balanceAfter: senderPoints.balance,
        description: `Transferred ${points} points to ${recipientUser.username}`,
        metadata: { recipientId: recipientUser._id, status: "completed" },
      });
      await senderTx.save({ session });

      const recipientTx = new PointsTransaction({
        userId: recipientUser._id,
        transactionId: `${transactionId}_RECIPIENT`,
        type: "credit",
        category: "points_transfer",
        amount: points,
        balanceBefore: recipientBalanceBefore,
        balanceAfter: recipientPoints.balance,
        description: `Received ${points} points from ${req.user.username}`,
        metadata: { senderId: senderId, status: "completed" },
      });
      await recipientTx.save({ session });

      // Create notifications
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
        message: `You received ${points} points from ${req.user.username}`,
        pointsAmount: points,
        createdAt: new Date(),
      });
      await recipientNotification.save({ session });

      await session.commitTransaction();
      res.json({
        msg: "Points transferred successfully",
        transfer: {
          points,
          recipient: recipientUser.username,
          status: "completed",
          createdAt: new Date(),
        },
      });
    } catch (err) {
      await session.abortTransaction();
      console.error("Points transfer error:", err);
      res.status(500).json({ msg: "Server error" });
    } finally {
      session.endSession();
    }
  }
);

/**
 * Get Transfer History
 * GET /api/points/transfer/history
 * Requires authentication
 */
router.get("/points/transfer/history", [authMiddleware], async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const userId = req.user.id;

    const transfers = await PointsTransaction.find({
      userId,
      category: "points_transfer",
    })
      .populate("metadata.recipientId", "username email")
      .populate("metadata.senderId", "username email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await PointsTransaction.countDocuments({
      userId,
      category: "points_transfer",
    });

    res.json({
      transfers,
      pagination: {
        page,
        pages: Math.ceil(total / limit),
        total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1,
      },
    });
  } catch (err) {
    console.error("Get transfer history error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

export default router;