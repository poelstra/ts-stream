/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */

import { Readable, Writable } from "./Stream";
import { batch, filter, map, Transform } from "./Transform";

export function mapper<In, Out>(
	mapFn: (value: In) => Out | PromiseLike<Out>
): Transform<In, Out> {
	return (readable: Readable<In>, writable: Writable<Out>): void => {
		map(readable, writable, mapFn);
	};
}

export function filterer<T>(
	filterFn: (value: T) => boolean | PromiseLike<boolean>
): Transform<T, T> {
	return (readable: Readable<T>, writable: Writable<T>): void => {
		filter(readable, writable, filterFn);
	};
}

export type BatcherOptions<T> = {
	minBatchSize?: number;
	flushTimeout?: number;
	handleError?: (e: Error, batch: T[]) => void | PromiseLike<void>;
};

/**
 * Transformer that pipes arrays of elements in regular batches. Useful to gather
 * items together for more efficient bulk operations, like writing rows to a database
 * or saving files to a remote data store.
 *
 * The transformer tries to emit batches of size `maxBatchSize` with the items it
 * receives. If items are left over when the stream ends, it emits them as a batch.
 *
 * With `minBatchSize` set, the stream's behaviour depends on backpressure from downstream
 * (i.e., if there are any async reads in progress). If there is no backpressure, it will
 * emit a batch of size `minBatchSize` as soon as possible. If there is backpressure, it
 * will wait until it has a batch of `maxBatchSize` before emitting it.
 *
 * You can think of `maxBatchSize` as the largest batch that you *can* process at once,
 * while `minBatchSize` is the smallest batch that is *worth* processing all at once
 * for efficiency.
 *
 * If `flushTimeout` is set, the stream will wait no longer than `flushTimeout` milliseconds
 * to emit a batch. This is useful to avoid holding onto items during periods of inactivity
 * in a long-running stream, like when processing input from an event listener.
 *
 * The optional `handleError` parameter is a function that runs each time an error occurs
 * during downstream processing of writes. If it throws an error, that error becomes the
 * write error to throw upstream; if it doesn't, the error is considered resolved and won't
 * be thrown.
 *
 * Because the batcher's write operation sometimes occurs "in the background" while the
 * batcher is still actively reading items, it is not guaranteed that the caller will receive
 * all errors that occurred (although it is guaranteed that the caller will receive at least one,
 * if one error did in fact occur). The `handleError` parameter overcomes this limitation: it
 * executes on every error and receives a parameter indicating the batch that experienced the
 * failure.
 *
 * @param maxBatchSize The maximum length of batch for the stream to emit.
 * @param options.minBatchSize? The minimum length of batch that the stream will try to emit if
 * no write is in progress. Defaults to `maxBatchSize`.
 * @param options.flushTimeout? The interval in milliseconds after which the stream will emit
 * all source values, even if there are fewer than `minBatchSize` of them.
 * @param options.handleError? If set, any write error this stream would throw will instead be run
 * through the provided function, with the error as the first argument and the second argument being
 * the batch that experienced the failure.
 * If handleError throws an error, that error will be thrown by the stream as normal; if not, the
 * error will be ignored and the stream will continue.
 * @return New readable stream emitting values from its source in batches.
 */
export function batcher<T>(
	maxBatchSize: number,
	options: BatcherOptions<T> = {}
): Transform<T, T[]> {
	return (readable: Readable<T>, writable: Writable<T[]>): void => {
		batch(readable, writable, maxBatchSize, options);
	};
}

/**
 * Transform to intercept downstream errors on stream end before they reach the
 * upstream source and propagate back down.
 *
 * This is a niche utility. It only needs to be used when you want your *source* to
 * recover from errors thrown by downstream enders.
 *
 * By default, any time a call to `end()` throws an error, that error gets thrown
 * from the ended stream's `result()`. However, if the caller provides an upstream's
 * `result()` as the second parameter to `end()`, this behaviour is averted and the
 * stream's `result()` will instead depend on that Promise (which can be resolved
 * or rejected as the upstream chooses).
 *
 * However, if it's the source that is calling `end()`, there is no upstream to use
 * as the ender's second argument. This means the source cannot properly catch errors
 * before they are sent to the downstream's `result()`.
 *
 * With the `endCatcher()` transform, you can simulate the behaviour of try-catch in
 * this special case. To recover from the error, have `handleError()` return normally.
 * To fail, simply re-throw the provided error (or a new, more appropriate Error).
 *
 * @example
 * // Without endCatcher()
 * getRowsFromDatabase<MyObject>(myQuery)
 *   .transform(
 *     // other transforms etc
 *   )
 *   .forEach(
 *     process,
 *     () => {
 *       if (someCondition) {
 *         throw new NotAllRowsProcessedError();
 *       }
 *     }
 *   ); // This throws a rejection, when the source uses the default behavior of bouncing an error into result
 *
 * // With endCatcher()
 * getRowsFromDatabase<MyObject>(myQuery)
 *   .transform(
 *     endCatcher((err: Error) => {
 *       if (
 *         err instanceof NotAllObjectsProcessedError
 *       ) {
 *         // ignore
 *       } else {
 *         // re-throw all other errors
 *         throw err;
 *       }
 *     })
 *   )
 *   .transform(
 *     // other transforms etc
 *   )
 *   .forEach(
 *     process,
 *     () => {
 *       if (someCondition) {
 *         throw new NotAllObjectsProcessedError();
 *       }
 *     }
 *   ); // No longer throws the error, because handleError() returns successfully
 *
 * @param handleError
 */
export function endCatcher<T>(
	handleError: (e: Error) => void | PromiseLike<void>
): Transform<T, T> {
	return (readable: Readable<T>, writable: Writable<T>): void => {
		writable.aborted().catch((err) => readable.abort(err));
		readable.aborted().catch((err) => writable.abort(err));
		readable.forEach(
			(value: T) => writable.write(value),
			(error?: Error) =>
				writable.end(error, readable.result()).catch(handleError)
		);
	};
}
