// utils/socket.js (Enhanced with messaging and follow system)
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import LiveStream from '../models/LiveStream.js';
import User from '../models/User.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';


let io;

const initializeSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: "https://theclipstream.netlify.app" || "http://localhost:3000",
      methods: ["GET", "POST"],
      credentials: true
    }
  });

  // Authentication middleware for socket
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || 
                   socket.handshake.headers.authorization?.split(' ')[1];
      
      if (!token) {
        // Allow anonymous viewers for live streams only
        socket.userId = null;
        socket.isAuthenticated = false;
        return next();
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.userId || decoded.id).select('-password');
      
      if (!user) {
        socket.userId = null;
        socket.isAuthenticated = false;
      } else {
        socket.userId = user._id.toString();
        socket.user = user;
        socket.isAuthenticated = true;
        
        // Update user online status
        await user.setOnlineStatus(true);
      }
      
      next();
    } catch (error) {
      console.error('Socket auth error:', error);
      socket.userId = null;
      socket.isAuthenticated = false;
      next();
    }
  });

  io.on('connection', async (socket) => {
    console.log(`User connected: ${socket.userId || 'Anonymous'}`);

    // Join user's personal room for notifications
    if (socket.isAuthenticated) {
      socket.join(`user-${socket.userId}`);
      
      // Broadcast online status to followers
      const user = await User.findById(socket.userId).populate('followers', '_id');
      if (user && user.followers) {
        user.followers.forEach(follower => {
          socket.to(`user-${follower._id}`).emit('user-online', {
            userId: socket.userId,
            username: socket.user.username,
            avatar: socket.user.avatar,
            timestamp: new Date()
          });
        });
      }
    }

    // === LIVE STREAMING EVENTS (Previous code) ===
    socket.on('join-stream', async (data) => {
      try {
        const { streamId, isStreamer } = data;
        
        const liveStream = await LiveStream.findById(streamId)
          .populate('streamer', 'username avatar');
        
        if (!liveStream) {
          socket.emit('error', { message: 'Live stream not found' });
          return;
        }

        socket.join(`stream-${streamId}`);
        socket.currentStreamId = streamId;
        socket.isStreamer = isStreamer;

        if (isStreamer) {
          if (!socket.isAuthenticated || liveStream.streamer._id.toString() !== socket.userId) {
            socket.emit('error', { message: 'Not authorized to stream' });
            return;
          }
          
          socket.emit('stream-started', {
            streamId,
            stream: liveStream
          });
        } else {
          if (socket.isAuthenticated) {
            await liveStream.addViewer(socket.userId);
          } else {
            liveStream.totalViews += 1;
            await liveStream.save();
          }

          const viewerCount = liveStream.currentViewers + (socket.isAuthenticated ? 0 : 1);
          io.to(`stream-${streamId}`).emit('viewer-joined', {
            viewerCount,
            totalViews: liveStream.totalViews
          });

          socket.emit('joined-stream', {
            stream: liveStream,
            viewerCount
          });
        }
      } catch (error) {
        console.error('Join stream error:', error);
        socket.emit('error', { message: 'Could not join stream' });
      }
    });

    // === MESSAGING EVENTS ===
    
    // Join conversation room
    socket.on('join-conversation', async (data) => {
      try {
        const { conversationId } = data;
        
        if (!socket.isAuthenticated) {
          socket.emit('error', { message: 'Authentication required for messaging' });
          return;
        }

        // Verify user is participant in conversation
        const conversation = await Conversation.findById(conversationId);
        if (!conversation || !conversation.participants.includes(socket.userId)) {
          socket.emit('error', { message: 'Not authorized to join this conversation' });
          return;
        }

        socket.join(`conversation-${conversationId}`);
        socket.currentConversationId = conversationId;

        // Mark messages as read when joining conversation
        await Message.updateMany(
          {
            conversation: conversationId,
            sender: { $ne: socket.userId },
            readBy: { $ne: socket.userId }
          },
          {
            $push: { readBy: { user: socket.userId, readAt: new Date() } }
          }
        );

        socket.emit('joined-conversation', { conversationId });
      } catch (error) {
        console.error('Join conversation error:', error);
        socket.emit('error', { message: 'Could not join conversation' });
      }
    });

    // Leave conversation room
    socket.on('leave-conversation', (data) => {
      const { conversationId } = data;
      socket.leave(`conversation-${conversationId}`);
      socket.currentConversationId = null;
    });

    // Send message
    socket.on('send-message', async (data) => {
      try {
        const { conversationId, content, type = 'text' } = data;
        
        if (!socket.isAuthenticated) {
          socket.emit('error', { message: 'Authentication required for messaging' });
          return;
        }

        if (!content || content.trim().length === 0) {
          socket.emit('error', { message: 'Message content is required' });
          return;
        }

        // Verify user is participant and can send messages
        const conversation = await Conversation.findById(conversationId)
          .populate('participants', 'username avatar allowMessagesFrom');

        if (!conversation || !conversation.participants.some(p => p._id.toString() === socket.userId)) {
          socket.emit('error', { message: 'Not authorized to send messages in this conversation' });
          return;
        }

        // Check messaging permissions
        const recipients = conversation.participants.filter(p => p._id.toString() !== socket.userId);
        const sender = await User.findById(socket.userId);
        
        for (let recipient of recipients) {
          if (!recipient.canReceiveMessageFrom(socket.userId)) {
            socket.emit('error', { 
              message: `${recipient.username} doesn't accept messages from you` 
            });
            return;
          }
        }

        // Create message
        const message = await Message.create({
          sender: socket.userId,
          conversation: conversationId,
          content: content.trim(),
          type,
          readBy: [{ user: socket.userId, readAt: new Date() }]
        });

        await message.populate('sender', 'username avatar');

        // Update conversation
        conversation.lastMessage = message._id;
        conversation.updatedAt = new Date();
        await conversation.save();

        // Emit to all participants in the conversation
        io.to(`conversation-${conversationId}`).emit('new-message', {
          message,
          conversation: {
            _id: conversation._id,
            participants: conversation.participants
          }
        });

        // Send push notifications to offline participants
        recipients.forEach(recipient => {
          if (!io.sockets.adapter.rooms.get(`user-${recipient._id}`)) {
            // User is offline, could trigger push notification here
            console.log(`Send push notification to ${recipient.username}`);
          }
        });

      } catch (error) {
        console.error('Send message error:', error);
        socket.emit('error', { message: 'Could not send message' });
      }
    });

    // Typing indicators
    socket.on('typing-start', (data) => {
      const { conversationId } = data;
      if (socket.isAuthenticated && conversationId) {
        socket.to(`conversation-${conversationId}`).emit('user-typing', {
          userId: socket.userId,
          username: socket.user.username,
          conversationId
        });
      }
    });

    socket.on('typing-stop', (data) => {
      const { conversationId } = data;
      if (socket.isAuthenticated && conversationId) {
        socket.to(`conversation-${conversationId}`).emit('user-stopped-typing', {
          userId: socket.userId,
          conversationId
        });
      }
    });

    // Message read receipts
    socket.on('mark-messages-read', async (data) => {
      try {
        const { conversationId, messageIds } = data;
        
        if (!socket.isAuthenticated) return;

        await Message.updateMany(
          {
            _id: { $in: messageIds },
            conversation: conversationId,
            sender: { $ne: socket.userId }
          },
          {
            $push: { readBy: { user: socket.userId, readAt: new Date() } }
          }
        );

        // Notify other participants about read receipts
        socket.to(`conversation-${conversationId}`).emit('messages-read', {
          userId: socket.userId,
          messageIds,
          readAt: new Date()
        });

      } catch (error) {
        console.error('Mark messages read error:', error);
      }
    });

    // === FOLLOW SYSTEM EVENTS ===
    
    // Real-time follow request notification (handled by API, but we can add extra real-time features)
    socket.on('follow-request-response', async (data) => {
      try {
        const { requestId, action } = data; // action: 'accept' or 'reject'
        
        if (!socket.isAuthenticated) {
          socket.emit('error', { message: 'Authentication required' });
          return;
        }

        // This would typically be handled by the API endpoint, 
        // but we can add real-time updates here
        socket.emit('follow-request-updated', {
          requestId,
          action,
          timestamp: new Date()
        });

      } catch (error) {
        console.error('Follow request response error:', error);
      }
    });

    // === GENERAL EVENTS ===

    // Handle disconnection
    socket.on('disconnect', async () => {
      console.log(`User disconnected: ${socket.userId || 'Anonymous'}`);
      
      try {
        // Handle live stream disconnection
        if (socket.currentStreamId) {
          if (socket.isStreamer) {
            const liveStream = await LiveStream.findById(socket.currentStreamId);
            if (liveStream && liveStream.status === 'live') {
              liveStream.status = 'ended';
              liveStream.endedAt = new Date();
              liveStream.duration = Math.floor((Date.now() - liveStream.startedAt.getTime()) / 1000);
              await liveStream.save();

              io.to(`stream-${socket.currentStreamId}`).emit('stream-ended', {
                message: 'The streamer has disconnected',
                duration: liveStream.duration
              });
            }
          } else if (socket.isAuthenticated) {
            const liveStream = await LiveStream.findById(socket.currentStreamId);
            if (liveStream) {
              await liveStream.removeViewer(socket.userId);
              
              io.to(`stream-${socket.currentStreamId}`).emit('viewer-left', {
                viewerCount: liveStream.currentViewers
              });
            }
          }
        }

        // Update user offline status
        if (socket.isAuthenticated) {
          const user = await User.findById(socket.userId).populate('followers', '_id');
          await user.setOnlineStatus(false);
          
          // Broadcast offline status to followers
          if (user && user.followers) {
            user.followers.forEach(follower => {
              socket.to(`user-${follower._id}`).emit('user-offline', {
                userId: socket.userId,
                username: socket.user.username,
                lastSeen: user.lastSeen,
                timestamp: new Date()
              });
            });
          }
        }

      } catch (error) {
        console.error('Disconnect cleanup error:', error);
      }
    });

    // Previous live streaming events (send-comment, send-heart, etc.) remain the same...
    // [Include all the live streaming events from the previous socket implementation]
    
  });

  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error('Socket.IO not initialized');
  }
  return io;
};

export { initializeSocket, getIO };