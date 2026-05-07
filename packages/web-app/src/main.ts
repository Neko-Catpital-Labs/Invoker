import { createApiClient } from './api-client';

export function init(app: HTMLElement = document.getElementById('app')!) {
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
