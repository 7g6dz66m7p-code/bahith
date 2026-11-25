/**
 * Masks an e-mail address for reports: `ahmed@domain.com` → `a***@d***.com`.
 * Only the first letter of the local part and of the first domain label survive, plus
 * the final label (TLD). Anything that is not an address masks to `***`.
 */
export function maskEmail(email: string | null | undefined): string {
  if (email === null || email === undefined) return '***';
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return '***';
  const local = email.slice(0, at);
  const labels = email.slice(at + 1).split('.');
  const tld = labels.length > 1 ? labels[labels.length - 1] : undefined;
  const first = labels[0] ?? '';
  const domain = `${first.slice(0, 1)}***${tld === undefined ? '' : `.${tld}`}`;
  return `${local.slice(0, 1)}***@${domain}`;
}

/** Masks a phone number, keeping the country prefix and last two digits. */
export function maskPhone(phone: string | null | undefined): string {
  if (phone === null || phone === undefined || phone.length < 6) return '***';
  return `${phone.slice(0, 4)}***${phone.slice(-2)}`;
}
