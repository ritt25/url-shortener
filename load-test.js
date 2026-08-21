import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = 'https://url-shortener-7ive.onrender.com';
const TEST_CODE = '0jtKTp'; // already in your DB from the test run

export const options = {
  stages: [
    { duration: '30s', target: 20 },  // ramp up to 20 users
    { duration: '1m',  target: 20 },  // hold at 20 users
    { duration: '15s', target: 0 },   // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed:   ['rate<0.05'],
  },
};

export default function () {
  // Primary test: Redis cache hit (this is the interesting one)
  const redirect = http.get(`${BASE_URL}/${TEST_CODE}`, {
    redirects: 0,
  });
  check(redirect, {
    'cache hit - redirect 301/302': (r) => r.status === 301 || r.status === 302,
  });

  sleep(1);
}