// models/Withdrawal.js
import mongoose from "mongoose";

const withdrawalSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    requestId: { type: String, required: true, unique: true, index: true },

    amount: { type: Number, required: true }, // USD
    pointsToDeduct: { type: Number, required: true }, // points
    method: {
      type: String,
      enum: ["paypal", "bank", "card", "usdt"],
      required: true,
    },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "cancelled"],
      default: "pending",
    },

    details: {
      fullName: { type: String, required: true },
      email: { type: String, required: true },
      phone: { type: String, required: true },

      paypalEmail: { type: String },

      bankDetails: {
        accountNumber: { type: String },
        bankName: { type: String },
        ifsc: { type: String },
        swiftCode: { type: String },
      },
      usdtDetails: {
        walletAddress: String,   // 👈 This was missing
      },

      cardDetails: {
        cardNumber: { type: String },
        expiry: { type: String },
        cardHolder: { type: String },
      },

      address: {
        street: { type: String },
        city: { type: String },
        state: { type: String },
        zipCode: { type: String },
        country: { type: String },
      },
    },

    requestedAt: { type: Date, default: Date.now },
    approvedAt: Date,
    rejectedAt: Date,
    cancelledAt: Date,

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    cancelledBy: { type: String }, // "user" | "admin"

    rejectionReason: { type: String },
    adminNotes: { type: String },

    metadata: {
      userBalance: { type: Number },
      exchangeRate: { type: Number }, // points per USD
      ipAddress: { type: String },
      device: { type: String },
    },
  },
  { timestamps: true }
);

export default mongoose.model("Withdrawal", withdrawalSchema);
