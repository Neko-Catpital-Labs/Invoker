// Force UTC timezone for deterministic snapshot tests (CI runs in UTC).
process.env.TZ = 'UTC';

import '@testing-library/jest-dom/vitest';
