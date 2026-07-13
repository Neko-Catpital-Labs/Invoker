import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import { installWebInvoker } from './web/web-invoker-client.js';
import './index.css';
import 'xterm/css/xterm.css';

installWebInvoker({});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
