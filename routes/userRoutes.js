// routes/userRoutes.js
import express from 'express';
import authMiddleware, { optionalAuth } from '../middleware/auth.js';
import User from '../models/User.js';

const router = express.Router();

router.get('/search', authMiddleware, async (req, res) => {
  try {
    const { q, page = 1, limit = 20 } = req.query;
    const currentUserId = req.userId;

    if (!q || q.trim().length === 0) {
      return res.status(400).json({ msg: 'Search query is required' });
    }

    // Minimum search length to prevent too broad searches
    if (q.trim().length < 2) {
      return res.status(400).json({ msg: 'Search query must be at least 2 characters' });
    }

    const searchQuery = q.trim();
    
    // Create search regex - escape special regex characters for safety
    const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchRegex = new RegExp(escapedQuery.split(' ').join('|'), 'i');
    
    // Search users by username, excluding current user
    const users = await User.find({
      _id: { $ne: currentUserId },
      username: { $regex: searchRegex } // Remove email search for privacy
    })
      .select('username avatar bio isVerified isPrivate followersCount followingCount totalLikes createdAt lastSeen isOnline')
      .limit(Math.min(parseInt(limit), 50)) // Cap at 50 results
      .skip((parseInt(page) - 1) * parseInt(limit))
      .sort({ 
        isVerified: -1,
        followersCount: -1,
        createdAt: -1
      });

    // Add computed follower counts for users that might not have them stored
    const usersWithCounts = await Promise.all(
      users.map(async (user) => {
        const userObj = user.toObject();
        
        // Ensure counts are numbers
        userObj.followersCount = userObj.followersCount || 0;
        userObj.followingCount = userObj.followingCount || 0;
        userObj.totalLikes = userObj.totalLikes || 0;

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

    // Add computed counts if not present
    user.followersCount = user.followersCount || (user.followers ? user.followers.length : 0);
    user.followingCount = user.followingCount || (user.following ? user.following.length : 0);
    user.savedVideosCount = user.savedVideos ? user.savedVideos.length : 0;

    // Don't return sensitive info for other users
    if (userId !== currentUserId) {
      delete user.email;
      delete user.googleId;
      delete user.savedVideos; // Don't show other users' saved videos
      
      // Don't show full follower/following lists for privacy
      if (user.followers) user.followers = user.followers.length;
      if (user.following) user.following = user.following.length;
    }

    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Get suggested users (users to follow)
router.get('/suggestions/users', authMiddleware, async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { limit = 10 } = req.query;

    // Get current user's following list
    const currentUser = await User.findById(currentUserId).select('following');
    const followingIds = currentUser.following || [];
    
    // Find users that current user is not following
    const suggestedUsers = await User.find({
      _id: { 
        $ne: currentUserId,
        $nin: followingIds
      },
      isPrivate: false // Only suggest public users
    })
      .select('username avatar bio isVerified followersCount totalLikes createdAt')
      .sort({ 
        isVerified: -1, // Prioritize verified users
        followersCount: -1, // Then by popularity
        createdAt: -1 // Then by recency
      })
      .limit(parseInt(limit));

    res.json(suggestedUsers);
  } catch (error) {
    console.error('Get suggested users error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Update user profile
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const {
      username,
      bio,
      isPrivate,
      avatar
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

      // Validate username format
      if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
        return res.status(400).json({ 
          msg: 'Username must be 3-30 characters and contain only letters, numbers, and underscores' 
        });
      }
    }

    // Validate bio length
    if (bio && bio.length > 160) {
      return res.status(400).json({ msg: 'Bio must be 160 characters or less' });
    }

    const updateData = {};
    if (username !== undefined) updateData.username = username;
    if (bio !== undefined) updateData.bio = bio;
    if (isPrivate !== undefined) updateData.isPrivate = Boolean(isPrivate);
    if (avatar !== undefined) updateData.avatar = avatar;

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    res.json({
      msg: 'Profile updated successfully',
      user: updatedUser
    });
  } catch (error) {
    console.error('Update profile error:', error);
    
    if (error.code === 11000) {
      return res.status(400).json({ msg: 'Username already taken' });
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

    // Compute missing counts
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

export default router;