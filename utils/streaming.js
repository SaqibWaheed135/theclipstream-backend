import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

export const generateStreamDetails = async (streamId, userId) => {
  try {
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      throw new Error(`Missing LiveKit environment variables: URL=${LIVEKIT_URL}, API_KEY=${LIVEKIT_API_KEY}`);
    }

    const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const roomName = `${streamId}-${userId}`;
    console.log('Creating LiveKit room with name:', roomName);

    // Create LiveKit room
    const room = await roomService.createRoom({
      name: roomName,
      emptyTimeout: 300,
      maxParticipants: 100,
    });
    console.log('Room created with SID:', room.sid);

    // Generate publisher token
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: userId.toString(), // Ensure string identity
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });
    const publishToken = at.toJwt();
    if (!publishToken || typeof publishToken !== 'string') {
      throw new Error('Failed to generate valid publishToken');
    }
    console.log('Generated publishToken:', publishToken);

    return {
      roomUrl: LIVEKIT_URL,
      roomSid: room.sid,
      publishToken: publishToken,
    };
  } catch (error) {
    console.error('LiveKit stream creation error:', error);
    throw new Error(`Failed to create live stream: ${error.message}`);
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
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      throw new Error('Missing LiveKit API credentials');
    }
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: userId ? userId.toString() : `viewer-${Date.now()}`,
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: false,
      canSubscribe: true,
    });
    const viewerToken = at.toJwt();
    console.log('Generated viewerToken:', viewerToken);
    return viewerToken;
  } catch (error) {
    console.error('LiveKit viewer token error:', error);
    throw new Error(`Failed to generate viewer token: ${error.message}`);
  }
};