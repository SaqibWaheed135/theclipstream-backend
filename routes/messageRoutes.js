// routes/messageRoutes.js
import express from 'express';
import AWS from 'aws-sdk';
import authMiddleware from '../middleware/auth.js';
import User from '../models/User.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';

const router = express.Router();

/* -------------------------------
   🔹 Setup Wasabi (S3 compatible)
-------------------------------- */
const s3 = new AWS.S3({
  endpoint: process.env.WASABI_ENDPOINT, // e.g. https://s3.ap-southeast-1.wasabisys.com
  region: process.env.WASABI_REGION,     // e.g. ap-southeast-1
  accessKeyId: process.env.WASABI_KEY,
  secretAccessKey: process.env.WASABI_SECRET,
  signatureVersion: 'v4',
});

/* -------------------------------
   🔹 1. Get Signed URL for Media Upload
-------------------------------- */
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
      Expires: 60 * 5, // 5 minutes
      ContentType: fileType,
    });

    // Permanent file URL (publicly accessible if bucket allows)
    const fileUrl = `https://${process.env.WASABI_BUCKET}.${process.env.WASABI_ENDPOINT.replace("https://", "")}/${key}`;

    res.json({ uploadUrl, fileUrl, key });
  } catch (err) {
    console.error('Signed URL error:', err);
    res.status(500).json({ msg: 'Could not generate signed URL' });
  }
});

/* -------------------------------
   🔹 2. Send a Message (with optional file)
-------------------------------- */
router.post('/conversations/:conversationId/messages', authMiddleware, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { content, type = 'text', fileUrl, fileSize, fileName, key } = req.body;
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
      key, // save Wasabi object key
      readBy: [senderId]
    });

    await message.populate('sender', 'username avatar');

    conversation.lastMessage = message._id;
    conversation.updatedAt = new Date();
    await conversation.save();

    res.status(201).json(message);
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

export default router;
