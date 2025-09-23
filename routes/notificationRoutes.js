import express from "express";
import Notification from "../models/Notification.js";
import authMiddleware from "../middleware/auth.js";

const router = express.Router();

// Get withdrawal notifications for the authenticated user
router.get("/withdrawals", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const notifications = await Notification.find({ userId, type: "withdrawal_approved" })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(notifications);
  } catch (err) {
    console.error("Get withdrawal notifications error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

export default router;