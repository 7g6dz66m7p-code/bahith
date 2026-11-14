import { describe, expect, it } from 'vitest';

import { AiConfigError, loadAiConfig } from '../src/config';

const env = {
  AI_CHAT_MODEL: 'provider-a:chat-model-1',
  AI_EMBEDDING_MODEL: 'provider-b:embed/model:v2',
  AI_RERANK_MODEL: 'provider-c:rerank-model',
};

describe('loadAiConfig', () => {
  it('splits each identifier into provider and model at the first colon', () => {
    expect(loadAiConfig(env)).toEqual({
      chat: { provider: 'provider-a', model: 'chat-model-1' },
      embedding: { provider: 'provider-b', model: 'embed/model:v2' },
      rerank: { provider: 'provider-c', model: 'rerank-model' },
    });
  });

  it('has no default model: missing variables fail and are named', () => {
    expect(() => loadAiConfig({})).toThrow(AiConfigError);
    expect(() => loadAiConfig({ ...env, AI_RERANK_MODEL: undefined })).toThrow(
      expect.objectContaining({ code: 'AI_CONFIG_INVALID', variables: ['AI_RERANK_MODEL'] }),
    );
  });

  it.each(['', 'no-provider', ':model', 'Provider:model', 'provider:'])(
    'rejects the malformed identifier "%s"',
    (value) => {
      expect(() => loadAiConfig({ ...env, AI_CHAT_MODEL: value })).toThrow(
        expect.objectContaining({ variables: ['AI_CHAT_MODEL'] }),
      );
    },
  );
});
