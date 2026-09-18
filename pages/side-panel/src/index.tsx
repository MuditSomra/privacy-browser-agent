import { createRoot } from 'react-dom/client';
import '@src/index.css';
import SidePanel from '@src/SidePanel';
import { ErrorBoundary } from '@src/components/ErrorBoundary';

function init() {
  const appContainer = document.querySelector('#app-container');
  if (!appContainer) {
    throw new Error('Can not find #app-container');
  }
  const root = createRoot(appContainer);
  root.render(
    <ErrorBoundary
      fallback={error => (
        <div className="flex h-screen w-screen flex-col items-center justify-center bg-slate-900 p-6 text-center text-white">
          <div className="rounded-2xl border border-slate-700 bg-slate-800/80 p-6 max-w-sm shadow-xl">
            <h2 className="text-base font-bold text-rose-400">Side Panel Error</h2>
            <p className="mt-2 text-xs text-slate-300 leading-relaxed">
              {error?.message || 'An unexpected rendering error occurred.'}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-500 cursor-pointer transition-colors">
              Reload Side Panel
            </button>
          </div>
        </div>
      )}>
      <SidePanel />
    </ErrorBoundary>,
  );
}

init();
