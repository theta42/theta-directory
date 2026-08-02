const https = require('https');

module.exports = {
  type: 'twilio',
  category: 'messaging',
  name: 'Twilio SMS',
  description: 'Send SMS messages (like 2FA codes) via Twilio.',
  
  configSchema: [
    { key: 'accountSid', label: 'Account SID', type: 'text', required: true },
    { key: 'authToken', label: 'Auth Token', type: 'password', required: true, secret: true },
    { key: 'fromNumber', label: 'From Phone Number', type: 'text', required: true, placeholder: '+15551234567' }
  ],

  validate: async (config) => {
    if (!config.accountSid || !config.authToken) return { ok: false, error: 'Missing credentials' };
    if (!config.fromNumber) return { ok: false, error: 'Missing fromNumber' };
    return { ok: true };
  },

  sendMessage: async (config, payload) => {
    const { to, message } = payload;
    if (!to || !message) throw new Error("Missing 'to' or 'message' in payload");

    const data = new URLSearchParams();
    data.append('To', to);
    data.append('From', config.fromNumber);
    data.append('Body', message);

    const postData = data.toString();

    const options = {
      hostname: 'api.twilio.com',
      port: 443,
      path: `/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(config.accountSid + ':' + config.authToken).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(body));
          } else {
            reject(new Error(`Twilio API Error: ${res.statusCode} ${body}`));
          }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
};
