import { Component, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught render error:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full items-center justify-center bg-surface p-6">
          <div className="w-full max-w-md rounded-lg border border-border bg-surface-raised p-6 text-center">
            <div className="mb-4 text-lg font-semibold text-white">Something went wrong</div>
            <p className="mb-4 text-sm text-gray-400">
              {this.state.error?.message || 'An unexpected error occurred while rendering this page.'}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="rounded bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-hover"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
