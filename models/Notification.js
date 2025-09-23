import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  type: {
    type: String,
    required: true,
    enum: ["withdrawal_approved", "follow_request","points_transfer_sent","points_transfer_received"], 
  },
  message: {
    type: String,
    required: true,
  },
  withdrawalAmount: {
    type: Number,
    required: function () {
      return this.type === "withdrawal_approved";
    },
  },
  method: {
    type: String,
    enum: ["paypal", "bank", "card", "usdt"],
    required: function () {
      return this.type === "withdrawal_approved";
    },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  read: {
    type: Boolean,
    default: false,
  },
});

export default mongoose.model("Notification", notificationSchema);