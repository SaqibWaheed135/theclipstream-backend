// routes/withdrawalRoutes.js

import express from "express";
import authMiddleware from "../middleware/auth.js";   // 🔹 removed adminAuth
import Withdrawal from "../models/Withdrawal.js";
import User from "../models/User.js";
import { PointsBalance, PointsTransaction } from "../models/Points.js";
import { body, validationResult } from "express-validator";
import mongoose from "mongoose";

const router = express.Router();

/**
 * USER ROUTES
 * (unchanged)
 */

// ... request, history, cancel routes stay same ...

/**
 * ADMIN ROUTES (now just use auth)
 */

// Approve
router.post("/admin/approve/:id", [authMiddleware, [body("notes").optional()]], async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const withdrawalId = req.params.id;
    const { notes } = req.body;
    const adminId = req.user.id; // still saved as approvedBy

    const withdrawal = await Withdrawal.findOne({ _id: withdrawalId, status: "pending" }).session(
      session
    );
    if (!withdrawal) {
      await session.abortTransaction();
      return res.status(404).json({ msg: "Pending withdrawal request not found" });
    }

    const userPoints = await PointsBalance.findOne({ userId: withdrawal.userId }).session(session);
    if (!userPoints || userPoints.balance < withdrawal.pointsToDeduct) {
      await session.abortTransaction();
      return res.status(400).json({ msg: "User no longer has sufficient points" });
    }

    // Deduct
    userPoints.balance -= withdrawal.pointsToDeduct;
    await userPoints.save({ session });

    withdrawal.status = "approved";
    withdrawal.approvedAt = new Date();
    withdrawal.approvedBy = adminId;
    withdrawal.adminNotes = notes;
    await withdrawal.save({ session });

    const tx = new PointsTransaction({
      userId: withdrawal.userId,
      transactionId: `${withdrawal.requestId}_APPROVED`,
      type: "debit",
      category: "withdrawal_approved",
      amount: withdrawal.pointsToDeduct,
      balanceBefore: userPoints.balance + withdrawal.pointsToDeduct,
      balanceAfter: userPoints.balance,
      description: `Withdrawal approved: $${withdrawal.amount} (${withdrawal.method})`,
      metadata: { withdrawalId: withdrawal._id, approvedBy: adminId, adminNotes: notes },
    });
    await tx.save({ session });

    await PointsTransaction.updateOne(
      { transactionId: withdrawal.requestId, category: "withdrawal_request" },
      {
        description: `Withdrawal approved: $${withdrawal.amount} (${withdrawal.method})`,
        "metadata.status": "approved",
        "metadata.approvedBy": adminId,
        "metadata.approvedAt": new Date(),
      }
    ).session(session);

    await session.commitTransaction();
    res.json({ msg: "Withdrawal approved", withdrawal, newBalance: userPoints.balance });
  } catch (err) {
    await session.abortTransaction();
    console.error("Approve withdrawal error:", err);
    res.status(500).json({ msg: "Server error" });
  } finally {
    session.endSession();
  }
});

// Reject
router.post("/admin/reject/:id", [authMiddleware, [body("reason").not().isEmpty()]], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { reason, notes } = req.body;
    const adminId = req.user.id;

    const withdrawal = await Withdrawal.findOne({ _id: req.params.id, status: "pending" });
    if (!withdrawal) return res.status(404).json({ msg: "Pending withdrawal request not found" });

    withdrawal.status = "rejected";
    withdrawal.rejectedAt = new Date();
    withdrawal.rejectedBy = adminId;
    withdrawal.rejectionReason = reason;
    withdrawal.adminNotes = notes;
    await withdrawal.save();

    await PointsTransaction.updateOne(
      { transactionId: withdrawal.requestId, category: "withdrawal_request" },
      {
        description: `Withdrawal rejected: $${withdrawal.amount} (${withdrawal.method})`,
        "metadata.status": "rejected",
        "metadata.rejectedBy": adminId,
        "metadata.rejectionReason": reason,
        "metadata.rejectedAt": new Date(),
      }
    );

    res.json({ msg: "Withdrawal rejected", withdrawal });
  } catch (err) {
    console.error("Reject withdrawal error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

export default router;
