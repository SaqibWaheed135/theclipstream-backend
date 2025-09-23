// routes/messageRoutes.js
import express from 'express';
import authMiddleware from '../middleware/auth.js';
import User from '../models/User.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import AWS from 'aws-sdk';
import mongoose from 'mongoose';

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
                match: { _id: { $ne: userId } }
            })
            .populate({
                path: 'lastMessage',
                select: 'content type createdAt sender'
            })
            .sort({ updatedAt: -1 })
            .limit(limit * 1)
            .skip((page - 1) * limit);

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

        let conversation = await Conversation.findOne({
            participants: { $all: [senderId, recipientId] }
        }).populate({
            path: 'participants',
            select: 'username avatar'
        });

        if (!conversation) {
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

// Get messages in a conversation - FIXED
router.get('/conversations/:conversationId/messages', authMiddleware, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const { page = 1, limit = 50 } = req.query;
        const userId = req.userId;

        if (!mongoose.Types.ObjectId.isValid(conversationId)) {
            return res.status(400).json({ msg: 'Invalid conversation ID' });
        }

        const conversation = await Conversation.findById(conversationId);
        if (!conversation || !conversation.participants.includes(userId)) {
            return res.status(403).json({ msg: 'Not authorized to view this conversation' });
        }

        const messages = await Message.find({ conversation: conversationId })
            .populate('sender', 'username avatar')
            .sort({ createdAt: -1 })
            .limit(limit * 1)
            .skip((page - 1) * limit);

        // FIXED: Mark messages as read - ensure userId is ObjectId, not object
        try {
            await Message.updateMany(
                {
                    conversation: conversationId,
                    sender: { $ne: userId },
                    readBy: { $not: { $elemMatch: { $eq: userId } } }
                },
                {
                    $addToSet: { readBy: userId } // Use $addToSet to avoid duplicates
                }
            );
        } catch (readError) {
            console.error('Error marking messages as read:', readError);
            // Don't fail the request if read update fails
        }

        res.json(messages.reverse());
    } catch (error) {
        console.error('Get messages error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// FIXED: Media signed URL generation
router.post('/media/signed-url', authMiddleware, async (req, res) => {
    try {
        const { fileName, fileType } = req.body;
        if (!fileName || !fileType) {
            return res.status(400).json({ msg: 'fileName and fileType are required' });
        }

        // Validate file size and type if needed
        const allowedTypes = ['image/', 'video/', 'audio/', 'application/pdf', 'text/', 'application/msword'];
        if (!allowedTypes.some(type => fileType.startsWith(type))) {
            return res.status(400).json({ msg: 'File type not allowed' });
        }

        const key = `messages/${req.userId}/${Date.now()}-${fileName}`;

        const uploadUrl = await s3.getSignedUrlPromise('putObject', {
            Bucket: process.env.WASABI_BUCKET,
            Key: key,
            Expires: 300, // 5 minutes
            ContentType: fileType,
        });

        // FIXED: Check if WASABI_ENDPOINT starts with protocol
        let fileUrl;
        const endpoint = process.env.WASABI_ENDPOINT;
        
        if (!endpoint) {
            throw new Error('WASABI_ENDPOINT not configured');
        }

        if (endpoint.startsWith('https://')) {
            const endpointWithoutProtocol = endpoint.replace('https://', '');
            fileUrl = `https://${process.env.WASABI_BUCKET}.${endpointWithoutProtocol}/${key}`;
        } else if (endpoint.startsWith('http://')) {
            const endpointWithoutProtocol = endpoint.replace('http://', '');
            fileUrl = `https://${process.env.WASABI_BUCKET}.${endpointWithoutProtocol}/${key}`;
        } else {
            // Endpoint doesn't include protocol
            fileUrl = `https://${process.env.WASABI_BUCKET}.${endpoint}/${key}`;
        }

        console.log('Generated URLs:', { uploadUrl: uploadUrl.substring(0, 50) + '...', fileUrl, key });

        res.json({ uploadUrl, fileUrl, key });
    } catch (err) {
        console.error('Signed URL error:', err);
        res.status(500).json({ msg: 'Could not generate signed URL', error: err.message });
    }
});

// Send a message - FIXED
router.post('/conversations/:conversationId/messages', authMiddleware, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const { content, type = 'text', fileUrl, fileSize, fileName, key, fileType } = req.body;
        const senderId = req.userId;

        if (!mongoose.Types.ObjectId.isValid(conversationId)) {
            return res.status(400).json({ msg: 'Invalid conversation ID' });
        }

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

        // FIXED: Ensure readBy is properly initialized
        const message = await Message.create({
            sender: senderId,
            conversation: conversationId,
            content: content?.trim() || '',
            type,
            fileUrl,
            fileSize,
            fileName,
            fileType,
            key,
            readBy: [senderId] // Make sure this is an array of ObjectIds
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
        res.status(500).json({ msg: 'Server error', error: error.message });
    }
});

// Delete conversation
router.delete('/conversations/:conversationId', authMiddleware, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const userId = req.userId;

        if (!mongoose.Types.ObjectId.isValid(conversationId)) {
            return res.status(400).json({ msg: 'Invalid conversation ID' });
        }

        const conversation = await Conversation.findById(conversationId);

        if (!conversation) {
            return res.status(404).json({ msg: 'Conversation not found' });
        }

        if (!conversation.participants.includes(userId)) {
            return res.status(403).json({ msg: 'Not authorized' });
        }

        await Message.deleteMany({ conversation: conversationId });
        await conversation.deleteOne();

        res.json({ msg: 'Conversation deleted successfully' });
    } catch (error) {
        console.error('Delete conversation error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// Delete message for everyone
router.delete('/:messageId/everyone', authMiddleware, async (req, res) => {
    try {
        const { messageId } = req.params;
        const userId = req.userId;

        if (!mongoose.Types.ObjectId.isValid(messageId)) {
            return res.status(400).json({ msg: 'Invalid message ID' });
        }

        const message = await Message.findById(messageId);
        if (!message) return res.status(404).json({ msg: 'Message not found' });

        if (message.sender.toString() !== userId) {
            return res.status(403).json({ msg: 'Only sender can delete for everyone' });
        }

        message.isDeleted = true;
        message.content = 'This message was deleted';
        await message.save();

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

// Delete message for me only
router.delete('/:messageId/me', authMiddleware, async (req, res) => {
    try {
        const { messageId } = req.params;
        const userId = req.userId;

        if (!mongoose.Types.ObjectId.isValid(messageId)) {
            return res.status(400).json({ msg: 'Invalid message ID' });
        }

        const message = await Message.findById(messageId);
        if (!message) return res.status(404).json({ msg: 'Message not found' });

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

        const conversations = await Conversation.find({ participants: userId }).select('_id');
        const conversationIds = conversations.map(conv => conv._id);

        const unreadCount = await Message.countDocuments({
            conversation: { $in: conversationIds },
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

        const matchingConversations = conversations.filter(conv =>
            conv.participants && conv.participants.length > 0
        );

        res.json(matchingConversations);
    } catch (error) {
        console.error('Search conversations error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
});

// FIXED: Get file with better error handling
router.get('/file/:key', authMiddleware, async (req, res) => {
    try {
        const { key } = req.params;
        
        if (!key || key.trim() === '') {
            return res.status(400).json({ msg: 'File key is required' });
        }

        const url = await s3.getSignedUrlPromise('getObject', {
            Bucket: process.env.WASABI_BUCKET,
            Key: key,
            Expires: 300, // 5 minutes
        });

        console.log('Generated signed URL for key:', key);
        res.json({ url });
    } catch (err) {
        console.error('File fetch error:', err);
        res.status(500).json({ msg: 'Could not fetch file', error: err.message });
    }
});

export default router;