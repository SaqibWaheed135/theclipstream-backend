// import express from 'express';
// const router = express.Router();
// import Stripe from "stripe";
// import User from '../models/User.js';
// import Transaction from '../models/Transaction.js';
// import authMiddleware from '../middleware/auth.js';

// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// // Get user's points balance
// router.get('/points/balance',  authMiddleware, async (req, res) => {
//   try {
//     const user = await User.findById(req.user.id);
//     if (!user) {
//       return res.status(404).json({ msg: 'User not found' });
//     }

//     res.json({
//       balance: user.points || 0
//     });
//   } catch (error) {
//     console.error('Error fetching points balance:', error);
//     res.status(500).json({ msg: 'Server error' });
//   }
// });

// // Get user's points history
// router.get('/points/history',  authMiddleware , async (req, res) => {
//   try {
//     const transactions = await Transaction.find({ userId: req.user.id })
//       .sort({ createdAt: -1 })
//       .limit(50); // Limit to last 50 transactions

//     res.json({
//       history: transactions
//     });
//   } catch (error) {
//     console.error('Error fetching points history:', error);
//     res.status(500).json({ msg: 'Server error' });
//   }
// });

// // Create Stripe Payment Intent
// router.post('/create-payment-intent',  authMiddleware , async (req, res) => {
//   try {
//     const { amount, currency = 'usd', metadata } = req.body;

//     // Validate amount
//     if (!amount || amount < 100) { // Minimum $1.00 (100 cents)
//       return res.status(400).json({ error: 'Minimum amount is $1.00' });
//     }

//     if (amount > 50000) { // Maximum $500.00 (50000 cents)
//       return res.status(400).json({ error: 'Maximum amount is $500.00' });
//     }

//     // Create payment intent with Stripe
//     const paymentIntent = await stripe.paymentIntents.create({
//       amount: amount, // amount in cents
//       currency: currency,
//       metadata: {
//         userId: req.user.id,
//         type: 'points_recharge',
//         ...metadata
//       },
//       automatic_payment_methods: {
//         enabled: true,
//       },
//     });

//     res.json({
//       paymentIntent: {
//         id: paymentIntent.id,
//         client_secret: paymentIntent.client_secret,
//         amount: paymentIntent.amount,
//         currency: paymentIntent.currency
//       }
//     });
//   } catch (error) {
//     console.error('Error creating payment intent:', error);
//     res.status(400).json({ 
//       error: error.message || 'Failed to create payment intent' 
//     });
//   }
// });

// // Confirm payment and add points
// router.post('/confirm-payment',  authMiddleware , async (req, res) => {
//   try {
//     const { paymentIntentId, amount, points } = req.body;
//     const userId = req.user.id;

//     // Verify payment with Stripe
//     const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

//     if (!paymentIntent) {
//       return res.status(400).json({ error: 'Payment intent not found' });
//     }

//     if (paymentIntent.status !== 'succeeded') {
//       return res.status(400).json({ error: 'Payment not completed' });
//     }

//     // Verify the payment belongs to this user
//     if (paymentIntent.metadata.userId !== userId) {
//       return res.status(403).json({ error: 'Unauthorized payment access' });
//     }

//     // Check if this payment has already been processed
//     const existingTransaction = await Transaction.findOne({ 
//       transactionId: paymentIntentId 
//     });

//     if (existingTransaction) {
//       return res.status(400).json({ error: 'Payment already processed' });
//     }

//     // Update user's points balance
//     const user = await User.findById(userId);
//     if (!user) {
//       return res.status(404).json({ error: 'User not found' });
//     }

//     user.points = (user.points || 0) + points;
//     await user.save();

//     // Create transaction record
//     const transaction = new Transaction({
//       userId: userId,
//       type: 'recharge',
//       amount: points,
//       description: `Points recharge via Stripe - $${amount}`,
//       paymentMethod: 'stripe',
//       transactionId: paymentIntentId,
//       status: 'completed',
//       metadata: {
//         stripePaymentIntentId: paymentIntentId,
//         amountPaid: amount,
//         pointsReceived: points
//       }
//     });

//     await transaction.save();

//     res.json({
//       success: true,
//       newBalance: user.points,
//       pointsAdded: points,
//       transactionId: paymentIntentId,
//       transaction: transaction
//     });

//   } catch (error) {
//     console.error('Error confirming payment:', error);
//     res.status(500).json({ 
//       error: error.message || 'Failed to confirm payment' 
//     });
//   }
// });

// // Legacy recharge endpoint (for non-Stripe payments)
// router.post('/points/recharge',  authMiddleware , async (req, res) => {
//   try {
//     const { amount, paymentMethod, paymentDetails, transactionId } = req.body;
//     const userId = req.user.id;

//     // Validate input
//     if (!amount || amount <= 0) {
//       return res.status(400).json({ msg: 'Invalid amount' });
//     }

//     if (amount < 1 || amount > 500) {
//       return res.status(400).json({ msg: 'Amount must be between $1 and $500' });
//     }

//     if (!paymentMethod) {
//       return res.status(400).json({ msg: 'Payment method is required' });
//     }

//     // Calculate points (1 dollar = 10 points base + bonus)
//     const calculatePoints = (amount) => {
//       const basePoints = amount * 10;
//       let bonus = 0;
      
//       // Apply bonuses based on amount
//       if (amount >= 100) bonus = 400;
//       else if (amount >= 50) bonus = 150;
//       else if (amount >= 25) bonus = 50;
//       else if (amount >= 10) bonus = 10;
      
//       return basePoints + bonus;
//     };

//     const pointsToAdd = calculatePoints(amount);

//     // For demo purposes, we'll simulate payment processing
//     // In production, you'd integrate with actual payment processors
    
//     // Simulate payment processing delay
//     await new Promise(resolve => setTimeout(resolve, 1000));

//     // Find user and update balance
//     const user = await User.findById(userId);
//     if (!user) {
//       return res.status(404).json({ msg: 'User not found' });
//     }

//     user.points= (user.points || 0) + pointsToAdd;
//     await user.save();

//     // Create transaction record
//     const transaction = new Transaction({
//       userId: userId,
//       type: 'recharge',
//       amount: pointsToAdd,
//       description: `Points recharge via ${paymentMethod} - $${amount}`,
//       paymentMethod: paymentMethod,
//       transactionId: transactionId || `legacy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
//       status: 'completed',
//       metadata: {
//         amountPaid: amount,
//         pointsReceived: pointsToAdd,
//         paymentDetails: paymentMethod !== 'stripe' ? paymentDetails : undefined
//       }
//     });

//     await transaction.save();

//     res.json({
//       success: true,
//       newBalance: user.points,
//       pointsAdded: pointsToAdd,
//       msg: `Successfully added ${pointsToAdd} points to your account`,
//       transaction: transaction
//     });

//   } catch (error) {
//     console.error('Error processing recharge:', error);
//     res.status(500).json({ msg: 'Server error during recharge' });
//   }
// });

// // Stripe webhook endpoint for handling payment events
// router.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
//   const sig = req.headers['stripe-signature'];
//   let event;

//   try {
//     event = stripe.webhooks.constructEvent(
//       req.body, 
//       sig, 
//       process.env.STRIPE_WEBHOOK_SECRET
//     );
//   } catch (err) {
//     console.error('Webhook signature verification failed:', err.message);
//     return res.status(400).send(`Webhook Error: ${err.message}`);
//   }

//   // Handle the event
//   switch (event.type) {
//     case 'payment_intent.succeeded':
//       const paymentIntent = event.data.object;
//       console.log('Payment succeeded:', paymentIntent.id);
      
//       // You can add additional logic here if needed
//       // For example, sending confirmation emails, updating analytics, etc.
//       break;

//     case 'payment_intent.payment_failed':
//       const failedPayment = event.data.object;
//       console.log('Payment failed:', failedPayment.id);
      
//       // Handle failed payment
//       // You might want to notify the user or log for analysis
//       break;

//     case 'payment_method.attached':
//       const paymentMethod = event.data.object;
//       console.log('Payment method attached:', paymentMethod.id);
//       break;

//     default:
//       console.log(`Unhandled event type ${event.type}`);
//   }

//   res.json({received: true});
// });

// // Get payment methods (for user's saved payment methods)
// router.get('/payment-methods',  authMiddleware , async (req, res) => {
//   try {
//     // This would typically fetch saved payment methods from Stripe
//     // For now, returning empty array
//     res.json({
//       paymentMethods: []
//     });
//   } catch (error) {
//     console.error('Error fetching payment methods:', error);
//     res.status(500).json({ error: 'Failed to fetch payment methods' });
//   }
// });

// // Refund points (admin function)
// router.post('/refund',  authMiddleware , async (req, res) => {
//   try {
//     const { transactionId, reason } = req.body;
    
//     // Check if user has admin privileges (implement your admin check)
//     // if (!req.user.isAdmin) {
//     //   return res.status(403).json({ error: 'Admin access required' });
//     // }

//     const transaction = await Transaction.findOne({ transactionId });
//     if (!transaction) {
//       return res.status(404).json({ error: 'Transaction not found' });
//     }

//     if (transaction.status === 'refunded') {
//       return res.status(400).json({ error: 'Transaction already refunded' });
//     }

//     // Process refund with Stripe if it was a Stripe payment
//     if (transaction.paymentMethod === 'stripe') {
//       const refund = await stripe.refunds.create({
//         payment_intent: transactionId,
//         reason: 'requested_by_customer'
//       });

//       if (refund.status !== 'succeeded') {
//         return res.status(400).json({ error: 'Refund failed' });
//       }
//     }

//     // Update user's points balance
//     const user = await User.findById(transaction.userId);
//     user.points = Math.max(0, user.points - transaction.amount);
//     await user.save();

//     // Update transaction status
//     transaction.status = 'refunded';
//     transaction.refundReason = reason;
//     transaction.refundedAt = new Date();
//     await transaction.save();

//     res.json({
//       success: true,
//       message: 'Refund processed successfully',
//       newBalance: user.points
//     });

//   } catch (error) {
//     console.error('Error processing refund:', error);
//     res.status(500).json({ error: 'Failed to process refund' });
//   }
// });

// export default router;

// Backend Routes for Recharges (recharges.js)
// Assume you have a Recharge model similar to Withdrawal:
// import Recharge from "../models/Recharge.js"; // Create this model: similar to Withdrawal but for recharges, with fields like userId, requestId, amount, pointsToAdd, method, status, details (including screenshotUrl), requestedAt, etc.
// Also assume you have multer for file upload if needed.
// For screenshot, use multer to upload and store the file, save URL in details.

// routes/recharges.js
import express from "express";
import Recharge from "../models/Recharge.js";
import { PointsBalance, PointsTransaction } from "../models/Points.js";
import { body, validationResult } from "express-validator";
import mongoose from "mongoose";
import authMiddleware from "../middleware/auth.js";
import User from "../models/User.js";
import multer from "multer";
import path from "path";
import crypto from "crypto"; // add this line
import axios from "axios";     // 👈 also needed since you are using axios.post


// Multer setup for screenshot upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/screenshots/');
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ 
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

const router = express.Router();

// const USDT_CONFIG = {
//   apiUrl: process.env.USDT_API_URL || "https://your-usdt-payment-gateway.com/api",
//   apiKey: process.env.USDT_API_KEY || "your-api-key",
//   secretKey: process.env.USDT_SECRET_KEY || "your-secret-key",
//   callbackUrl: process.env.USDT_CALLBACK_URL || "https://yourdomain.com/api/recharges/usdt/callback",
//   usdtToPointsRate: 10, // 1 USDT = 10 points
// };
const USDT_CONFIG = {
  receiveWallet: "TNPfwe8tbnU4dXBKgoJAuk4P4Dx7MivRjD",
  usdtToPointsRate: 10, // 1 USDT = 10 points
  orderExpiryMinutes: 15,
};

// Helper function to parse FormData details
const parseFormDataDetails = (req) => {
  try {
    const detailsStr = req.body.details;
    if (detailsStr && typeof detailsStr === 'string') {
      return JSON.parse(detailsStr);
    }
    return req.body.details || {};
  } catch (error) {
    console.error('Error parsing details:', error);
    return {};
  }
};

// Generate signature for USDT payments
const generateSignature = (data, secretKey) => {
  const sortedParams = Object.keys(data)
    .sort()
    .map(key => `${key}=${data[key]}`)
    .join('&');
  
  return crypto
    .createHmac('sha256', secretKey)
    .update(sortedParams)
    .digest('hex');
};
/**
 * USDT PAYMENT ROUTES
 */

// Create USDT payment order
router.post("/usdt/create-order", authMiddleware, [
  body("amount", "Amount is required").isNumeric().isFloat({ min: 1 }),
], async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.user.id;
    const parsedAmount = parseFloat(amount);

    if (parsedAmount < 1) {
      return res.status(400).json({ msg: "Minimum USDT recharge amount is 1" });
    }

    // Only allow one pending at a time
    const pending = await Recharge.findOne({ userId, method: "usdt", status: "pending" });
    if (pending) {
      return res.status(400).json({ msg: "You already have a pending USDT payment" });
    }

    // 🔹 Generate unique fractional suffix (4 random digits)
    const uniqueSuffix = (Math.floor(Math.random() * 9000) + 1000) / 1e6; // e.g. 0.004321
    const finalAmount = parseFloat((parsedAmount + uniqueSuffix).toFixed(6));

    // Calculate points
    const pointsToAdd = parsedAmount * USDT_CONFIG.usdtToPointsRate; 
    // points based on original requested amount, NOT the unique cents

    // Generate unique order ID
    const requestId = `USDT${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    const expiresAt = new Date(Date.now() + USDT_CONFIG.orderExpiryMinutes * 60 * 1000);

    const recharge = new Recharge({
      userId,
      requestId,
      amount: finalAmount, // 🔹 store final unique amount
      pointsToAdd,
      method: "usdt",
      status: "pending",
      details: {
        usdtAmount: finalAmount,
        requestedAmount: parsedAmount, // save original requested separately
        exchangeRate: USDT_CONFIG.usdtToPointsRate,
        walletAddress: USDT_CONFIG.receiveWallet,
        transactionHash: "",
      },
      requestedAt: new Date(),
      expiresAt,
      metadata: { paymentGateway: "direct_tronscan" },
    });

    await recharge.save();

    res.json({
      success: true,
      msg: "USDT payment order created successfully",
      data: {
        orderId: requestId,
        amount: finalAmount, // 🔹 user sees the unique amount
        originalAmount: parsedAmount,
        pointsToAdd,
        walletAddress: USDT_CONFIG.receiveWallet,
        expiresAt,
      },
    });
  } catch (err) {
    console.error("USDT order creation error:", err);
    res.status(500).json({ msg: "Server error", errors: [{ msg: err.message }] });
  }
});


router.post("/usdt/check-payment", authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ msg: "Order ID is required" });
    }

    const recharge = await Recharge.findOne({
      requestId: orderId,
      userId: req.user.id,
      method: "usdt",
    });

    if (!recharge) {
      return res.status(404).json({ msg: "Order not found" });
    }

    if (recharge.status === "approved") {
      return res.json({ success: true, status: "approved", data: recharge });
    }

    if (new Date() > recharge.expiresAt) {
      recharge.status = "expired";
      await recharge.save();
      return res.json({ success: false, status: "expired", msg: "Order expired" });
    }

    // Query TronGrid
    const url = `https://api.trongrid.io/v1/accounts/${USDT_CONFIG.receiveWallet}/transactions/trc20?limit=50`;
    const tronRes = await axios.get(url, {
      headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" },
      timeout: 10000,
    });

    const transfers = tronRes.data?.data || [];
    const expectedAmount = Number(recharge.amount);
    const expectedUnits = BigInt(Math.round(expectedAmount * 1e6)); // USDT has 6 decimals
    const startTime = new Date(recharge.requestedAt).getTime();
    const endTime = new Date(recharge.expiresAt).getTime();

    const match = transfers.find((tx) => {
      const to = (tx.to || "").toLowerCase();
      if (to !== USDT_CONFIG.receiveWallet.toLowerCase()) return false;

      // Only accept official USDT contract
      if (!tx.token_info || tx.token_info.contract_address !== "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj") {
        return false;
      }

      // Compare amount
      let rawVal = tx.value || "0";
      let valueBigInt = BigInt(rawVal.toString());
      if (valueBigInt !== expectedUnits) return false;

      // Check timestamp (TronGrid provides block_timestamp in ms)
      const txTime = tx.block_timestamp;
      if (txTime < startTime || txTime > endTime) return false;

      return true;
    });

    if (match) {
      const txHash = match.transaction_id;

      await approveUsdtPayment(recharge, {
        transaction_hash: txHash,
        amount: recharge.amount,
        status: "paid",
      });

      return res.json({
        success: true,
        status: "approved",
        msg: "Payment confirmed",
        data: {
          orderId: recharge.requestId,
          amount: recharge.amount,
          pointsAdded: recharge.pointsToAdd,
          transactionHash: txHash,
        },
      });
    }

    res.json({
      success: false,
      status: "pending",
      msg: "Payment not yet detected",
      data: {
        orderId: recharge.requestId,
        amount: recharge.amount,
        walletAddress: recharge.details.walletAddress,
      },
    });
  } catch (err) {
    console.error("Payment check error:", err);
    res.status(500).json({ msg: "Server error", errors: [{ msg: err.message }] });
  }
});





// Helper function to approve USDT payment
async function approveUsdtPayment(recharge, paymentData) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    // 1. Get or create PointsBalance
    let userPoints = await PointsBalance.findOne({ userId: recharge.userId }).session(session);
    if (!userPoints) {
      userPoints = new PointsBalance({ 
        userId: recharge.userId, 
        balance: 0,
        totalEarned: 0 
      });
      await userPoints.save({ session });
    }
    
    const before = userPoints.balance;

    // 2. Add to PointsBalance
    userPoints.balance += recharge.pointsToAdd;
    userPoints.totalEarned += recharge.pointsToAdd;
    await userPoints.save({ session });

    // 3. Add to User model (mirror)
    await User.findByIdAndUpdate(
      recharge.userId,
      { $inc: { points: recharge.pointsToAdd } },
      { session }
    );

    // 4. Update recharge
    recharge.status = "approved";
    recharge.approvedAt = new Date();
    recharge.details.transactionHash = paymentData.transaction_hash;
    recharge.details.confirmedAmount = paymentData.amount;
    recharge.adminNotes = "Auto-approved via USDT payment";
    await recharge.save({ session });

    // 5. Log transaction
    const tx = new PointsTransaction({
      userId: recharge.userId,
      transactionId: `${recharge.requestId}_USDT_APPROVED`,
      type: "credit",
      category: "usdt_recharge_approved",
      amount: recharge.pointsToAdd,
      balanceBefore: before,
      balanceAfter: userPoints.balance,
      description: `USDT Recharge: ${recharge.amount} USDT`,
      metadata: { 
        rechargeId: recharge._id,
        transactionHash: paymentData.transaction_hash,
        usdtAmount: recharge.amount,
        autoApproved: true
      },
    });
    await tx.save({ session });

    await session.commitTransaction();
    console.log("USDT payment approved and points added for user:", recharge.userId);
    
  } catch (error) {
    await session.abortTransaction();
    console.error("Error approving USDT payment:", error);
    throw error;
  } finally {
    session.endSession();
  }
}


/**
 * USER ROUTES
 */

// Request recharge (for manual methods like bank)
router.post(
  "/request",
  [
    authMiddleware, 
    upload.single('transactionScreenshot')
  ],
  [
    // Validate main fields first
    body("amount", "Amount is required").isNumeric().isFloat({ min: 1 }),
    body("pointsToAdd", "Points to add is required").isNumeric().isFloat({ min: 1 }),
    body("method", "Recharge method is required").isIn(["bank"]),
    
    // Validate details fields - these will be checked after parsing
  ],
  async (req, res) => {
    try {
      // Parse details from FormData
      const details = parseFormDataDetails(req);
      
      // Manual validation for details (since express-validator doesn't work well with FormData nested objects)
      const errors = [];
      
      if (!req.body.amount || !req.body.pointsToAdd || !req.body.method) {
        return res.status(400).json({ 
          errors: [
            { msg: 'Amount, points, and method are required' }
          ]
        });
      }

      if (!details.fullName || details.fullName.trim() === '') {
        errors.push({ type: 'field', msg: 'Full name is required', path: 'details.fullName' });
      }
      
      if (!details.email || !/\S+@\S+\.\S+/.test(details.email)) {
        errors.push({ type: 'field', msg: 'Valid email is required', path: 'details.email' });
      }
      
      if (!details.phone || details.phone.trim() === '') {
        errors.push({ type: 'field', msg: 'Phone number is required', path: 'details.phone' });
      }
      
      if (!details.transactionId || details.transactionId.trim() === '') {
        errors.push({ type: 'field', msg: 'Transaction ID is required', path: 'details.transactionId' });
      }

      // Check for screenshot
      if (!req.file) {
        errors.push({ type: 'field', msg: 'Transaction screenshot is required', path: 'transactionScreenshot' });
      }

      if (errors.length > 0) {
        return res.status(400).json({ errors });
      }

      const { amount, pointsToAdd, method } = req.body;
      const userId = req.user.id;
      const parsedAmount = parseFloat(amount);
      const parsedPoints = parseFloat(pointsToAdd);

      // Minimum recharge rules
      const minimumLimits = { bank: 10 };
      if (parsedAmount < minimumLimits[method]) {
        return res.status(400).json({
          msg: `Minimum recharge amount for ${method} is $${minimumLimits[method]}`,
          errors: [{ msg: `Minimum recharge amount for ${method} is $${minimumLimits[method]}` }]
        });
      }

      // Prevent multiple pending
      const pending = await Recharge.findOne({ userId, status: "pending" });
      if (pending) {
        return res.status(400).json({ 
          msg: "You already have a pending recharge request",
          errors: [{ msg: "You already have a pending recharge request" }]
        });
      }

      // Add screenshot info to details
      const fullDetails = {
        ...details,
        transactionScreenshot: {
          filename: req.file.filename,
          originalName: req.file.originalname,
          path: `/uploads/screenshots/${req.file.filename}`,
          size: req.file.size,
          mimetype: req.file.mimetype,
          uploadedAt: new Date()
        }
      };

      // Create request
      const requestId = `RC${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
      const recharge = new Recharge({
        userId,
        requestId,
        amount: parsedAmount,
        pointsToAdd: parsedPoints,
        method,
        status: "pending",
        details: fullDetails,
        requestedAt: new Date(),
        metadata: {
          exchangeRate: parsedPoints / parsedAmount,
        },
      });
      await recharge.save();

      // Log transaction (not add yet)
      const userPoints = await PointsBalance.findOne({ userId });
      const tx = new PointsTransaction({
        userId,
        transactionId: requestId,
        type: "credit",
        category: "recharge_request",
        amount: parsedPoints,
        balanceBefore: userPoints ? userPoints.balance : 0,
        balanceAfter: userPoints ? userPoints.balance : 0,
        description: `Recharge request: $${parsedAmount} (${method})`,
        metadata: { 
          rechargeRequest: recharge._id, 
          status: "pending",
          screenshotPath: fullDetails.transactionScreenshot.path
        },
      });
      await tx.save();

      res.json({
        msg: "Recharge request submitted successfully",
        recharge: {
          id: recharge._id,
          requestId: recharge.requestId,
          amount: recharge.amount,
          pointsToAdd: recharge.pointsToAdd,
          method: recharge.method,
          status: recharge.status,
          requestedAt: recharge.requestedAt,
        },
      });
    } catch (err) {
      console.error("Recharge request error:", err);
      res.status(500).json({ 
        msg: "Server error", 
        errors: [{ msg: "Server error: " + err.message }] 
      });
    }
  }
);

// Recharge history
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

    const recharges = await Recharge.find(query)
      .populate("userId", "username email")
      .sort({ requestedAt: -1 })
      .skip(skip)
      .limit(limit);

    const baseUrl = "https://theclipstream-backend.onrender.com" || "https://api.theclipstream.com";

    // 🔹 Add screenshot + balance
    const rechargesWithBalance = await Promise.all(
      recharges.map(async (recharge) => {
        // Build screenshot URL
        let screenshotUrl = null;
        if (
          recharge.method === "bank" &&
          recharge.details?.transactionScreenshot
        ) {
          const screenshotPath = recharge.details.transactionScreenshot.path;
          const cleanPath = screenshotPath.startsWith("/")
            ? screenshotPath.slice(1)
            : screenshotPath;
          screenshotUrl = `${baseUrl}/${cleanPath}`;
        }

        // Fetch user balance from PointsBalance
        const userPoints = await PointsBalance.findOne({
          userId: recharge.userId,
        });

        return {
          ...recharge.toObject(),
          screenshotUrl,
          userBalance: userPoints ? userPoints.balance : 0, // ✅ balance included
        };
      })
    );

    const total = await Recharge.countDocuments(query);

    res.json({
      recharges: rechargesWithBalance,
      pagination: {
        page,
        pages: Math.ceil(total / limit),
        total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1,
      },
    });
  } catch (err) {
    console.error("Get recharge history error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});


// Cancel recharge
router.post("/cancel/:id", async (req, res) => {
  try {
    const recharge = await Recharge.findOne({
      _id: req.params.id,
      status: "pending",
    });
    if (!recharge) {
      return res.status(404).json({ msg: "Pending recharge not found" });
    }

    recharge.status = "cancelled";
    recharge.cancelledAt = new Date();
    recharge.cancelledBy = "user";
    await recharge.save();

    res.json({ msg: "Recharge cancelled", recharge });
  } catch (err) {
    console.error("Cancel recharge error:", err);
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

    const recharge = await Recharge.findOne({
      _id: req.params.id,
      status: "pending",
    }).session(session);

    if (!recharge) {
      await session.abortTransaction();
      return res.status(404).json({ msg: "Pending recharge not found" });
    }

    // 1. Get or create PointsBalance
    let userPoints = await PointsBalance.findOne({ userId: recharge.userId }).session(session);
    if (!userPoints) {
      userPoints = new PointsBalance({ 
        userId: recharge.userId, 
        balance: 0,
        totalEarned: 0 
      });
      await userPoints.save({ session });
    }
    
    const before = userPoints.balance;

    // 2. Add to PointsBalance
    userPoints.balance += recharge.pointsToAdd;
    userPoints.totalEarned += recharge.pointsToAdd;
    await userPoints.save({ session });

    // 3. Add to User model (mirror)
    await User.findByIdAndUpdate(
      recharge.userId,
      { $inc: { points: recharge.pointsToAdd } },
      { session }
    );

    // 4. Update recharge
    recharge.status = "approved";
    recharge.approvedAt = new Date();
    recharge.adminNotes = req.body.notes || "Approved by admin";
    await recharge.save({ session });

    // 5. Log transaction
    const tx = new PointsTransaction({
      userId: recharge.userId,
      transactionId: `${recharge.requestId}_APPROVED`,
      type: "credit",
      category: "recharge_approved",
      amount: recharge.pointsToAdd,
      balanceBefore: before,
      balanceAfter: userPoints.balance,
      description: `Recharge approved: $${recharge.amount} (${recharge.method})`,
      metadata: { 
        rechargeId: recharge._id, 
        adminNotes: req.body.notes || "Approved by admin",
        screenshotPath: recharge.details.transactionScreenshot?.path
      },
    });
    await tx.save({ session });

    await session.commitTransaction();
    res.json({
      msg: "Recharge approved, points added",
      recharge,
      newBalance: userPoints.balance,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error("Approve recharge error:", err);
    res.status(500).json({ msg: "Server error" });
  } finally {
    session.endSession();
  }
});

// Reject
router.post("/admin/reject/:id", async (req, res) => {
  try {
    const recharge = await Recharge.findOne({ _id: req.params.id, status: "pending" });
    if (!recharge) {
      return res.status(404).json({ msg: "Pending recharge not found" });
    }

    recharge.status = "rejected";
    recharge.rejectedAt = new Date();
    recharge.rejectionReason = req.body.reason || "Rejected by admin";
    recharge.adminNotes = req.body.notes || "Rejected by admin";
    await recharge.save();

    res.json({ msg: "Recharge rejected", recharge });
  } catch (err) {
    console.error("Reject recharge error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

// Get admin dashboard data
router.get("/admin/dashboard", async (req, res) => {
  try {
    const stats = await Recharge.aggregate([
      {
        $group: {
          _id: null,
          totalPending: {
            $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] }
          },
          totalApproved: {
            $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] }
          },
          totalRejected: {
            $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] }
          },
          totalCancelled: {
            $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] }
          },
          totalAmountRequested: { $sum: '$amount' },
          totalPointsRequested: { $sum: '$pointsToAdd' }
        }
      }
    ]);

    res.json({
      stats: stats[0] || {
        totalPending: 0,
        totalApproved: 0,
        totalRejected: 0,
        totalCancelled: 0,
        totalAmountRequested: 0,
        totalPointsRequested: 0
      }
    });
  } catch (err) {
    console.error("Dashboard stats error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

export default router;