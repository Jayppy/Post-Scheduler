import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || 'Unexpected application error.',
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('Application ErrorBoundary caught error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      let parsedDetail = this.state.message;
      try {
        const parsed = JSON.parse(this.state.message);
        if (parsed?.error) {
          parsedDetail = `${parsed.operationType?.toUpperCase() || 'FIRESTORE'} error on ${
            parsed.path || 'database'
          }: ${parsed.error}`;
        }
      } catch {
        // non-JSON error message
      }

      return (
        <div className="min-h-screen bg-[#09090b] text-zinc-100 flex items-center justify-center p-6">
          <div className="max-w-lg w-full rounded-xl bg-[#111114] border border-red-500/40 p-6 space-y-4">
            <div className="flex items-center gap-3 text-red-400">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <h1 className="text-base font-semibold">Application Error Intercepted</h1>
            </div>
            <p className="text-xs text-zinc-300 font-mono leading-relaxed break-words bg-[#09090b] p-3 rounded border border-zinc-800">
              {parsedDetail}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-zinc-100 text-zinc-950 text-xs font-semibold hover:bg-white"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reload Studio</span>
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
