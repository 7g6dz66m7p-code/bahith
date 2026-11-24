# ADR-0008: Request nonces for the browser content security policy

- Status: accepted
- Date: 2026-11-24

## Context

The application serves private academic work and authentication pages. React/Next
bootstrap uses inline scripts, so a policy that allows every inline script would
leave a significant injection path open. The previous application had no document
CSP, clickjacking policy, or common response security headers.

## Decision

Generate a new cryptographically random nonce in the Next proxy for each page
request. Pass its CSP to Next through request headers, using next-intl's existing
request forwarding, and return the same CSP to the browser. Overwrite incoming
nonce/policy headers rather than trusting client values. The locale root layout
awaits `connection()` so framework scripts are rendered with that request's nonce.

Production scripts require the nonce and `strict-dynamic`; `unsafe-eval` is limited
to the development server. Production style elements require a nonce. Style
attributes remain allowed for Next/Image's generated image styles; this exception
does not allow inline JavaScript. Fonts, images, connections and forms use local
origins, with data/blob images for the locally generated TOTP QR. Object embedding,
framing and base URL changes are blocked.

Next configuration also supplies headers for API/error/asset responses: nosniff,
DENY framing, no-referrer, disabled unused browser permissions, and same-origin
resource policy. HTTPS deployments receive HSTS for one year; no subdomain or
preload commitment is made. HSTS and insecure-request upgrades are enabled from
the configured HTTPS authentication origin, never from untrusted forwarded headers.

## Alternatives

- Allow inline scripts globally: rejected because reflected or stored injected
  script could execute without a nonce.
- Experimental Next SRI: preserves static rendering, but is not a stable basis
  for this application's security boundary.
- CSP report-only: useful for rollout observations, but would not stop execution.

## Consequences and validation

Locale pages use request rendering and cannot share cached HTML containing a
nonce. This adds server work for public pages; load measurements must include the
production CSP configuration. Authenticated pages already use request identity.

Browser regression coverage checks fresh nonces, matching framework scripts,
actual blocked injected script execution, and successful client hydration in both
languages. Existing authentication integration coverage additionally checks the
actual session cookie attributes for HTTP fixtures and configured HTTPS. These
tests verify local isolated services; they do not establish external OAuth,
production TLS, or proxy configuration correctness.
