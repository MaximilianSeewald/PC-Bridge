import { createPublicKey, verify } from 'node:crypto';

function jsonSegment(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('Invalid JWT segment');
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new Error('Use a valid HTTPS issuer or endpoint.');
  }
  return url;
}

export function oauthVerifier({ issuer, resource, scope }, fetcher = fetch) {
  httpsUrl(issuer);
  let cached;

  async function readJson(url) {
    const response = await fetcher(httpsUrl(url), { redirect: 'error', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error('Cannot read the OAuth provider metadata.');
    return response.json();
  }

  async function keys() {
    const now = Date.now();
    if (!cached || cached.expires <= now) {
      const promise = (async () => {
        const base = issuer.endsWith('/') ? issuer : issuer + '/';
        const metadata = await readJson(new URL('.well-known/openid-configuration', base).href);
        if (metadata.issuer !== issuer) throw new Error('OAuth issuer mismatch.');
        const jwks = await readJson(metadata.jwks_uri);
        return jwks.keys.filter(key => key.kty === 'RSA' && key.kid &&
          (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
      })();
      cached = { expires: now + 60_000, promise };
    }
    return cached.promise;
  }

  return async (token) => {
    if (typeof token !== 'string' || token.length > 8192) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return null;
    try {
      const header = jsonSegment(parts[0]);
      const claims = jsonSegment(parts[1]);
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const scopes = typeof claims.scope === 'string' ? claims.scope.split(/\s+/).filter(Boolean) : [];
      const now = Math.floor(Date.now() / 1000);
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' ||
          claims.iss !== issuer || !audiences.includes(resource) ||
          typeof claims.sub !== 'string' || !claims.sub || !scopes.includes(scope) ||
          !Number.isFinite(claims.exp) || claims.exp <= now ||
          (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now))) return null;
      const key = (await keys()).find(jwk => jwk.kid === header.kid);
      if (!key) return null;
      return verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]),
        createPublicKey({ format: 'jwk', key }), Buffer.from(parts[2], 'base64url'))
        ? claims.sub : null;
    } catch {
      return null;
    }
  };
}
