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
 * executes on every error and receives a parameter indicating the items that failed.
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
