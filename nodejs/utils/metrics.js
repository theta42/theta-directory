'use strict';
const { createClient } = require('redis');
const conf = require('@simpleworkjs/conf');

let client;
async function getClient() {
    if (!client) {
        // conf.redis could be an object or a connection string depending on @simpleworkjs/conf
        // But for sso-manager, Redis runs locally or is configured via environment
        // The tests use createClient() with no args, so we do the same, allowing env vars to override
        const url = (conf.redis && typeof conf.redis === 'string') ? conf.redis : (conf.redis && conf.redis.url) ? conf.redis.url : undefined;
        client = createClient({ url });
        client.on('error', (err) => console.error('Redis metrics error', err));
        await client.connect();
    }
    return client;
}

function getTodayKey() {
    return new Date().toISOString().split('T')[0];
}

async function recordFailedLogin(ip, username) {
    try {
        const c = await getClient();
        const date = getTodayKey();
        const p = c.multi();
        if (ip) {
            p.zIncrBy(`metrics:failed_ips:${date}`, 1, ip);
            p.expire(`metrics:failed_ips:${date}`, 30 * 86400);
        }
        if (username) {
            p.zIncrBy(`metrics:failed_users:${date}`, 1, username);
            p.expire(`metrics:failed_users:${date}`, 30 * 86400);
        }
        await p.exec();
    } catch(e) {
        console.error('Failed to record failed login metric', e);
    }
}

async function recordServiceUsage(serviceName, username) {
    try {
        const c = await getClient();
        const date = getTodayKey();
        const p = c.multi();
        if (serviceName) {
            p.zIncrBy(`metrics:service_usage:${date}`, 1, serviceName);
            p.expire(`metrics:service_usage:${date}`, 30 * 86400);
            if (username) {
                p.zIncrBy(`metrics:user_service_usage:${username}:${date}`, 1, serviceName);
                p.expire(`metrics:user_service_usage:${username}:${date}`, 30 * 86400);
            }
        }
        await p.exec();
    } catch(e) {
        console.error('Failed to record service usage metric', e);
    }
}

// Helper to aggregate the last N days of a metric prefix
async function getTopN(prefix, days, topN, user = null) {
    try {
        const c = await getClient();
        const keys = [];
        const today = new Date();
        for (let i = 0; i < days; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            if (user) {
                keys.push(`${prefix}:${user}:${dateStr}`);
            } else {
                keys.push(`${prefix}:${dateStr}`);
            }
        }
        
        const tempKey = `metrics:temp:union:${Date.now()}:${Math.floor(Math.random() * 1000000)}`;
        // ZUNIONSTORE is replaced by ZUNIONSTORE in redis v4 Node client, usually zUnionStore
        await c.zUnionStore(tempKey, keys.length, keys);
        const results = await c.zRangeWithScores(tempKey, 0, topN - 1, { REV: true });
        await c.del(tempKey);
        
        return results.map(r => ({ value: r.value, score: r.score }));
    } catch(e) {
        console.error('Failed to get top N metrics', e);
        return [];
    }
}

module.exports = {
    recordFailedLogin,
    recordServiceUsage,
    getTopN
};
