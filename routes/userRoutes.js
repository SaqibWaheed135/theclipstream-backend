// routes/userRoutes.js
import express from 'express';
import authMiddleware, { optionalAuth } from '../middleware/auth.js';
import User from '../models/User.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = express.Router();
const BASE_URL = process.env.BASE_URL || 'https://theclipstream-backend.onrender.com' || 'https://api.theclipstream.com';

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(process.cwd(), 'uploads/avatars');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Helper to safely build avatar URL
const buildAvatarUrl = (avatarPath) => {
  if (!avatarPath) return null;
  
  // If it's already a full URL, return as-is
  if (avatarPath.startsWith('http://') || avatarPath.startsWith('https://')) {
    return avatarPath;
  }
  
  // Otherwise, assume it's a relative path and prepend BASE_URL
  return `${BASE_URL}${avatarPath}`;
};

// Configure multer for file uploads (avatar) - LOCAL STORAGE
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/avatars/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'avatar-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'));
    }
  }
});

// Search users
router.get('/search', authMiddleware, async (req, res) => {
  try {
    const { q, page = 1, limit = 20 } = req.query;
    const currentUserId = req.userId;

    if (!q || q.trim().length === 0) {
      return res.status(400).json({ msg: 'Search query is required' });
    }

    if (q.trim().length < 2) {
      return res.status(400).json({ msg: 'Search query must be at least 2 characters' });
    }

    const searchQuery = q.trim();
    const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchRegex = new RegExp(escapedQuery.split(' ').join('|'), 'i');
    
    const users = await User.find({
      _id: { $ne: currentUserId },
      username: { $regex: searchRegex }
    })
      .select('username avatar bio isVerified isPrivate followersCount followingCount totalLikes createdAt lastSeen isOnline')
      .limit(Math.min(parseInt(limit), 50))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .sort({ 
        isVerified: -1,
        followersCount: -1,
        createdAt: -1
      });

    const usersWithCounts = await Promise.all(
      users.map(async (user) => {
        const userObj = user.toObject();
        userObj.followersCount = userObj.followersCount || 0;
        userObj.followingCount = userObj.followingCount || 0;
        userObj.totalLikes = userObj.totalLikes || 0;
        
        // Transform avatar URL
        userObj.avatar = buildAvatarUrl(userObj.avatar);
        return userObj;
      })
    );

    res.json(usersWithCounts);
  } catch (error) {
    console.error('User search error:', error);
    res.status(500).json({ msg: 'Server error while searching users' });
  }
});

// Get user by ID
router.get('/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.userId;

    const user = await User.findById(userId)
      .select('-password')
      .populate('savedVideos', '_id title thumbnail views likesCount createdAt')
      .lean();

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    user.followersCount = user.followersCount || (user.followers ? user.followers.length : 0);
    user.followingCount = user.followingCount || (user.following ? user.following.length : 0);
    user.savedVideosCount = user.savedVideos ? user.savedVideos.length : 0;

    // Transform avatar URL
    user.avatar = buildAvatarUrl(user.avatar);

    if (userId !== currentUserId) {
      delete user.email;
      delete user.googleId;
      delete user.savedVideos;
      
      if (user.followers) user.followers = user.followers.length;
      if (user.following) user.following = user.following.length;
    }

    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Get suggested users
router.get('/suggestions/users', authMiddleware, async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { limit = 10 } = req.query;

    const currentUser = await User.findById(currentUserId).select('following');
    const followingIds = currentUser.following || [];
    
    const suggestedUsers = await User.find({
      _id: { 
        $ne: currentUserId,
        $nin: followingIds
      },
      isPrivate: false
    })
      .select('username avatar bio isVerified followersCount totalLikes createdAt')
      .sort({ 
        isVerified: -1,
        followersCount: -1,
        createdAt: -1
      })
      .limit(parseInt(limit));

    // Transform avatar URLs for all suggested users
    const usersWithAvatars = suggestedUsers.map(user => {
      const userObj = user.toObject();
      userObj.avatar = buildAvatarUrl(userObj.avatar);
      return userObj;
    });

    res.json(usersWithAvatars);
  } catch (error) {
    console.error('Get suggested users error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Update user profile (COMPLETE AND FIXED)
router.put('/profile', authMiddleware, upload.single('avatar'), async (req, res) => {
  try {
    const userId = req.userId;
    const {
      username,
      bio,
      isPrivate,
      email,
      firstName,
      lastName,
      dateOfBirth,
      location,
      website,
      removeAvatar
    } = req.body;

    // Validate username uniqueness if provided
    if (username) {
      const existingUser = await User.findOne({
        username,
        _id: { $ne: userId }
      });

      if (existingUser) {
        return res.status(400).json({ msg: 'Username already taken' });
      }

      if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
        return res.status(400).json({ 
          msg: 'Username must be 3-30 characters and contain only letters, numbers, and underscores' 
        });
      }
    }

    // Validate email if provided
    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ msg: 'Invalid email format' });
      }

      const existingEmailUser = await User.findOne({
        email,
        _id: { $ne: userId }
      });

      if (existingEmailUser) {
        return res.status(400).json({ msg: 'Email already in use' });
      }
    }

    // Validate bio length
    if (bio && bio.length > 160) {
      return res.status(400).json({ msg: 'Bio must be 160 characters or less' });
    }

    // Validate website URL if provided
    if (website && website.trim() !== '') {
      const urlRegex = /^https?:\/\/.+/;
      if (!urlRegex.test(website)) {
        return res.status(400).json({ msg: 'Website must be a valid URL starting with http:// or https://' });
      }
    }

    // Validate date of birth
    if (dateOfBirth) {
      const dob = new Date(dateOfBirth);
      const today = new Date();
      let age = today.getFullYear() - dob.getFullYear();
      const monthDiff = today.getMonth() - dob.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
        age--;
      }
      
      if (age < 13) {
        return res.status(400).json({ msg: 'You must be at least 13 years old' });
      }
    }

    // Build update data object
    const updateData = {};
    if (username !== undefined) updateData.username = username;
    if (bio !== undefined) updateData.bio = bio;
    if (isPrivate !== undefined) updateData.isPrivate = Boolean(isPrivate);
    if (email !== undefined) updateData.email = email;
    if (firstName !== undefined) updateData.firstName = firstName;
    if (lastName !== undefined) updateData.lastName = lastName;
    if (dateOfBirth !== undefined) updateData.dateOfBirth = dateOfBirth;
    if (location !== undefined) updateData.location = location;
    if (website !== undefined) updateData.website = website;

    // Handle avatar upload or removal
    if (req.file) {
      // Delete old avatar if exists
      const currentUser = await User.findById(userId);
      if (currentUser && currentUser.avatar) {
        const oldAvatarPath = path.join(process.cwd(), currentUser.avatar.replace(`${BASE_URL}`, ''));
        if (fs.existsSync(oldAvatarPath)) {
          fs.unlinkSync(oldAvatarPath);
        }
      }
      
      // Store the relative path in DB
      updateData.avatar = `/uploads/avatars/${req.file.filename}`;
    } else if (removeAvatar === 'true') {
      // Delete current avatar file if exists
      const currentUser = await User.findById(userId);
      if (currentUser && currentUser.avatar) {
        const oldAvatarPath = path.join(process.cwd(), currentUser.avatar.replace(`${BASE_URL}`, ''));
        if (fs.existsSync(oldAvatarPath)) {
          fs.unlinkSync(oldAvatarPath);
        }
      }
      updateData.avatar = null;
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    // Transform avatar URL for response
    const responseUser = { ...updatedUser.toObject() };
    responseUser.avatar = buildAvatarUrl(responseUser.avatar);

    res.json({
      msg: 'Profile updated successfully',
      user: responseUser
    });
  } catch (error) {
    console.error('Update profile error:', error);
    
    if (error.code === 11000) {
      return res.status(400).json({ msg: 'Username or email already taken' });
    }
    
    // Handle multer errors
    if (error.message && error.message.includes('Only JPEG, PNG, GIF, and WebP are allowed')) {
      return res.status(400).json({ msg: error.message });
    }
    
    res.status(500).json({ msg: 'Server error while updating profile' });
  }
});

// Get user's public stats
router.get('/:userId/stats', optionalAuth, async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId)
      .select('username followersCount followingCount totalLikes totalVideos isVerified createdAt')
      .lean();

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    if (user.followersCount === undefined) {
      const userWithFollowers = await User.findById(userId).select('followers');
      user.followersCount = userWithFollowers.followers ? userWithFollowers.followers.length : 0;
    }

    if (user.followingCount === undefined) {
      const userWithFollowing = await User.findById(userId).select('following');
      user.followingCount = userWithFollowing.following ? userWithFollowing.following.length : 0;
    }

    res.json(user);
  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Get current user profile for editing
router.get('/profile/edit', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    const user = await User.findById(userId)
      .select('-password')
      .lean();

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // Transform avatar URL for response
    const responseUser = { ...user };
    responseUser.avatar = buildAvatarUrl(responseUser.avatar);

    res.json(responseUser);
  } catch (error) {
    console.error('Get profile edit error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Points System Routes

// Get points balance
router.get('/points/balance', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    
    const user = await User.findById(userId).select('points pointsHistory');
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    res.json({
      balance: user.points || 0,
      history: user.pointsHistory || []
    });
  } catch (error) {
    console.error('Get points balance error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Add points (Recharge/Purchase)
router.post('/points/recharge', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { amount, paymentMethod, paymentDetails, transactionId } = req.body;

     // Validate payment details based on payment method
    if (paymentMethod === 'card') {
      // Validate card details
      if (!paymentDetails.cardNumber || !paymentDetails.expiryDate || !paymentDetails.cvv) {
        return res.status(400).json({ msg: 'Complete card details required' });
      }
    }
    
    // Validate amount
    if (!amount || amount <= 0) {
      return res.status(400).json({ msg: 'Invalid recharge amount' });
    }

    // For demo purposes, we'll simulate payment processing
    // In production, integrate with actual payment providers (Stripe, PayPal, etc.)
    
    const pointsToAdd = Math.floor(amount * 10); // 1 dollar = 10 points (example rate)
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // Update points balance
    user.points = (user.points || 0) + pointsToAdd;
    
    // Add to points history
    const historyEntry = {
      type: 'recharge',
      amount: pointsToAdd,
      description: `Recharged ${pointsToAdd} points ($${amount})`,
      paymentMethod,
      transactionId,
      createdAt: new Date()
    };

    if (!user.pointsHistory) {
      user.pointsHistory = [];
    }
    user.pointsHistory.push(historyEntry);

    await user.save();

    res.json({
      msg: 'Points recharged successfully',
      newBalance: user.points,
      pointsAdded: pointsToAdd,
      transaction: historyEntry
    });
  } catch (error) {
    console.error('Points recharge error:', error);
    res.status(500).json({ msg: 'Server error during recharge' });
  }
});

// Deduct points (for premium features, gifts, etc.)
router.post('/points/spend', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { amount, description, itemId, itemType } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ msg: 'Invalid spend amount' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // Check if user has sufficient points
    if ((user.points || 0) < amount) {
      return res.status(400).json({ 
        msg: 'Insufficient points',
        currentBalance: user.points || 0,
        required: amount
      });
    }

    // Deduct points
    user.points = (user.points || 0) - amount;
    
    // Add to points history
    const historyEntry = {
      type: 'spend',
      amount: -amount,
      description: description || `Spent ${amount} points`,
      itemId,
      itemType,
      createdAt: new Date()
    };

    if (!user.pointsHistory) {
      user.pointsHistory = [];
    }
    user.pointsHistory.push(historyEntry);

    await user.save();

    res.json({
      msg: 'Points spent successfully',
      newBalance: user.points,
      pointsSpent: amount,
      transaction: historyEntry
    });
  } catch (error) {
    console.error('Points spend error:', error);
    res.status(500).json({ msg: 'Server error during spend' });
  }
});

// Get points history
router.get('/points/history', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { page = 1, limit = 20 } = req.query;

    const user = await User.findById(userId).select('pointsHistory');
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    const history = user.pointsHistory || [];
    
    // Sort by most recent first
    const sortedHistory = history.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    // Paginate
    const startIndex = (parseInt(page) - 1) * parseInt(limit);
    const endIndex = startIndex + parseInt(limit);
    const paginatedHistory = sortedHistory.slice(startIndex, endIndex);

    res.json({
      history: paginatedHistory,
      totalItems: history.length,
      currentPage: parseInt(page),
      totalPages: Math.ceil(history.length / parseInt(limit))
    });
  } catch (error) {
    console.error('Get points history error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Award points (for admin use or system rewards)
router.post('/points/award', authMiddleware, async (req, res) => {
  try {
    const { targetUserId, amount, reason, adminId } = req.body;

    // In production, add admin authentication check here
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ msg: 'Invalid award amount' });
    }

    const user = await User.findById(targetUserId);
    if (!user) {
      return res.status(404).json({ msg: 'Target user not found' });
    }

    // Add points
    user.points = (user.points || 0) + amount;
    
    // Add to points history
    const historyEntry = {
      type: 'award',
      amount: amount,
      description: reason || `Awarded ${amount} points`,
      adminId,
      createdAt: new Date()
    };

    if (!user.pointsHistory) {
      user.pointsHistory = [];
    }
    user.pointsHistory.push(historyEntry);

    await user.save();

    res.json({
      msg: 'Points awarded successfully',
      newBalance: user.points,
      pointsAwarded: amount,
      transaction: historyEntry
    });
  } catch (error) {
    console.error('Points award error:', error);
    res.status(500).json({ msg: 'Server error during award' });
  }
});

export default router;