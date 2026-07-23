'use strict';

const router = require('express').Router();
const { Resource, ResourceGroup } = require('../models/resource');

// GET /api/discovery/me
// Returns the list of resources the current user has access to.
router.get('/me', async (req, res, next) => {
  try {
    const userGroups = req.user.groups || []; // array of LDAP group CNs
    const accessibleResourceIds = new Set();
    
    if (req.user.isMachine) {
        // Machines only have access to themselves by default
        accessibleResourceIds.add(req.resourceId);
    } else {
        // End users get access via groups
        const allGroups = await ResourceGroup.list();
        for (const rg of allGroups) {
            if (userGroups.includes(rg.groupCn)) {
                accessibleResourceIds.add(rg.resourceId);
            }
        }
    }
    
    // Fetch all resources and filter
    const allResources = await Resource.list();
    const accessible = allResources.filter(r => accessibleResourceIds.has(r.id) || r.metadata?.isPublic);
    
    res.json({ results: accessible });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
