import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import LiveStream from '../models/LiveStream.js';
import User from '../models/User.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import Group from '../models/Group.js';

let io;

// Placeholder function for generating stream details
const generateStreamDetails = (streamId, userId) => {
  return {
    rtmpUrl: `rtmp://theclipstream-backend.onrender.com/live`,
    streamKey: `${streamId}-${userId}`,
    playbackUrl: `https://theclipstream-backend.onrender.com/live/${streamId}-${userId}.m3u8`
  };
};

const initializeSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: ["https://theclipstream.netlify.app", "http://localhost:5173", "https://theclipstream.com"],
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

    // === LIVE STREAMING EVENTS ===
    socket.on('join-stream', async (data) => {
      try {
        const { streamId, isStreamer } = data;

        const liveStream = await LiveStream.findById(streamId)
          .populate('streamer', 'username avatar')
          .populate('streams.user', 'username avatar');

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

    socket.on('leave-stream', async ({ streamId }) => {
      try {
        const liveStream = await LiveStream.findById(streamId);
        if (liveStream && socket.isAuthenticated) {
          await liveStream.removeViewer(socket.userId);
          io.to(`stream-${streamId}`).emit('viewer-left', {
            viewerCount: liveStream.currentViewers
          });
        }
      } catch (error) {
        console.error('Leave stream error:', error);
      }
    });

    // socket.on('send-comment', async (comment) => {
    //   try {
    //     const liveStream = await LiveStream.findById(comment.streamId);
    //     if (!liveStream) {
    //       socket.emit('error', { message: 'Stream not found' });
    //       return;
    //     }

    //     const userId = socket.isAuthenticated ? socket.userId : null;
    //     await liveStream.addComment(userId, comment.text);
    //     const populatedComment = {
    //       ...comment,
    //       username: userId ? socket.user.username : 'Anonymous'
    //     };
    //     io.to(`stream-${comment.streamId}`).emit('new-comment', populatedComment);
    //   } catch (error) {
    //     console.error('Send comment error:', error);
    //     socket.emit('error', { message: 'Could not send comment' });
    //   }
    // });

    socket.on('send-comment', async (commentData) => {
      try {
        const { streamId, text } = commentData;

        if (!text || text.trim().length === 0) {
          return socket.emit('error', { message: 'Comment cannot be empty' });
        }

        const liveStream = await LiveStream.findById(streamId);
        if (!liveStream) {
          return socket.emit('error', { message: 'Stream not found' });
        }

        // Add comment to database
        const userId = socket.isAuthenticated ? socket.userId : null;
        await liveStream.addComment(userId, text.trim());

        const username = socket.isAuthenticated && socket.user ? socket.user.username : 'Anonymous Viewer';

        // Emit to ALL users in the stream (host and viewers)
        io.to(`stream-${streamId}`).emit('new-comment', {
          id: Date.now() + Math.random(),
          username: username,
          text: text.trim(),
          userId: userId,
          timestamp: new Date(),
          isViewer: true // Flag to indicate this is from a viewer
        });

        console.log(`Comment received in stream ${streamId} from ${username}:`, text);
      } catch (error) {
        console.error('Send comment error:', error);
        socket.emit('error', { message: 'Could not send comment' });
      }
    });
    // socket.on('send-heart', async ({ streamId }) => {
    //   try {
    //     const liveStream = await LiveStream.findById(streamId);
    //     if (liveStream) {
    //       await liveStream.addHeart();
    //       io.to(`stream-${streamId}`).emit('heart-sent');
    //     }
    //   } catch (error) {
    //     console.error('Send heart error:', error);
    //   }
    // });

    socket.on('send-heart', async (heartData) => {
      try {
        const { streamId } = heartData;

        const liveStream = await LiveStream.findById(streamId);
        if (!liveStream) {
          return socket.emit('error', { message: 'Stream not found' });
        }

        // Add heart to database
        await liveStream.addHeart();

        const username = socket.isAuthenticated && socket.user ? socket.user.username : 'Anonymous Viewer';

        // Emit heart event to ALL users in the stream (host and viewers)
        io.to(`stream-${streamId}`).emit('heart-sent', {
          id: Date.now() + Math.random(),
          username: username,
          userId: socket.isAuthenticated ? socket.userId : null,
          timestamp: new Date(),
          isViewer: true // Flag to indicate this is from a viewer
        });

        console.log(`Heart received in stream ${streamId} from ${username}`);
      } catch (error) {
        console.error('Send heart error:', error);
        socket.emit('error', { message: 'Could not send heart' });
      }
    });

    socket.on('end-stream', async ({ streamId }) => {
      try {
        const liveStream = await LiveStream.findById(streamId);
        if (liveStream && socket.isAuthenticated && liveStream.streamer.toString() === socket.userId) {
          liveStream.status = 'ended';
          liveStream.endedAt = new Date();
          liveStream.duration = Math.floor((Date.now() - liveStream.startedAt.getTime()) / 1000);
          await liveStream.save();
          io.to(`stream-${streamId}`).emit('stream-ended', {
            message: 'The stream has ended',
            duration: liveStream.duration
          });
        }
      } catch (error) {
        console.error('End stream error:', error);
      }
    });

    // === CO-HOST EVENTS ===
    socket.on('request-cohost', async ({ streamId }) => {
      try {
        if (!socket.isAuthenticated) {
          socket.emit('error', { message: 'Authentication required to request co-host' });
          return;
        }

        const liveStream = await LiveStream.findById(streamId).populate('streamer', 'username avatar');
        if (!liveStream) {
          socket.emit('error', { message: 'Stream not found' });
          return;
        }

        const user = await User.findById(socket.userId);
        if (!user) {
          socket.emit('error', { message: 'User not found' });
          return;
        }

        // Notify the streamer
        io.to(`stream-${streamId}`).emit('cohost-request', {
          userId: socket.userId,
          username: user.username,
          avatar: user.avatar
        });
      } catch (error) {
        console.error('Request co-host error:', error);
        socket.emit('error', { message: 'Could not request to co-host' });
      }
    });

    socket.on('approve-cohost', async ({ streamId, userId }) => {
      try {
        if (!socket.isAuthenticated) {
          socket.emit('error', { message: 'Authentication required' });
          return;
        }

        const liveStream = await LiveStream.findById(streamId);
        if (!liveStream) {
          socket.emit('error', { message: 'Stream not found' });
          return;
        }

        if (liveStream.streamer.toString() !== socket.userId) {
          socket.emit('error', { message: 'Not authorized to approve co-hosts' });
          return;
        }

        if (liveStream.streams.some(s => s.user.toString() === userId)) {
          socket.emit('error', { message: 'User is already a host' });
          return;
        }

        const newStream = generateStreamDetails(streamId, userId);
        liveStream.streams.push({
          user: userId,
          joinedAt: new Date(),
          rtmpUrl: newStream.rtmpUrl,
          streamKey: newStream.streamKey,
          playbackUrl: newStream.playbackUrl
        });

        await liveStream.save();
        await liveStream.populate('streams.user', 'username avatar');

        io.to(`stream-${streamId}`).emit('cohost-joined', {
          stream: liveStream
        });
        io.to(`user-${userId}`).emit('cohost-approved', {
          userId,
          rtmpUrl: newStream.rtmpUrl,
          streamKey: newStream.streamKey,
          playbackUrl: newStream.playbackUrl
        });
      } catch (error) {
        console.error('Approve co-host error:', error);
        socket.emit('error', { message: 'Could not approve co-host' });
      }
    });

    socket.on('reject-cohost', async ({ streamId, userId }) => {
      try {
        if (!socket.isAuthenticated) {
          socket.emit('error', { message: 'Authentication required' });
          return;
        }

        const liveStream = await LiveStream.findById(streamId);
        if (!liveStream) {
          socket.emit('error', { message: 'Stream not found' });
          return;
        }

        if (liveStream.streamer.toString() !== socket.userId) {
          socket.emit('error', { message: 'Not authorized to reject co-hosts' });
          return;
        }

        io.to(`user-${userId}`).emit('cohost-rejected', { userId });
      } catch (error) {
        console.error('Reject co-host error:', error);
        socket.emit('error', { message: 'Could not reject co-host' });
      }
    });

    // === MESSAGING EVENTS ===
    // In socket.js - join-conversation event
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

        // Mark messages as read - FIXED VERSION
        await Message.updateMany(
          {
            conversation: conversationId,
            sender: { $ne: socket.userId },
            readBy: { $ne: socket.userId }
          },
          {
            $addToSet: { readBy: socket.userId }  // Changed from $push with object
          }
        );

        socket.emit('joined-conversation', { conversationId });
      } catch (error) {
        console.error('Join conversation error:', error);
        socket.emit('error', { message: 'Could not join conversation' });
      }
    });

    // Also update mark-messages-read event
    socket.on('mark-messages-read', async (data) => {
      try {
        const { conversationId, messageIds } = data;

        if (!socket.isAuthenticated) return;

        await Message.updateMany(
          {
            _id: { $in: messageIds },
            conversation: conversationId,
            sender: { $ne: socket.userId },
            readBy: { $ne: socket.userId }
          },
          {
            $addToSet: { readBy: socket.userId }  // Changed from $push with object
          }
        );

        socket.to(`conversation-${conversationId}`).emit('messages-read', {
          userId: socket.userId,
          messageIds,
          readAt: new Date()
        });
      } catch (error) {
        console.error('Mark messages read error:', error);
      }
    });

    socket.on('leave-conversation', (data) => {
      const { conversationId } = data;
      socket.leave(`conversation-${conversationId}`);
      socket.currentConversationId = null;
    });

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
            console.log(`Send push notification to ${recipient.username}`);
          }
        });
      } catch (error) {
        console.error('Send message error:', error);
        socket.emit('error', { message: 'Could not send message' });
      }
    });

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
    socket.on('follow-request-response', async (data) => {
      try {
        const { requestId, action } = data;

        if (!socket.isAuthenticated) {
          socket.emit('error', { message: 'Authentication required' });
          return;
        }

        socket.emit('follow-request-updated', {
          requestId,
          action,
          timestamp: new Date()
        });
      } catch (error) {
        console.error('Follow request response error:', error);
      }
    });

    // === DISCONNECT HANDLING ===
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

          if (user && user.followers) {
            user.followers.forEach(follower => {
              socket.to(`user-${follower._id}`).emit('user-offline', {
                userId: socket.userId,
                username: user.username,
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
    socket.on('join-group', async (data) => {
      try {
        const { groupId } = data;

        if (!socket.isAuthenticated) {
          socket.emit('error', { message: 'Authentication required for groups' });
          return;
        }

        const group = await Group.findById(groupId);

        if (!group) {
          socket.emit('error', { message: 'Group not found' });
          return;
        }

        // Verify user is a member
        if (!group.isMember(socket.userId)) {
          socket.emit('error', { message: 'Not a member of this group' });
          return;
        }

        socket.join(`group-${groupId}`);
        socket.currentGroupId = groupId;

        socket.emit('joined-group', { groupId });
      } catch (error) {
        console.error('Join group error:', error);
        socket.emit('error', { message: 'Could not join group' });
      }
    });

    socket.on('leave-group', (data) => {
      const { groupId } = data;
      socket.leave(`group-${groupId}`);
      socket.currentGroupId = null;
    });

    socket.on('send-group-message', async (data) => {
      try {
        const { groupId, content, type = 'text', key, fileType, fileName } = data;

        if (!socket.isAuthenticated) {
          socket.emit('error', { message: 'Authentication required' });
          return;
        }


        const group = await Group.findById(groupId);
        if (!group) {
          socket.emit('error', { message: 'Group not found' });
          return;
        }

        // Check if user can post
        if (!group.canPost(socket.userId)) {
          socket.emit('error', { message: 'You do not have permission to post in this group' });
          return;
        }

        // Create message
        let messageData = {
          sender: socket.userId,
          conversation: group.conversation,
          type,
          readBy: [socket.userId]
        };

        if (type === 'text') {
          messageData.content = content?.trim();
        }

        if (['image', 'video', 'audio'].includes(type)) {
          messageData.key = key;
          messageData.fileType = fileType;
          messageData.fileName = fileName;
        }

        const message = await Message.create(messageData);
        await message.populate('sender', 'username avatar');

        // Update conversation
        const conversation = await Conversation.findById(group.conversation);
        if (conversation) {
          conversation.lastMessage = message._id;
          conversation.updatedAt = new Date();
          await conversation.save();
        }

        // Emit to all group members
        io.to(`group-${groupId}`).emit('new-group-message', {
          message,
          groupId
        });

      } catch (error) {
        console.error('Send group message error:', error);
        socket.emit('error', { message: 'Could not send message' });
      }
    });

    socket.on('group-typing-start', (data) => {
      const { groupId } = data;
      if (socket.isAuthenticated && groupId) {
        socket.to(`group-${groupId}`).emit('group-user-typing', {
          userId: socket.userId,
          username: socket.user.username,
          groupId
        });
      }
    });

    socket.on('group-typing-stop', (data) => {
      const { groupId } = data;
      if (socket.isAuthenticated && groupId) {
        socket.to(`group-${groupId}`).emit('group-user-stopped-typing', {
          userId: socket.userId,
          groupId
        });
      }
    });

    // Handle group member events
    socket.on('update-group-member', async (data) => {
      try {
        const { groupId, action, memberId } = data;

        if (!socket.isAuthenticated) {
          socket.emit('error', { message: 'Authentication required' });
          return;
        }

        io.to(`group-${groupId}`).emit('group-member-updated', {
          groupId,
          action,
          memberId,
          updatedBy: socket.userId,
          timestamp: new Date()
        });
      } catch (error) {
        console.error('Update group member error:', error);
      }
    });


    // socket.on('add-product', async (data) => {
    //   try {
    //     const { streamId, product } = data;

    //     if (!socket.isAuthenticated) {
    //       return socket.emit('error', { message: 'Authentication required' });
    //     }

    //     const liveStream = await LiveStream.findById(streamId);
    //     if (!liveStream) {
    //       return socket.emit('error', { message: 'Stream not found' });
    //     }

    //     // Only host can add products
    //     if (liveStream.streamer.toString() !== socket.userId) {
    //       return socket.emit('error', { message: 'Only host can add products' });
    //     }

    //     // Validate product data
    //     if (!product.type || !['product', 'ad'].includes(product.type) ||
    //       !product.name || product.price === undefined) {
    //       return socket.emit('error', { message: 'Invalid product data' });
    //     }

    //     product.addedBy = socket.userId;
    //     product.addedAt = new Date();

    //     liveStream.products.push(product);
    //     await liveStream.save();

    //     const productIndex = liveStream.products.length - 1;

    //     // Emit to ALL viewers in the stream room (including the host)
    //     io.to(`stream-${streamId}`).emit('product-added', {
    //       product: product,
    //       productIndex: productIndex,
    //       streamId: streamId
    //     });

    //     console.log(`Product added to stream ${streamId}:`, product.name);
    //   } catch (error) {
    //     console.error('Add product error:', error);
    //     socket.emit('error', { message: 'Could not add product' });
    //   }
    // });

    // socket.on('place-order', async (data) => {
    //   try {
    //     const { streamId, productIndex, quantity = 1 } = data;

    //     if (!socket.isAuthenticated) {
    //       return socket.emit('error', { message: 'Authentication required to place order' });
    //     }

    //     const liveStream = await LiveStream.findById(streamId);
    //     if (!liveStream) {
    //       return socket.emit('error', { message: 'Stream not found' });
    //     }

    //     if (productIndex < 0 || productIndex >= liveStream.products.length) {
    //       return socket.emit('error', { message: 'Invalid product' });
    //     }

    //     const product = liveStream.products[productIndex];
    //     if (product.type !== 'product') {
    //       return socket.emit('error', { message: 'Can only order products, not ads' });
    //     }

    //     const order = {
    //       productIndex,
    //       buyer: socket.userId,
    //       quantity,
    //     };

    //     liveStream.orders.push(order);
    //     await liveStream.save();

    //     io.to(`stream-${streamId}`).emit('new-order', {
    //       order,
    //       buyerUsername: socket.user.username
    //     });
    //   } catch (error) {
    //     console.error('Place order error:', error);
    //     socket.emit('error', { message: 'Could not place order' });
    //   }
    // });

    socket.on('add-product', async (data) => {
      try {
        const { streamId, product } = data;

        if (!socket.isAuthenticated) {
          return socket.emit('error', { message: 'Authentication required' });
        }

        const liveStream = await LiveStream.findById(streamId);
        if (!liveStream) {
          return socket.emit('error', { message: 'Stream not found' });
        }

        if (liveStream.streamer.toString() !== socket.userId) {
          return socket.emit('error', { message: 'Only host can add products' });
        }

        if (!product.type || !['product', 'ad'].includes(product.type) ||
          !product.name || product.price === undefined || product.price <= 0) {
          return socket.emit('error', { message: 'Invalid product data' });
        }

        product.addedBy = socket.userId;
        product.addedAt = new Date();

        liveStream.products.push(product);
        await liveStream.save();

        const productIndex = liveStream.products.length - 1;

        // Emit to ALL users in the stream
        io.to(`stream-${streamId}`).emit('product-added', {
          product: product,
          productIndex: productIndex,
          streamId: streamId
        });

        console.log(`Product added to stream ${streamId}:`, product.name);
      } catch (error) {
        console.error('Add product error:', error);
        socket.emit('error', { message: 'Could not add product' });
      }
    });

    // socket.on('place-order', async (data) => {
    //   try {
    //     const { streamId, productIndex, quantity = 1 } = data;

    //     if (!socket.isAuthenticated) {
    //       return socket.emit('error', { message: 'Authentication required to place order' });
    //     }

    //     const liveStream = await LiveStream.findById(streamId)
    //       .populate('orders.buyer', 'username avatar');

    //     if (!liveStream) {
    //       return socket.emit('error', { message: 'Stream not found' });
    //     }

    //     if (productIndex < 0 || productIndex >= liveStream.products.length) {
    //       return socket.emit('error', { message: 'Invalid product' });
    //     }

    //     const product = liveStream.products[productIndex];
    //     if (product.type !== 'product') {
    //       return socket.emit('error', { message: 'Can only order products, not ads' });
    //     }

    //     const order = {
    //       productIndex,
    //       buyer: socket.userId,
    //       quantity,
    //       status: 'pending',
    //       orderedAt: new Date()
    //     };

    //     liveStream.orders.push(order);
    //     await liveStream.save();

    //     // Emit to ALL viewers in the stream - REAL-TIME ORDER UPDATE
    //     io.to(`stream-${streamId}`).emit('new-order', {
    //       order: {
    //         ...order,
    //         buyer: {
    //           _id: socket.userId,
    //           username: socket.user.username,
    //           avatar: socket.user.avatar
    //         }
    //       },
    //       buyerUsername: socket.user.username,
    //       streamId: streamId
    //     });

    //     console.log(`Order placed in stream ${streamId}:`, socket.user.username);
    //   } catch (error) {
    //     console.error('Place order error:', error);
    //     socket.emit('error', { message: 'Could not place order' });
    //   }
    // });

    socket.on('place-order', async (data) => {
      try {
        const { streamId, productIndex, quantity = 1 } = data;

        if (!socket.isAuthenticated) {
          return socket.emit('error', { message: 'Authentication required to place order' });
        }

        const liveStream = await LiveStream.findById(streamId)
          .populate('orders.buyer', 'username avatar');

        if (!liveStream) {
          return socket.emit('error', { message: 'Stream not found' });
        }

        if (productIndex < 0 || productIndex >= liveStream.products.length) {
          return socket.emit('error', { message: 'Invalid product' });
        }

        const product = liveStream.products[productIndex];
        if (product.type !== 'product') {
          return socket.emit('error', { message: 'Can only order products, not ads' });
        }

        const order = {
          productIndex,
          buyer: socket.userId,
          quantity,
          status: 'pending',
          orderedAt: new Date()
        };

        liveStream.orders.push(order);
        await liveStream.save();

        // Emit to ALL users in the stream - REAL-TIME ORDER UPDATE
        io.to(`stream-${streamId}`).emit('new-order', {
          order: {
            ...order,
            buyer: {
              _id: socket.userId,
              username: socket.user.username,
              avatar: socket.user.avatar
            }
          },
          product: product,
          buyerUsername: socket.user.username,
          streamId: streamId
        });

        console.log(`Order placed in stream ${streamId}:`, socket.user.username);
      } catch (error) {
        console.error('Place order error:', error);
        socket.emit('error', { message: 'Could not place order' });
      }
    });

  });


  return io;
};







// In disconnect handler, add this to leave group rooms:
// if (socket.currentGroupId) {
//   socket.leave(`group-${socket.currentGroupId}`);
// }
const getIO = () => {
  if (!io) {
    throw new Error('Socket.IO not initialized');
  }
  return io;
};

export { initializeSocket, getIO };