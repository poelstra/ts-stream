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
	handleError?: (e: Error, batch: T[]) => void;
};

/**
 * Transformer to pipe arrays of elements in regular batches.
 *
 * The stream keeps an internal queue. When the queue reaches `maxBatchSize`, all its
 * contents are written to the stream.
 *
 * If `minBatchSize` is set, the queue will try to write its contents to the stream
 * when the queue reaches `minBatchSize`, but only if there is no previous asynchronous
 * write in progress.
 *
 * In other words, `minBatchSize` declares the smallest batch that successive transforms
 * consider "worthwhile" to handle, while `maxBatchSize` declares the largest batch that
 * successive transforms can comfortably handle in a single operation (think writes to a
 * database or calls to an external API).
 *
 * If `flushTimeout` is set, the queue will always begin writing its contents within the
 * specified time period (in milliseconds). In the case of sources that provide sporadic
 * input over a long interval, this can be used to ensure that short bursts of input
 * aren't held up indefinitely as they wait for enough elements to cross the `minBatchSize`
 * threshold.
 *
 * When the stream ends, all remaining elements in the queue are written, regardless of any
 * thresholds.
 *
 * @param maxBatchSize The maximum length of batch for the stream to emit.
 * @param options.minBatchSize? The minimum length of batch that the stream will try to emit if
 * no write is in progress. Defaults to `maxBatchSize`.
 * @param options.flushTimeout? The interval in milliseconds after which the stream will emit
 * all source values, even if there are fewer than `minBatchSize` of them.
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
