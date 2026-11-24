import { randomUUID } from 'node:crypto';

import type * as DatabaseModule from '@bahith/db';
import { SanadError, withSanadProject } from '@bahith/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/projects/[projectId]/sources/route';
import { getStorage } from '@/server/pipeline';
import { getRequestSession } from '@/server/session';

vi.mock('@bahith/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseModule>()),
  withSanadProject: vi.fn(),
}));
vi.mock('@/server/db', () => ({ getDatabase: () => ({}) }));
vi.mock('@/server/pipeline', () => ({ getStorage: vi.fn(), getQueues: vi.fn() }));
vi.mock('@/server/session', () => ({ getRequestSession: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe('upload authorization before body or storage work', () => {
  it.each(['SANAD_FORBIDDEN', 'SANAD_PROJECT_NOT_FOUND'] as const)(
    'rejects %s without reading or storing the upload',
    async (code) => {
      vi.stubEnv('BETTER_AUTH_URL', 'https://bahith.example.test');
      const userId = randomUUID();
      const workspaceId = randomUUID();
      const projectId = randomUUID();
      vi.mocked(getRequestSession).mockResolvedValue({ user: { id: userId } } as Awaited<
        ReturnType<typeof getRequestSession>
      >);
      vi.mocked(withSanadProject).mockRejectedValue(new SanadError(code));
      const form = new FormData();
      form.append('file', new File(['private source'], 'source.txt'));
      const request = new Request(
        `https://bahith.example.test/api/projects/${projectId}/sources?workspaceId=${workspaceId}`,
        {
          method: 'POST',
          headers: { origin: 'https://bahith.example.test' },
          body: form,
        },
      );
      const response = await POST(request, { params: Promise.resolve({ projectId }) });
      expect(response.status).toBe(code === 'SANAD_FORBIDDEN' ? 403 : 404);
      expect(await response.json()).toEqual({ code });
      expect(request.bodyUsed).toBe(false);
      expect(getStorage).not.toHaveBeenCalled();
      expect(withSanadProject).toHaveBeenCalledWith(
        {},
        { userId, workspaceId, projectId },
        true,
        expect.any(Function),
      );
    },
  );
});
