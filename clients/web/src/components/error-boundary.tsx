import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  /** Rendered in place of `children` after a render error is caught. */
  fallback: ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Minimal render-error boundary. Keeps a crashed subtree from unwinding the
 * whole app: once `getDerivedStateFromError` fires, `fallback` renders until
 * the subtree is remounted with a new `key`.
 *
 * Pair it with `captureError` in an `onError`-style hook or the router's
 * `onError` for observability — this component only owns the UI swap.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  public state: ErrorBoundaryState = { hasError: false };

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[error_boundary]", error, info.componentStack);
  }

  public render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}
