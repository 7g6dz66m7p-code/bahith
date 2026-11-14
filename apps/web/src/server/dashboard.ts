import { listUserProjects } from '@bahith/db';

import { getDatabase } from './db';

export function getDashboardData(userId: string) {
  return listUserProjects(getDatabase(), userId);
}
