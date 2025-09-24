import { AccessToken, RoomServiceClient } from '@livekit/server-sdk';

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

export const generateStreamDetails = async (streamId, userId) => {
  try {
    const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const roomName = `${streamId}-${userId}`;

    // Create LiveKit room
    const room = await roomService.createRoom({
      name: roomName,
      emptyTimeout: 300, // Auto-close after 5min idle
      maxParticipants: 100,
    });

    // Generate publisher token
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: userId,
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });

    return {
      roomUrl: LIVEKIT_URL, // WebRTC URL for publishers/viewers
      roomSid: room.sid, // For cleanup
      publishToken: at.toJwt(), // Token for publishing
    };
  } catch (error) {
    console.error('LiveKit stream creation error:', error);
    throw new Error('Failed to create live stream');
  }
};

export const endLiveInput = async (roomSid) => {
  try {
    const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    await roomService.deleteRoom(roomSid);
    console.log(`LiveKit room ${roomSid} deleted`);
  } catch (error) {
    console.error('Error ending LiveKit room:', error);
  }
};

export const generateViewerToken = (roomName, userId) => {
  try {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: userId || `viewer-${Date.now()}`,
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: false,
      canSubscribe: true,
    });
    return at.toJwt();
  } catch (error) {
    console.error('LiveKit viewer token error:', error);
    throw new Error('Failed to generate viewer token');
  }
};