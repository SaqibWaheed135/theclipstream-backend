import dotenv from "dotenv";
dotenv.config();

import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import path, { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import routes
import authRoutes from "./routes/auth.js";
import videoRoutes from './routes/videos.js';
import liveRoutes from './routes/liveRoutes.js'; // New live streaming routes
import adminRoutes from './routes/adminAuth.js'
import followRoutes from './routes/followRoutes.js'
import messageRoutes from './routes/messageRoutes.js';

// Import Socket.IO setup
import { initializeSocket } from './utils/socket.js';

const app = express();
const server = createServer(app); // Create HTTP server for Socket.IO

const allowedOrigins = [
  "http://localhost:5173", // React dev server
  "http://localhost:5174",
  "http://localhost:3000", // Alternative React port
  "http://localhost:5000", // API itself (optional)
  "https://theclipstream.com", // your production domain
];

// CORS configuration
app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (like mobile apps, Postman)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      } else {
        return callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser()); // Add cookie parser for JWT handling

// Initialize Socket.IO with the server
const io = initializeSocket(server);

// Make io accessible in routes (optional)
app.set('io', io);

// MongoDB connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log("✅ MongoDB connected");
}).catch(err => {
  console.error("❌ MongoDB connection error:", err);
  process.exit(1);
});

// Serve uploaded files (dev)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use("/api/auth", authRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/live', liveRoutes); 
app.use("/api/admin", adminRoutes);
app.use('/api/follow', followRoutes); 
app.use('/api/messages', messageRoutes);

app.get('/api/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const User = (await import('./models/User.js')).default;
    
    const user = await User.findById(userId)
      .select('-password -email') // Don't expose sensitive data
      .populate('followers', 'username avatar')
      .populate('following', 'username avatar');
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    services: {
      database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      socket: 'active',
      server: 'running'
    },
    environment: process.env.NODE_ENV || 'development'
  });
});

// Get live streaming stats (optional endpoint)
app.get('/api/live-stats', (req, res) => {
  const socketCount = io.engine.clientsCount;
  const rooms = Array.from(io.sockets.adapter.rooms.keys())
    .filter(room => room.startsWith('stream-'));
  
  res.json({
    connectedUsers: socketCount,
    activeStreams: rooms.length,
    rooms: rooms.map(room => ({
      streamId: room.replace('stream-', ''),
      viewers: io.sockets.adapter.rooms.get(room)?.size || 0
    }))
  });
});

// app.get('/api/live-stats', (req, res) => {
//   const socketCount = io.engine.clientsCount;
//   const rooms = Array.from(io.sockets.adapter.rooms.keys());
//   const streamRooms = rooms.filter(room => room.startsWith('stream-'));
//   const conversationRooms = rooms.filter(room => room.startsWith('conversation-'));
//   const userRooms = rooms.filter(room => room.startsWith('user-'));
  
//   res.json({
//     connectedUsers: socketCount,
//     activeStreams: streamRooms.length,
//     activeConversations: conversationRooms.length,
//     onlineUsers: userRooms.length,
//     totalRooms: rooms.length,
//     streams: streamRooms.map(room => ({
//       streamId: room.replace('stream-', ''),
//       viewers: io.sockets.adapter.rooms.get(room)?.size || 0
//     }))
//   });
// });

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  
  // CORS errors
  if (err.message === "Not allowed by CORS") {
    return res.status(403).json({ 
      msg: "CORS: Origin not allowed",
      origin: req.get('Origin') 
    });
  }
  
  // MongoDB errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({ 
      msg: "Validation Error", 
      errors: Object.values(err.errors).map(e => e.message) 
    });
  }
  
  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ msg: "Invalid token" });
  }
  
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ msg: "Token expired" });
  }
  
  // Default error response
  res.status(500).json({ 
    msg: process.env.NODE_ENV === 'production' 
      ? 'Something went wrong!' 
      : err.message 
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    msg: 'Route not found',
    path: req.originalUrl,
    method: req.method
  });
});

const PORT = process.env.PORT || 5000;

// Use server.listen instead of app.listen for Socket.IO
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 Socket.IO server ready for live streaming`);
  console.log(`🌐 Allowed origins:`, allowedOrigins.join(', '));
  console.log(`🗄️ Database: ${mongoose.connection.readyState === 1 ? 'Connected' : 'Connecting...'}}`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    mongoose.connection.close(false, () => {
      console.log('MongoDB connection closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    mongoose.connection.close(false, () => {
      console.log('MongoDB connection closed');
      process.exit(0);
    });
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
  process.exit(1);
});

export default app;