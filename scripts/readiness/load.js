import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

const fixturePath = __ENV.BAHITH_LOAD_FIXTURES;
if (!fixturePath) throw new Error('BAHITH_LOAD_FIXTURES must name the private local fixture file');
const input = JSON.parse(open(fixturePath));
const origin = input.baseUrl;
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))
  throw new Error('Load tests require an isolated local server');
const users = new SharedArray('verified synthetic users', () => input.users);
if (users.length !== 50) throw new Error('Exactly 50 verified users are required');

export const options = {
  scenarios: {
    concurrent_users: { executor: 'constant-vus', vus: 50, duration: '30s', gracefulStop: '15s' },
  },
  thresholds: {
    http_req_failed: ['rate==0'],
    checks: ['rate==1'],
    'http_req_duration{operation:projects}': ['p(95)<8000'],
    'http_req_duration{operation:retrieval}': ['p(95)<8000'],
  },
};
http.setResponseCallback(http.expectedStatuses(200, 403));

export default function () {
  const own = users[__VU - 1];
  const peer = users[__VU % users.length];
  const headers = { origin, Cookie: own.cookie, 'Content-Type': 'application/json' };
  const projects = http.get(`${origin}/api/projects`, {
    headers,
    tags: { name: 'GET /api/projects', operation: 'projects' },
  });
  check(projects, {
    'own project listing succeeds': (response) => response.status === 200,
    'project listing contains only own workspace': (response) =>
      response.status === 200 &&
      response.json('projects').length === 1 &&
      response.json('projects').some((project) => project.id === own.projectId) &&
      response.json('projects').every((project) => project.workspaceId === own.workspaceId),
  });
  const result = http.post(
    `${origin}/api/sanad/retrieve`,
    JSON.stringify({
      workspaceId: own.workspaceId,
      projectId: own.projectId,
      query: 'scientific',
      limit: 10,
    }),
    { headers, tags: { name: 'POST /api/sanad/retrieve own', operation: 'retrieval' } },
  );
  check(result, {
    'actual evidence retrieval succeeds': (response) => response.status === 200,
    'retrieval stays lexical without a model': (response) =>
      response.status === 200 && response.json('mode') === 'lexical',
    'evidence belongs to the requesting user': (response) =>
      response.status === 200 &&
      response.json('results').length > 0 &&
      response
        .json('results')
        .every(
          (entry) => entry.workspaceId === own.workspaceId && entry.content.includes(own.marker),
        ),
  });
  const denied = http.post(
    `${origin}/api/sanad/retrieve`,
    JSON.stringify({
      workspaceId: peer.workspaceId,
      projectId: peer.projectId,
      query: 'scientific',
    }),
    { headers, tags: { name: 'POST /api/sanad/retrieve other workspace', operation: 'isolation' } },
  );
  check(denied, {
    'cross-user retrieval remains forbidden under load': (response) =>
      response.status === 403 && response.json('code') === 'SANAD_FORBIDDEN',
  });
  sleep(0.25);
}
