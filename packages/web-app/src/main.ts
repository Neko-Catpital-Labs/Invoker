import { createApiClient } from './api-client';
import { featureFlags } from './feature-flags';

export function init(app: HTMLElement = document.getElementById('app')!) {
  if (featureFlags.AUTH_ENABLED) {
    app.textContent = 'Auth: not implemented';
    app.dataset.state = 'auth-placeholder';
    return;
  }

  app.textContent = 'Loading…';
  app.dataset.state = 'loading';

  const client = createApiClient();

  client.hello().then(
    (data) => {
      app.textContent = data.message;
      app.dataset.state = 'success';
    },
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      app.textContent = `Error: ${msg}`;
      app.dataset.state = 'error';
    },
  );
}

const root = document.getElementById('app');
if (root) init(root);
