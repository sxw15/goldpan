'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  fallback: ReactNode;
  children: ReactNode;
  /** When this value changes, the error state is cleared without remounting children. */
  resetKey?: string | number;
}

interface State {
  hasError: boolean;
  prevResetKey?: string | number;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, prevResetKey: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (state.hasError && props.resetKey !== state.prevResetKey) {
      return { hasError: false, prevResetKey: props.resetKey };
    }
    if (props.resetKey !== state.prevResetKey) {
      return { prevResetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}
