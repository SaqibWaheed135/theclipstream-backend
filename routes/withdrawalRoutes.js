// routes/withdrawals.js
const express = require('express');
const router = express.Router();
const { auth, adminAuth } = require('../middleware/auth');
const Withdrawal = require('../models/Withdrawal');
const User = require('../models/User');
const Points = require('../models/Points');
const { body, validationResult } = require('express-validator');
const mongoose = require('mongoose');

// @route   POST /api/withdrawals/request
// @desc    Request a withdrawal
// @access  Private
router.post('/request', [
  auth,
  [
    body('amount', 'Amount is required').isNumeric().isFloat({ min: 1 }),
    body('pointsToDeduct', 'Points to deduct is required').isNumeric(),
    body('method', 'Withdrawal method is required').isIn(['paypal', 'bank', 'card']),
    body('details.fullName', 'Full name is required').not().isEmpty(),
    body('details.email', 'Valid email is required').isEmail(),
    body('details.phone', 'Phone number is required').not().isEmpty()
  ]
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { amount, pointsToDeduct, method, details } = req.body;
    const userId = req.user.id;

    // Check if user has enough points
    const userPoints = await Points.findOne({ userId });
    if (!userPoints || userPoints.balance < pointsToDeduct) {
      return res.status(400).json({
        msg: 'Insufficient points for this withdrawal'
      });
    }

    // Check minimum withdrawal limits
    const minimumLimits = {
      paypal: 10,
      bank: 25,
      card: 5
    };

    if (amount < minimumLimits[method]) {
      return res.status(400).json({
        msg: `Minimum withdrawal amount for ${method} is $${minimumLimits[method]}`
      });
    }

    // Check for pending withdrawals (optional - limit one at a time)
    const pendingWithdrawal = await Withdrawal.findOne({
      userId,
      status: 'pending'
    });

    if (pendingWithdrawal) {
      return res.status(400).json({
        msg: 'You already have a pending withdrawal request. Please wait for approval or contact support.'
      });
    }

    // Generate request ID
    const requestId = `WD${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

    // Create withdrawal request
    const withdrawal = new Withdrawal({
      userId,
      requestId,
      amount,
      pointsToDeduct,
      method,
      status: 'pending',
      details: {
        fullName: details.fullName,
        email: details.email,
        phone: details.phone,
        paypalEmail: method === 'paypal' ? details.paypalEmail : undefined,
        bankDetails: method === 'bank' ? details.bankDetails : undefined,
        cardDetails: method === 'card' ? details.cardDetails : undefined,
        address: details.address
      },
      requestedAt: new Date(),
      metadata: {
        userBalance: userPoints.balance,
        exchangeRate: pointsToDeduct / amount // points per dollar
      }
    });

    await withdrawal.save();

    // Log the withdrawal request in points history (but don't deduct points yet)
    const pointsHistory = new Points({
      userId,
      type: 'debit',
      amount: -pointsToDeduct,
      category: 'withdrawal_request',
      description: `Withdrawal request: $${amount} (${method})`,
      balanceAfter: userPoints.balance, // Balance stays same until approved
      transactionId: requestId,
      metadata: {
        withdrawalRequest: withdrawal._id,
        status: 'pending'
      }
    });

    await pointsHistory.save();

    // TODO: Send notification to admin (email, webhook, etc.)
    // await sendAdminNotification(withdrawal);

    res.json({
      msg: 'Withdrawal request submitted successfully',
      withdrawal: {
        id: withdrawal._id,
        requestId: withdrawal.requestId,
        amount: withdrawal.amount,
        method: withdrawal.method,
        status: withdrawal.status,
        requestedAt: withdrawal.requestedAt
      }
    });

  } catch (error) {
    console.error('Withdrawal request error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// @route   GET /api/withdrawals/history
// @desc    Get user's withdrawal history
// @access  Private
router.get('/history', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const withdrawals = await Withdrawal.find({ userId })
      .sort({ requestedAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-details.bankDetails.accountNumber -details.cardDetails.cardNumber'); // Hide sensitive data

    const total = await Withdrawal.countDocuments({ userId });

    res.json({
      withdrawals,
      pagination: {
        page,
        pages: Math.ceil(total / limit),
        total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      }
    });

  } catch (error) {
    console.error('Get withdrawal history error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// @route   POST /api/withdrawals/cancel/:id
// @desc    Cancel a pending withdrawal request
// @access  Private
router.post('/cancel/:id', auth, async (req, res) => {
  try {
    const withdrawalId = req.params.id;
    const userId = req.user.id;

    const withdrawal = await Withdrawal.findOne({
      _id: withdrawalId,
      userId,
      status: 'pending'
    });

    if (!withdrawal) {
      return res.status(404).json({
        msg: 'Pending withdrawal request not found'
      });
    }

    // Update withdrawal status
    withdrawal.status = 'cancelled';
    withdrawal.cancelledAt = new Date();
    withdrawal.cancelledBy = 'user';
    await withdrawal.save();

    // Update points history
    await Points.updateOne(
      {
        transactionId: withdrawal.requestId,
        category: 'withdrawal_request'
      },
      {
        description: `Withdrawal request cancelled: $${withdrawal.amount} (${withdrawal.method})`,
        'metadata.status': 'cancelled'
      }
    );

    res.json({
      msg: 'Withdrawal request cancelled successfully',
      withdrawal
    });

  } catch (error) {
    console.error('Cancel withdrawal error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// ADMIN ROUTES

// @route   GET /api/withdrawals/admin/pending
// @desc    Get all pending withdrawal requests (Admin only)
// @access  Private + Admin
router.get('/admin/pending', adminAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const withdrawals = await Withdrawal.find({ status: 'pending' })
      .populate('userId', 'username email profileImage isVerified')
      .sort({ requestedAt: 1 }) // Oldest first
      .skip(skip)
      .limit(limit);

    const total = await Withdrawal.countDocuments({ status: 'pending' });

    // Calculate total pending amount
    const totalPendingAmount = await Withdrawal.aggregate([
      { $match: { status: 'pending' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    res.json({
      withdrawals,
      pagination: {
        page,
        pages: Math.ceil(total / limit),
        total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      },
      statistics: {
        totalPendingRequests: total,
        totalPendingAmount: totalPendingAmount[0]?.total || 0
      }
    });

  } catch (error) {
    console.error('Get pending withdrawals error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// @route   GET /api/withdrawals/admin/all
// @desc    Get all withdrawal requests with filters (Admin only)
// @access  Private + Admin
router.get('/admin/all', adminAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const { status, method, fromDate, toDate, userId, search } = req.query;

    // Build filter query
    let filterQuery = {};

    if (status && status !== 'all') {
      filterQuery.status = status;
    }

    if (method && method !== 'all') {
      filterQuery.method = method;
    }

    if (userId) {
      filterQuery.userId = userId;
    }

    if (fromDate || toDate) {
      filterQuery.requestedAt = {};
      if (fromDate) {
        filterQuery.requestedAt.$gte = new Date(fromDate);
      }
      if (toDate) {
        filterQuery.requestedAt.$lte = new Date(toDate);
      }
    }

    let query = Withdrawal.find(filterQuery)
      .populate('userId', 'username email profileImage isVerified');

    // Search by request ID or user info
    if (search) {
      const searchRegex = new RegExp(search, 'i');
      query = Withdrawal.find({
        ...filterQuery,
        $or: [
          { requestId: searchRegex },
          { 'details.fullName': searchRegex },
          { 'details.email': searchRegex }
        ]
      }).populate('userId', 'username email profileImage isVerified');
    }

    const withdrawals = await query
      .sort({ requestedAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = search ? 
      await Withdrawal.countDocuments({
        ...filterQuery,
        $or: [
          { requestId: new RegExp(search, 'i') },
          { 'details.fullName': new RegExp(search, 'i') },
          { 'details.email': new RegExp(search, 'i') }
        ]
      }) : 
      await Withdrawal.countDocuments(filterQuery);

    // Get statistics
    const stats = await Withdrawal.aggregate([
      { $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalAmount: { $sum: '$amount' }
      }}
    ]);

    res.json({
      withdrawals,
      pagination: {
        page,
        pages: Math.ceil(total / limit),
        total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      },
      statistics: stats
    });

  } catch (error) {
    console.error('Get all withdrawals error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// @route   POST /api/withdrawals/admin/approve/:id
// @desc    Approve a withdrawal request (Admin only)
// @access  Private + Admin
router.post('/admin/approve/:id', [
  adminAuth,
  [
    body('notes', 'Admin notes can be provided').optional()
  ]
], async (req, res) => {
  const session = await mongoose.startSession();
  
  try {
    session.startTransaction();
    
    const withdrawalId = req.params.id;
    const { notes } = req.body;
    const adminId = req.user.id;

    const withdrawal = await Withdrawal.findOne({
      _id: withdrawalId,
      status: 'pending'
    }).session(session);

    if (!withdrawal) {
      await session.abortTransaction();
      return res.status(404).json({
        msg: 'Pending withdrawal request not found'
      });
    }

    // Check if user still has enough points
    const userPoints = await Points.findOne({ userId: withdrawal.userId }).session(session);
    if (!userPoints || userPoints.balance < withdrawal.pointsToDeduct) {
      await session.abortTransaction();
      return res.status(400).json({
        msg: 'User no longer has sufficient points for this withdrawal'
      });
    }

    // Deduct points from user
    userPoints.balance -= withdrawal.pointsToDeduct;
    await userPoints.save({ session });

    // Update withdrawal status
    withdrawal.status = 'approved';
    withdrawal.approvedAt = new Date();
    withdrawal.approvedBy = adminId;
    withdrawal.adminNotes = notes;
    await withdrawal.save({ session });

    // Create points transaction for the actual deduction
    const pointsTransaction = new Points({
      userId: withdrawal.userId,
      type: 'debit',
      amount: -withdrawal.pointsToDeduct,
      category: 'withdrawal_approved',
      description: `Withdrawal approved: $${withdrawal.amount} (${withdrawal.method})`,
      balanceAfter: userPoints.balance,
      transactionId: `${withdrawal.requestId}_APPROVED`,
      metadata: {
        withdrawalId: withdrawal._id,
        approvedBy: adminId,
        originalRequestId: withdrawal.requestId,
        adminNotes: notes
      }
    });

    await pointsTransaction.save({ session });

    // Update the original request record in points history
    await Points.updateOne(
      {
        transactionId: withdrawal.requestId,
        category: 'withdrawal_request'
      },
      {
        description: `Withdrawal approved: $${withdrawal.amount} (${withdrawal.method})`,
        'metadata.status': 'approved',
        'metadata.approvedBy': adminId,
        'metadata.approvedAt': new Date()
      }
    ).session(session);

    await session.commitTransaction();

    // TODO: Send notification to user (email, push notification, etc.)
    // await sendUserNotification(withdrawal.userId, 'withdrawal_approved', withdrawal);

    // TODO: Process actual payment via payment provider
    // await processPayment(withdrawal);

    res.json({
      msg: 'Withdrawal request approved successfully',
      withdrawal,
      newBalance: userPoints.balance
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('Approve withdrawal error:', error);
    res.status(500).json({ msg: 'Server error' });
  } finally {
    session.endSession();
  }
});

// @route   POST /api/withdrawals/admin/reject/:id
// @desc    Reject a withdrawal request (Admin only)
// @access  Private + Admin
router.post('/admin/reject/:id', [
  adminAuth,
  [
    body('reason', 'Rejection reason is required').not().isEmpty()
  ]
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const withdrawalId = req.params.id;
    const { reason, notes } = req.body;
    const adminId = req.user.id;

    const withdrawal = await Withdrawal.findOne({
      _id: withdrawalId,
      status: 'pending'
    });

    if (!withdrawal) {
      return res.status(404).json({
        msg: 'Pending withdrawal request not found'
      });
    }

    // Update withdrawal status
    withdrawal.status = 'rejected';
    withdrawal.rejectedAt = new Date();
    withdrawal.rejectedBy = adminId;
    withdrawal.rejectionReason = reason;
    withdrawal.adminNotes = notes;
    await withdrawal.save();

    // Update points history
    await Points.updateOne(
      {
        transactionId: withdrawal.requestId,
        category: 'withdrawal_request'
      },
      {
        description: `Withdrawal rejected: $${withdrawal.amount} (${withdrawal.method})`,
        'metadata.status': 'rejected',
        'metadata.rejectedBy': adminId,
        'metadata.rejectionReason': reason,
        'metadata.rejectedAt': new Date()
      }
    );

    // TODO: Send notification to user
    // await sendUserNotification(withdrawal.userId, 'withdrawal_rejected', { withdrawal, reason });

    res.json({
      msg: 'Withdrawal request rejected successfully',
      withdrawal
    });

  } catch (error) {
    console.error('Reject withdrawal error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// @route   GET /api/withdrawals/admin/stats
// @desc    Get withdrawal statistics (Admin only)
// @access  Private + Admin
router.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    
    let dateFilter = {};
    const now = new Date();
    
    switch (period) {
      case '7d':
        dateFilter = { requestedAt: { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } };
        break;
      case '30d':
        dateFilter = { requestedAt: { $gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) } };
        break;
      case '90d':
        dateFilter = { requestedAt: { $gte: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) } };
        break;
      default:
        dateFilter = {};
    }

    const stats = await Withdrawal.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: {
            status: '$status',
            method: '$method'
          },
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' },
          totalPoints: { $sum: '$pointsToDeduct' }
        }
      },
      {
        $group: {
          _id: '$_id.status',
          methods: {
            $push: {
              method: '$_id.method',
              count: '$count',
              totalAmount: '$totalAmount',
              totalPoints: '$totalPoints'
            }
          },
          totalCount: { $sum: '$count' },
          totalAmount: { $sum: '$totalAmount' },
          totalPoints: { $sum: '$totalPoints' }
        }
      }
    ]);

    // Get pending requests that need attention (older than 24 hours)
    const urgentRequests = await Withdrawal.countDocuments({
      status: 'pending',
      requestedAt: { $lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) }
    });

    res.json({
      statistics: stats,
      urgentRequests,
      period
    });

  } catch (error) {
    console.error('Get withdrawal stats error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

module.exports = router;