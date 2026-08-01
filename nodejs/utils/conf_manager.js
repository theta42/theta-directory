'use strict';
const conf = require('@simpleworkjs/conf');
const VAULT_URL = 'http://openbao:8200';
const VAULT_TOKEN = 'root';

async function getVaultConf() {
  try {
    const res = await fetch(`${VAULT_URL}/v1/secret/data/sso-manager/conf`, {
      headers: { 'X-Vault-Token': VAULT_TOKEN }
    });
    if (res.status === 200) {
      const json = await res.json();
      return json.data.data;
    }
  } catch (err) {
    console.error('Error fetching conf from Vault:', err);
  }
  return null;
}

async function setVaultConf(newConf) {
  const res = await fetch(`${VAULT_URL}/v1/secret/data/sso-manager/conf`, {
    method: 'POST',
    headers: { 'X-Vault-Token': VAULT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: newConf })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vault API error: ${res.status} ${text}`);
  }
  applyConf(newConf);
}

function applyConf(newConf) {
  if (!newConf) return;
  // Deep merge into conf
  for (const key of Object.keys(newConf)) {
    if (typeof newConf[key] === 'object' && newConf[key] !== null && !Array.isArray(newConf[key])) {
      conf[key] = { ...conf[key], ...newConf[key] };
    } else {
      conf[key] = newConf[key];
    }
  }
}

async function init() {
  const vaultConf = await getVaultConf();
  if (vaultConf) {
    applyConf(vaultConf);
  }
}

module.exports = { getVaultConf, setVaultConf, init };
