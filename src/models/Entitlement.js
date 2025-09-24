/**
 * Entitlement Model
 * Manages module and feature entitlements per tenant
 */

import mongoose from 'mongoose';

const featureSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  enabled: {
    type: Boolean,
    default: false
  },
  config: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: new Map()
  },
  limits: {
    type: Map,
    of: Number,
    default: new Map()
  }
});

const moduleSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    enum: [
      'forms', 'submissions', 'staff', 'discounts', 'notifications', 
      'reports', 'analytics', 'translations', 'integrations', 'exports',
      'audit', 'settings', 'billing', 'rbac', 'organizations', 'brands'
    ]
  },
  enabled: {
    type: Boolean,
    default: false
  },
  features: [featureSchema],
  limits: {
    type: Map,
    of: Number,
    default: new Map()
  },
  config: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: new Map()
  }
});

const entitlementSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  tenantType: {
    type: String,
    required: true,
    enum: ['organization', 'business', 'franchise'],
    index: true
  },
  planId: {
    type: String,
    required: true,
    index: true
  },
  addOns: [{
    addOnId: String,
    name: String,
    enabled: { type: Boolean, default: true },
    expiresAt: Date
  }],
  modules: [moduleSchema],
  quotas: {
    submissions: { type: Number, default: 1000 },
    forms: { type: Number, default: 10 },
    staff: { type: Number, default: 5 },
    notifications: { type: Number, default: 100 },
    exports: { type: Number, default: 10 },
    integrations: { type: Number, default: 3 }
  },
  usage: {
    submissions: { type: Number, default: 0 },
    forms: { type: Number, default: 0 },
    staff: { type: Number, default: 0 },
    notifications: { type: Number, default: 0 },
    exports: { type: Number, default: 0 },
    integrations: { type: Number, default: 0 }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  effectiveFrom: {
    type: Date,
    default: Date.now
  },
  effectiveUntil: {
    type: Date,
    default: null
  },
  metadata: {
    createdBy: {
      type: String,
      required: true
    },
    lastModifiedBy: String,
    version: {
      type: String,
      default: '1.0'
    },
    notes: String
  },
  audit: [{
    action: {
      type: String,
      enum: ['created', 'updated', 'activated', 'deactivated', 'quota_exceeded']
    },
    performedBy: String,
    performedAt: { type: Date, default: Date.now },
    changes: Map,
    reason: String
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
entitlementSchema.index({ tenantId: 1, tenantType: 1 }, { unique: true });
entitlementSchema.index({ planId: 1 });
entitlementSchema.index({ isActive: 1 });
entitlementSchema.index({ effectiveFrom: 1, effectiveUntil: 1 });

// Pre-save middleware
entitlementSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Methods
entitlementSchema.methods.isModuleEnabled = function(moduleName) {
  const module = this.modules.find(m => m.name === moduleName);
  return module ? module.enabled : false;
};

entitlementSchema.methods.isFeatureEnabled = function(moduleName, featureName) {
  const module = this.modules.find(m => m.name === moduleName);
  if (!module || !module.enabled) return false;
  
  const feature = module.features.find(f => f.name === featureName);
  return feature ? feature.enabled : false;
};

entitlementSchema.methods.getModuleConfig = function(moduleName) {
  const module = this.modules.find(m => m.name === moduleName);
  return module ? module.config : new Map();
};

entitlementSchema.methods.getFeatureConfig = function(moduleName, featureName) {
  const module = this.modules.find(m => m.name === moduleName);
  if (!module) return new Map();
  
  const feature = module.features.find(f => f.name === featureName);
  return feature ? feature.config : new Map();
};

entitlementSchema.methods.checkQuota = function(resource) {
  const quota = this.quotas[resource] || 0;
  const usage = this.usage[resource] || 0;
  return usage < quota;
};

entitlementSchema.methods.incrementUsage = function(resource, amount = 1) {
  this.usage[resource] = (this.usage[resource] || 0) + amount;
  return this.save();
};

entitlementSchema.methods.addAuditEntry = function(action, performedBy, changes = {}, reason = '') {
  this.audit.push({
    action,
    performedBy,
    changes: new Map(Object.entries(changes)),
    reason,
    performedAt: new Date()
  });
  return this.save();
};

// Static methods
entitlementSchema.statics.getByTenant = function(tenantId, tenantType) {
  return this.findOne({ tenantId, tenantType, isActive: true });
};

entitlementSchema.statics.getByPlan = function(planId) {
  return this.find({ planId, isActive: true });
};

entitlementSchema.statics.getExpiringSoon = function(days = 7) {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + days);
  
  return this.find({
    effectiveUntil: { $lte: futureDate, $gt: new Date() },
    isActive: true
  });
};

entitlementSchema.statics.getQuotaExceeded = function() {
  return this.find({
    isActive: true,
    $expr: {
      $or: Object.keys(this.schema.paths.quotas.schema.paths).map(resource => ({
        $gt: [`$usage.${resource}`, `$quotas.${resource}`]
      }))
    }
  });
};

export default mongoose.model('Entitlement', entitlementSchema);
