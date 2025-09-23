// routes/messageRoutes.js
import express from 'express';
import authMiddleware from '../middleware/auth.js';
import User from '../models/User.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import AWS from 'aws-sdk';

const router = express.Router();

const s3 = new AWS.S3({
  accessKeyId: process.env.WASABI_KEY,
  secretAccessKey: process.env.WASABI_SECRET,
  endpoint: process.env.WASABI_ENDPOINT,
  region: process.env.WASABI_REGION,
  signatureVersion: "v4",
});

// Get all conversations for a user
router.get('/conversations', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { page = 1, limit = 20 } = req.query;

        const conversations = await Conversation.find({
            participants: userId
        })
            .populate({
                path: 'participants',
                select: 'username avatar',
                match: { _id: { $ne: userId } } // Exclude current user
            })
            .populate({
                path: 'lastMessage',
                select: 'content type createdAt sender'
            })
            .sort({ updatedAt: -1 })
            .limit(limit * 1)
            .skip((page - 1) * limit);

        // Filter out conversations where participant population failed
        const validConversations = conversations.filter(conv =>
            conv.participants && conv.participants.length > 0
        );

        res.json(validConversations);
    } catch (error) {
        console.error('Get conversations error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Start a new conversation or get existing one
router.post('/conversations', authMiddleware, async (req, res) => {
    try {
        const { recipientId } = req.body;
        const senderId = req.userId;

        if (!recipientId) {
            return res.status(400).json({ msg: 'Recipient ID is required' });
        }

        if (recipientId === senderId) {
            return res.status(400).json({ msg: 'Cannot start conversation with yourself' });
        }

        // Check if both users follow each other (required for messaging)
        const sender = await User.findById(senderId);
        const recipient = await User.findById(recipientId);

        if (!recipient) {
            return res.status(404).json({ msg: 'Recipient not found' });
        }

        const canMessage = sender.following.includes(recipientId) &&
            recipient.following.includes(senderId);

        if (!canMessage) {
            return res.status(403).json({
                msg: 'Both users must follow each other to start a conversation'
            });
        }

        // Check if conversation already exists
        let conversation = await Conversation.findOne({
            participants: { $all: [senderId, recipientId] }
        }).populate({
            path: 'participants',
            select: 'username avatar'
        });

        if (!conversation) {
            // Create new conversation
            conversation = await Conversation.create({
                participants: [senderId, recipientId]
            });

            await conversation.populate({
                path: 'participants',
                select: 'username avatar'
            });
        }

        res.json(conversation);
    } catch (error) {
        console.error('Create conversation error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Get messages in a conversation
router.get('/conversations/:conversationId/messages', authMiddleware, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const { page = 1, limit = 50 } = req.query;
        const userId = req.userId;

        // Check if user is part of the conversation
        const conversation = await Conversation.findById(conversationId);
        if (!conversation || !conversation.participants.includes(userId)) {
            return res.status(403).json({ msg: 'Not authorized to view this conversation' });
        }

        const messages = await Message.find({ conversation: conversationId })
            .populate('sender', 'username avatar')
            .sort({ createdAt: -1 })
            .limit(limit * 1)
            .skip((page - 1) * limit);

        // Mark messages as read
        await Message.updateMany(
            {
                conversation: conversationId,
                sender: { $ne: userId },
                readBy: { $ne: userId }
            },
            {
                $push: { readBy: userId }
            }
        );

        res.json(messages.reverse()); // Return in chronological order
    } catch (error) {
        console.error('Get messages error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

router.post('/media/signed-url', authMiddleware, async (req, res) => {
  try {
    const { fileName, fileType } = req.body;
    if (!fileName || !fileType) {
      return res.status(400).json({ msg: 'fileName and fileType are required' });
    }

    // Unique key for the file
    const key = `messages/${req.userId}/${Date.now()}-${fileName}`;

    const uploadUrl = await s3.getSignedUrlPromise('putObject', {
      Bucket: process.env.WASABI_BUCKET,
      Key: key,
      Expires: 604800, // 5 minutes
      ContentType: fileType,
    });

    // Fix the file URL construction
    // Option 1: If your WASABI_ENDPOINT includes the protocol
    let fileUrl;
    if (process.env.WASABI_.startsWith('https://')) {
      const endpointWithoutProtocol = process.env.WASABI_ENDPOINT.replace('https://', '');
      fileUrl = `https://${process.env.WASABI_BUCKET}.${endpointWithoutProtocol}/${key}`;
    } else {
      // Option 2: If your WASABI_ENDPOINT doesn't include the protocol
      fileUrl = `https://${process.env.WASABI_BUCKET}.${process.env.WASABI_ENDPOINT}/${key}`;
    }

    // Alternative approach - construct URL more reliably
    // fileUrl = `${process.env.WASABI_ENDPOINT}/${process.env.WASABI_BUCKET}/${key}`;

    console.log('Generated file URL:', fileUrl); // Debug log

    res.json({ uploadUrl, fileUrl, key });
  } catch (err) {
    console.error('Signed URL error:', err);
    res.status(500).json({ msg: 'Could not generate signed URL' });
  }
});


// Send a message
/* -------------------------------
   🔹 2. Send a Message (with optional file)
-------------------------------- */
router.post('/conversations/:conversationId/messages', authMiddleware, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { content, type = 'text', fileUrl, fileSize, fileName, key, fileType } = req.body;
    const senderId = req.userId;

    if (type === 'text' && (!content || content.trim().length === 0)) {
      return res.status(400).json({ msg: 'Message content is required' });
    }

    if (['image', 'video', 'audio', 'file'].includes(type) && (!fileUrl || !key)) {
      return res.status(400).json({ msg: 'File URL and key are required for media messages' });
    }

    const conversation = await Conversation.findById(conversationId);
    if (!conversation || !conversation.participants.includes(senderId)) {
      return res.status(403).json({ msg: 'Not authorized' });
    }

    const message = await Message.create({
      sender: senderId,
      conversation: conversationId,
      content: content?.trim() || '',
      type,
      fileUrl,
      fileSize,
      fileName,
      fileType, // Store fileType
      key,
      readBy: [senderId]
    });

    await message.populate('sender', 'username avatar');

    conversation.lastMessage = message._id;
    conversation.updatedAt = new Date();
    await conversation.save();

    // Emit socket event
    const io = req.app.get('io');
    if (io) {
      io.to(`conversation-${conversationId}`).emit('new-message', {
        message,
        conversation
      });
    }

    res.status(201).json(message);
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// DELETE /conversations/:conversationId
router.delete('/conversations/:conversationId', authMiddleware, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const userId = req.userId;

        const conversation = await Conversation.findById(conversationId);

        if (!conversation) {
            return res.status(404).json({ msg: 'Conversation not found' });
        }

        if (!conversation.participants.includes(userId)) {
            return res.status(403).json({ msg: 'Not authorized' });
        }

        // Delete all messages in this conversation
        await Message.deleteMany({ conversation: conversationId });

        // Delete the conversation itself
        await conversation.deleteOne();

        res.json({ msg: 'Conversation deleted successfully' });
    } catch (error) {
        console.error('Delete conversation error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});


// Delete a message

// router.delete('/messages/:messageId', authMiddleware, async (req, res) => {
//   try {
//     const { messageId } = req.params;
//     const userId = req.userId;

//     const message = await Message.findById(messageId);
//     if (!message) {
//       return res.status(404).json({ msg: 'Message not found' });
//     }

//     // Only the sender can delete their own message
//     if (message.sender.toString() !== userId) {
//       return res.status(403).json({ msg: 'Not authorized to delete this message' });
//     }

//     // Soft delete → mark as deleted
//     message.isDeleted = true;
//     message.content = 'This message was deleted';
//     await message.save();

//     // Get conversation for socket event
//     const conversation = await Conversation.findById(message.conversation)
//       .populate('participants', '_id');

//     // Emit real-time delete event
//     const io = req.app.get('io');
//     if (io && conversation) {
//       conversation.participants.forEach(participant => {
//         io.to(`user-${participant._id}`).emit('message-deleted', {
//           messageId: message._id,
//           conversationId: conversation._id,
//         });
//       });
//     }

//     res.json({ msg: 'Message deleted successfully', message });
//   } catch (error) {
//     console.error('Delete message error:', error);
//     res.status(500).json({ msg: 'Server error' });
//   }
// });

// DELETE /messages/:messageId/everyone
router.delete('/:messageId/everyone', authMiddleware, async (req, res) => {
    try {
        const { messageId } = req.params;
        const userId = req.userId;

        const message = await Message.findById(messageId);
        if (!message) return res.status(404).json({ msg: 'Message not found' });

        if (message.sender.toString() !== userId) {
            return res.status(403).json({ msg: 'Only sender can delete for everyone' });
        }

        // Soft delete for everyone
        message.isDeleted = true;
        message.content = 'This message was deleted';
        await message.save();

        // Emit socket event
        const io = req.app.get('io');
        if (io) {
            io.to(`conversation-${message.conversation}`).emit('message-deleted-everyone', {
                messageId: message._id,
                conversationId: message.conversation,
            });
        }

        res.json({ msg: 'Message deleted for everyone', message });
    } catch (error) {
        console.error('Delete for everyone error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// DELETE /messages/:messageId/me
router.delete('/:messageId/me', authMiddleware, async (req, res) => {
    try {
        const { messageId } = req.params;
        const userId = req.userId;

        const message = await Message.findById(messageId);
        if (!message) return res.status(404).json({ msg: 'Message not found' });

        // Add user to deletedFor list
        if (!message.deletedFor.includes(userId)) {
            message.deletedFor.push(userId);
            await message.save();
        }

        res.json({ msg: 'Message deleted for you only' });
    } catch (error) {
        console.error('Delete for me error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Get unread message count
router.get('/unread-count', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;

        const unreadCount = await Message.countDocuments({
            conversation: {
                $in: await Conversation.find({ participants: userId }).select('_id')
            },
            sender: { $ne: userId },
            readBy: { $ne: userId },
            isDeleted: { $ne: true }
        });

        res.json({ unreadCount });
    } catch (error) {
        console.error('Get unread count error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Search conversations
router.get('/conversations/search', authMiddleware, async (req, res) => {
    try {
        const { query } = req.query;
        const userId = req.userId;

        if (!query || query.trim().length === 0) {
            return res.status(400).json({ msg: 'Search query is required' });
        }

        const conversations = await Conversation.find({
            participants: userId
        })
            .populate({
                path: 'participants',
                match: {
                    $and: [
                        { _id: { $ne: userId } },
                        { username: { $regex: query.trim(), $options: 'i' } }
                    ]
                },
                select: 'username avatar'
            })
            .populate('lastMessage');

        // Filter conversations where participant search matched
        const matchingConversations = conversations.filter(conv =>
            conv.participants && conv.participants.length > 0
        );

        res.json(matchingConversations);
    } catch (error) {
        console.error('Search conversations error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// messageRoutes.js
// router.get('/file/:key', authMiddleware, async (req, res) => {
//   try {
//     const { key } = req.params;

//     const url = s3.getSignedUrl('getObject', {
//       Bucket: process.env.WASABI_BUCKET,
//       Key: key,
//       Expires: 60 * 5, // 5 minutes
//     });

//     return res.redirect(url); // 🔥 Browser loads file directly
//   } catch (err) {
//     console.error('File fetch error:', err);
//     res.status(500).json({ msg: 'Could not fetch file' });
//   }
// });

router.get('/file/:key', authMiddleware, async (req, res) => {
  try {
    const { key } = req.params;
    const url = s3.getSignedUrl('getObject', {
      Bucket: process.env.WASABI_BUCKET,
      Key: key,
      Expires: 604800,
    });
    console.log('Signed URL for file:', url);
    res.json({ url });
  } catch (err) {
    console.error('File fetch error:', err);
    res.status(500).json({ msg: 'Could not fetch file' });
  }
});


export default router;