import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

/**
 * Unified User Model
 * Consolidates Agent and Staff into a single user model with role-based access control
 * Supports: super_admin, relationship_manager, regional_manager, franchise, agent, accounts_manager
 */
const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      lowercase: true,
      unique: true,
      index: true,
    },

    mobile: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    phone: {
      type: String,
      sparse: true,
    },

    profileImage: {
      type: String,
      default: null,
    },

    password: {
      type: String,
      // Password is not required for sub-agents (they don't log in)
      required: function () {
        return !this.parentAgent; // Not required if parentAgent exists (sub-agent)
      },
      select: false,
    },

    // Single active session controls
    isLoggedIn: {
      type: Boolean,
      default: false,
      index: true,
    },
    sessionToken: {
      type: String,
      default: null,
      select: false,
    },

    role: {
      type: String,
      enum: [
        'super_admin',
        'regional_manager',
        'franchise',
        'relationship_manager',
        'agent',
        'accounts_manager',
      ],
      required: true,
      index: true,
    },

    // Role-specific fields
    // For franchise owners (kept for backward compatibility)
    franchise: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Franchise',
      // franchise field is required for users with role 'franchise' (franchise owner)
      required: function () {
        return this.role === 'franchise';
      },
    },

    // Flexible owner for agents: can be a Franchise or a RelationshipManager.
    // Uses dynamic ref via refPath.
    managedBy: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: 'managedByModel',
      required: function () {
        return this.role === 'agent';
      },
      index: true,
    },
    managedByModel: {
      type: String,
      enum: ['Franchise', 'RelationshipManager'],
    },

    // For franchise owners
    franchiseOwned: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Franchise',
      required: function () {
        return this.role === 'franchise';
      },
    },

    // For relationship managers
    relationshipManagerOwned: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RelationshipManager',
    },

    // For agents
    commissionPercentage: {
      type: Number,
      default: 0,
    },

    // For sub-agents: reference to parent agent
    parentAgent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },

    // Permissions array for granular access control
    permissions: {
      type: [String],
      default: [],
    },

    // KYC details (mainly for agents)
    kyc: {
      pan: String,
      aadhaar: String,
      gst: String,
      verified: {
        type: Boolean,
        default: false,
      },
    },

    // Bank details (mainly for agents)
    bankDetails: {
      accountHolderName: String,
      accountNumber: String,
      branch: String,
      ifsc: String,
      bankName: String,
    },

    status: {
      type: String,
      enum: ['active', 'inactive', 'blocked'],
      default: 'active',
      index: true,
    },

    lastLoginAt: Date,
    lastActive: Date,
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

// Index for efficient queries
userSchema.index({ role: 1, status: 1 });
userSchema.index({ franchise: 1, role: 1 });
userSchema.index({ managedBy: 1, role: 1 });
userSchema.index({ parentAgent: 1, role: 1 });
userSchema.index({ isLoggedIn: 1, lastActive: 1 });

// Hash password before save when modified
userSchema.pre('save', async function (next) {
  try {
    if (!this.isModified('password') || !this.password) return next();
    const isAlreadyHashed = this.password.startsWith('$2a$') || this.password.startsWith('$2b$') || this.password.startsWith('$2y$');
    if (isAlreadyHashed) return next();
    this.password = await bcrypt.hash(this.password, 12);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method (supports both plain text and bcrypt hashed passwords)
userSchema.methods.comparePassword = async function (enteredPassword) {
  if (!this.password) {
    console.log('❌ No password stored for user');
    return false;
  }

  // Check if password is bcrypt hashed (starts with $2a$, $2b$, or $2y$)
  const isHashed = this.password && (this.password.startsWith('$2a$') || this.password.startsWith('$2b$') || this.password.startsWith('$2y$'));
  
  if (isHashed) {
    // Password is hashed, use bcrypt comparison
    console.log('🔐 Comparing bcrypt hashed password');
    const result = await bcrypt.compare(enteredPassword, this.password);
    console.log('🔐 Bcrypt comparison result:', result);
    return result;
  }
  
  // Password is plain text, use direct comparison
  console.log('🔐 Comparing plain text password');
  console.log('🔐 Entered password length:', enteredPassword?.length);
  console.log('🔐 Stored password length:', this.password?.length);
  console.log('🔐 Passwords match:', enteredPassword === this.password);
  return enteredPassword === this.password;
};

// Method to check if user has permission
userSchema.methods.hasPermission = function (permission) {
  if (['super_admin', 'regional_manager'].includes(this.role)) return true;
  return this.permissions.includes(permission);
};

export default mongoose.model('User', userSchema);
