import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import dotenv from 'dotenv';
dotenv.config();

const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = process.env;

export function createJoinToken(roomName, identity, isRecorder = false, ttlSeconds = 60 * 60) {
  // create AccessToken
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity
  });

  // grant join room + permission to publish & subscribe
  const grants = { room: roomName };
  at.addGrant(grants);
  at.ttl = ttlSeconds;
  return at.toJwt();
}

// Optionally: create room via REST API (RoomServiceClient)
export async function ensureRoom(roomName) {
  if (!LIVEKIT_URL) throw new Error('LIVEKIT_URL not set');
  const svc = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  try {
    // create or return existing
    await svc.createRoom({ name: roomName });
  } catch (e) {
    // ignore if exists
    if (!/already exists/i.test(e.message)) {
      console.warn('ensureRoom error', e.message);
    }
  }
}
