import express from "express";
import Withdrawal from "../models/Withdrawal.js";
import { PointsBalance, PointsTransaction } from "../models/Points.js";
import { body, validationResult } from "express-validator";
import mongoose from "mongoose";
import authMiddleware from "../middleware/auth.js";
import User from "../models/User.js";
import Notification from "../models/Notification.js";

const router = express.Router();

/**
 * USER ROUTES
 */
router.post(
  "/request",
  [
    authMiddleware,
    [
      body("amount", "Amount is required").isNumeric().isFloat({ min: 1 }),
      body("pointsToDeduct", "Points to deduct is required").isNumeric(),
      body("method", "Withdrawal method is required").isIn(["paypal", "bank", "card", "usdt"]),
      body("details.fullName", "Full name is required").not().isEmpty(),
      body("details.email", "Valid email is required").isEmail(),
      body("details.phone", "Phone number is required").not().isEmpty(),
      body("details.paypalEmail", "PayPal email is required for PayPal method")
        .if(body("method").equals("paypal"))
        .not().isEmpty(),
      body("details.bankDetails.bankName", "Bank name is required for bank method")
        .if(body("method").equals("bank"))
        .not().isEmpty(),
      body("details.bankDetails.accountNumber", "Account number is required for bank method")
        .if(body("method").equals("bank"))
        .not().isEmpty(),
      body("details.bankDetails.accountHolderName", "Account holder name is required for bank method")
        .if(body("method").equals("bank"))
        .not().isEmpty(),
      body("details.cardDetails.cardNumber", "Card number is required for card method")
        .if(body("method").equals("card"))
        .not().isEmpty(),
      body("details.cardDetails.cardholderName", "Cardholder name is required for card method")
        .if(body("method").equals("card"))
        .not().isEmpty(),
      body("details.usdtDetails.walletAddress", "USDT wallet address is required for USDT method")
        .if(body("method").equals("usdt"))
        .not().isEmpty()
        .matches(/^0x[a-fA-F0-9]{40}$/)
        .withMessage("Invalid USDT wallet address"),
    ],
  ],
  async (req, res) => {
    try {
      console.log('Received withdrawal request details:', req.body.details); // Debug log
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { amount, pointsToDeduct, method, details } = req.body;
      const userId = req.user.id;

      const userPoints = await PointsBalance.findOne({ userId });
      if (!userPoints || userPoints.balance < pointsToDeduct) {
        return res.status(400).json({ msg: "Insufficient points for this withdrawal" });
      }

      const minimumLimits = { paypal: 10, bank: 25, card: 5, usdt: 20 };
      if (amount < minimumLimits[method]) {
        return res.status(400).json({
          msg: `Minimum withdrawal amount for ${method} is $${minimumLimits[method]}`,
        });
      }

      const pending = await Withdrawal.findOne({ userId, status: "pending" });
      if (pending) {
        return res.status(400).json({ msg: "You already have a pending withdrawal request" });
      }

      const requestId = `WD${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
      const withdrawal = new Withdrawal({
        userId,
        requestId,
        amount,
        pointsToDeduct,
        method,
        status: "pending",
        details,
        requestedAt: new Date(),
        metadata: {
          userBalance: userPoints.balance,
          exchangeRate: pointsToDeduct / amount,
        },
      });
      await withdrawal.save();

      const tx = new PointsTransaction({
        userId,
        transactionId: requestId,
        type: "debit",
        category: "withdrawal_request",
        amount: pointsToDeduct,
        balanceBefore: userPoints.balance,
        balanceAfter: userPoints.balance,
        description: `Withdrawal request: $${amount} (${method})`,
        metadata: { withdrawalRequest: withdrawal._id, status: "pending" },
      });
      await tx.save();

      res.json({
        msg: "Withdrawal request submitted successfully",
        withdrawal: {
          id: withdrawal._id,
          requestId: withdrawal.requestId,
          amount: withdrawal.amount,
          method: withdrawal.method,
          status: withdrawal.status,
          requestedAt: withdrawal.requestedAt,
        },
      });
    } catch (err) {
      console.error("Withdrawal request error:", err);
      res.status(500).json({ msg: "Server error" });
    }
  }
);

router.get("/history", async (req, res) => {
  try {
    const { userId } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    let query = {};
    if (userId) {
      query.userId = userId;
    }

    const withdrawals = await Withdrawal.find(query)
      .populate("userId", "username email")
      .sort({ requestedAt: -1 })
      .skip(skip)
      .limit(limit);

    const withdrawalsWithBalance = await Promise.all(
      withdrawals.map(async (withdrawal) => {
        const userPoints = await PointsBalance.findOne({ userId: withdrawal.userId });
        return {
          ...withdrawal.toObject(),
          userBalance: userPoints ? userPoints.balance : 0,
        };
      })
    );

    const total = await Withdrawal.countDocuments(query);

    res.json({
      withdrawals: withdrawalsWithBalance,
      pagination: {
        page,
        pages: Math.ceil(total / limit),
        total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1,
      },
    });
  } catch (err) {
    console.error("Get withdrawal history error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

router.post("/cancel/:id", async (req, res) => {
  try {
    const withdrawal = await Withdrawal.findOne({
      _id: req.params.id,
      status: "pending",
    });
    if (!withdrawal) return res.status(404).json({ msg: "Pending withdrawal not found" });

    withdrawal.status = "cancelled";
    withdrawal.cancelledAt = new Date();
    withdrawal.cancelledBy = "user";
    await withdrawal.save();

    res.json({ msg: "Withdrawal cancelled", withdrawal });
  } catch (err) {
    console.error("Cancel withdrawal error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

/**
 * POINTS TRANSFER ROUTES
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

      // Find recipient's points balance or create one
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

/**
 * ADMIN ROUTES
 */
router.post("/admin/approve/:id", async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const withdrawal = await Withdrawal.findOne({
      _id: req.params.id,
      status: "pending",
    }).session(session);

    if (!withdrawal) {
      await session.abortTransaction();
      return res.status(404).json({ msg: "Pending withdrawal not found" });
    }

    const userPoints = await PointsBalance.findOne({ userId: withdrawal.userId }).session(session);
    if (!userPoints || userPoints.balance < withdrawal.pointsToDeduct) {
      await session.abortTransaction();
      return res.status(400).json({ msg: "User does not have enough points" });
    }

    const before = userPoints.balance;

    userPoints.balance -= withdrawal.pointsToDeduct;
    userPoints.totalSpent += withdrawal.pointsToDeduct;
    await userPoints.save({ session });

    await User.findByIdAndUpdate(
      withdrawal.userId,
      { $inc: { points: -withdrawal.pointsToDeduct } },
      { session }
    );

    withdrawal.status = "approved";
    withdrawal.approvedAt = new Date();
    withdrawal.adminNotes = req.body.notes;
    await withdrawal.save({ session });

    const tx = new PointsTransaction({
      userId: withdrawal.userId,
      transactionId: `${withdrawal.requestId}_APPROVED`,
      type: "debit",
      category: "withdrawal_approved",
      amount: withdrawal.pointsToDeduct,
      balanceBefore: before,
      balanceAfter: userPoints.balance,
      description: `Withdrawal approved: $${withdrawal.amount} (${withdrawal.method})`,
      metadata: { withdrawalId: withdrawal._id, adminNotes: req.body.notes },
    });
    await tx.save({ session });

    const notification = new Notification({
      userId: withdrawal.userId,
      type: "withdrawal_approved",
      message: `Your withdrawal request of $${withdrawal.amount} via ${withdrawal.method} has been approved!`,
      withdrawalAmount: withdrawal.amount,
      method: withdrawal.method,
      createdAt: new Date(),
    });
    await notification.save({ session });

    await session.commitTransaction();
    res.json({
      msg: "Withdrawal approved, points deducted",
      withdrawal,
      newBalance: userPoints.balance,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error("Approve withdrawal error:", err);
    res.status(500).json({ msg: "Server error" });
  } finally {
    session.endSession();
  }
});

router.post("/admin/reject/:id", async (req, res) => {
  try {
    const withdrawal = await Withdrawal.findOne({ _id: req.params.id, status: "pending" });
    if (!withdrawal) return res.status(404).json({ msg: "Pending withdrawal not found" });

    withdrawal.status = "rejected";
    withdrawal.rejectedAt = new Date();
    withdrawal.rejectionReason = req.body.reason || "Rejected by admin";
    withdrawal.adminNotes = req.body.notes;
    await withdrawal.save();

    res.json({ msg: "Withdrawal rejected", withdrawal });
  } catch (err) {
    console.error("Reject withdrawal error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

export default router;