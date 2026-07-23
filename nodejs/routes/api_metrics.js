'use strict';
const router = require('express').Router();
const permission = require('../utils/permission');
const metrics = require('../utils/metrics');

// /api/metrics/executive
router.get('/executive', async (req, res, next) => {
    try {
        await permission.byGroup(req.user, ['app_sso_admin']);
        
        const topIps = await metrics.getTopN('metrics:failed_ips', 7, 5);
        const topUsers = await metrics.getTopN('metrics:failed_users', 7, 5);
        const topServices = await metrics.getTopN('metrics:service_usage', 7, 5);
        
        res.json({ results: { ips: topIps, users: topUsers, services: topServices } });
    } catch(e) {
        next(e);
    }
});

// /api/metrics/user/:uid
router.get('/user/:uid', async (req, res, next) => {
    try {
        // Can only view if admin or self
        if (req.user.uid !== req.params.uid) {
            await permission.byGroup(req.user, ['app_sso_admin']);
        }
        
        // Failed logins for user is hard if we didn't track it by user, but wait, we did! metrics:failed_users:YYYY-MM-DD
        // However, we didn't track failed IPs per user. We tracked failed_users as a sorted set.
        // To get the user's failures, we just query their score from the union.
        
        // Wait, for services we have user_service_usage:<uid>:<date>. No, in metrics.js I wrote:
        // `metrics:user_service_usage:${username}:${date}`
        
        const topServices = await metrics.getTopN('metrics:user_service_usage', 7, 5, req.params.uid);
        
        res.json({ results: { services: topServices } });
    } catch(e) {
        next(e);
    }
});

module.exports = router;
