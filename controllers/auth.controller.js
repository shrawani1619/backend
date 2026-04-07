import jwt from 'jsonwebtoken';
import User from '../models/user.model.js';
import { JWT_SECRET, JWT_EXPIRE } from '../config/env.js';
import { generateSessionId } from '../utils/session.js';

/**
 * Generate JWT Token
 */
const generateToken = (userId, role, sessionId) => {
  return jwt.sign({ userId, role, sessionId }, JWT_SECRET, {
    expiresIn: JWT_EXPIRE || '1h',
  });
};

const isTokenStillValid = (token) => {
  try {
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch (_) {
    return false;
  }
};

const forwardOrRespondError = (next, res, error) => {
  if (typeof next === 'function') return next(error);
  return res.status(500).json({
    success: false,
    message: error?.message || 'Internal server error',
  });
};

/**
 * Get cookie expiration time in milliseconds
 */
const getCookieExpiration = () => {
  if (!JWT_EXPIRE) {
    return 7 * 24 * 60 * 60 * 1000; // 7 days default
  }

  // Parse JWT_EXPIRE format (e.g., "7d", "30d", "1h", etc.)
  const match = JWT_EXPIRE.match(/^(\d+)([dhms])$/);
  if (match) {
    const value = parseInt(match[1]);
    const unit = match[2];
    
    switch (unit) {
      case 'd':
        return value * 24 * 60 * 60 * 1000;
      case 'h':
        return value * 60 * 60 * 1000;
      case 'm':
        return value * 60 * 1000;
      case 's':
        return value * 1000;
      default:
        return 7 * 24 * 60 * 60 * 1000;
    }
  }

  // If it's just a number, assume days
  const days = parseInt(JWT_EXPIRE);
  return isNaN(days) ? 7 * 24 * 60 * 60 * 1000 : days * 24 * 60 * 60 * 1000;
};

/**
 * Login User (Unified)
 */
export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password',
      });
    }

    // Normalize email to lowercase
    const normalizedEmail = email.toLowerCase().trim();

    console.log('🔍 Login attempt for email:', normalizedEmail);

    // Find user and include password field
    let user = await User.findOne({ email: normalizedEmail }).select('+password +sessionToken +sessionId');

    // If not found in User collection, check old Agent collection (for backward compatibility)
    if (!user) {
      try {
        const Agent = (await import('../models/agent.model.js')).default;
        const oldAgent = await Agent.findOne({ email: normalizedEmail }).select('+password');
        
        if (oldAgent) {
          console.log('⚠️ Found agent in old collection, migrating to User model...');
          
          // Check password first
          const isPasswordValid = await oldAgent.comparePassword(password);
          if (!isPasswordValid) {
            return res.status(401).json({
              success: false,
              message: 'Invalid credentials',
            });
          }

          // Check status
          if (oldAgent.status !== 'active') {
            return res.status(403).json({
              success: false,
              message: `Account is ${oldAgent.status}. Please contact administrator to activate your account.`,
            });
          }

          // Migrate agent to User model
          user = await User.create({
            name: oldAgent.name,
            email: oldAgent.email,
            mobile: oldAgent.mobile,
            password: password, // Store as plain text in new model
            role: 'agent',
            franchise: oldAgent.franchise,
            commissionPercentage: oldAgent.commissionPercentage || 0,
            kyc: oldAgent.kyc || {},
            bankDetails: oldAgent.bankDetails || {},
            status: oldAgent.status,
            lastLoginAt: new Date(),
          });

          console.log('✅ Agent migrated successfully');
        }
      } catch (migrationError) {
        console.error('Migration error:', migrationError);
        // Continue with normal flow
      }
    }

    if (!user) {
      console.log('❌ User not found');
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
      });
    }

    console.log('✅ User found:', {
      id: user._id,
      email: user.email,
      role: user.role,
      status: user.status,
      passwordStored: user.password ? (user.password.substring(0, 10) + '...') : 'not found',
    });

    // Check if user is active - provide specific message
    if (user.status !== 'active') {
      console.log('❌ Account is not active:', user.status);
      return res.status(403).json({
        success: false,
        message: `Account is ${user.status}. Please contact administrator to activate your account.`,
      });
    }

    // Check password
    console.log('🔐 Checking password...');
    const isPasswordValid = await user.comparePassword(password);
    console.log('🔐 Password valid:', isPasswordValid);

    if (!isPasswordValid) {
      console.log('❌ Invalid password');
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
      });
    }

    // Enforce single active session per user:
    // - When logging in from a new device/browser, invalidate any previous session immediately.
    if (user.isLoggedIn) {
      user.isLoggedIn = false;
      user.sessionToken = null;
      user.sessionId = null;
      user.lastActivity = null;
      user.lastActive = null;
    }

    // Generate a unique sessionId for this login
    const sessionId = generateSessionId();

    // Generate JWT token (includes sessionId payload)
    const token = generateToken(user._id, user.role, sessionId);

    // Mark active session and update activity timestamps
    user.isLoggedIn = true;
    user.sessionId = sessionId;
    // Keep legacy field for backward compatibility with any older middleware/token usage
    user.sessionToken = token;
    user.lastLoginAt = new Date();
    user.lastActivity = new Date();
    user.lastActive = user.lastActivity;
    await user.save();

    // Set cookie
    const cookieOptions = {
      expires: new Date(Date.now() + getCookieExpiration()),
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
    };

    res.cookie('token', token, cookieOptions);

    // Exclude password from response
    const userResponse = await User.findById(user._id).select('-password').populate('franchise', 'name');

    console.log('✅ Login successful for:', user.email);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: userResponse,
      token,
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    return forwardOrRespondError(next, res, error);
  }
};

/**
 * Logout
 */
export const logout = async (req, res, next) => {
  try {
    // Clear DB-backed active session
    await User.findByIdAndUpdate(req.user._id, {
      $set: {
        isLoggedIn: false,
        sessionId: null,
        sessionToken: null,
        lastActivity: null,
        lastActive: null,
      },
    });

    res.cookie('token', '', {
      expires: new Date(0),
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
    });

    res.status(200).json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    return forwardOrRespondError(next, res, error);
  }
};

/**
 * Get Current User
 */
export const getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id)
      .select('-password')
      .populate('franchise', 'name')
      .populate('managedBy', 'name email phone mobile address status');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    res.status(200).json({
      success: true,
      data: user,
    });
  } catch (error) {
    return forwardOrRespondError(next, res, error);
  }
};

/**
 * Signup - Public registration
 */
export const signup = async (req, res, next) => {
  try {
    const { name, email, mobile, password, role, franchise, kyc, bankDetails } = req.body;

    // Validate required fields
    if (!name || !email || !mobile || !password || !role) {
      return res.status(400).json({
        success: false,
        message: 'Please provide name, email, mobile, password, and role',
      });
    }

    // Validate role
    const validRoles = ['super_admin', 'regional_manager', 'relationship_manager', 'franchise', 'agent', 'accounts_manager'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid role. Valid roles are: ' + validRoles.join(', '),
      });
    }

    // Check if franchise is required for this role
    const rolesRequiringFranchise = ['agent', 'franchise'];
    if (rolesRequiringFranchise.includes(role) && !franchise) {
      return res.status(400).json({
        success: false,
        message: `Franchise is required for ${role} role`,
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email }, { mobile }],
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User with this email or mobile already exists',
      });
    }

    // Verify franchise exists and is active (if provided)
    if (franchise) {
      const Franchise = (await import('../models/franchise.model.js')).default;
      const franchiseExists = await Franchise.findById(franchise);

      if (!franchiseExists || franchiseExists.status !== 'active') {
        return res.status(400).json({
          success: false,
          message: 'Invalid or inactive franchise',
        });
      }
    }

    // Create new user (status will be inactive until approved)
    const userData = {
      name,
      email,
      mobile,
      password,
      role,
      status: 'inactive', // Requires admin/franchise owner approval
      kyc: kyc || {},
      bankDetails: bankDetails || {},
    };

    // Add franchise if provided
    if (franchise) {
      userData.franchise = franchise;
    }

    // For franchise role, also set franchiseOwned
    if (role === 'franchise' && franchise) {
      userData.franchiseOwned = franchise;
    }

    const user = await User.create(userData);

    // Generate token for auto-login.
    // Note: user status is typically "inactive" after signup, but we still include
    // sessionId in the JWT payload so the auth middleware can validate payload shape.
    const sessionId = generateSessionId();
    user.sessionId = sessionId;
    await user.save();

    const token = generateToken(user._id, user.role, sessionId);

    // Set cookie
    const cookieOptions = {
      expires: new Date(Date.now() + getCookieExpiration()),
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
    };

    res.cookie('token', token, cookieOptions);

    // Exclude password from response
    const userResponse = await User.findById(user._id).select('-password').populate('franchise', 'name');

    res.status(201).json({
      success: true,
      message: 'Registration successful. Your account is pending approval.',
      data: userResponse,
      token,
    });
  } catch (error) {
    return forwardOrRespondError(next, res, error);
  }
};

/**
 * Update Profile
 */
export const updateProfile = async (req, res, next) => {
  try {
    const { name, email, mobile, phone, profileImage } = req.body;
    const userId = req.user._id;

    // Build update object
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;
    if (mobile !== undefined) updateData.mobile = mobile;
    if (phone !== undefined) updateData.phone = phone;
    if (profileImage !== undefined) updateData.profileImage = profileImage;

    // Update user
    const user = await User.findByIdAndUpdate(
      userId,
      updateData,
      {
        new: true,
        runValidators: true,
      }
    ).select('-password').populate('franchise', 'name');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: user,
    });
  } catch (error) {
    return forwardOrRespondError(next, res, error);
  }
};

/**
 * Change Password
 */
export const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Please provide current and new password',
      });
    }

    // Get user with password
    const user = await User.findById(req.user._id).select('+password +sessionToken +sessionId');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Verify current password
    const isPasswordValid = await user.comparePassword(currentPassword);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect',
      });
    }

    // Update password
    user.password = newPassword;
    // Security: invalidate all sessions when password is changed.
    user.isLoggedIn = false;
    user.sessionId = null;
    user.sessionToken = null;
    user.lastActivity = null;
    user.lastActive = null;
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Password changed successfully. Please login again.',
    });
  } catch (error) {
    return forwardOrRespondError(next, res, error);
  }
};
