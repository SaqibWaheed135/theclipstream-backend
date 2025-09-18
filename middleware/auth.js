import jwt from 'jsonwebtoken';
import User from '../models/User.js'

const authMiddleware = async (req, res, next) => {
  try {
    let token;
    
    // Check for token in Authorization header (for API requests)
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    // Check for token in cookies (for browser requests)
    else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return res.status(401).json({ 
        msg: 'No token provided, authorization denied' 
      });
    }

    try {
      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      // Get user from token (handle both userId and id field names)
      const userId = decoded.userId || decoded.id;
      const user = await User.findById(userId).select('-password');
      
      if (!user) {
        return res.status(401).json({ msg: 'User not found, token invalid' });
      }

      // Add user info to request
      req.userId = user._id.toString();
      req.user = user;
      next();
    } catch (jwtError) {
      console.error('JWT verification error:', jwtError);
      return res.status(401).json({ 
        msg: 'Token is invalid or expired',
        error: process.env.NODE_ENV === 'development' ? jwtError.message : undefined
      });
    }
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ 
      msg: 'Server error in authentication',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Optional auth middleware (doesn't throw error if no token)
export const optionalAuth = async (req, res, next) => {
  try {
    let token;
    
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.userId || decoded.id;
        const user = await User.findById(userId).select('-password');
        
        if (user) {
          req.userId = user._id.toString();
          req.user = user;
          req.isAuthenticated = true;
        }
      } catch (jwtError) {
        // Token invalid, but continue without auth
        console.log('Optional auth - invalid token:', jwtError.message);
      }
    }
    
    // Continue regardless of auth status
    next();
  } catch (error) {
    console.error('Optional auth middleware error:', error);
    next(); // Continue even on error
  }
};

export default authMiddleware;