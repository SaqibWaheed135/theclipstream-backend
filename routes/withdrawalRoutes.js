import express from "express";
import Withdrawal from "../models/Withdrawal.js";
import { PointsBalance, PointsTransaction } from "../models/Points.js";
import { body, validationResult } from "express-validator";
import mongoose from "mongoose";
import authMiddleware from "../middleware/auth.js";
import User from "../models/User.js";

const router = express.Router();

/**
 * USER ROUTES (no auth now)
 */

// Request withdrawal
router.post(
  "/request",
  [
    authMiddleware,  // ✅ pulls user from JWT
    [
      body("amount", "Amount is required").isNumeric().isFloat({ min: 1 }),
      body("pointsToDeduct", "Points to deduct is required").isNumeric(),
      body("method", "Withdrawal method is required").isIn(["paypal", "bank", "card"]),
      body("details.fullName", "Full name is required").not().isEmpty(),
      body("details.email", "Valid email is required").isEmail(),
      body("details.phone", "Phone number is required").not().isEmpty(),
    ],
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { amount, pointsToDeduct, method, details } = req.body;
      const userId = req.user.id; // ✅ from auth middleware

      // Check points balance
      const userPoints = await PointsBalance.findOne({ userId });
      if (!userPoints || userPoints.balance < pointsToDeduct) {
        return res.status(400).json({ msg: "Insufficient points for this withdrawal" });
      }

      // Minimum withdrawal rules
      const minimumLimits = { paypal: 10, bank: 25, card: 5 };
      if (amount < minimumLimits[method]) {
        return res.status(400).json({
          msg: `Minimum withdrawal amount for ${method} is $${minimumLimits[method]}`,
        });
      }

      // Prevent multiple pending
      const pending = await Withdrawal.findOne({ userId, status: "pending" });
      if (pending) {
        return res.status(400).json({ msg: "You already have a pending withdrawal request" });
      }

      // Create request
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

      // Log transaction (not deduct yet)
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

// Withdrawal history
// Withdrawal history
router.get("/history", async (req, res) => {
  try {
    const { userId } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    let query = {};
    if (userId) {
      query.userId = userId; // user mode
    }

    const withdrawals = await Withdrawal.find(query)
      .populate("userId", "username email")
      .sort({ requestedAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Withdrawal.countDocuments(query);

    res.json({
      withdrawals,
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


// Cancel withdrawal
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
 * ADMIN ROUTES (no auth now)
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

    // 1. Get PointsBalance
    const userPoints = await PointsBalance.findOne({ userId: withdrawal.userId }).session(session);
    if (!userPoints || userPoints.balance < withdrawal.pointsToDeduct) {
      await session.abortTransaction();
      return res.status(400).json({ msg: "User does not have enough points" });
    }

    const before = userPoints.balance;

    // 2. Deduct from PointsBalance
    userPoints.balance -= withdrawal.pointsToDeduct;
    userPoints.totalSpent += withdrawal.pointsToDeduct;
    await userPoints.save({ session });

    // 3. Deduct from User model (mirror)
    await User.findByIdAndUpdate(
      withdrawal.userId,
      { $inc: { points: -withdrawal.pointsToDeduct } }, // subtract directly
      { session }
    );

    // 4. Update withdrawal
    withdrawal.status = "approved";
    withdrawal.approvedAt = new Date();
    withdrawal.adminNotes = req.body.notes;
    await withdrawal.save({ session });

    // 5. Log transaction
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



// Reject
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
