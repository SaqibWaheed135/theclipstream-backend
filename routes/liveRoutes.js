// import express from 'express';
// import LiveStream from '../models/LiveStream.js';
// import User from '../models/User.js';
// import authMiddleware from '../middleware/auth.js';
// import { generateStreamDetails, endLiveInput, generateViewerToken, testLiveKitConnection,testTokenGeneration} from '../utils/streaming.js';
// import { getIO } from '../utils/socket.js';  // CORRECTED IMPORT


// const router = express.Router();



// // Create a new live stream
// router.post('/create', authMiddleware, async (req, res) => {
//   try {
//     const { title, description, privacy = 'public' } = req.body;

//     if (!title || title.trim().length === 0) {
//       return res.status(400).json({ msg: 'Title is required' });
//     }

//     const existingStream = await LiveStream.findOne({
//       streamer: req.userId,
//       status: 'live',
//     });

//     if (existingStream) {
//       return res.status(400).json({
//         msg: 'You already have an active live stream',
//         streamId: existingStream._id,
//       });
//     }

//     const liveStream = new LiveStream({
//       title: title.trim(),
//       description: description?.trim() || '',
//       streamer: req.userId,
//       privacy,
//       status: 'live',
//       startedAt: new Date(),
//       streams: [],
//     });

//     // Save the stream first to get the ID
//     await liveStream.save();

//     try {
//       const mainStream = await generateStreamDetails(liveStream._id.toString(), req.userId);
//       console.log('Main stream details:', mainStream);

//       // Validate the response from generateStreamDetails
//       if (!mainStream.publishToken || typeof mainStream.publishToken !== 'string') {
//         console.error('Invalid publishToken generated:', mainStream.publishToken);
//         await LiveStream.findByIdAndDelete(liveStream._id);
//         return res.status(500).json({ msg: 'Failed to generate stream token' });
//       }

//       liveStream.streams.push({
//         user: req.userId,
//         joinedAt: new Date(),
//         roomUrl: mainStream.roomUrl,
//         roomSid: mainStream.roomSid,
//       });

//       await liveStream.save();
//       await liveStream.populate('streamer', 'username avatar');
//       await liveStream.populate('streams.user', 'username avatar');

//       const responseData = {
//         streamId: liveStream._id,
//         publishToken: mainStream.publishToken,
//         roomUrl: mainStream.roomUrl,
//         stream: liveStream,
//       };

//       res.status(201).json(responseData);
//     } catch (streamError) {
//       console.error('Stream generation error:', streamError);
//       // Clean up the created stream if LiveKit setup fails
//       await LiveStream.findByIdAndDelete(liveStream._id);
//       res.status(500).json({ msg: `Could not create live stream: ${streamError.message}` });
//     }
//   } catch (error) {
//     console.error('Create live stream error:', error);
//     res.status(500).json({ msg: `Could not create live stream: ${error.message}` });
//   }
// });

// // Add co-host
// router.post('/:streamId/add-cohost', authMiddleware, async (req, res) => {
//   try {
//     const { userId } = req.body;
//     const liveStream = await LiveStream.findById(req.params.streamId);

//     if (!liveStream) {
//       return res.status(404).json({ msg: 'Live stream not found' });
//     }

//     if (liveStream.streamer.toString() !== req.userId) {
//       return res.status(403).json({ msg: 'Not authorized' });
//     }

//     if (liveStream.streams.some((s) => s.user.toString() === userId)) {
//       return res.status(400).json({ msg: 'Already a host' });
//     }

//     const newStream = await generateStreamDetails(liveStream._id.toString(), userId);
//     liveStream.streams.push({
//       user: userId,
//       joinedAt: new Date(),
//       roomUrl: newStream.roomUrl,
//       roomSid: newStream.roomSid,
//     });

//     await liveStream.save();
//     await liveStream.populate('streamer', 'username avatar');
//     await liveStream.populate('streams.user', 'username avatar');

//     res.json({
//       msg: 'Co-host added',
//       stream: liveStream,
//       publishToken: newStream.publishToken,
//       roomUrl: newStream.roomUrl,
//     });
//   } catch (error) {
//     console.error('Add co-host error:', error);
//     res.status(500).json({ msg: 'Could not add co-host' });
//   }
// });

// // End a live stream
// router.post('/:streamId/end', authMiddleware, async (req, res) => {
//   try {
//     const liveStream = await LiveStream.findById(req.params.streamId);

//     if (!liveStream) {
//       return res.status(404).json({ msg: 'Live stream not found' });
//     }

//     if (liveStream.streamer.toString() !== req.userId) {
//       return res.status(403).json({ msg: 'Not authorized to end this stream' });
//     }

//     // Cleanup LiveKit rooms
//     for (const s of liveStream.streams) {
//       if (s.roomSid) {
//         await endLiveInput(s.roomSid);
//       }
//     }

//     liveStream.status = 'ended';
//     liveStream.endedAt = new Date();
//     liveStream.duration = Math.floor((Date.now() - liveStream.startedAt.getTime()) / 1000);

//     await liveStream.save();

//     res.json({
//       msg: 'Live stream ended successfully',
//       duration: liveStream.duration,
//     });
//   } catch (error) {
//     console.error('End live stream error:', error);
//     res.status(500).json({ msg: 'Could not end live stream' });
//   }
// });

// // Get viewer token for LiveKit - FIXED
// // router.get('/:streamId/token', async (req, res) => {
// //   try {
// //     const liveStream = await LiveStream.findById(req.params.streamId);
// //     if (!liveStream) {
// //       return res.status(404).json({ msg: 'Live stream not found' });
// //     }

// //     // Use the first stream's room for viewer token
// //     const mainStream = liveStream.streams[0];
// //     if (!mainStream) {
// //       return res.status(404).json({ msg: 'No active stream found' });
// //     }

// //     // Generate viewer token with the room name (streamId-userId format)
// //     const roomName = `${req.params.streamId}-${liveStream.streamer}`;
// //     const viewerId = req.headers.authorization ? 
// //       req.headers.authorization.replace('Bearer ', '') : 
// //       `viewer-${Date.now()}`;
    
// //     const viewerToken = generateViewerToken(roomName, viewerId);
    
// //     res.json({
// //       viewerToken,
// //       roomUrl: process.env.LIVEKIT_URL,
// //       roomName: roomName
// //     });
// //   } catch (error) {
// //     console.error('Get viewer token error:', error);
// //     res.status(500).json({ msg: 'Could not generate viewer token' });
// //   }
// // });
// // Add this test route to your liveRoutes.js
// router.get('/test-credentials', async (req, res) => {
//   try {
//     // Test token generation
//     const tokenTest = testTokenGeneration();
    
//     // Test LiveKit connection
//     const connectionTest = await testLiveKitConnection();
    
//     res.json({
//       tokenGeneration: tokenTest,
//       liveKitConnection: connectionTest,
//       message: 'Credential tests completed'
//     });
//   } catch (error) {
//     res.status(500).json({
//       error: error.message,
//       message: 'Credential test failed'
//     });
//   }
// });

// // Get all active live streams
// router.get('/', async (req, res) => {
//   try {
//     const { page = 1, limit = 20 } = req.query;

//     const liveStreams = await LiveStream.find({
//       status: 'live',
//       privacy: 'public',
//     })
//       .populate('streamer', 'username avatar')
//       .populate('streams.user', 'username avatar')
//       .sort({ startedAt: -1 })
//       .limit(limit * 1)
//       .skip((page - 1) * limit);

//     res.json(liveStreams);
//   } catch (error) {
//     console.error('Get live streams error:', error);
//     res.status(500).json({ msg: 'Could not fetch live streams' });
//   }
// });

// // In your liveRoutes.js, update the viewer token route
// router.get('/:streamId/token', async (req, res) => {
//   try {
//     const liveStream = await LiveStream.findById(req.params.streamId);
//     if (!liveStream) {
//       return res.status(404).json({ msg: 'Live stream not found' });
//     }

//     const mainStream = liveStream.streams[0];
//     if (!mainStream) {
//       return res.status(404).json({ msg: 'No active stream found' });
//     }

//     const roomName = `${req.params.streamId}-${liveStream.streamer}`;
//     const viewerId = req.headers.authorization ? 
//       req.headers.authorization.replace('Bearer ', '') : 
//       `viewer-${Date.now()}`;
    
//     const viewerToken = await generateViewerToken(roomName, viewerId); // Add await here
    
//     res.json({
//       viewerToken,
//       roomUrl: process.env.LIVEKIT_URL,
//       roomName: roomName
//     });
//   } catch (error) {
//     console.error('Get viewer token error:', error);
//     res.status(500).json({ msg: 'Could not generate viewer token' });
//   }
// });

// // Also update the specific stream route
// router.get('/:streamId', async (req, res) => {
//   try {
//     const liveStream = await LiveStream.findById(req.params.streamId)
//       .populate('streamer', 'username avatar')
//       .populate('streams.user', 'username avatar');

//     if (!liveStream) {
//       return res.status(404).json({ msg: 'Live stream not found' });
//     }

//     const roomName = `${req.params.streamId}-${liveStream.streamer._id}`;
//     const viewerId = req.headers.authorization ? 
//       req.headers.authorization.replace('Bearer ', '') : 
//       `viewer-${Date.now()}`;
    
//     try {
//       const viewerToken = await generateViewerToken(roomName, viewerId); // Add await here
//       liveStream._doc.viewerToken = viewerToken;
//       liveStream._doc.roomUrl = process.env.LIVEKIT_URL;
//     } catch (tokenError) {
//       console.error('Error generating viewer token:', tokenError);
//       // Continue without token - frontend can handle gracefully
//     }

//     res.json(liveStream);
//   } catch (error) {
//     console.error('Get live stream error:', error);
//     res.status(500).json({ msg: 'Could not fetch live stream' });
//   }
// });

// // Get live stream analytics
// router.get('/:streamId/analytics', authMiddleware, async (req, res) => {
//   try {
//     const liveStream = await LiveStream.findById(req.params.streamId)
//       .populate('streamer', 'username avatar')
//       .populate('streams.user', 'username avatar');

//     if (!liveStream) {
//       return res.status(404).json({ msg: 'Live stream not found' });
//     }

//     if (liveStream.streamer.toString() !== req.userId) {
//       return res.status(403).json({ msg: 'Not authorized to view analytics' });
//     }

//     res.json({
//       streamId: liveStream._id,
//       title: liveStream.title,
//       status: liveStream.status,
//       viewerCount: liveStream.viewers.length,
//       totalViews: liveStream.totalViews,
//       peakViewers: liveStream.peakViewers,
//       duration: liveStream.duration,
//       heartsReceived: liveStream.heartsReceived,
//       commentsCount: liveStream.comments.length,
//       startedAt: liveStream.startedAt,
//       endedAt: liveStream.endedAt,
//       streams: liveStream.streams,
//     });
//   } catch (error) {
//     console.error('Get analytics error:', error);
//     res.status(500).json({ msg: 'Could not fetch analytics' });
//   }
// });

// // Report a live stream
// router.post('/:streamId/report', authMiddleware, async (req, res) => {
//   try {
//     const { reason } = req.body;

//     if (!reason) {
//       return res.status(400).json({ msg: 'Report reason is required' });
//     }

//     const liveStream = await LiveStream.findById(req.params.streamId);

//     if (!liveStream) {
//       return res.status(404).json({ msg: 'Live stream not found' });
//     }

//     const existingReport = liveStream.reports.find(
//       (report) => report.reporter.toString() === req.userId
//     );

//     if (existingReport) {
//       return res.status(400).json({ msg: 'You have already reported this stream' });
//     }

//     liveStream.reports.push({
//       reporter: req.userId,
//       reason,
//       reportedAt: new Date(),
//     });

//     await liveStream.save();

//     res.json({ msg: 'Live stream reported successfully' });
//   } catch (error) {
//     console.error('Report live stream error:', error);
//     res.status(500).json({ msg: 'Could not report live stream' });
//   }
// });
// // Add new routes to liveRoutes.js

// // Add product to stream
// router.post('/:streamId/add-product', authMiddleware, async (req, res) => {
//   try {
//     const liveStream = await LiveStream.findById(req.params.streamId);
//     if (!liveStream) return res.status(404).json({ msg: 'Stream not found' });
//     if (liveStream.streamer.toString() !== req.userId) return res.status(403).json({ msg: 'Only host can add products' });
    
//     const product = {
//       ...req.body,
//       addedBy: req.userId
//     };
//     liveStream.products.push(product);
//     await liveStream.save();
    
//     res.json({ product, productIndex: liveStream.products.length - 1 });
//   } catch (error) {
//     res.status(500).json({ msg: 'Could not add product' });
//   }
// });

// // Place order
// router.post('/:streamId/place-order', authMiddleware, async (req, res) => {
//   try {
//     const { productIndex, quantity = 1 } = req.body;
//     const liveStream = await LiveStream.findById(req.params.streamId);
//     if (!liveStream) return res.status(404).json({ msg: 'Stream not found' });
//     if (productIndex < 0 || productIndex >= liveStream.products.length) return res.status(400).json({ msg: 'Invalid product' });
//     if (liveStream.products[productIndex].type !== 'product') return res.status(400).json({ msg: 'Can only order products' });
    
//     const order = {
//       productIndex,
//       buyer: req.userId,
//       quantity
//     };
//     liveStream.orders.push(order);
//     await liveStream.save();
    
//     res.json({ msg: 'Order placed' });
//   } catch (error) {
//     res.status(500).json({ msg: 'Could not place order' });
//   }
// });

// // Get all orders for a live stream
// router.get('/:streamId/orders', authMiddleware, async (req, res) => {
//   try {
//     const { streamId } = req.params;

//     // Find the live stream and populate buyer info
//     const liveStream = await LiveStream.findById(streamId)
//       .populate('orders.buyer', 'username avatar');

//     if (!liveStream) {
//       return res.status(404).json({ msg: 'Live stream not found' });
//     }

//     // Optional: Restrict access — only the streamer can see all orders
//     if (liveStream.streamer.toString() !== req.userId) {
//       return res.status(403).json({ msg: 'Not authorized to view orders' });
//     }

//     res.json({
//       orders: liveStream.orders || [],
//     });
//   } catch (error) {
//     console.error('Get orders error:', error);
//     res.status(500).json({ msg: 'Could not fetch orders' });
//   }
// });


// // Get user's coin balance
// router.get('/user/coin-balance', authMiddleware, async (req, res) => {
//   try {
//     const user = await User.findById(req.userId);
//     if (!user) return res.status(404).json({ msg: 'User not found' });
//     res.json({ balance: user.points || 0 });
//   } catch (error) {
//     console.error('Error fetching coin balance:', error);
//     res.status(500).json({ msg: 'Server error' });
//   }
// });


// // Purchase product with coins
// // router.post('/:streamId/purchase-with-coins', authMiddleware, async (req, res) => {
// //   try {
// //     const { streamId } = req.params;
// //     const { productIndex, coinCost } = req.body;

// //     // Validate stream and product
// //     const liveStream = await LiveStream.findById(streamId);
// //     if (!liveStream) return res.status(404).json({ msg: 'Stream not found' });
// //     if (productIndex < 0 || productIndex >= liveStream.products.length) {
// //       return res.status(400).json({ msg: 'Invalid product' });
// //     }
// //     if (liveStream.products[productIndex].type !== 'product') {
// //       return res.status(400).json({ msg: 'Can only purchase products' });
// //     }

// //     // Validate user's coin balance
// //     const user = await User.findById(req.userId);
// //     if (!user) return res.status(404).json({ msg: 'User not found' });
// //     if (user.points < coinCost) {
// //       return res.status(400).json({ msg: 'Insufficient coins' });
// //     }

// //     // Deduct coins from user and credit to live stream
// //     user.points -= coinCost;
// //     await user.save();

// //     liveStream.points = (liveStream.points || 0) + coinCost;
    
// //     // Record the order
// //     const order = {
// //       productIndex,
// //       buyer: req.userId,
// //       quantity: 1,
// //       status: 'completed', // Since payment is already processed
// //       orderedAt: new Date()
// //     };
// //     liveStream.orders.push(order);
// //     await liveStream.save();

// //     res.json({ msg: 'Purchase successful' });
// //   } catch (error) {
// //     console.error('Purchase error:', error);
// //     res.status(500).json({ msg: 'Failed to complete purchase' });
// //   }
// // });

// // Update the purchase-with-coins route in liveRoutes.js
// router.post('/:streamId/purchase-with-coins', authMiddleware, async (req, res) => {
//   try {
//     const { streamId } = req.params;
//     const { productIndex, coinCost } = req.body;

//     // Validate stream and product
//     const liveStream = await LiveStream.findById(streamId)
//       .populate('streamer', 'username avatar');
    
//     if (!liveStream) return res.status(404).json({ msg: 'Stream not found' });
    
//     if (productIndex < 0 || productIndex >= liveStream.products.length) {
//       return res.status(400).json({ msg: 'Invalid product' });
//     }
    
//     if (liveStream.products[productIndex].type !== 'product') {
//       return res.status(400).json({ msg: 'Can only purchase products' });
//     }

//     // Validate user's coin balance
//     const user = await User.findById(req.userId);
//     if (!user) return res.status(404).json({ msg: 'User not found' });
//     if (user.points < coinCost) {
//       return res.status(400).json({ msg: 'Insufficient coins' });
//     }

//     // Deduct coins from buyer
//     user.points -= coinCost;
//     await user.save();

//     // ADD POINTS TO HOST
//     const streamer = await User.findById(liveStream.streamer._id);
//     if (streamer) {
//       streamer.points = (streamer.points || 0) + coinCost;
//       await streamer.save();
//     }

//     // Update stream points
//     liveStream.points = (liveStream.points || 0) + coinCost;
    
//     // Record the order with buyer info
//     const order = {
//       productIndex,
//       buyer: req.userId,
//       quantity: 1,
//       status: 'completed',
//       orderedAt: new Date()
//     };
//     liveStream.orders.push(order);
//     await liveStream.save();

//     // Populate the order with buyer details for response
//     const populatedStream = await liveStream.populate('orders.buyer', 'username avatar');
//     const newOrder = populatedStream.orders[populatedStream.orders.length - 1];

//     // EMIT SOCKET EVENT to notify host
//     // const { getIO } = await import('../socket.js');
//     try {
//       const io = getIO();
//       io.to(`stream-${streamId}`).emit('new-order', {
//         order: newOrder,
//         product: liveStream.products[productIndex],
//         buyerUsername: user.username,
//         streamerEarnings: coinCost,
//         totalEarnings: liveStream.points
//       });

//       // Notify the streamer specifically about coin update
//       io.to(`user-${liveStream.streamer._id}`).emit('coins-updated', {
//         coinBalance: streamer.points,
//         earnedAmount: coinCost,
//         streamId: streamId
//       });
//     } catch (socketError) {
//       console.error('Socket emission error:', socketError);
//       // Continue even if socket fails
//     }

//     res.json({ 
//       msg: 'Purchase successful',
//       order: newOrder,
//       streamerEarnings: coinCost,
//       totalEarnings: liveStream.points
//     });
//   } catch (error) {
//     console.error('Purchase error:', error);
//     res.status(500).json({ msg: 'Failed to complete purchase' });
//   }
// });


// export default router;


import express from 'express';
import LiveStream from '../models/LiveStream.js';
import User from '../models/User.js';
import authMiddleware from '../middleware/auth.js';
import { generateStreamDetails, endLiveInput, generateViewerToken, testLiveKitConnection, testTokenGeneration } from '../utils/streaming.js';
import { getIO } from '../utils/socket.js';

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
      points: 0, // Initialize points for this stream
    });

    await liveStream.save();

    try {
      const mainStream = await generateStreamDetails(liveStream._id.toString(), req.userId);
      console.log('Main stream details:', mainStream);

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

router.get('/test-credentials', async (req, res) => {
  try {
    const tokenTest = testTokenGeneration();
    const connectionTest = await testLiveKitConnection();
    
    res.json({
      tokenGeneration: tokenTest,
      liveKitConnection: connectionTest,
      message: 'Credential tests completed'
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      message: 'Credential test failed'
    });
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

router.get('/:streamId/token', async (req, res) => {
  try {
    const liveStream = await LiveStream.findById(req.params.streamId);
    if (!liveStream) {
      return res.status(404).json({ msg: 'Live stream not found' });
    }

    const mainStream = liveStream.streams[0];
    if (!mainStream) {
      return res.status(404).json({ msg: 'No active stream found' });
    }

    const roomName = `${req.params.streamId}-${liveStream.streamer}`;
    const viewerId = req.headers.authorization ? 
      req.headers.authorization.replace('Bearer ', '') : 
      `viewer-${Date.now()}`;
    
    const viewerToken = await generateViewerToken(roomName, viewerId);
    
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

// Get specific stream
router.get('/:streamId', async (req, res) => {
  try {
    const liveStream = await LiveStream.findById(req.params.streamId)
      .populate('streamer', 'username avatar')
      .populate('streams.user', 'username avatar');

    if (!liveStream) {
      return res.status(404).json({ msg: 'Live stream not found' });
    }

    const roomName = `${req.params.streamId}-${liveStream.streamer._id}`;
    const viewerId = req.headers.authorization ? 
      req.headers.authorization.replace('Bearer ', '') : 
      `viewer-${Date.now()}`;
    
    try {
      const viewerToken = await generateViewerToken(roomName, viewerId);
      liveStream._doc.viewerToken = viewerToken;
      liveStream._doc.roomUrl = process.env.LIVEKIT_URL;
    } catch (tokenError) {
      console.error('Error generating viewer token:', tokenError);
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
      streamEarnings: liveStream.points, // Stream-specific earnings
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

// Add product to stream
router.post('/:streamId/add-product', authMiddleware, async (req, res) => {
  try {
    const liveStream = await LiveStream.findById(req.params.streamId);
    if (!liveStream) return res.status(404).json({ msg: 'Stream not found' });
    if (liveStream.streamer.toString() !== req.userId) return res.status(403).json({ msg: 'Only host can add products' });
    
    const product = {
      ...req.body,
      addedBy: req.userId
    };
    liveStream.products.push(product);
    await liveStream.save();
    
    // Emit socket event to all viewers watching this stream
    try {
      const io = getIO();
      io.to(`stream-${req.params.streamId}`).emit('product-added', {
        product: product,
        productIndex: liveStream.products.length - 1,
        streamId: req.params.streamId
      });
    } catch (socketError) {
      console.error('Socket emission error:', socketError);
    }
    
    res.json({ product, productIndex: liveStream.products.length - 1 });
  } catch (error) {
    res.status(500).json({ msg: 'Could not add product' });
  }
});

// Place order
router.post('/:streamId/place-order', authMiddleware, async (req, res) => {
  try {
    const { productIndex, quantity = 1 } = req.body;
    const liveStream = await LiveStream.findById(req.params.streamId);
    if (!liveStream) return res.status(404).json({ msg: 'Stream not found' });
    if (productIndex < 0 || productIndex >= liveStream.products.length) return res.status(400).json({ msg: 'Invalid product' });
    if (liveStream.products[productIndex].type !== 'product') return res.status(400).json({ msg: 'Can only order products' });
    
    const order = {
      productIndex,
      buyer: req.userId,
      quantity
    };
    liveStream.orders.push(order);
    await liveStream.save();
    
    res.json({ msg: 'Order placed' });
  } catch (error) {
    res.status(500).json({ msg: 'Could not place order' });
  }
});

// Get all orders for a live stream
router.get('/:streamId/orders', authMiddleware, async (req, res) => {
  try {
    const { streamId } = req.params;

    const liveStream = await LiveStream.findById(streamId)
      .populate('orders.buyer', 'username avatar');

    if (!liveStream) {
      return res.status(404).json({ msg: 'Live stream not found' });
    }

    if (liveStream.streamer.toString() !== req.userId) {
      return res.status(403).json({ msg: 'Not authorized to view orders' });
    }

    res.json({
      orders: liveStream.orders || [],
    });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ msg: 'Could not fetch orders' });
  }
});

// Get user's coin balance
router.get('/user/coin-balance', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ msg: 'User not found' });
    res.json({ balance: user.points || 0 });
  } catch (error) {
    console.error('Error fetching coin balance:', error);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Purchase product with coins
router.post('/:streamId/purchase-with-coins', authMiddleware, async (req, res) => {
  try {
    const { streamId } = req.params;
    const { productIndex, coinCost, deliveryInfo } = req.body;

    const liveStream = await LiveStream.findById(streamId)
      .populate('streamer', 'username avatar');
    
    if (!liveStream) return res.status(404).json({ msg: 'Stream not found' });
    
    if (productIndex < 0 || productIndex >= liveStream.products.length) {
      return res.status(400).json({ msg: 'Invalid product' });
    }
    
    if (liveStream.products[productIndex].type !== 'product') {
      return res.status(400).json({ msg: 'Can only purchase products' });
    }

    // Validate delivery info
    if (!deliveryInfo || !deliveryInfo.firstName || !deliveryInfo.lastName || !deliveryInfo.email || 
        !deliveryInfo.phone || !deliveryInfo.address || !deliveryInfo.city || !deliveryInfo.state || 
        !deliveryInfo.zipCode || !deliveryInfo.country) {
      return res.status(400).json({ msg: 'Complete delivery information is required' });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ msg: 'User not found' });
    if (user.points < coinCost) {
      return res.status(400).json({ msg: 'Insufficient coins' });
    }

    // Deduct coins from buyer
    user.points -= coinCost;
    await user.save();

    // Add points to host
    const streamer = await User.findById(liveStream.streamer._id);
    if (streamer) {
      streamer.points = (streamer.points || 0) + coinCost;
      await streamer.save();
    }

    // Update stream points (stream-specific earnings)
    liveStream.points = (liveStream.points || 0) + coinCost;
    
    // Record the order with delivery info
    const order = {
      productIndex,
      buyer: req.userId,
      quantity: 1,
      status: 'completed',
      orderedAt: new Date(),
      deliveryInfo: {
        firstName: deliveryInfo.firstName,
        lastName: deliveryInfo.lastName,
        email: deliveryInfo.email,
        phone: deliveryInfo.phone,
        address: deliveryInfo.address,
        city: deliveryInfo.city,
        state: deliveryInfo.state,
        zipCode: deliveryInfo.zipCode,
        country: deliveryInfo.country
      }
    };
    liveStream.orders.push(order);
    await liveStream.save();

    const populatedStream = await liveStream.populate('orders.buyer', 'username avatar');
    const newOrder = populatedStream.orders[populatedStream.orders.length - 1];

    try {
      const io = getIO();
      
      // Emit to host about the new order with delivery info
      io.to(`stream-${streamId}`).emit('new-order', {
        order: newOrder,
        product: liveStream.products[productIndex],
        buyerUsername: user.username,
        streamerEarnings: coinCost,
        totalEarnings: liveStream.points,
        deliveryInfo: order.deliveryInfo,
        streamId: streamId
      });

      // Notify the streamer specifically about coin update for this stream
      io.to(`user-${liveStream.streamer._id}`).emit('coins-updated', {
        coinBalance: streamer.points,
        earnedAmount: coinCost,
        streamEarnings: liveStream.points,
        streamId: streamId
      });
    } catch (socketError) {
      console.error('Socket emission error:', socketError);
    }

    res.json({ 
      msg: 'Purchase successful',
      order: newOrder,
      streamerEarnings: coinCost,
      totalEarnings: liveStream.points
    });
  } catch (error) {
    console.error('Purchase error:', error);
    res.status(500).json({ msg: 'Failed to complete purchase' });
  }
});

export default router;