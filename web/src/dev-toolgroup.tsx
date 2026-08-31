import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import type { ToolCall } from './api/types';
import { ToolGroup } from './components/ToolGroup';
import i18n from './i18n';
import './styles/index.css';

const steps: ToolCall[][] = [
  [{ tool: 'run_command', command: 'ls -la', status: 'running' }],
  [
    { tool: 'run_command', command: 'ls -la', status: 'done', output: 'ok' },
    { tool: 'sql_query', command: 'select * from users where id = 3', status: 'running' },
  ],
  [
    { tool: 'run_command', command: 'ls -la', status: 'done', output: 'ok' },
    { tool: 'sql_query', command: 'select 1', status: 'done', output: 'ok' },
    { tool: 'read_file', command: 'web/src/components/ToolGroup.tsx', status: 'running' },
  ],
  [
    { tool: 'run_command', command: 'ls -la', status: 'done', output: 'ok' },
    { tool: 'sql_query', command: 'select 1', status: 'done', output: 'ok' },
    { tool: 'read_file', command: 'web/src/components/ToolGroup.tsx', status: 'done', output: 'ok' },
  ],
];

function Demo() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((v) => (v + 1) % steps.length), 2200);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="p-8">
      <button type="button" className="mb-4 border px-2" onClick={() => setI((v) => (v + 1) % steps.length)}>
        step {i}
      </button>
      <ToolGroup entries={steps[i].map((call) => ({ kind: 'call' as const, call }))} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <Demo />
    </I18nextProvider>
  </StrictMode>,
);
