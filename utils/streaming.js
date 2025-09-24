import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

const LIVEKIT_URL = "wss://theclipstream-q0jt88zr.livekit.cloud";
const LIVEKIT_API_KEY = "APIQNh9qgZftA9E";
const LIVEKIT_API_SECRET = "jMHFq7jtcmmuXVsdpuTZInYpSrX12vPvVsc9p9x2vML";

// Validate and clean URL
const validateLiveKitURL = (url) => {
  if (!url) return null;
  
  // Remove extra characters and validate format
  const cleanUrl = url.trim();
  
  if (!cleanUrl.startsWith('wss://') && !cleanUrl.startsWith('ws://')) {
    throw new Error(`Invalid LiveKit URL format: ${cleanUrl}`);
  }
  
  // Check for common typos
  if (cleanUrl.includes('.cloude') || cleanUrl.includes('.cluod')) {
    throw new Error(`Possible typo in LiveKit URL: ${cleanUrl}. Should end with .livekit.cloud`);
  }
  
  return cleanUrl;
};

// Debug function to test credentials
export const debugCredentials = () => {
  console.log('=== LiveKit Credentials Debug ===');
  console.log('LIVEKIT_URL:', LIVEKIT_URL ? `${LIVEKIT_URL.substring(0, 20)}...` : 'MISSING');
  console.log('LIVEKIT_API_KEY length:', LIVEKIT_API_KEY ? LIVEKIT_API_KEY.length : 0);
  console.log('LIVEKIT_API_SECRET length:', LIVEKIT_API_SECRET ? LIVEKIT_API_SECRET.length : 0);
  console.log('LIVEKIT_API_KEY starts with:', LIVEKIT_API_KEY ? LIVEKIT_API_KEY.substring(0, 8) + '...' : 'MISSING');
  console.log('LIVEKIT_API_SECRET starts with:', LIVEKIT_API_SECRET ? LIVEKIT_API_SECRET.substring(0, 8) + '...' : 'MISSING');
  console.log('================================');
};

export const generateStreamDetails = async (streamId, userId) => {
  try {
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      throw new Error('Missing LiveKit environment variables');
    }

    const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const roomName = `${streamId}-${userId}`;

    const room = await roomService.createRoom({
      name: roomName,
      emptyTimeout: 300,
      maxParticipants: 100,
    });

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

    return {
      roomUrl: LIVEKIT_URL,
      roomSid: room.sid,
      publishToken: publishToken,
    };
  } catch (error) {
    console.error('LiveKit error:', error);
    throw new Error(`Failed to create live stream: ${error.message}`);
  }
};

export const endLiveInput = async (roomSid) => {
  try {
    const validatedUrl = validateLiveKitURL(LIVEKIT_URL);
    const roomService = new RoomServiceClient(validatedUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
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
    console.log('Generated viewerToken successfully, length:', viewerToken.length);
    return viewerToken;
  } catch (error) {
    console.error('LiveKit viewer token error:', error);
    throw new Error(`Failed to generate viewer token: ${error.message}`);
  }
};

// Simple test to verify token generation works
export const testTokenGeneration = () => {
  try {
    console.log('Testing token generation...');
    
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      throw new Error('Missing API credentials');
    }
    
    const testToken = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: 'test-user',
    });
    
    testToken.addGrant({
      roomJoin: true,
      room: 'test-room',
      canPublish: true,
      canSubscribe: true,
    });
    
    const jwt = testToken.toJwt();
    console.log('Test token generated successfully:', !!jwt);
    console.log('Test token length:', jwt.length);
    return true;
  } catch (error) {
    console.error('Token generation test failed:', error);
    return false;
  }
};
export const testLiveKitConnection = async () => {
  try {
    if (!LIVEKIT_URL) {
      throw new Error('LIVEKIT_URL not configured');
    }
    
    const validatedUrl = validateLiveKitURL(LIVEKIT_URL);
    const roomService = new RoomServiceClient(validatedUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    
    // Try to list rooms as a connectivity test
    await roomService.listRooms();
    console.log('LiveKit connectivity test passed');
    return true;
  } catch (error) {
    console.error('LiveKit connectivity test failed:', error);
    return false;
  }
};