export interface ShutdownSignalTarget {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

export interface GracefulShutdownOptions {
  cleanup: (signal: NodeJS.Signals) => Promise<void> | void;
  onError?: (error: Error) => void;
  exit?: (code: number) => void;
  signalTarget?: ShutdownSignalTarget;
}

export interface GracefulShutdownController {
  isShutdownRequested(): boolean;
  markReady(): Promise<number | null>;
  request(signal: NodeJS.Signals): Promise<number>;
  dispose(): void;
}

/**
 * Installs idempotent SIGINT/SIGTERM handlers before a worker's first awaited
 * startup pass.
 *
 * A signal received during that pass is remembered instead of terminating the
 * process with Node's default signal action. Calling {@link markReady} after
 * the pass starts cleanup exactly once. Keeping both listeners installed also
 * makes a repeated signal join the same cleanup instead of interrupting it.
 */
export function createGracefulShutdownController(
  options: GracefulShutdownOptions,
): GracefulShutdownController {
  const target = options.signalTarget ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let ready = false;
  let requestedSignal: NodeJS.Signals | null = null;
  let cleanupPromise: Promise<number> | null = null;
  let resolvePending: ((code: number) => void) | null = null;
  const pending = new Promise<number>((resolve) => {
    resolvePending = resolve;
  });

  const runCleanup = (): Promise<number> => {
    if (cleanupPromise) return cleanupPromise;
    const signal = requestedSignal;
    if (!ready || !signal) return pending;

    cleanupPromise = Promise.resolve()
      .then(() => options.cleanup(signal))
      .then(
        () => 0,
        (cause: unknown) => {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          options.onError?.(error);
          return 1;
        },
      )
      .then((code) => {
        resolvePending?.(code);
        exit(code);
        return code;
      });
    return cleanupPromise;
  };

  const request = (signal: NodeJS.Signals): Promise<number> => {
    requestedSignal ??= signal;
    return runCleanup();
  };
  const onSigint = () => {
    void request('SIGINT');
  };
  const onSigterm = () => {
    void request('SIGTERM');
  };

  target.on('SIGINT', onSigint);
  target.on('SIGTERM', onSigterm);

  return {
    isShutdownRequested: () => requestedSignal !== null,
    markReady: () => {
      ready = true;
      return requestedSignal ? runCleanup() : Promise.resolve(null);
    },
    request,
    dispose: () => {
      target.off('SIGINT', onSigint);
      target.off('SIGTERM', onSigterm);
    },
  };
}
