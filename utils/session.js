import crypto from 'crypto';

/**
 * Generate a cryptographically-strong session identifier.
 * Stored in MongoDB and also embedded in the JWT payload.
 */
export const generateSessionId = () => crypto.randomBytes(32).toString('hex');

/**
 * Session inactivity timeout (defaults to 10 minutes).
 * Env options:
 * - SESSION_INACTIVITY_MS (number, takes precedence)
 * - SESSION_INACTIVITY_MINUTES (number)
 */
export const getSessionInactivityMs = () => {
  const msFromEnv = process.env.SESSION_INACTIVITY_MS;
  if (msFromEnv) {
    const ms = Number(msFromEnv);
    if (!Number.isNaN(ms) && ms > 0) return ms;
  }

  const minutesFromEnv = process.env.SESSION_INACTIVITY_MINUTES;
  const minutes = minutesFromEnv ? Number(minutesFromEnv) : 10;
  if (!Number.isNaN(minutes) && minutes > 0) return minutes * 60 * 1000;

  return 10 * 60 * 1000;
};

