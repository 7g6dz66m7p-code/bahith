import { unreadCount } from '@bahith/db';

import { getDatabase } from './db';

/** The header badge: unread notifications of the user. A failure only hides the badge. */
export function getUnreadNotificationCount(userId: string): Promise<number> {
  return unreadCount(getDatabase(), { userId }).catch(() => 0);
}
