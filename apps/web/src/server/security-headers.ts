/** Browser policy shared by the Next proxy/config and security regression tests. */
export function contentSecurityPolicy(
  nonce: string,
  development: boolean,
  secure: boolean,
): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    `style-src 'self'${development ? " 'unsafe-inline'" : ` 'nonce-${nonce}'`}`,
    // Next/Image uses a style attribute; inline scripts and style elements remain blocked.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${development ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    ...(secure ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export function baselineSecurityHeaders(secure: boolean): { key: string; value: string }[] {
  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
    // Pages replace this with their per-request nonce policy. API responses and assets
    // have no reason to execute script when opened as a document.
    {
      key: 'Content-Security-Policy',
      value: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    },
    ...(secure ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }] : []),
  ];
}
