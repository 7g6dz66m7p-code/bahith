import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import type { AnswerPassage, ResolvedChatModel } from '../src/index';
import {
  AiCallError,
  AiConfigError,
  AiProviderError,
  estimateCostUsd,
  loadChatModelChain,
  parseModelPrices,
  resolveChatModelChain,
  runGroundedAnswer,
  runWithFallback,
  shouldFallBack,
} from '../src/index';

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

const passages: AnswerPassage[] = [
  {
    chunkId: '00000000-0000-4000-8000-000000000001',
    sourceId: '00000000-0000-4000-8000-000000000002',
    content: 'The trial enrolled 120 adults and measured recall after one week.',
    kind: 'full_text',
    fileId: '00000000-0000-4000-8000-000000000003',
    fileSha256: 'a'.repeat(64),
    pageStart: 4,
    pageEnd: 4,
    sourceVerificationStatus: 'verified',
    sourceTitle: 'Fixture study',
  },
];

const answer = JSON.stringify({
  abstain: false,
  sentences: [
    {
      text: 'The trial enrolled 120 adults.',
      kind: 'supported',
      evidence: [{ passage: 'P1', quote: 'The trial enrolled 120 adults' }],
    },
  ],
});

function answering(calls: string[], name: string) {
  return new MockLanguageModelV4({
    doGenerate: () => {
      calls.push(name);
      return Promise.resolve({
        content: [{ type: 'text', text: answer }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      });
    },
  });
}

function failing(calls: string[], name: string, statusCode: number, body = '{}') {
  return new MockLanguageModelV4({
    doGenerate: () => {
      calls.push(name);
      return Promise.reject(
        new APICallError({
          message: 'provider failure',
          url: 'https://provider.test',
          requestBodyValues: {},
          statusCode,
          responseBody: body,
          isRetryable: false,
        }),
      );
    },
  });
}

const entry = (label: string, model: MockLanguageModelV4): ResolvedChatModel => {
  const [provider = '', name = ''] = label.split(':');
  return { ref: { provider, model: name }, label, model };
};

describe('loadChatModelChain', () => {
  it('reads the primary and the optional fallback, both from configuration', () => {
    expect(loadChatModelChain({ AI_CHAT_MODEL: 'openai:m1' })).toEqual([
      { provider: 'openai', model: 'm1' },
    ]);
    expect(
      loadChatModelChain({ AI_CHAT_MODEL: 'openai:m1', AI_CHAT_FALLBACK_MODEL: 'anthropic:m2' }),
    ).toEqual([
      { provider: 'openai', model: 'm1' },
      { provider: 'anthropic', model: 'm2' },
    ]);
  });

  it('rejects a malformed or identical fallback and a missing primary', () => {
    expect(() =>
      loadChatModelChain({ AI_CHAT_MODEL: 'openai:m1', AI_CHAT_FALLBACK_MODEL: 'nonsense' }),
    ).toThrow(AiConfigError);
    expect(() =>
      loadChatModelChain({ AI_CHAT_MODEL: 'openai:m1', AI_CHAT_FALLBACK_MODEL: 'openai:m1' }),
    ).toThrow(AiConfigError);
    expect(() => loadChatModelChain({ AI_CHAT_FALLBACK_MODEL: 'anthropic:m2' })).toThrow(
      AiConfigError,
    );
  });

  it('every model in the chain needs its own provider key', () => {
    const refs = loadChatModelChain({
      AI_CHAT_MODEL: 'openai:m1',
      AI_CHAT_FALLBACK_MODEL: 'anthropic:m2',
    });
    expect(() => resolveChatModelChain(refs, { OPENAI_API_KEY: 'k' })).toThrow(AiProviderError);
    expect(
      resolveChatModelChain(refs, { OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }).map(
        (item) => item.label,
      ),
    ).toEqual(['openai:m1', 'anthropic:m2']);
  });
});

describe('runWithFallback with the real grounded-answer agent (mock providers)', () => {
  const ask = (chain: ResolvedChatModel[], failures: string[] = []) =>
    runWithFallback(
      chain,
      (item) =>
        runGroundedAnswer({
          model: item.model,
          question: 'How many adults were enrolled?',
          language: 'en',
          passages,
          maxRetries: 0,
        }),
      (item, error) => {
        failures.push(`${item.label}:${error instanceof AiCallError ? error.code : 'other'}`);
        return Promise.resolve();
      },
    );

  it('an exhausted primary balance falls back to the other provider, with grounding intact', async () => {
    const calls: string[] = [];
    const failures: string[] = [];
    const result = await ask(
      [
        entry(
          'openai:m1',
          failing(calls, 'openai', 429, '{"error":{"code":"insufficient_quota"}}'),
        ),
        entry('anthropic:m2', answering(calls, 'anthropic')),
      ],
      failures,
    );
    expect(calls).toEqual(['openai', 'anthropic']);
    expect(failures).toEqual(['openai:m1:AI_PROVIDER_QUOTA']);
    expect(result.used.label).toBe('anthropic:m2');
    expect(result.attempts).toEqual([
      { label: 'openai:m1', errorCode: 'AI_PROVIDER_QUOTA' },
      { label: 'anthropic:m2', errorCode: null },
    ]);
    expect(result.result.answer.sentences[0]?.evidence[0]?.pageStart).toBe(4);
  });

  it('a healthy primary is the only model called', async () => {
    const calls: string[] = [];
    const result = await ask([
      entry('openai:m1', answering(calls, 'openai')),
      entry('anthropic:m2', answering(calls, 'anthropic')),
    ]);
    expect(calls).toEqual(['openai']);
    expect(result.used.label).toBe('openai:m1');
  });

  it('when every provider fails, the last classified error is raised', async () => {
    const calls: string[] = [];
    await expect(
      ask([
        entry('openai:m1', failing(calls, 'openai', 500)),
        entry('anthropic:m2', failing(calls, 'anthropic', 401)),
      ]),
    ).rejects.toEqual(new AiCallError('AI_PROVIDER_AUTH', 401));
    expect(calls).toEqual(['openai', 'anthropic']);
  });

  it('invalid model output is not retried on another provider', async () => {
    const calls: string[] = [];
    const broken = new MockLanguageModelV4({
      doGenerate: () => {
        calls.push('openai');
        return Promise.resolve({
          content: [{ type: 'text', text: 'not json' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage,
          warnings: [],
        });
      },
    });
    await expect(
      ask([entry('openai:m1', broken), entry('anthropic:m2', answering(calls, 'anthropic'))]),
    ).rejects.toEqual(new AiCallError('AI_OUTPUT_INVALID'));
    expect(calls).toEqual(['openai']);
    expect(shouldFallBack(new AiCallError('AI_OUTPUT_INVALID'))).toBe(false);
    expect(shouldFallBack(new Error('x'))).toBe(false);
  });
});

describe('cost estimation from configured prices', () => {
  it('uses only owner-configured prices and reports unknown as null', () => {
    const prices = parseModelPrices({
      AI_MODEL_PRICES_JSON: '{"openai:m1":{"inputPerMillion":2,"outputPerMillion":8}}',
    });
    expect(estimateCostUsd(prices.get('openai:m1'), { inputTokens: 1000, outputTokens: 500 })).toBe(
      0.006,
    );
    expect(estimateCostUsd(prices.get('anthropic:m2'), { inputTokens: 1, outputTokens: 1 })).toBe(
      null,
    );
    expect(estimateCostUsd(prices.get('openai:m1'), { inputTokens: null, outputTokens: 1 })).toBe(
      null,
    );
    expect(parseModelPrices({}).size).toBe(0);
    for (const bad of ['[]', 'x', '{"openai:m1":{"inputPerMillion":-1,"outputPerMillion":1}}']) {
      expect(() => parseModelPrices({ AI_MODEL_PRICES_JSON: bad })).toThrow(AiConfigError);
    }
  });
});
