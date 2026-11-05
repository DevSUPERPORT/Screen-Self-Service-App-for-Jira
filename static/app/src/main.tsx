/**
 * Custom UI bootstrap: imports the global styles and mounts App inside the error Boundary in React
 * StrictMode. The devtools audit hooks are imported only in development builds.
 *
 * @file        static/app/src/main.tsx
 * @app         Screen Self-Service for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-29
 * @updated     2026-11-05
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { Boundary } from './Boundary';

if (import.meta.env.DEV) void import('./devtools');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </StrictMode>,
);
