import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

const LIVEKIT_URL = "wss://theclipstream-q0jt88zr.livekit.cloude";
const LIVEKIT_API_KEY = "APIQNh9qgZftA9E";
const LIVEKIT_API_SECRET = "jMHFq7jtcmmuXVsdpuTZInYpSrX12vPvVsc9p9x2vML";

export const generateStreamDetails = async (streamId, userId) => {
  try {
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      throw new Error('Missing LiveKit environment variables');
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
    const publishToken = at.toJwt();
    
    // Validate token before returning
    if (!publishToken || typeof publishToken !== 'string') {
      throw new Error('Generated token is invalid');
    }
    
    console.log('Generated publishToken:', publishToken);

    return {
      roomUrl: LIVEKIT_URL,
      roomSid: room.sid, // This should now work
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
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: userId || `viewer-${Date.now()}`,
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

// Add this test function to verify your LiveKit server
export const testLiveKitConnection = async () => {
  try {
    const response = await fetch(LIVEKIT_URL.replace('wss://', 'https://'), {
      method: 'HEAD',
    });
    console.log('LiveKit server status:', response.status);
    return response.ok;
  } catch (error) {
    console.error('LiveKit server unreachable:', error);
    return false;
  }
};