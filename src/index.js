/**
 * Keephy Entitlements Service
 * Manages module and feature entitlements per tenant
 */

import express from 'express';
import mongoose from 'mongoose';
import pino from 'pino';
import pinoHttp from 'pino-http';
import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

import Entitlement from './models/Entitlement.js';

dotenv.config();

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Middleware
app.use(express.json());
app.use(pinoHttp({ logger }));
app.use(helmet());
app.use(cors());

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/keephy_entitlements';
mongoose.connect(MONGO_URI)
  .then(() => logger.info('Connected to MongoDB'))
  .catch(err => {
    logger.error('MongoDB connection error:', err);
    process.exit(1);
  });

// JWT verification middleware
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Super Admin check middleware
const requireSuperAdmin = (req, res, next) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
};

// Entitlement Management
app.post('/entitlements', verifyToken, requireSuperAdmin, async (req, res) => {
  try {
    const entitlement = new Entitlement({
      ...req.body,
      metadata: {
        ...req.body.metadata,
        createdBy: req.user.userId
      }
    });
    
    await entitlement.save();
    await entitlement.addAuditEntry('created', req.user.userId, req.body);
    
    logger.info({ entitlementId: entitlement._id, tenantId: entitlement.tenantId }, 'Entitlement created');
    res.status(201).json(entitlement);
  } catch (error) {
    logger.error('Entitlement creation error:', error);
    res.status(400).json({ error: error.message });
  }
});

app.get('/entitlements', verifyToken, async (req, res) => {
  try {
    const { tenantId, tenantType, planId, isActive = true } = req.query;
    const query = { isActive };
    
    if (tenantId) query.tenantId = tenantId;
    if (tenantType) query.tenantType = tenantType;
    if (planId) query.planId = planId;
    
    const entitlements = await Entitlement.find(query).sort({ createdAt: -1 });
    res.json(entitlements);
  } catch (error) {
    logger.error('Entitlements fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch entitlements' });
  }
});

app.get('/entitlements/:id', verifyToken, async (req, res) => {
  try {
    const entitlement = await Entitlement.findById(req.params.id);
    if (!entitlement) {
      return res.status(404).json({ error: 'Entitlement not found' });
    }
    res.json(entitlement);
  } catch (error) {
    logger.error('Entitlement fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch entitlement' });
  }
});

app.get('/entitlements/tenant/:tenantId/:tenantType', verifyToken, async (req, res) => {
  try {
    const { tenantId, tenantType } = req.params;
    const entitlement = await Entitlement.getByTenant(tenantId, tenantType);
    
    if (!entitlement) {
      return res.status(404).json({ error: 'Entitlement not found for tenant' });
    }
    
    res.json(entitlement);
  } catch (error) {
    logger.error('Tenant entitlement fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch tenant entitlement' });
  }
});

app.patch('/entitlements/:id', verifyToken, requireSuperAdmin, async (req, res) => {
  try {
    const entitlement = await Entitlement.findByIdAndUpdate(
      req.params.id,
      { 
        ...req.body,
        'metadata.lastModifiedBy': req.user.userId,
        updatedAt: new Date()
      },
      { new: true, runValidators: true }
    );
    
    if (!entitlement) {
      return res.status(404).json({ error: 'Entitlement not found' });
    }
    
    await entitlement.addAuditEntry('updated', req.user.userId, req.body);
    
    logger.info({ entitlementId: entitlement._id }, 'Entitlement updated');
    res.json(entitlement);
  } catch (error) {
    logger.error('Entitlement update error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Module Management
app.patch('/entitlements/:id/modules/:moduleName', verifyToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id, moduleName } = req.params;
    const { enabled, features, limits, config } = req.body;
    
    const entitlement = await Entitlement.findById(id);
    if (!entitlement) {
      return res.status(404).json({ error: 'Entitlement not found' });
    }
    
    const moduleIndex = entitlement.modules.findIndex(m => m.name === moduleName);
    if (moduleIndex === -1) {
      return res.status(404).json({ error: 'Module not found' });
    }
    
    const module = entitlement.modules[moduleIndex];
    if (enabled !== undefined) module.enabled = enabled;
    if (features) module.features = features;
    if (limits) module.limits = new Map(Object.entries(limits));
    if (config) module.config = new Map(Object.entries(config));
    
    await entitlement.save();
    await entitlement.addAuditEntry('updated', req.user.userId, { module: moduleName, changes: req.body });
    
    logger.info({ entitlementId: id, moduleName }, 'Module updated');
    res.json(module);
  } catch (error) {
    logger.error('Module update error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Feature Management
app.patch('/entitlements/:id/modules/:moduleName/features/:featureName', verifyToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id, moduleName, featureName } = req.params;
    const { enabled, config, limits } = req.body;
    
    const entitlement = await Entitlement.findById(id);
    if (!entitlement) {
      return res.status(404).json({ error: 'Entitlement not found' });
    }
    
    const module = entitlement.modules.find(m => m.name === moduleName);
    if (!module) {
      return res.status(404).json({ error: 'Module not found' });
    }
    
    const featureIndex = module.features.findIndex(f => f.name === featureName);
    if (featureIndex === -1) {
      return res.status(404).json({ error: 'Feature not found' });
    }
    
    const feature = module.features[featureIndex];
    if (enabled !== undefined) feature.enabled = enabled;
    if (config) feature.config = new Map(Object.entries(config));
    if (limits) feature.limits = new Map(Object.entries(limits));
    
    await entitlement.save();
    await entitlement.addAuditEntry('updated', req.user.userId, { 
      module: moduleName, 
      feature: featureName, 
      changes: req.body 
    });
    
    logger.info({ entitlementId: id, moduleName, featureName }, 'Feature updated');
    res.json(feature);
  } catch (error) {
    logger.error('Feature update error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Quota Management
app.patch('/entitlements/:id/quotas', verifyToken, requireSuperAdmin, async (req, res) => {
  try {
    const entitlement = await Entitlement.findById(req.params.id);
    if (!entitlement) {
      return res.status(404).json({ error: 'Entitlement not found' });
    }
    
    entitlement.quotas = { ...entitlement.quotas, ...req.body };
    await entitlement.save();
    await entitlement.addAuditEntry('updated', req.user.userId, { quotas: req.body });
    
    logger.info({ entitlementId: entitlement._id }, 'Quotas updated');
    res.json(entitlement.quotas);
  } catch (error) {
    logger.error('Quota update error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Usage Tracking
app.post('/entitlements/:id/usage/:resource', verifyToken, async (req, res) => {
  try {
    const { id, resource } = req.params;
    const { amount = 1 } = req.body;
    
    const entitlement = await Entitlement.findById(id);
    if (!entitlement) {
      return res.status(404).json({ error: 'Entitlement not found' });
    }
    
    if (!entitlement.checkQuota(resource)) {
      await entitlement.addAuditEntry('quota_exceeded', req.user.userId, { resource, amount });
      return res.status(429).json({ 
        error: 'Quota exceeded',
        resource,
        quota: entitlement.quotas[resource],
        usage: entitlement.usage[resource]
      });
    }
    
    await entitlement.incrementUsage(resource, amount);
    
    logger.info({ entitlementId: id, resource, amount }, 'Usage incremented');
    res.json({ 
      resource, 
      usage: entitlement.usage[resource],
      quota: entitlement.quotas[resource],
      remaining: entitlement.quotas[resource] - entitlement.usage[resource]
    });
  } catch (error) {
    logger.error('Usage tracking error:', error);
    res.status(500).json({ error: 'Failed to track usage' });
  }
});

// Permission Check
app.post('/check-permission', verifyToken, async (req, res) => {
  try {
    const { tenantId, tenantType, module, feature, action } = req.body;
    
    const entitlement = await Entitlement.getByTenant(tenantId, tenantType);
    if (!entitlement) {
      return res.json({ 
        hasPermission: false, 
        reason: 'No entitlement found for tenant' 
      });
    }
    
    const isModuleEnabled = entitlement.isModuleEnabled(module);
    const isFeatureEnabled = feature ? entitlement.isFeatureEnabled(module, feature) : true;
    
    const hasPermission = isModuleEnabled && isFeatureEnabled;
    
    res.json({ 
      hasPermission,
      module,
      feature,
      action,
      isModuleEnabled,
      isFeatureEnabled,
      quota: entitlement.quotas,
      usage: entitlement.usage
    });
  } catch (error) {
    logger.error('Permission check error:', error);
    res.status(500).json({ error: 'Permission check failed' });
  }
});

// Reports
app.get('/entitlements/reports/quota-exceeded', verifyToken, requireSuperAdmin, async (req, res) => {
  try {
    const quotaExceeded = await Entitlement.getQuotaExceeded();
    res.json(quotaExceeded);
  } catch (error) {
    logger.error('Quota exceeded report error:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

app.get('/entitlements/reports/expiring', verifyToken, requireSuperAdmin, async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const expiring = await Entitlement.getExpiringSoon(parseInt(days));
    res.json(expiring);
  } catch (error) {
    logger.error('Expiring entitlements report error:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// Health endpoints
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
app.get('/ready', (req, res) => {
  const state = mongoose.connection.readyState;
  res.status(state === 1 ? 200 : 503).json({ ready: state === 1 });
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

const port = Number(process.env.PORT || 3002);
app.listen(port, () => logger.info({ port }, 'keephy_entitlements service listening'));

export default app;