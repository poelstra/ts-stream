/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */

import { Readable, Stream, Writable } from "./Stream";
import assert = require("assert");

export type Transform<In, Out> = (
	readable: Readable<In>,
	writable: Writable<Out>
) => void;

export function compose<In, Middle, Out>(
	t1: Transform<In, Middle>,
	t2: Transform<Middle, Out>
): Transform<In, Out> {
	return (readable: Readable<In>, writable: Writable<Out>): void => {
		const stream = new Stream<Middle>();
		t1(readable, stream);
		t2(stream, writable);
	};
}

// Return an ender callback that first runs an optional user-supplied ender,
// followed by the default ender that always ends the stream.
// It's refactored out, because it's currently a bit tricky and exact behavior
// may change, see TODO in implementation.
function composeEnders(
	ender: ((error?: Error) => void | PromiseLike<void>) | undefined,
	defaultEnder: (error?: Error) => void | PromiseLike<void>
): (error?: Error) => void | PromiseLike<void> {
	if (!ender) {
		return defaultEnder;
	}
	return (error?: Error) => {
		// TODO: an error returned from ender is currently passed on to next
		// stream, if stream was not ended with an error yet.
		// It'd maybe be better to not have the next stream be ended when an
		// error occurred in this ender, but there's no way to send another
		// end(), so we have to close it somehow...
		return Promise.resolve(error)
			.then(ender)
			.then(
				() => defaultEnder(error),
				(enderError: Error) => {
					// ender callback failed, but in order to let final stream fail,
					// we need to pass 'something' on, and to wait for that to come
					// back.
					// Finally, make sure to return the enderError.
					return Promise.resolve(
						defaultEnder(error || enderError)
					).then(
						() => Promise.reject(enderError),
						() => Promise.reject(enderError)
					);
				}
			);
	};
}

export function map<T, R>(
	readable: Readable<T>,
	writable: Writable<R>,
	mapper: (value: T) => R | PromiseLike<R>,
	ender?: (error?: Error) => void | PromiseLike<void>,
	aborter?: (error: Error) => void
): void {
	writable.aborted().catch((err) => readable.abort(err));
	readable.aborted().catch((err) => writable.abort(err));
	readable.forEach(
		(v: T) => writable.write(mapper(v)),
		composeEnders(ender, (error?: Error) =>
			writable.end(error, readable.result())
		),
		aborter
	);
}

export function filter<T>(
	readable: Readable<T>,
	writable: Writable<T>,
	filterer: (value: T) => boolean | PromiseLike<boolean>,
	ender?: (error?: Error) => void | PromiseLike<void>,
	aborter?: (error: Error) => void
): void {
	writable.aborted().catch((err) => readable.abort(err));
	readable.aborted().catch((err) => writable.abort(err));
	readable.forEach(
		(v: T): void | Promise<void> => {
			const b = filterer(v);
			if (!b) {
				return;
			} else if (b === true) {
				// note: not just `if (b)`!
				return writable.write(v);
			} else {
				// more complex return type, probably a PromiseLike
				return Promise.resolve(b).then((resolvedB) => {
					if (resolvedB) {
						return writable.write(v);
					}
				});
			}
		},
		composeEnders(ender, (error?: Error) =>
			writable.end(error, readable.result())
		),
		aborter
	);
}

export function batch<T>(
	readable: Readable<T>,
	writable: Writable<T[]>,
	maxBatchSize: number,
	minBatchSize = maxBatchSize,
	flushTimeout: number | undefined
): void {
	let isAborted = false;

	writable.aborted().catch((err: Error) => {
		readable.abort(err);
		isAborted = true;
	});
	readable.aborted().catch((err) => {
		writable.abort(err);
	});

	let queue: T[] = [];
	let timer: NodeJS.Timer | undefined;
	let pendingWrite = false;

	async function flush() {
		console.log("flush");

		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}

		if (queue.length) {
			const peeled = queue;
			queue = [];

			if (!isAborted) {
				console.log("writable.write");

				await writable.write(peeled);
			}
		}
	}

	let earlyError: Error | undefined;
	async function earlyFlush(): Promise<void> {
		console.log(JSON.stringify({ pendingWrite: pendingWrite }));

		if (!pendingWrite && earlyError === undefined) {
			try {
				do {
					pendingWrite = true;
					await flush();
					pendingWrite = false;
				} while (queue.length >= minBatchSize);
			} catch (err) {
				pendingWrite = false;
				console.log(`${earlyError} = ${err}`);

				earlyError = err;
			}
		}
	}

	function consumeEarlyEndError() {
		const result = earlyError;
		earlyError = undefined;
		return result;
	}

	function throwIfThrowable(e: Error | undefined) {
		if (e) {
			throw e;
		}
	}

	readable.forEach(
		async (v: T): Promise<void> => {
			queue.push(v);
			let flushFailureError: Error | undefined;

			if (queue.length >= maxBatchSize) {
				// backpressure
				try {
					await flush();
				} catch (e) {
					flushFailureError = e;
				}
			} else if (queue.length >= minBatchSize && !pendingWrite) {
				// no backpressure yet (until new queue fills to maxBatchSize)
				earlyFlush();
			} else if (
				queue.length &&
				flushTimeout !== undefined &&
				!pendingWrite
			) {
				if (timer !== undefined) {
					clearTimeout(timer);
				}
				timer = setTimeout(earlyFlush, flushTimeout);
			}

			throwIfThrowable(consumeEarlyEndError());
			throwIfThrowable(flushFailureError);
		},
		async (error?: Error) => {
			// collect early error
			// try to flush
			// end writable with error argument (if above did not fail)
			// or with the failure (if above did fail, error argument taking precedence if present)
			// if above did fail, throw that failure

			const earlyError = consumeEarlyEndError();
			let flushError: Error | undefined;
			try {
				await flush();
			} catch (e) {
				flushError = e;
			}

			console.log("writable.end");

			await writable.end(
				error || earlyError || flushError,
				readable.result()
			);
			throwIfThrowable(earlyError || flushError);

			//----
			// console.log(JSON.stringify({ "pendingWrite.end": pendingWrite }));
			// console.log(JSON.stringify({ "queue.end": queue }));
			// let toThrow = error;
			// try {
			// 	await flush();
			// } catch (e) {
			// 	toThrow = e;
			// }
			// await writable.end(toThrow, readable.result());
			// throwIfThrowable(consumeEarlyEndError());
		},
		flush
	);
}

export default Transform;
