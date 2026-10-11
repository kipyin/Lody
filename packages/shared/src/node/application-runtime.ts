import { Cause, Deferred, Effect, Exit, Layer, ManagedRuntime, Ref } from 'effect';

/** One application owner; concurrent close joins its receipt, failed close retains recovery. */
export const makeApplicationRuntime = <R, E>(
  layer: Layer.Layer<R, E>,
  options: {
    readonly recover: (cause: Cause.Cause<unknown>) => Effect.Effect<void, unknown>;
    readonly project: (cause: Cause.Cause<unknown>) => unknown;
  }
) => {
  const runtime = ManagedRuntime.make(layer);
  const state = Ref.makeUnsafe<{
    disposed: boolean;
    failure?: Cause.Cause<unknown>;
    active?: Deferred.Deferred<void, unknown>;
  }>({ disposed: false });
  const closeEffect = Effect.uninterruptible(
    Effect.gen(function* () {
      const claim = yield* Ref.modify(state, (current) => {
        if (current.active)
          return [
            { first: false as boolean, done: current.active, previous: current },
            current,
          ] as const;
        const done = Deferred.makeUnsafe<void, unknown>();
        return [
          { first: true as boolean, done, previous: current },
          { ...current, active: done },
        ] as const;
      });
      if (!claim.first) return yield* Deferred.await(claim.done);
      const result = yield* (
        claim.previous.disposed
          ? claim.previous.failure
            ? options.recover(claim.previous.failure)
            : Effect.void
          : runtime.disposeEffect
      ).pipe(Effect.exit);
      yield* Ref.set(state, {
        disposed: true,
        ...(Exit.isFailure(result) ? { failure: claim.previous.failure ?? result.cause } : {}),
      });
      yield* Deferred.done(claim.done, result);
      return yield* result;
    })
  );
  return {
    runtime,
    isClosing: () => {
      const current = Ref.getUnsafe(state);
      return current.disposed || current.active !== undefined;
    },
    isReleased: () => {
      const current = Ref.getUnsafe(state);
      return current.disposed && !current.failure && !current.active;
    },
    /** @deprecated Execution/close boundary for an application still using Promise orchestration. */
    closeLegacy: (): Promise<void> =>
      Effect.runPromiseExit(closeEffect).then((exit) => {
        if (Exit.isFailure(exit)) throw options.project(exit.cause);
      }),
  };
};

export type ApplicationRuntime<R, E> = ReturnType<typeof makeApplicationRuntime<R, E>>;
