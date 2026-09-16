const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const net = require('net');

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function ipv4InCidr(address, base, prefix) {
  const value = ipv4Number(address);
  const network = ipv4Number(base);
  if (value === null || network === null) return false;
  const size = 2 ** (32 - prefix);
  return Math.floor(value / size) === Math.floor(network / size);
}

const BLOCKED_IPV4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

const blockedIpv6 = new net.BlockList();
for (const [base, prefix] of [
  ['::', 96], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32],
  ['2001:2::', 48], ['2001:10::', 28], ['2001:20::', 28], ['2001:db8::', 32],
  ['2002::', 16], ['3fff::', 20], ['5f00::', 16], ['fc00::', 7],
  ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blockedIpv6.addSubnet(base, prefix, 'ipv6');

function mappedIpv4(address) {
  const value = String(address).toLowerCase().split('%')[0];
  const dotted = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted && net.isIPv4(dotted)) return dotted;
  const hex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return '';
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

function isPrivateAddress(address) {
  const value = String(address || '').split('%')[0];
  if (net.isIPv4(value)) return BLOCKED_IPV4.some(([base, prefix]) => ipv4InCidr(value, base, prefix));
  if (net.isIPv6(value)) {
    const mapped = mappedIpv4(value);
    if (mapped) return isPrivateAddress(mapped);
    return blockedIpv6.check(value, 'ipv6');
  }
  return true;
}

function parseHttpUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('error.external_invalid_url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('error.external_invalid_url');
  if (url.username || url.password) throw new Error('error.external_invalid_url');
  return url;
}

async function resolveSafeUrl(value, allowedHosts, allowPrivateNetwork = false) {
  const url = parseHttpUrl(value);
  if (!allowedHosts.has(url.hostname.toLowerCase())) throw new Error('error.external_host_not_allowed');
  if (!allowPrivateNetwork && url.port && url.port !== '80' && url.port !== '443') {
    throw new Error('error.external_port_not_allowed');
  }
  const lookupHost = url.hostname.replace(/^\[|\]$/g, '');
  if (lookupHost.includes('%')) throw new Error('error.external_invalid_url');
  const literalFamily = net.isIP(lookupHost);
  const addresses = literalFamily
    ? [{ address: lookupHost, family: literalFamily }]
    : await dns.lookup(lookupHost, { all: true, verbatim: true });
  if (!addresses.length || (!allowPrivateNetwork && addresses.some(item => isPrivateAddress(item.address)))) {
    throw new Error('error.external_private_network_blocked');
  }
  return { url, addresses };
}

async function assertSafeUrl(value, allowedHosts, allowPrivateNetwork = false) {
  return (await resolveSafeUrl(value, allowedHosts, allowPrivateNetwork)).url;
}

function timeoutError() {
  return new Error('error.external_timeout');
}

function withDeadline(promise, deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return Promise.reject(timeoutError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), remainingMs);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function requestPinned(url, address, { deadline, accept }) {
  return new Promise((resolve, reject) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return reject(timeoutError());
    const client = url.protocol === 'https:' ? https : http;
    let settled = false;
    let request;
    const absoluteTimer = setTimeout(() => request?.destroy(timeoutError()), remainingMs);
    const connectTimer = setTimeout(
      () => request?.destroy(new Error('error.external_connect_timeout')),
      Math.min(3000, remainingMs),
    );
    request = client.request({
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      servername: net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
      headers: { Host: url.host, ...(accept ? { Accept: accept } : {}) },
    }, response => {
      settled = true;
      clearTimeout(connectTimer);
      resolve({
        response,
        cancelDeadline: () => clearTimeout(absoluteTimer),
      });
    });
    request.on('error', error => {
      clearTimeout(connectTimer);
      clearTimeout(absoluteTimer);
      if (!settled) reject(error);
    });
    request.end();
  });
}

async function requestValidatedAddress(url, addresses, options) {
  let lastError;
  for (const address of addresses) {
    try {
      return await requestPinned(url, address, options);
    } catch (error) {
      lastError = error;
      if (Date.now() >= options.deadline) throw timeoutError();
    }
  }
  throw lastError || new Error('error.external_connection_failed');
}

async function readBounded(response, maxBytes = DEFAULT_MAX_BYTES) {
  const header = typeof response.headers?.get === 'function'
    ? response.headers.get('content-length')
    : response.headers?.['content-length'];
  const declared = Number(header || 0);
  if (declared > maxBytes) {
    response.destroy?.();
    throw new Error('error.external_response_too_large');
  }
  if (!response.body && !response[Symbol.asyncIterator]) return Buffer.alloc(0);
  const stream = response.body || response;
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) {
      stream.destroy?.();
      try { await stream.cancel?.(); } catch { /* already closed */ }
      throw new Error('error.external_response_too_large');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

async function safeFetch(urlValue, {
  allowedHosts,
  allowPrivateNetwork = false,
  timeoutMs = 10000,
  maxRedirects = 3,
  maxBytes = DEFAULT_MAX_BYTES,
  accept = '',
} = {}) {
  let current = String(urlValue);
  const deadline = Date.now() + timeoutMs;
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    if (Date.now() >= deadline) throw timeoutError();
    const { url, addresses } = await withDeadline(
      resolveSafeUrl(current, allowedHosts, allowPrivateNetwork),
      deadline,
    );
    // Try only the exact addresses validated above. This permits an unreachable AAAA record to
    // fall back to A without performing another DNS lookup or reopening the rebinding window.
    const { response, cancelDeadline } = await requestValidatedAddress(url, addresses, { deadline, accept });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.destroy();
      cancelDeadline();
      if (redirect === maxRedirects) throw new Error('error.external_too_many_redirects');
      const location = response.headers.location;
      if (!location) throw new Error('error.external_invalid_redirect');
      current = new URL(location, url).href;
      continue;
    }
    try {
      const buffer = await readBounded(response, maxBytes);
      if (Date.now() >= deadline) throw timeoutError();
      return {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        url: url.href,
        contentType: response.headers['content-type'] || '',
        buffer,
      };
    } finally {
      cancelDeadline();
    }
  }
  throw new Error('error.external_too_many_redirects');
}

module.exports = {
  assertSafeUrl,
  isPrivateAddress,
  mappedIpv4,
  parseHttpUrl,
  readBounded,
  requestValidatedAddress,
  resolveSafeUrl,
  safeFetch,
};
