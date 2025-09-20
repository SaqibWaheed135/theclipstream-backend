// routes/followRoutes.js
import express from 'express';
import authMiddleware from '../middleware/auth.js';
import User from '../models/User.js';
import FollowRequest from '../models/FollowRequest.js';

const router = express.Router();

// Send follow request
router.post('/request/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const followerId = req.userId;

    // Can't follow yourself
    if (userId === followerId) {
      return res.status(400).json({ msg: 'You cannot follow yourself' });
    }

    // Check if user exists
    const userToFollow = await User.findById(userId);
    if (!userToFollow) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // Check if already following
    const currentUser = await User.findById(followerId);
    if (currentUser.following.includes(userId)) {
      return res.status(400).json({ msg: 'Already following this user' });
    }

    // Check if follow request already exists
    const existingRequest = await FollowRequest.findOne({
      requester: followerId,
      recipient: userId,
      status: 'pending'
    });

    if (existingRequest) {
      return res.status(400).json({ msg: 'Follow request already sent' });
    }

    let followRequest;

    if (userToFollow.isPrivate) {
      // Create follow request for private accounts
      followRequest = await FollowRequest.create({
        requester: followerId,
        recipient: userId,
        status: 'pending'
      });

      await followRequest.populate([
        { path: 'requester', select: 'username avatar' },
        { path: 'recipient', select: 'username avatar' }
      ]);

      // Emit socket event for real-time notification
      const io = req.app.get('io');
      if (io) {
        io.to(`user-${userId}`).emit('follow-request', {
          type: 'follow_request',
          from: {
            id: currentUser._id,
            username: currentUser.username,
            avatar: currentUser.avatar
          },
          message: `${currentUser.username} wants to follow you`
        });
      }

      res.status(201).json({
        msg: 'Follow request sent',
        request: followRequest,
        requiresApproval: true
      });
    } else {
      // Auto-follow for public accounts
      await User.findByIdAndUpdate(followerId, {
        $push: { following: userId }
      });

      await User.findByIdAndUpdate(userId, {
        $push: { followers: followerId }
      });

      // Emit socket event
      const io = req.app.get('io');
      if (io) {
        io.to(`user-${userId}`).emit('new-follower', {
          type: 'new_follower',
          follower: {
            id: currentUser._id,
            username: currentUser.username,
            avatar: currentUser.avatar
          },
          message: `${currentUser.username} started following you`
        });
      }

      res.json({
        msg: 'Now following user',
        requiresApproval: false
      });
    }
  } catch (error) {
    console.error('Follow request error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Accept follow request
router.post('/accept/:requestId', authMiddleware, async (req, res) => {
  try {
    const { requestId } = req.params;
    const userId = req.userId;

    const followRequest = await FollowRequest.findById(requestId)
      .populate('requester', 'username avatar');

    if (!followRequest) {
      return res.status(404).json({ msg: 'Follow request not found' });
    }

    if (followRequest.recipient.toString() !== userId) {
      return res.status(403).json({ msg: 'Not authorized to accept this request' });
    }

    if (followRequest.status !== 'pending') {
      return res.status(400).json({ msg: 'Request already processed' });
    }

    // Update follow request status
    followRequest.status = 'accepted';
    await followRequest.save();

    // Add to followers/following
    await User.findByIdAndUpdate(followRequest.requester._id, {
      $push: { following: userId }
    });

    await User.findByIdAndUpdate(userId, {
      $push: { followers: followRequest.requester._id }
    });

    // Emit socket event to requester
    const io = req.app.get('io');
    if (io) {
      const currentUser = await User.findById(userId).select('username avatar');
      
      io.to(`user-${followRequest.requester._id}`).emit('follow-accepted', {
        type: 'follow_accepted',
        user: {
          id: currentUser._id,
          username: currentUser.username,
          avatar: currentUser.avatar
        },
        message: `${currentUser.username} accepted your follow request`
      });
    }

    res.json({
      msg: 'Follow request accepted',
      follower: followRequest.requester
    });
  } catch (error) {
    console.error('Accept follow error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Reject follow request
router.post('/reject/:requestId', authMiddleware, async (req, res) => {
  try {
    const { requestId } = req.params;
    const userId = req.userId;

    const followRequest = await FollowRequest.findById(requestId);

    if (!followRequest) {
      return res.status(404).json({ msg: 'Follow request not found' });
    }

    if (followRequest.recipient.toString() !== userId) {
      return res.status(403).json({ msg: 'Not authorized to reject this request' });
    }

    followRequest.status = 'rejected';
    await followRequest.save();

    res.json({ msg: 'Follow request rejected' });
  } catch (error) {
    console.error('Reject follow error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Unfollow user
router.post('/unfollow/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const followerId = req.userId;

    await User.findByIdAndUpdate(followerId, {
      $pull: { following: userId }
    });

    await User.findByIdAndUpdate(userId, {
      $pull: { followers: followerId }
    });

    res.json({ msg: 'Unfollowed successfully' });
  } catch (error) {
    console.error('Unfollow error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Get follow requests (pending requests received)
router.get('/requests', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    const requests = await FollowRequest.find({
      recipient: userId,
      status: 'pending'
    })
      .populate('requester', 'username avatar')
      .sort({ createdAt: -1 });

    res.json(requests);
  } catch (error) {
    console.error('Get follow requests error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Get follow status between two users
router.get('/status/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.userId;

    if (userId === currentUserId) {
      return res.json({ relationship: 'self' });
    }

    const currentUser = await User.findById(currentUserId);
    const targetUser = await User.findById(userId);

    if (!targetUser) {
      return res.status(404).json({ msg: 'User not found' });
    }

    const isFollowing = currentUser.following.includes(userId);
    const isFollowedBy = currentUser.followers.includes(userId);

    // Check for pending request
    const pendingRequest = await FollowRequest.findOne({
      requester: currentUserId,
      recipient: userId,
      status: 'pending'
    });

    res.json({
      isFollowing,
      isFollowedBy,
      hasPendingRequest: !!pendingRequest,
      canMessage: isFollowing && isFollowedBy, // Both must follow each other to message
      targetUserIsPrivate: targetUser.isPrivate,
      relationship: isFollowing && isFollowedBy ? 'mutual' : 
                   isFollowing ? 'following' : 
                   isFollowedBy ? 'follower' : 'none'
    });
  } catch (error) {
    console.error('Get follow status error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Get user's followers
router.get('/followers/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const user = await User.findById(userId)
      .populate({
        path: 'followers',
        select: 'username avatar',
        options: {
          limit: limit * 1,
          skip: (page - 1) * limit
        }
      });

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    res.json({
      followers: user.followers,
      totalCount: user.followers.length
    });
  } catch (error) {
    console.error('Get followers error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Get user's following
router.get('/following/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const user = await User.findById(userId)
      .populate({
        path: 'following',
        select: 'username avatar',
        options: {
          limit: limit * 1,
          skip: (page - 1) * limit
        }
      });

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    res.json({
      following: user.following,
      totalCount: user.following.length
    });
  } catch (error) {
    console.error('Get following error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Get current user's followers
router.get('/followers', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { page = 1, limit = 20 } = req.query;

    const user = await User.findById(userId)
      .populate({
        path: 'followers',
        select: 'username avatar bio followersCount isVerified',
        options: {
          limit: limit * 1,
          skip: (page - 1) * limit
        }
      });

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    res.json({
      data: user.followers,
      totalCount: user.followers.length
    });
  } catch (error) {
    console.error('Get followers error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Get current user's following
router.get('/following', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { page = 1, limit = 20 } = req.query;

    const user = await User.findById(userId)
      .populate({
        path: 'following',
        select: 'username avatar bio followersCount isVerified',
        options: {
          limit: limit * 1,
          skip: (page - 1) * limit
        }
      });

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    res.json({
      data: user.following,
      totalCount: user.following.length
    });
  } catch (error) {
    console.error('Get following error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Get current user's friends (mutual followers)
router.get('/friends', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { page = 1, limit = 20 } = req.query;

    const user = await User.findById(userId)
      .populate('followers', '_id username avatar bio followersCount isVerified')
      .populate('following', '_id username avatar bio followersCount isVerified');

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // Find mutual friends (users who follow each other)
    const friends = user.following.filter(followedUser =>
      user.followers.some(follower => 
        follower._id.toString() === followedUser._id.toString()
      )
    );

    // Apply pagination
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + parseInt(limit);
    const paginatedFriends = friends.slice(startIndex, endIndex);

    res.json({
      data: paginatedFriends,
      totalCount: friends.length,
      page: parseInt(page),
      totalPages: Math.ceil(friends.length / limit)
    });
  } catch (error) {
    console.error('Get friends error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

export default router;