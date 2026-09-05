(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VoiceLocalEndpointPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function parsedUrl(value) {
    try {
      return new URL(String(value || '').trim());
    } catch {
      return null;
    }
  }

  function isLoopbackHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  }

  function isLanHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (host.endsWith('.local') && host.length > '.local'.length) return true;

    const ipv4 = host.split('.');
    if (ipv4.length === 4 && ipv4.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
      const octets = ipv4.map(Number);
      return octets[0] === 10
        || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] === 192 && octets[1] === 168)
        || (octets[0] === 169 && octets[1] === 254);
    }

    const ipv6 = host.replace(/^\[|\]$/g, '');
    if (!ipv6.includes(':')) return false;
    const firstHextet = Number.parseInt(ipv6.split(':', 1)[0], 16);
    if (!Number.isFinite(firstHextet)) return false;
    return (firstHextet >= 0xfc00 && firstHextet <= 0xfdff)
      || (firstHextet >= 0xfe80 && firstHextet <= 0xfebf);
  }

  function classifyEndpointAccess({ pageUrl, apiBaseUrl, runtimeKind = 'browser' } = {}) {
    const endpoint = parsedUrl(apiBaseUrl);
    if (!endpoint || !['http:', 'https:'].includes(endpoint.protocol)) {
      return {
        allowed: false,
        code: 'INVALID_API_BASE_URL',
        mode: 'invalid',
        message: 'API Base URL必須是完整的http://或https://網址。',
      };
    }

    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      return {
        allowed: false,
        code: 'UNSAFE_API_BASE_URL',
        mode: 'invalid',
        message: 'API Base URL不可包含帳號密碼、query或fragment。',
      };
    }

    if (runtimeKind === 'electron') {
      return { allowed: true, code: null, mode: 'electron', message: '' };
    }

    const page = parsedUrl(pageUrl);
    if (!page) {
      return {
        allowed: false,
        code: 'INVALID_PAGE_URL',
        mode: 'invalid',
        message: '無法判斷目前網頁來源。',
      };
    }

    const hostedHttps = page.protocol === 'https:';
    if (hostedHttps && endpoint.protocol === 'http:') {
      if (!isLoopbackHost(endpoint.hostname) && !isLanHost(endpoint.hostname)) {
        return {
          allowed: false,
          code: 'HOSTED_HTTPS_HTTP_REQUIRES_LOCAL_NETWORK',
          mode: 'hosted-web',
          message: '正式網頁只允許HTTP連到localhost或LAN模型；公開Internet端點請使用HTTPS。',
        };
      }
      if (isLanHost(endpoint.hostname)) {
        return {
          allowed: true,
          code: null,
          mode: 'hosted-lan',
          message: '⚠️ LAN HTTP會以明文傳輸API Key與對話；請只在受信任網路使用，並允許瀏覽器的「本機網路存取」。',
        };
      }
      return {
        allowed: true,
        code: null,
        mode: 'hosted-loopback',
        message: '可直接連線這台電腦上的HTTP模型；瀏覽器首次連線時請允許「本機網路存取」。',
      };
    }

    const localWeb = page.protocol === 'http:' && isLoopbackHost(page.hostname);
    if (endpoint.protocol === 'http:' && !localWeb) {
      return {
        allowed: false,
        code: 'BROWSER_HTTP_ENDPOINT_BLOCKED',
        mode: 'browser',
        message: 'Browser只允許Local Web Mode直接連HTTP模型；請從http://127.0.0.1啟動本機頁面。',
      };
    }
    if (endpoint.protocol === 'http:' && !isLoopbackHost(endpoint.hostname) && !isLanHost(endpoint.hostname)) {
      return {
        allowed: false,
        code: 'LOCAL_WEB_HTTP_REQUIRES_LOCAL_NETWORK',
        mode: 'local-web',
        message: 'Local Web Mode只允許明文HTTP連到localhost或LAN模型；公開Internet端點請使用HTTPS。',
      };
    }
    if (endpoint.protocol === 'http:' && isLanHost(endpoint.hostname)) {
      return {
        allowed: true,
        code: null,
        mode: 'local-web-lan',
        message: '⚠️ LAN HTTP會以明文傳輸API Key與對話；請只在受信任網路使用。',
      };
    }
    return {
      allowed: true,
      code: null,
      mode: localWeb ? 'local-web' : 'browser',
      message: localWeb && endpoint.protocol === 'http:'
        ? 'Local Web Mode：可直接連線這台電腦上的HTTP本地模型。'
        : '',
    };
  }

  return { classifyEndpointAccess, isLoopbackHost, isLanHost };
});
