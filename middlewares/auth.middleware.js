import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/env.js';
import User from '../models/user.model.js';

const SESSION_INACTIVITY_MS = Number(process.env.SESSION_INACTIVITY_MS || 30 * 60 * 1000);

/**
 * Protect routes - Verify JWT token from cookies or Authorization header
 */
export const authenticate = async (req, res, next) => {
  try {
    let token;

    // Get token from cookies, Authorization header, or query param (for file downloads via window.open)
    if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    } else if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.query?.token) {
      token = req.query.token;
    }

    // Make sure token exists
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized to access this route',
      });
    }

    try {
      // Verify token
      const decoded = jwt.verify(token, JWT_SECRET);

      // Check if user still exists (using unified User model)
      const user = await User.findById(decoded.userId).select('+sessionToken');

      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'User no longer exists',
        });
      }

      // Check if user is active
      if (user.status !== 'active') {
        return res.status(403).json({
          success: false,
          message: 'Account is not active',
        });
      }

      // Enforce single active session via token match
      if (!user.isLoggedIn || !user.sessionToken || user.sessionToken !== token) {
        return res.status(401).json({
          success: false,
          message: 'Session expired or logged in from another device',
        });
      }

      // Optional idle-timeout auto logout
      if (user.lastActive && Date.now() - new Date(user.lastActive).getTime() > SESSION_INACTIVITY_MS) {
        user.isLoggedIn = false;
        user.sessionToken = null;
        await user.save();
        return res.status(401).json({
          success: false,
          message: 'Session expired due to inactivity',
        });
      }

      // Track activity timestamp on successful authenticated request
      user.lastActive = new Date();
      await user.save();

      // Attach full user object to request
      req.user = user;
      
      // Debug log for role verification
      console.log(`User ${user.email} authenticated with role: ${user.role}`);

      next();
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized to access this route',
      });
    }
  } catch (error) {
    next(error);
  }
};

/**
 * Optional auth - sets req.user when a valid token is present, does not 401 when missing/invalid.
 * Use for routes that behave differently for logged-in users (e.g. scoped franchise list).
 */
export const optionalAuthenticate = async (req, res, next) => {
  try {
    let token;
    if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    } else if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return next();
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.userId).select('+sessionToken');
      const isValidSession = user && user.status === 'active' && user.isLoggedIn && user.sessionToken === token;
      if (isValidSession) req.user = user;
    } catch (_) { /* ignore invalid token */ }
    next();
  } catch (error) {
    next(error);
  }
};
