import express from 'express';
const router = express.Router();
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import User from '../models/User.js'

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || "");


// Default avatar generator function
function generateDefaultAvatar(username) {
  // You can use services like:
  // 1. UI Avatars (free)
  const uiAvatarsUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&color=fff&size=200&bold=true`;

  // 2. Alternative: Gravatar default avatars
  // const gravatarUrl = `https://www.gravatar.com/avatar/${Math.random().toString(36).substring(7)}?d=identicon&s=200`;

  // 3. Alternative: Dicebear (more modern)
  // const dicebearUrl = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(username)}`;

  return uiAvatarsUrl;
}

// JWT generator
function generateToken(user) {
  return jwt.sign(
    { id: user._id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// POST /api/auth/signup
// router.post('/signup', async (req, res) => {
//   try {
//     const { username, email, password } = req.body;
//     if (!username || !email || !password) return res.status(400).json({ msg: 'All fields are required' });

//     const exists = await User.findOne({ email });
//     if (exists) return res.status(400).json({ msg: 'Email already used' });

//     // Check if username exists
//     const usernameExists = await User.findOne({ username });
//     if (usernameExists) return res.status(400).json({ msg: 'Username already taken' });

//     // Generate default avatar
//     const defaultAvatar = generateDefaultAvatar(username);

//     const user = new User({
//       username,
//       email,
//       password,
//       points: 5,
//       avatar: defaultAvatar
//     });
//     await user.save();

//     const token = generateToken(user);
//     res.status(201).json({
//       token,
//       user: {
//         id: user._id,
//         username: user.username,
//         email: user.email,
//         avatar: user.avatar,
//         points: user.points
//       }
//     });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ msg: 'Server error' });
//   }
// });

// Update your signup route
router.post('/signup', async (req, res) => {
  try {
    const { username, email, password, referralCode } = req.body;
    if (!username || !email || !password) return res.status(400).json({ msg: 'All fields are required' });

    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ msg: 'Email already used' });

    const usernameExists = await User.findOne({ username });
    if (usernameExists) return res.status(400).json({ msg: 'Username already taken' });

    const defaultAvatar = generateDefaultAvatar(username);

    const user = new User({
      username,
      email,
      password,
      points: 5,
      avatar: defaultAvatar,
      inviteCode: Math.random().toString(36).substring(2, 10) // Generate unique code
    });

    // Handle referral
    if (referralCode) {
      const referrer = await User.findOne({ 
        $or: [
          { inviteCode: referralCode },
          { _id: referralCode }
        ]
      });

      if (referrer) {
        user.invitedBy = referrer._id;
        user.points += 5; // Bonus points for using referral
        
        // Reward the referrer
        referrer.totalInvites += 1;
        referrer.points += 10; // Coins for successful referral
        referrer.inviteRewardEarned += 10;
        await referrer.save();
      }
    }

    await user.save();

    const token = generateToken(user);
    res.status(201).json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        points: user.points,
        inviteCode: user.inviteCode,
        totalInvites: user.totalInvites
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ msg: 'All fields are required' });

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: 'Invalid credentials' });

    const match = await user.matchPassword(password);
    if (!match) return res.status(400).json({ msg: 'Invalid credentials' });

    const token = generateToken(user);
    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        points: user.points
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

/**
 * POST /api/auth/google
 * Body: { idToken: <Google ID token from client> }
 * Verifies idToken with Google, finds or creates user, returns JWT
 */
router.post('/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ msg: 'No idToken provided' });

    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    console.log("Google token aud:", payload.aud);
    console.log("Backend expected aud:", process.env.GOOGLE_CLIENT_ID);
    const { sub: googleId, email, name, picture } = payload;

    if (!email) {
      return res.status(400).json({ msg: 'No email provided by Google' });
    }

    // Find by googleId or email
    let user = await User.findOne({ $or: [{ googleId }, { email }] });

    if (!user) {
      // Generate unique username if name is not provided
      let username = name || email.split('@')[0];

      // Ensure username is unique
      const existingUser = await User.findOne({ username });
      if (existingUser) {
        username = `${username}_${Math.random().toString(36).substring(2, 8)}`;
      }

      // Create new user with Google avatar or default avatar
      const avatar = picture || generateDefaultAvatar(username);

      user = new User({
        username,
        email,
        googleId,
        avatar,
        points: 5,
        isVerified: true // Google users are considered verified
      });
      await user.save();
    } else {
      // Update existing user with Google info if missing
      let updated = false;

      if (!user.googleId) {
        user.googleId = googleId;
        updated = true;
      }

      if (!user.avatar && picture) {
        user.avatar = picture;
        updated = true;
      }

      if (!user.isVerified) {
        user.isVerified = true; // Mark as verified since they used Google
        updated = true;
      }

      if (updated) {
        await user.save();
      }
    }

    const token = generateToken(user);
    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        points: user.points,
        isVerified: user.isVerified
      }
    });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ msg: 'Google authentication failed' });
  }
});

// GET /api/auth/getUsers
router.get("/getUsers", async (req, res) => {
  try {
    const users = await User.find({}, "-password -__v");
    // exclude password & __v

    res.json({
      success: true,
      data: users,
    });
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ msg: "Server error fetching users" });
  }
});
router.get("/searchUsers", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ msg: "Search query must be at least 2 characters" });
    }

    const regex = new RegExp(q, "i"); // case-insensitive search

    const users = await User.find({ username: { $regex: regex } }, "-password -__v")
      .limit(20)
      .sort({ createdAt: -1 });

    res.json({ success: true, data: users });
  } catch (err) {
    console.error("Error searching users:", err);
    res.status(500).json({ msg: "Server error searching users" });
  }
});

// DELETE /api/auth/deleteUser/:id
router.delete("/deleteUser/:id", async (req, res) => {
  try {
    const userId = req.params.id;
    const deleted = await User.findByIdAndDelete(userId);

    if (!deleted) {
      return res.status(404).json({ msg: "User not found" });
    }

    res.json({ success: true, msg: "User deleted successfully" });
  } catch (err) {
    console.error("Error deleting user:", err);
    res.status(500).json({ msg: "Server error deleting user" });
  }
});

export default router;