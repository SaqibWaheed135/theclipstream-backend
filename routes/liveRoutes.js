import express from 'express';
import LiveStream from '../models/LiveStream.js';
import authMiddleware from '../middleware/auth.js';
import { generateStreamDetails, endLiveInput, generateViewerToken } from '../utils/streaming.js';

const router = express.Router();

// Create a new live stream
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { title, description, privacy = 'public' } = req.body;

    if (!title || title.trim().length === 0) {
      return res.status(400).json({ msg: 'Title is required' });
    }

    const existingStream = await LiveStream.findOne({
      streamer: req.userId,
      status: 'live',
    });

    if (existingStream) {
      return res.status(400).json({
        msg: 'You already have an active live stream',
        streamId: existingStream._id,
      });
    }

    const liveStream = new LiveStream({
      title: title.trim(),
      description: description?.trim() || '',
      streamer: req.userId,
      privacy,
      status: 'live',
      startedAt: new Date(),
      streams: [],
    });

    // Save the stream first to get the ID
    await liveStream.save();

    try {
      const mainStream = await generateStreamDetails(liveStream._id.toString(), req.userId);
      console.log('Main stream details:', mainStream);

      // Validate the response from generateStreamDetails
      if (!mainStream.publishToken || typeof mainStream.publishToken !== 'string') {
        console.error('Invalid publishToken generated:', mainStream.publishToken);
        await LiveStream.findByIdAndDelete(liveStream._id);
        return res.status(500).json({ msg: 'Failed to generate stream token' });
      }

      liveStream.streams.push({
        user: req.userId,
        joinedAt: new Date(),
        roomUrl: mainStream.roomUrl,
        roomSid: mainStream.roomSid,
      });

      await liveStream.save();
      await liveStream.populate('streamer', 'username avatar');
      await liveStream.populate('streams.user', 'username avatar');

      const responseData = {
        streamId: liveStream._id,
        publishToken: mainStream.publishToken,
        roomUrl: mainStream.roomUrl,
        stream: liveStream,
      };

      res.status(201).json(responseData);
    } catch (streamError) {
      console.error('Stream generation error:', streamError);
      // Clean up the created stream if LiveKit setup fails
      await LiveStream.findByIdAndDelete(liveStream._id);
      res.status(500).json({ msg: `Could not create live stream: ${streamError.message}` });
    }
  } catch (error) {
    console.error('Create live stream error:', error);
    res.status(500).json({ msg: `Could not create live stream: ${error.message}` });
  }
});

// Add co-host
router.post('/:streamId/add-cohost', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    const liveStream = await LiveStream.findById(req.params.streamId);

    if (!liveStream) {
      return res.status(404).json({ msg: 'Live stream not found' });
    }

    if (liveStream.streamer.toString() !== req.userId) {
      return res.status(403).json({ msg: 'Not authorized' });
    }

    if (liveStream.streams.some((s) => s.user.toString() === userId)) {
      return res.status(400).json({ msg: 'Already a host' });
    }

    const newStream = await generateStreamDetails(liveStream._id.toString(), userId);
    liveStream.streams.push({
      user: userId,
      joinedAt: new Date(),
      roomUrl: newStream.roomUrl,
      roomSid: newStream.roomSid,
    });

    await liveStream.save();
    await liveStream.populate('streamer', 'username avatar');
    await liveStream.populate('streams.user', 'username avatar');

    res.json({
      msg: 'Co-host added',
      stream: liveStream,
      publishToken: newStream.publishToken,
      roomUrl: newStream.roomUrl,
    });
  } catch (error) {
    console.error('Add co-host error:', error);
    res.status(500).json({ msg: 'Could not add co-host' });
  }
});

// End a live stream
router.post('/:streamId/end', authMiddleware, async (req, res) => {
  try {
    const liveStream = await LiveStream.findById(req.params.streamId);

    if (!liveStream) {
      return res.status(404).json({ msg: 'Live stream not found' });
    }

    if (liveStream.streamer.toString() !== req.userId) {
      return res.status(403).json({ msg: 'Not authorized to end this stream' });
    }

    // Cleanup LiveKit rooms
    for (const s of liveStream.streams) {
      if (s.roomSid) {
        await endLiveInput(s.roomSid);
      }
    }

    liveStream.status = 'ended';
    liveStream.endedAt = new Date();
    liveStream.duration = Math.floor((Date.now() - liveStream.startedAt.getTime()) / 1000);

    await liveStream.save();

    res.json({
      msg: 'Live stream ended successfully',
      duration: liveStream.duration,
    });
  } catch (error) {
    console.error('End live stream error:', error);
    res.status(500).json({ msg: 'Could not end live stream' });
  }
});

// Get viewer token for LiveKit - FIXED
router.get('/:streamId/token', async (req, res) => {
  try {
    const liveStream = await LiveStream.findById(req.params.streamId);
    if (!liveStream) {
      return res.status(404).json({ msg: 'Live stream not found' });
    }

    // Use the first stream's room for viewer token
    const mainStream = liveStream.streams[0];
    if (!mainStream) {
      return res.status(404).json({ msg: 'No active stream found' });
    }

    // Generate viewer token with the room name (streamId-userId format)
    const roomName = `${req.params.streamId}-${liveStream.streamer}`;
    const viewerId = req.headers.authorization ? 
      req.headers.authorization.replace('Bearer ', '') : 
      `viewer-${Date.now()}`;
    
    const viewerToken = generateViewerToken(roomName, viewerId);
    
    res.json({
      viewerToken,
      roomUrl: process.env.LIVEKIT_URL,
      roomName: roomName
    });
  } catch (error) {
    console.error('Get viewer token error:', error);
    res.status(500).json({ msg: 'Could not generate viewer token' });
  }
});

// Get all active live streams
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const liveStreams = await LiveStream.find({
      status: 'live',
      privacy: 'public',
    })
      .populate('streamer', 'username avatar')
      .populate('streams.user', 'username avatar')
      .sort({ startedAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json(liveStreams);
  } catch (error) {
    console.error('Get live streams error:', error);
    res.status(500).json({ msg: 'Could not fetch live streams' });
  }
});

// Get a specific live stream - FIXED to include viewer token
router.get('/:streamId', async (req, res) => {
  try {
    const liveStream = await LiveStream.findById(req.params.streamId)
      .populate('streamer', 'username avatar')
      .populate('streams.user', 'username avatar');

    if (!liveStream) {
      return res.status(404).json({ msg: 'Live stream not found' });
    }

    // Generate viewer token for this stream
    const roomName = `${req.params.streamId}-${liveStream.streamer._id}`;
    const viewerId = req.headers.authorization ? 
      req.headers.authorization.replace('Bearer ', '') : 
      `viewer-${Date.now()}`;
    
    try {
      const viewerToken = generateViewerToken(roomName, viewerId);
      liveStream._doc.viewerToken = viewerToken;
      liveStream._doc.roomUrl = process.env.LIVEKIT_URL;
    } catch (tokenError) {
      console.error('Error generating viewer token:', tokenError);
      // Continue without token - frontend can handle gracefully
    }

    res.json(liveStream);
  } catch (error) {
    console.error('Get live stream error:', error);
    res.status(500).json({ msg: 'Could not fetch live stream' });
  }
});

// Get live stream analytics
router.get('/:streamId/analytics', authMiddleware, async (req, res) => {
  try {
    const liveStream = await LiveStream.findById(req.params.streamId)
      .populate('streamer', 'username avatar')
      .populate('streams.user', 'username avatar');

    if (!liveStream) {
      return res.status(404).json({ msg: 'Live stream not found' });
    }

    if (liveStream.streamer.toString() !== req.userId) {
      return res.status(403).json({ msg: 'Not authorized to view analytics' });
    }

    res.json({
      streamId: liveStream._id,
      title: liveStream.title,
      status: liveStream.status,
      viewerCount: liveStream.viewers.length,
      totalViews: liveStream.totalViews,
      peakViewers: liveStream.peakViewers,
      duration: liveStream.duration,
      heartsReceived: liveStream.heartsReceived,
      commentsCount: liveStream.comments.length,
      startedAt: liveStream.startedAt,
      endedAt: liveStream.endedAt,
      streams: liveStream.streams,
    });
  } catch (error) {
    console.error('Get analytics error:', error);
    res.status(500).json({ msg: 'Could not fetch analytics' });
  }
});

// Report a live stream
router.post('/:streamId/report', authMiddleware, async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ msg: 'Report reason is required' });
    }

    const liveStream = await LiveStream.findById(req.params.streamId);

    if (!liveStream) {
      return res.status(404).json({ msg: 'Live stream not found' });
    }

    const existingReport = liveStream.reports.find(
      (report) => report.reporter.toString() === req.userId
    );

    if (existingReport) {
      return res.status(400).json({ msg: 'You have already reported this stream' });
    }

    liveStream.reports.push({
      reporter: req.userId,
      reason,
      reportedAt: new Date(),
    });

    await liveStream.save();

    res.json({ msg: 'Live stream reported successfully' });
  } catch (error) {
    console.error('Report live stream error:', error);
    res.status(500).json({ msg: 'Could not report live stream' });
  }
});

export default router;