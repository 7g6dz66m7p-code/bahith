'use client';

import type { BahithAuth } from '@bahith/auth';
import { inferAdditionalFields, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  plugins: [twoFactorClient(), inferAdditionalFields<BahithAuth>()],
});
