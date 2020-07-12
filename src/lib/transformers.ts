/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */

import { Readable, Writable } from "./Stream";
import { filter, map, Transform, batch } from "./Transform";

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

export function batcher<In>(maxBatchSize: number, minBatchSize = maxBatchSize, flushTimeout?: number): Transform<In, In[]> {
	return (readable: Readable<In>, writable: Writable<In[]>): void => {
		batch(readable, writable, minBatchSize, maxBatchSize, flushTimeout);
	};
}
