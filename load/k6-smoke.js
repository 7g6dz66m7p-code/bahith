// k6 load test against the LOCAL harness only (see prepare.ts and docs/runbooks/load-security.md).
// 50 virtual users for 60 s over pages and APIs a researcher uses; no AI provider calls.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE;
const headers = { cookie: __ENV.COOKIE, origin: BASE, 'content-type': 'application/json' };
const scope = `workspaceId=${__ENV.WORKSPACE_ID}`;
const project = `${BASE}/api/projects/${__ENV.PROJECT_ID}`;

export const options = {
  scenarios: {
    researchers: { executor: 'constant-vus', vus: 50, duration: '60s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{kind:page}': ['p(95)<1500'],
    'http_req_duration{kind:api}': ['p(95)<800'],
    'http_req_duration{kind:search}': ['p(95)<1000'],
  },
};

const queries = ['التعلم المدمج', 'عينة الدراسة', 'حجم الأثر لدى الطالبات', 'تدريب المعلمين'];

export default function () {
  const responses = http.batch([
    ['GET', `${BASE}/ar`, null, { tags: { kind: 'page' } }],
    [
      'GET',
      `${BASE}/ar/workspaces/${__ENV.WORKSPACE_ID}/projects/${__ENV.PROJECT_ID}`,
      null,
      { headers, tags: { kind: 'page' } },
    ],
    ['GET', `${BASE}/api/projects`, null, { headers, tags: { kind: 'api' } }],
    ['GET', `${project}/sources?${scope}`, null, { headers, tags: { kind: 'api' } }],
    ['GET', `${project}/references?${scope}`, null, { headers, tags: { kind: 'api' } }],
    [
      'POST',
      `${BASE}/api/sanad/retrieve`,
      JSON.stringify({
        workspaceId: __ENV.WORKSPACE_ID,
        projectId: __ENV.PROJECT_ID,
        query: queries[__ITER % queries.length],
      }),
      { headers, tags: { kind: 'search' } },
    ],
  ]);
  for (const response of responses) check(response, { 'status 200': (r) => r.status === 200 });
}
