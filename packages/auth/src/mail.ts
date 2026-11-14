import nodemailer from 'nodemailer';

import type { AuthSmtpConfig } from './config';

export interface AuthMailMessage {
  to: string;
  subject: string;
  text: string;
}

/** An actual delivery boundary; tests can capture messages without external email. */
export interface AuthMailTransport {
  send(message: AuthMailMessage): Promise<void>;
  close?(): void;
}

export class AuthMailError extends Error {
  readonly code = 'AUTH_MAIL_DELIVERY_FAILED';

  constructor() {
    super('Authentication email delivery failed.');
    this.name = 'AuthMailError';
  }
}

/** SMTP errors are sanitized; tokens, addresses, URLs and server replies stay out of logs. */
export function createAuthMailTransport(config: AuthSmtpConfig): AuthMailTransport {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure && !['localhost', '127.0.0.1'].includes(config.host),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    logger: false,
    debug: false,
    ...(config.user !== undefined && config.password !== undefined
      ? { auth: { user: config.user, pass: config.password } }
      : {}),
  });
  return {
    async send(message) {
      try {
        const result = await transport.sendMail({ from: config.from, ...message });
        if (result.accepted.length === 0 || result.rejected.length > 0) throw new AuthMailError();
      } catch {
        throw new AuthMailError();
      }
    },
    close() {
      transport.close();
    },
  };
}
