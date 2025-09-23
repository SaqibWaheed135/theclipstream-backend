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