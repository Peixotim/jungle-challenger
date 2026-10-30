import { integrityThreshold } from './integrity.js';

export const smoke = {
  http_req_duration: ['p(95)<300'],
  http_req_failed: ['rate==0'],
  checks: ['rate==1'],
  ...integrityThreshold,
};
