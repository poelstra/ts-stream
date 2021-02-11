/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */

/* istanbul ignore next */ // ignores Typescript's __extend() function

import BaseError from "./BaseError";
import { filter, map, Transform } from "./Transform";
import {
	defer,
	Deferred,
	noop,
	swallowErrors,
	track,
	TrackedPromise,
} from "./util";

/**
 * Required methods for both readable and writable parts of a stream.
 */
export interface Common<T> {
	/**
	 * Obtain a promise that resolves when all parts of a stream chain have
	 * completely ended.
	 *
	 * Specifically:
	 * - `end()` has been called (possibly with an Error),
	 * - `ender` callback has run and its returned promise resolved,
	 * - `end()`'s result parameter (if any) has been resolved.
	 *
	 * @return Promise resolved when stream chain has completely ended
	 */
	result(): Promise<void>;

	/**
	 * Signal that the stream is aborted: it will no longer read incoming
	 * elements and will no longer write elements except in the course of
	 * processing any pending asynchronous reader callbacks (i.e. unresolved
	 * Promises returned by `forEach()` or other stream iterators). Does not
	 * end the stream.
	 *
	 * An upstream source can handle this `abort()` by catching the exception
	 * from its own `aborted()` method--for example, to cancel pending fetch
	 * operations, or close a continuous data stream.
	 *
	 * If the stream's `forEach()` function provided an `aborter` callback and
	 * the stream is not yet ended, `aborter` will be called with the abort reason.
	 * This can be used to cancel any remaining operations inside the asynchronous
	 * reader callback.
	 *
	 * Once the last pending callback is resolved, any pending and future `write()`s
	 * to this stream will be rejected with the error provided to `abort()`.
	 *
	 * It is still necessary to explicitly `end()` the stream, to ensure that any
	 * resources can be cleaned up correctly both on the reader and writer side.
	 * The stream's `ender` callback will be called with the abort error (i.e. any
	 * error passed to `end()` is ignored.)
	 *
	 * The abort is ignored if the stream is already aborted.
	 *
	 * It's possible to abort an ended stream. This can be used to 'bubble' an
	 * abort signal to other parts in a chain of streams which may not have ended
	 * yet. It will not change the end-state of this part of the stream though.
	 *
	 * @param reason Optional Error value to signal a reason for the abort
	 */
	abort(reason?: Error): void;

	/**
	 * Obtain promise that resolves to a rejection when `abort()` is called.
	 *
	 * Useful to pass abort to upstream sources.
	 *
	 * Note: this promise either stays pending, or is rejected. It is never
	 * fulfilled.
	 *
	 * @return Promise that is rejected with abort error when stream is aborted
	 */
	aborted(): Promise<never>;

	/**
	 * Obtain promise that resolves to a rejection when `abort()` is called.
	 *
	 * Useful to pass abort to upstream sources.
	 *
	 * Note: this promise either stays pending, or is rejected. It is never
	 * fulfilled.
	 *
	 * @return Promise that is rejected with abort error when stream is aborted
	 */
	aborted(aborter: (reason: Error) => void): void;
}

/**
 * Required methods for the readable part of a stream.
 */
export interface Readable<T> extends Common<T> {
	/**
	 * Read all values from stream, optionally waiting for explicit stream end.
	 *
	 * `reader` is called for every written value.
	 *
	 * `ender` is called once, when the writer `end()`s the stream, either with
	 * or without an error.
	 *
	 * `reader` and `ender` callbacks can return a promise to indicate when the
	 * value or end-of-stream condition has been completely processed. This
	 * ensures that a fast writer can never overload a slow reader, and is
	 * called 'backpressure'.
	 *
	 * The `reader` callback is never called while its previously returned
	 * promise is still pending, and the `ender` callback is likewise only
	 * called after all reads have completed.
	 *
	 * The corresponding `write()` or `end()` operation is blocked until the
	 * value returned from the reader or ender callback is resolved. If the
	 * callback throws an error or the returned promise resolves to a rejection,
	 * the `write()` or `end()` will be rejected with it.
	 *
	 * All callbacks are always called asynchronously (i.e. some time after
	 * `forEach()`, `write()`, `end()` or `abort()` returns), and their `this`
	 * argument will be undefined.
	 *
	 * `aborter` is called once if the stream is aborted and has not ended yet.
	 * (I.e. it will be called if e.g. `ender`'s returned promise is still
	 * pending, to allow early termination, but it will no longer be called
	 * if its promise has resolved).
	 *
	 * The `aborter` callback can be called while a reader callback's promise is
	 * still pending, and should try to let `reader` or `ender` finish as fast
	 * as possible.
	 *
	 * Note that even when a stream is aborted, it still needs to be `end()`'ed
	 * correctly.
	 *
	 * If no `ender` is given, a default end handler is installed that directly
	 * acknowledges the end-of-stream, also in case of an error. Note that that
	 * error will still be returned from `forEach()`.
	 *
	 * If no `aborter` is given, an abort is ignored (but will still cause
	 * further writes to fail, and it will be reflected in the returned promise).
	 *
	 * It is an error to call `forEach()` multiple times, and it is not possible
	 * to 'detach' already attached callbacks. Reason is that the exact behaviour
	 * of such actions (e.g. block or simply ignore further writes) is application
	 * dependent, and should be implemented as a transform instead.
	 *
	 * The return value of `forEach()` is `result()`, a promise that resolves
	 * when all parts in the stream(-chain) have completely finished.
	 *
	 * @param reader  Callback called with every written value
	 * @param ender   Optional callback called when stream is ended
	 * @param aborter Optional callback called when stream is aborted
	 * @return Promise for completely finished stream, i.e. same promise as `result()`
	 */
	forEach(
		reader: (value: T) => void | PromiseLike<void>,
		ender?: (error?: Error) => void | PromiseLike<void>,
		aborter?: (error: Error) => void
	): Promise<void>;
}

/**
 * Required methods for the writable part of a stream.
 */
export interface Writable<T> extends Common<T> {
	/**
	 * Write value (or promise for value) to stream.
	 *
	 * Writer is blocked until the value is read by the read handler passed to
	 * `forEach()`, and the value returned by that read handler is resolved.
	 *
	 * It is an error to write an `undefined` value (as this is a common
	 * programming error). Writing a promise for a void is currently allowed,
	 * but discouraged.
	 *
	 * The promise returned by `write()` will be rejected with the same reason if:
	 * - the written value is a PromiseLike that resolves to a rejection
	 * - the read handler throws an error or returns a rejected promise
	 * It is still possible to write another value after that, or e.g. `end()`
	 * the stream with or without an error.
	 *
	 * @param value Value to write, or promise for it
	 * @return Void-promise that resolves when value was processed by reader
	 */
	write(value: T | PromiseLike<T>): Promise<void>;

	/**
	 * End the stream, optionally passing an error.
	 *
	 * Already pending writes will be processed by the reader passed to
	 * `forEach()` before passing the end-of-stream to its end handler.
	 *
	 * The returned promise will resolve after the end handler has finished
	 * processing. It is rejected if the end handler throws an error or returns
	 * a rejected promise.
	 *
	 * All calls to `write()` or `end()` after the first `end()` will be
	 * rejected with a `WriteAfterEndError`.
	 *
	 * By default, this stream's `result()` will be resolved when `end()`
	 * resolves, or rejected with the error if `end()` is called with an error.
	 * It is possible to let this stream's `result()` 'wait' until any upstream
	 * streams have completed by e.g. passing that upstream's `result()` as the
	 * second argument to `end()`.
	 *
	 * Note: even if a stream is aborted, it is still necessary to call `end()`
	 * to allow any resources to correctly be cleaned up.
	 *
	 * @param  error Optional Error to pass to `forEach()` end handler
	 * @param  result Optional promise that determines final value of `result()`
	 * @return Void-promise that resolves when `ended`-handler has processed the
	 *         end-of-stream
	 */
	end(error?: Error, result?: PromiseLike<void>): Promise<void>;
}

export interface CommonStream<T> {
	/**
	 * Determine whether `end()` has been called on the stream, but the stream
	 * is still processing it.
	 *
	 * @return true when `end()` was called but not acknowledged yet, false
	 *         otherwise
	 */
	isEnding(): boolean;

	/**
	 * Determine whether stream has completely ended (i.e. end handler has been
	 * called and its return PromiseLike, if any, is resolved).
	 *
	 * @return true when stream has ended, false otherwise
	 */
	isEnded(): boolean;

	/**
	 * Determine whether `end()` has been called on the stream.
	 *
	 * @return true when `end()` was called
	 */
	isEndingOrEnded(): boolean;

	/**
	 * Determine whether `forEach()` callback(s) are currently attached to the
	 * stream.
	 *
	 * @return true when `forEach()` has been called on this stream
	 */
	hasReader(): boolean;
}

/**
 * Readable part of a generic Stream, which contains handy helpers such as
 * .map() in addition to the basic requirements of a Readable interface.
 */
export interface ReadableStream<T> extends Readable<T>, CommonStream<T> {
	/**
	 * Run all input values through a mapping callback, which must produce a new
	 * value (or promise for a value), similar to e.g. `Array`'s `map()`.
	 *
	 * Stream end in the input stream (normal or with error) will be passed to
	 * the output stream, after awaiting the result of the optional ender.
	 *
	 * Any error (thrown or rejection) in mapper or ender is returned to the
	 * input stream.
	 *
	 * @param mapper  Callback which receives each value from this stream, and
	 *                must produce a new value (or promise for a value)
	 * @param ender   Called when stream is ending, result is waited for before
	 *                passing on `end()`
	 * @param aborter Called when stream is aborted
	 * @return New stream with mapped values
	 */
	map<R>(
		mapper: (value: T) => R | PromiseLike<R>,
		ender?: (error?: Error) => void | PromiseLike<void>,
		aborter?: (error: Error) => void
	): ReadableStream<R>;

	/**
	 * Run all input values through a filtering callback. If the filter callback
	 * returns a truthy value (or a promise for a truthy value), the input value
	 * is written to the output stream, otherwise it is ignored.
	 * Similar to e.g. `Array`'s `filter()`.
	 *
	 * Stream end in the input stream (normal or with error) will be passed to
	 * the output stream, after awaiting the result of the optional ender.
	 *
	 * Any error (thrown or rejection) in mapper or ender is returned to the
	 * input stream.
	 *
	 * @param filterer Callback which receives each value from this stream,
	 *                 input value is written to output if callback returns a
	 *                 (promise for) a truthy value.
	 * @param ender    Called when stream is ending, result is waited for before
	 *                 passing on `end()`
	 * @param aborter  Called when stream is aborted
	 * @return New stream with filtered values.
	 */
	filter(
		filterer: (value: T) => boolean | PromiseLike<boolean>,
		ender?: (error?: Error) => void | PromiseLike<void>,
		aborter?: (error: Error) => void
	): ReadableStream<T>;

	/**
	 * Reduce the stream into a single value by calling a reducer callback for
	 * each value in the stream. Similar to `Array#reduce()`.
	 *
	 * The output of the previous call to `reducer` (aka `accumulator`) is given
	 * as the first argument of the next call. For the first call, either the
	 * `initial` value to `reduce()` is passed, or the first value of the stream
	 * is used (and `current` will be the second value).
	 *
	 * The result of `reduce()` is a promise for the last value returned by
	 * `reducer` (or the initial value, if there were no calls to `reducer`).
	 * If no initial value could be determined, the result is rejected with a
	 * TypeError.
	 * If the stream is ended with an error, the result is rejected with that
	 * error.
	 *
	 * It is possible for `reducer` to return a promise for its result.
	 *
	 * If the `reducer` throws an error or returns a rejected promise, the
	 * originating `write()` will fail with that error.
	 *
	 * Examples:
	 * s.reduce((acc, val) => acc + val); // sums all values
	 * s.reduce((acc, val) => { acc.push(val); return acc; }, []); // toArray()
	 *
	 * @param  reducer Callback called for each value in the stream, with
	 *                 accumulator, current value, index of current value, and
	 *                 this stream.
	 * @param  initial Optional initial value for accumulator. If no initial
	 *                 value is given, first value of stream is used.
	 * @return Promise for final accumulator.
	 */
	reduce(
		reducer: (
			accumulator: T,
			current: T,
			index: number,
			stream: ReadableStream<T>
		) => T | PromiseLike<T>,
		initial?: T
	): Promise<T>;
	/**
	 * Reduce the stream into a single value by calling a reducer callback for
	 * each value in the stream. Similar to `Array#reduce()`.
	 *
	 * The output of the previous call to `reducer` (aka `accumulator`) is given
	 * as the first argument of the next call. For the first call, either the
	 * `initial` value to `reduce()` is passed, or the first value of the stream
	 * is used (and `current` will be the second value).
	 *
	 * The result of `reduce()` is a promise for the last value returned by
	 * `reducer` (or the initial value, if there were no calls to `reducer`).
	 * If no initial value could be determined, the result is rejected with a
	 * TypeError.
	 * If the stream is ended with an error, the result is rejected with that
	 * error.
	 *
	 * It is possible for `reducer` to return a promise for its result.
	 *
	 * If the `reducer` throws an error or returns a rejected promise, the
	 * originating `write()` will fail with that error.
	 *
	 * Examples:
	 * s.reduce((acc, val) => acc + val); // sums all values
	 * s.reduce((acc, val) => { acc.push(val); return acc; }, []); // toArray()
	 *
	 * @param  reducer Callback called for each value in the stream, with
	 *                 accumulator, current value, index of current value, and
	 *                 this stream.
	 * @param  initial Optional initial value for accumulator. If no initial
	 *                 value is given, first value of stream is used.
	 * @return Promise for final accumulator.
	 */
	reduce<R>(
		reducer: (
			accumulator: R,
			current: T,
			index: number,
			stream: ReadableStream<T>
		) => PromiseLike<R>,
		initial: R
	): Promise<R>;
	/**
	 * Reduce the stream into a single value by calling a reducer callback for
	 * each value in the stream. Similar to `Array#reduce()`.
	 *
	 * The output of the previous call to `reducer` (aka `accumulator`) is given
	 * as the first argument of the next call. For the first call, either the
	 * `initial` value to `reduce()` is passed, or the first value of the stream
	 * is used (and `current` will be the second value).
	 *
	 * The result of `reduce()` is a promise for the last value returned by
	 * `reducer` (or the initial value, if there were no calls to `reducer`).
	 * If no initial value could be determined, the result is rejected with a
	 * TypeError.
	 * If the stream is ended with an error, the result is rejected with that
	 * error.
	 *
	 * It is possible for `reducer` to return a promise for its result.
	 *
	 * If the `reducer` throws an error or returns a rejected promise, the
	 * originating `write()` will fail with that error.
	 *
	 * Examples:
	 * s.reduce((acc, val) => acc + val); // sums all values
	 * s.reduce((acc, val) => { acc.push(val); return acc; }, []); // toArray()
	 *
	 * @param  reducer Callback called for each value in the stream, with
	 *                 accumulator, current value, index of current value, and
	 *                 this stream.
	 * @param  initial Optional initial value for accumulator. If no initial
	 *                 value is given, first value of stream is used.
	 * @return Promise for final accumulator.
	 */
	reduce<R>(
		// tslint:disable-next-line:unified-signatures
		reducer: (
			accumulator: R,
			current: T,
			index: number,
			stream: ReadableStream<T>
		) => R,
		initial: R
	): Promise<R>;

	/**
	 * Read all stream values into an array.
	 *
	 * Returns a promise that resolves to that array if the stream ends
	 * normally, or to the error if the stream is ended with an error.
	 *
	 * @return Promise for an array of all stream values
	 */
	toArray(): Promise<T[]>;

	/**
	 * Read all values and end-of-stream from this stream, writing them to
	 * `writable`.
	 *
	 * @param  writable Destination stream
	 * @return The stream passed in, for easy chaining
	 */
	pipe<R extends Writable<T>>(writable: R): R;

	/**
	 * Return a new stream with the results of running the given
	 * transform.
	 *
	 * @param transformer Function that receives this stream and result stream
	 *                    as inputs.
	 * @return Readable stream with the transformed results
	 */
	transform<R>(transformer: Transform<T, R>): ReadableStream<R>;
}

/**
 * Writable part of a generic Stream, which contains handy helpers such as
 * .mappedBy() in addition to the basic requirements of a Writable interface.
 */
export interface WritableStream<T> extends Writable<T>, CommonStream<T> {
	/**
	 * Repeatedly call `writer` and write its returned value (or promise for it)
	 * to the stream.
	 * The stream is ended when `writer` returns `undefined` (or a promise that
	 * resolves to `undefined`).
	 *
	 * `writer` is only called again when its previously returned value has been
	 * processed by the stream.
	 *
	 * If writing of a value fails (either by the `writer` throwing an error,
	 * returning a rejection, or the write call failing), the stream is aborted
	 * and ended with that error.
	 *
	 * `ender` is always called once, just before the stream is ended. I.e.
	 * after `writer` returned (a promise for) `undefined` or the stream is
	 * aborted.
	 * It can be used to e.g. close a resource such as a database.
	 * Note: `ender` will only be called when `writer`'s promise (if any) has
	 * resolved.
	 *
	 * `aborter` is called once iff the stream is aborted. It can be called
	 * while e.g. a promise returned from the writer or ender is still pending,
	 * and can be used to make sure that that promise is resolved/rejected
	 * sooner.
	 * Note: the aborter should be considered a 'signal to abort', but cleanup
	 * of resources should be done in the `ender` (i.e. it cannot return a
	 * promise).
	 * It can be called (long) after `ender` has been called, because a stream
	 * can be aborted even after it is already ended, which is useful if this
	 * stream element is part of a larger chain of streams.
	 * An aborter must never throw an error.
	 *
	 * @param writer Called when the next value can be written to the stream,
	 *               should return (a promise for) a value to be written,
	 *               or `undefined` (or void promise) to end the stream.
	 *               Will always be called asynchronously.
	 * @param ender Optional callback called once after `writer` indicated
	 *              end-of-stream, or when the stream is aborted (and
	 *              previously written value resolved/rejected). It's called
	 *              without an argument if stream was not aborted (yet), and
	 *              the abort reason if it was aborted (`aborter` will have
	 *              been called, too). Will always be called asynchronously.
	 * @param aborter Optional callback called once when stream is aborted.
	 *                Receives abort reason as its argument. Should be used
	 *                to prematurely terminate any pending promises of
	 *                `writer` or `ender`. Will always be called
	 *                asynchronously. Can be called before and after
	 *                `writer` or `ender` have been called, even when `ender`
	 *                is completely finished (useful to e.g. abort other streams, which may
	 *                not be aborted yet).
	 *                Must not throw any errors, will lead to unhandled
	 *                rejected promise if it does.
	 * @return Promise for completely finished stream, i.e. same promise as `result()`
	 */
	writeEach(
		writer: () => T | undefined | void | PromiseLike<T | undefined | void>,
		ender?: (abortReason?: Error) => void | PromiseLike<void>,
		aborter?: (abortReason: Error) => void
	): Promise<void>;

	// TODO Experimental
	// TODO Not sure whether a 'reverse' function confuses more than it helps
	mappedBy<X>(mapper: (value: X) => T | PromiseLike<T>): WritableStream<X>;

	// TODO Experimental
	// TODO Not sure whether a 'reverse' function confuses more than it helps
	filterBy(
		filterer: (value: T) => boolean | PromiseLike<boolean>
	): WritableStream<T>;
}

/**
 * Used when writing to an already-ended stream.
 */
export class WriteAfterEndError extends BaseError {
	constructor() {
		super("WriteAfterEndError", "stream already ended");
	}
}

/**
 * Used when read callback(s) have already been attached.
 */
export class AlreadyHaveReaderError extends BaseError {
	constructor() {
		super("AlreadyHaveReaderError", "stream already has a reader");
	}
}

/**
 * Special internal 'error' value to indicate normal stream end.
 */
const EOF = new Error("eof");

/**
 * Special end-of-stream value, optionally signalling an error.
 */
class Eof {
	public error?: Error;
	public result?: PromiseLike<void>;

	/**
	 * Create new end-of-stream value, optionally signalling an error.
	 * @param error     Optional Error value
	 * @param result Optional final result value of `result()`
	 */
	constructor(error?: Error, result?: PromiseLike<void>) {
		this.error = error;
		this.result = result;
	}
}

/**
 * Written value-promise and a function to resolve the corresponding `write()`
 * call's return promise.
 */
interface WriteItem<T> {
	/**
	 * Resolver `write()`'s returned promise
	 */
	resolveWrite: (done?: void | PromiseLike<void>) => void;

	/**
	 * Promise for value passed to `write()`.
	 * Either a special Eof value, or a value of type `T`.
	 */
	value: Eof | TrackedPromise<T>;
}

/**
 * Object stream with seamless support for backpressure, ending and error
 * handling.
 */
export class Stream<T> implements ReadableStream<T>, WritableStream<T> {
	/**
	 * Writers waiting for `_reader` to retrieve and process their value.
	 */
	private _writers: WriteItem<T>[] = [];

	/**
	 * Read handler that is called for every written value, as set by
	 * `forEach()`.
	 */
	private _reader?: (value: T) => void | PromiseLike<void>;

	/**
	 * End handler that is called when the stream is ended, as set by
	 * `forEach()`. Note that `forEach()` installs a default handler if the user
	 * did not supply one.
	 * Set to 'undefined' when it has been called.
	 */
	private _ender?: (error?: Error) => void | PromiseLike<void>;

	/**
	 * Abort handler that is called when the stream is aborted, as set by
	 * `forEach()` (can be undefined).
	 * Set to 'undefined' when it has been called.
	 */
	private _aborter?: (error: Error) => void;

	/**
	 * When a written value is being processed by the `_reader`, this property
	 * is set to a promise that resolves when the reader's returned PromiseLike is
	 * resolved (or rejected).
	 */
	private _readBusy?: TrackedPromise<void>;

	/**
	 * Set to an instance of an Eof object, containing optional error and final
	 * result of this stream. Set when `end()` is called.
	 */
	private _ending?: Eof;

	/**
	 * Set to an instance of an Eof object, containing optional error and final
	 * result of this stream. Set when `_ender` is being called but not finished
	 * yet, unset when `_ended` is set.
	 */
	private _endPending?: Eof;

	/**
	 * Set to the error passed to `end()` (or the special value `eof`) when the
	 * stream has ended, and the operation was confirmed by the `_ender`.
	 */
	private _ended?: Error;

	/**
	 * Set to a rejected promise when the stream is explicitly `abort()`'ed.
	 */
	private _abortPromise?: Promise<void>;
	/**
	 * Error given in abort() method
	 */
	private _abortReason?: Error;

	/**
	 * Resolved to a rejection when `abort()` is called.
	 */
	private _abortDeferred: Deferred<never> = defer<never>();

	/**
	 * Resolved to the result of calling `_ender`, then the `result` property of
	 * the end-of-stream value.
	 */
	private _resultDeferred: Deferred<void> = defer();

	/**
	 * Write value (or promise for value) to stream.
	 *
	 * Writer is blocked until the value is read by the read handler passed to
	 * `forEach()`, and the value returned by that read handler is resolved.
	 *
	 * It is an error to write an `undefined` value (as this is a common
	 * programming error). Writing a promise for a void is currently allowed,
	 * but discouraged.
	 *
	 * The promise returned by `write()` will be rejected with the same reason if:
	 * - the written value is a PromiseLike that resolves to a rejection
	 * - the read handler throws an error or returns a rejected promise
	 * It is still possible to write another value after that, or e.g. `end()`
	 * the stream with or without an error.
	 *
	 * @param value Value to write, or promise for it
	 * @return Void-promise that resolves when value was processed by reader
	 */
	public write(value: T | PromiseLike<T>): Promise<void> {
		if (value === undefined) {
			// Technically, we could allow this, but it's a common programming
			// error to forget to return a value, and it's arguable whether it's
			// useful to have a stream of void's, so let's prevent it for now.
			// NOTE: This behaviour may change in the future
			// NOTE: writeEach() currently DOES use `undefined` to signal EOF
			// TODO: prevent writing a void PromiseLike too?
			return Promise.reject(
				new TypeError(
					"cannot write void value, use end() to end the stream"
				)
			);
		}

		const writeDone = defer();
		this._writers.push({
			resolveWrite: writeDone.resolve,
			value: track<T>(Promise.resolve(value)),
		});
		this._pump();
		return writeDone.promise;
	}

	/**
	 * End the stream, optionally passing an error.
	 *
	 * Already pending writes will be processed by the reader passed to
	 * `forEach()` before passing the end-of-stream to its end handler.
	 *
	 * The returned promise will resolve after the end handler has finished
	 * processing. It is rejected if the end handler throws an error or returns
	 * a rejected promise.
	 *
	 * All calls to `write()` or `end()` after the first `end()` will be
	 * rejected with a `WriteAfterEndError`.
	 *
	 * By default, this stream's `result()` will be resolved when `end()`
	 * resolves, or rejected with the error if `end()` is called with an error.
	 * It is possible to let this stream's `result()` 'wait' until any upstream
	 * streams have completed by e.g. passing that upstream's `result()` as the
	 * second argument to `end()`.
	 *
	 * Note: even if a stream is aborted, it is still necessary to call `end()`
	 * to allow any resources to correctly be cleaned up.
	 *
	 * @param  error Optional Error to pass to `forEach()` end handler
	 * @param  result Optional promise that determines final value of `result()`
	 * @return Void-promise that resolves when `ended`-handler has processed the
	 *         end-of-stream
	 */
	public end(error?: Error, endedResult?: PromiseLike<void>): Promise<void> {
		if (
			!(error === undefined || error === null || error instanceof Error)
		) {
			// tslint:disable-line:no-null-keyword
			return Promise.reject(
				new TypeError(
					"invalid argument to end(): must be undefined, null or Error object"
				)
			);
		}
		const eof = new Eof(error, endedResult);
		if (!this._ending && !this._ended) {
			this._ending = eof;
		}
		const writeDone = defer();
		const item: WriteItem<T> = {
			resolveWrite: writeDone.resolve,
			value: eof,
		};
		this._writers.push(item);
		this._pump();
		return writeDone.promise;
	}

	/**
	 * Read all values from stream, optionally waiting for explicit stream end.
	 *
	 * `reader` is called for every written value.
	 *
	 * `ender` is called once, when the writer `end()`s the stream, either with
	 * or without an error.
	 *
	 * `reader` and `ender` callbacks can return a promise to indicate when the
	 * value or end-of-stream condition has been completely processed. This
	 * ensures that a fast writer can never overload a slow reader, and is
	 * called 'backpressure'.
	 *
	 * The `reader` callback is never called while its previously returned
	 * promise is still pending, and the `ender` callback is likewise only
	 * called after all reads have completed.
	 *
	 * The corresponding `write()` or `end()` operation is blocked until the
	 * value returned from the reader or ender callback is resolved. If the
	 * callback throws an error or the returned promise resolves to a rejection,
	 * the `write()` or `end()` will be rejected with it.
	 *
	 * All callbacks are always called asynchronously (i.e. some time after
	 * `forEach()`, `write()`, `end()` or `abort()` returns), and their `this`
	 * argument will be undefined.
	 *
	 * `aborter` is called once if the stream is aborted and has not ended yet.
	 * (I.e. it will be called if e.g. `ender`'s returned promise is still
	 * pending, to allow early termination, but it will no longer be called
	 * if its promise has resolved).
	 *
	 * The `aborter` callback can be called while a reader callback's promise is
	 * still pending, and should try to let `reader` or `ender` finish as fast
	 * as possible.
	 *
	 * Note that even when a stream is aborted, it still needs to be `end()`'ed
	 * correctly.
	 *
	 * If no `ender` is given, a default end handler is installed that directly
	 * acknowledges the end-of-stream, also in case of an error. Note that that
	 * error will still be returned from `forEach()`.
	 *
	 * If no `aborter` is given, an abort is ignored (but will still cause
	 * further writes to fail, and it will be reflected in the returned promise).
	 *
	 * It is an error to call `forEach()` multiple times, and it is not possible
	 * to 'detach' already attached callbacks. Reason is that the exact behaviour
	 * of such actions (e.g. block or simply ignore further writes) is application
	 * dependent, and should be implemented as a transform instead.
	 *
	 * The return value of `forEach()` is `result()`, a promise that resolves
	 * when all parts in the stream(-chain) have completely finished.
	 *
	 * @param reader  Callback called with every written value
	 * @param ender   Optional callback called when stream is ended
	 * @param aborter Optional callback called when stream is aborted
	 * @return Promise for completely finished stream, i.e. same promise as `result()`
	 */
	public forEach(
		reader: (value: T) => void | PromiseLike<void>,
		ender?: (error?: Error) => void | PromiseLike<void>,
		aborter?: (error: Error) => void
	): Promise<void> {
		if (this.hasReader()) {
			return Promise.reject(new AlreadyHaveReaderError());
		}
		if (!ender) {
			// Default ender swallows errors, because they
			// will already be signalled in the stream's
			// `.result()` (and thus the output of `.forEach()`).
			// See #35.
			ender = noop;
		}
		this._reader = reader;
		this._ender = ender;
		this._aborter = aborter;
		this._pump();
		return this.result();
	}

	/**
	 * Signal that the stream is aborted: it will no longer read incoming
	 * elements and will no longer write elements except in the course of
	 * processing any pending asynchronous reader callbacks (i.e. unresolved
	 * Promises returned by `forEach()` or other stream iterators). Does not
	 * end the stream.
	 *
	 * An upstream source can handle this `abort()` by catching the exception
	 * from its own `aborted()` method--for example, to cancel pending fetch
	 * operations, or close a continuous data stream.
	 *
	 * If the stream's `forEach()` function provided an `aborter` callback and
	 * the stream is not yet ended, `aborter` will be called with the abort reason.
	 * This can be used to cancel any remaining operations inside the asynchronous
	 * reader callback.
	 *
	 * Once the last pending callback is resolved, any pending and future `write()`s
	 * to this stream will be rejected with the error provided to `abort()`.
	 *
	 * It is still necessary to explicitly `end()` the stream, to ensure that any
	 * resources can be cleaned up correctly both on the reader and writer side.
	 * The stream's `ender` callback will be called with the abort error (i.e. any
	 * error passed to `end()` is ignored.)
	 *
	 * The abort is ignored if the stream is already aborted.
	 *
	 * It's possible to abort an ended stream. This can be used to 'bubble' an
	 * abort signal to other parts in a chain of streams which may not have ended
	 * yet. It will not change the end-state of this part of the stream though.
	 *
	 * @param reason Optional Error value to signal a reason for the abort
	 */
	public abort(reason?: Error): void {
		if (this._abortPromise) {
			return;
		}
		if (!reason) {
			reason = new Error("aborted");
		}
		this._abortDeferred.reject(reason);
		this._abortPromise = this._abortDeferred.promise;
		this._abortReason = reason;
		this._pump();
	}

	/**
	 * Obtain promise that resolves to a rejection when `abort()` is called.
	 *
	 * Useful to pass abort to up- and down-stream sources.
	 *
	 * Note: this promise either stays pending, or is rejected. It is never
	 * fulfilled.
	 *
	 * @return Promise that is rejected with abort error when stream is aborted
	 */
	public aborted(): Promise<never> {
		return this._abortDeferred.promise;
	}

	/**
	 * Obtain a promise that resolves when the stream has completely ended:
	 * - `end()` has been called (possibly with an Error),
	 * - `ender` callback has run and its returned promise resolved,
	 * - `end()`'s result parameter (if any) has been resolved.
	 *
	 * @return Promise resolved when stream has completely ended
	 */
	public result(): Promise<void> {
		return this._resultDeferred.promise;
	}

	/**
	 * Determine whether `end()` has been called on the stream, but the stream
	 * is still processing it.
	 *
	 * @return true when `end()` was called but not acknowledged yet, false
	 *         otherwise
	 */
	public isEnding(): boolean {
		return !!this._ending;
	}

	/**
	 * Determine whether stream has completely ended (i.e. end handler has been
	 * called and its return PromiseLike, if any, is resolved).
	 * @return true when stream has ended, false otherwise
	 */
	public isEnded(): boolean {
		return !!this._ended;
	}

	/**
	 * Determine whether `end()` has been called on the stream.
	 *
	 * @return true when `end()` was called
	 */
	public isEndingOrEnded(): boolean {
		return this.isEnding() || this.isEnded();
	}

	/**
	 * Determine whether `forEach()` callback(s) are currently attached to the
	 * stream.
	 *
	 * @return true when `forEach()` has been called on this stream
	 */
	public hasReader(): boolean {
		return !!this._reader;
	}

	/**
	 * Run all input values through a mapping callback, which must produce a new
	 * value (or promise for a value), similar to e.g. `Array`'s `map()`.
	 *
	 * Stream end in the input stream (normal or with error) will be passed to
	 * the output stream, after awaiting the result of the optional ender.
	 *
	 * Any error (thrown or rejection) in mapper or ender is returned to the
	 * input stream.
	 *
	 * @param mapper  Callback which receives each value from this stream, and
	 *                must produce a new value (or promise for a value)
	 * @param ender   Called when stream is ending, result is waited for before
	 *                passing on `end()`
	 * @param aborter Called when stream is aborted
	 * @return New stream with mapped values
	 */
	public map<R>(
		mapper: (value: T) => R | PromiseLike<R>,
		ender?: (error?: Error) => void | PromiseLike<void>,
		aborter?: (error: Error) => void
	): ReadableStream<R> {
		const output = new Stream<R>();
		map(this, output, mapper, ender, aborter);
		return output;
	}

	/**
	 * Run all input values through a filtering callback. If the filter callback
	 * returns a truthy value (or a promise for a truthy value), the input value
	 * is written to the output stream, otherwise it is ignored.
	 * Similar to e.g. `Array`'s `filter()`.
	 *
	 * Stream end in the input stream (normal or with error) will be passed to
	 * the output stream, after awaiting the result of the optional ender.
	 *
	 * Any error (thrown or rejection) in mapper or ender is returned to the
	 * input stream.
	 *
	 * @param filterer Callback which receives each value from this stream,
	 *                 input value is written to output if callback returns a
	 *                 (promise for) a truthy value.
	 * @param ender    Called when stream is ending, result is waited for before
	 *                 passing on `end()`
	 * @param aborter  Called when stream is aborted
	 * @return New stream with filtered values.
	 */
	public filter(
		filterer: (value: T) => boolean | PromiseLike<boolean>,
		ender?: (error?: Error) => void | PromiseLike<void>,
		aborter?: (error: Error) => void
	): ReadableStream<T> {
		const output = new Stream<T>();
		filter(this, output, filterer, ender, aborter);
		return output;
	}

	/**
	 * Reduce the stream into a single value by calling a reducer callback for
	 * each value in the stream. Similar to `Array#reduce()`.
	 *
	 * The output of the previous call to `reducer` (aka `accumulator`) is given
	 * as the first argument of the next call. For the first call, either the
	 * `initial` value to `reduce()` is passed, or the first value of the stream
	 * is used (and `current` will be the second value).
	 *
	 * The result of `reduce()` is a promise for the last value returned by
	 * `reducer` (or the initial value, if there were no calls to `reducer`).
	 * If no initial value could be determined, the result is rejected with a
	 * TypeError.
	 * If the stream is ended with an error, the result is rejected with that
	 * error.
	 *
	 * It is possible for `reducer` to return a promise for its result.
	 *
	 * If the `reducer` throws an error or returns a rejected promise, the
	 * originating `write()` will fail with that error.
	 *
	 * Examples:
	 * s.reduce((acc, val) => acc + val); // sums all values
	 * s.reduce((acc, val) => { acc.push(val); return acc; }, []); // toArray()
	 *
	 * @param  reducer Callback called for each value in the stream, with
	 *                 accumulator, current value, index of current value, and
	 *                 this stream.
	 * @param  initial Optional initial value for accumulator. If no initial
	 *                 value is given, first value of stream is used.
	 * @return Promise for final accumulator.
	 */
	public reduce(
		reducer: (
			accumulator: T,
			current: T,
			index: number,
			stream: ReadableStream<T>
		) => T | PromiseLike<T>,
		initial?: T
	): Promise<T>;
	/**
	 * Reduce the stream into a single value by calling a reducer callback for
	 * each value in the stream. Similar to `Array#reduce()`.
	 *
	 * The output of the previous call to `reducer` (aka `accumulator`) is given
	 * as the first argument of the next call. For the first call, either the
	 * `initial` value to `reduce()` is passed, or the first value of the stream
	 * is used (and `current` will be the second value).
	 *
	 * The result of `reduce()` is a promise for the last value returned by
	 * `reducer` (or the initial value, if there were no calls to `reducer`).
	 * If no initial value could be determined, the result is rejected with a
	 * TypeError.
	 * If the stream is ended with an error, the result is rejected with that
	 * error.
	 *
	 * It is possible for `reducer` to return a promise for its result.
	 *
	 * If the `reducer` throws an error or returns a rejected promise, the
	 * originating `write()` will fail with that error.
	 *
	 * Examples:
	 * s.reduce((acc, val) => acc + val); // sums all values
	 * s.reduce((acc, val) => { acc.push(val); return acc; }, []); // toArray()
	 *
	 * @param  reducer Callback called for each value in the stream, with
	 *                 accumulator, current value, index of current value, and
	 *                 this stream.
	 * @param  initial Optional initial value for accumulator. If no initial
	 *                 value is given, first value of stream is used.
	 * @return Promise for final accumulator.
	 */
	public reduce<R>(
		reducer: (
			accumulator: R,
			current: T,
			index: number,
			stream: ReadableStream<T>
		) => PromiseLike<R>,
		initial: R
	): Promise<R>;
	/**
	 * Reduce the stream into a single value by calling a reducer callback for
	 * each value in the stream. Similar to `Array#reduce()`.
	 *
	 * The output of the previous call to `reducer` (aka `accumulator`) is given
	 * as the first argument of the next call. For the first call, either the
	 * `initial` value to `reduce()` is passed, or the first value of the stream
	 * is used (and `current` will be the second value).
	 *
	 * The result of `reduce()` is a promise for the last value returned by
	 * `reducer` (or the initial value, if there were no calls to `reducer`).
	 * If no initial value could be determined, the result is rejected with a
	 * TypeError.
	 * If the stream is ended with an error, the result is rejected with that
	 * error.
	 *
	 * It is possible for `reducer` to return a promise for its result.
	 *
	 * If the `reducer` throws an error or returns a rejected promise, the
	 * originating `write()` will fail with that error.
	 *
	 * Examples:
	 * s.reduce((acc, val) => acc + val); // sums all values
	 * s.reduce((acc, val) => { acc.push(val); return acc; }, []); // toArray()
	 *
	 * @param  reducer Callback called for each value in the stream, with
	 *                 accumulator, current value, index of current value, and
	 *                 this stream.
	 * @param  initial Optional initial value for accumulator. If no initial
	 *                 value is given, first value of stream is used.
	 * @return Promise for final accumulator.
	 */
	public reduce<R>(
		// tslint:disable-next-line:unified-signatures
		reducer: (
			accumulator: R,
			current: T,
			index: number,
			stream: ReadableStream<T>
		) => R,
		initial: R
	): Promise<R> {
		let haveAccumulator = arguments.length === 2;
		let accumulator: any = initial;
		let index = 0;
		return this.forEach((value: T): void | PromiseLike<void> => {
			if (!haveAccumulator) {
				accumulator = value;
				haveAccumulator = true;
				index++;
			} else {
				return Promise.resolve(
					reducer(accumulator, value, index++, this)
				).then((newAccumulator: any) => (accumulator = newAccumulator));
			}
		}).then(() => {
			if (!haveAccumulator) {
				return Promise.reject<R>(
					new TypeError(
						"cannot reduce() empty stream without initial value"
					)
				);
			}
			return accumulator;
		});
	}

	/**
	 * Read all stream values into an array.
	 *
	 * Returns a promise that resolves to that array if the stream ends
	 * normally, or to the error if the stream is ended with an error.
	 *
	 * @return Promise for an array of all stream values
	 */
	public toArray(): Promise<T[]> {
		const result: T[] = [];
		return this.forEach((value: T) => {
			result.push(value);
		}).then(() => result);
	}

	/**
	 * Read all values and end-of-stream from this stream, writing them to
	 * `writable`.
	 *
	 * @param  writable Destination stream
	 * @return The stream passed in, for easy chaining
	 */
	public pipe<R extends Writable<T>>(writable: R): R {
		writable.aborted().catch((err) => this.abort(err));
		this.aborted().catch((err) => writable.abort(err));
		this.forEach(
			(value: T) => writable.write(value),
			(error?: Error) => writable.end(error, this.result())
		);
		return writable;
	}

	/**
	 * Return a new stream with the results of running the given
	 * transform.
	 *
	 * @param transformer Function that receives this stream and result stream
	 *                    as inputs.
	 * @return Readable stream with the transformed results
	 */
	public transform<R>(transformer: Transform<T, R>): ReadableStream<R> {
		const output = new Stream<R>();
		transformer(this, output);
		return output;
	}

	/**
	 * Repeatedly call `writer` and write its returned value (or promise for it)
	 * to the stream.
	 * The stream is ended when `writer` returns `undefined` (or a promise that
	 * resolves to `undefined`).
	 *
	 * `writer` is only called again when its previously returned value has been
	 * processed by the stream.
	 *
	 * If writing of a value fails (either by the `writer` throwing an error,
	 * returning a rejection, or the write call failing), the stream is aborted
	 * and ended with that error.
	 *
	 * `ender` is always called once, just before the stream is ended. I.e.
	 * after `writer` returned (a promise for) `undefined` or the stream is
	 * aborted.
	 * It can be used to e.g. close a resource such as a database.
	 * Note: `ender` will only be called when `writer`'s promise (if any) has
	 * resolved.
	 *
	 * `aborter` is called once iff the stream is aborted. It can be called
	 * while e.g. a promise returned from the writer or ender is still pending,
	 * and can be used to make sure that that promise is resolved/rejected
	 * sooner.
	 * Note: the aborter should be considered a 'signal to abort', but cleanup
	 * of resources should be done in the `ender` (i.e. it cannot return a
	 * promise).
	 * It can be called (long) after `ender` has been called, because a stream
	 * can be aborted even after it is already ended, which is useful if this
	 * stream element is part of a larger chain of streams.
	 * An aborter must never throw an error.
	 *
	 * @param writer Called when the next value can be written to the stream,
	 *               should return (a promise for) a value to be written,
	 *               or `undefined` (or void promise) to end the stream.
	 *               Will always be called asynchronously.
	 * @param ender Optional callback called once after `writer` indicated
	 *              end-of-stream, or when the stream is aborted (and
	 *              previously written value resolved/rejected). It's called
	 *              without an argument if stream was not aborted (yet), and
	 *              the abort reason if it was aborted (`aborter` will have
	 *              been called, too). Will always be called asynchronously.
	 * @param aborter Optional callback called once when stream is aborted.
	 *                Receives abort reason as its argument. Should be used
	 *                to prematurely terminate any pending promises of
	 *                `writer` or `ender`. Will always be called
	 *                asynchronously. Can be called before and after
	 *                `writer` or `ender` have been called, even when `ender`
	 *                is completely finished (useful to e.g. abort other streams, which may
	 *                not be aborted yet).
	 *                Must not throw any errors, will lead to unhandled
	 *                rejected promise if it does.
	 * @return Promise for completely finished stream, i.e. same promise as `result()`
	 */
	public writeEach(
		writer: () => T | undefined | void | PromiseLike<T | undefined | void>,
		ender?: (abortReason?: Error) => void | PromiseLike<void>,
		aborter?: (abortReason: Error) => void
	): Promise<void> {
		/**
		 * Call aborter (if any) and convert any thrown error into
		 * unhandled rejection. Unset aborter to prevent calling it
		 * again later.
		 */
		const callAborter = (abortReason: Error) => {
			if (!aborter) {
				return;
			}
			try {
				const callback = aborter;
				aborter = undefined;
				callback(abortReason);
			} catch (aborterError) {
				// Convert into unhandled rejection. There's not really
				// a sensible way to convert it into something else.
				// One might think to pass it to the ender, which may
				// be undefined, or this.end(), but that seams rather
				// unexpected to occassionally have to handle an error
				// from one specific aborter, whereas other aborters's
				// errors will also lead to unhandled rejections.
				// Note: the most sensible thing to do now, is to
				// terminate the program.
				Promise.reject(aborterError);
			}
		};
		const worker = async () => {
			try {
				while (!this._abortPromise) {
					const value = await writer();
					if (value === undefined) {
						break;
					} else {
						await this.write(value as T);
					}
				}
			} catch (writeError) {
				this.abort(writeError);
			} finally {
				// If our writer caused the abort, make sure to
				// call ender (and aborter) with that reason. Other aborts
				// may happen at any time, so they may be caught by this,
				// or they may be caught by the out-of-loop asynchronous
				// callback registered below.
				let endError = this._abortReason; // Will be `undefined` in normal cases
				if (this._abortReason) {
					callAborter(this._abortReason);
				}

				if (ender) {
					try {
						await (this._abortReason
							? ender(this._abortReason)
							: ender());
					} catch (error) {
						endError = error;
					}
				}

				await this.end(endError);
			}
		};
		// Asynchronously call worker, abort on error
		Promise.resolve()
			.then(worker)
			.catch((error: Error) => this.abort(error));
		// Ensure aborter is asynchronously called if necessary
		this.aborted().catch(callAborter);
		return this.result();
	}

	// TODO Experimental
	// TODO Not sure whether a 'reverse' function confuses more than it helps
	public mappedBy<X>(
		mapper: (value: X) => T | PromiseLike<T>
	): WritableStream<X> {
		const input = new Stream<X>();
		map(input, this, mapper);
		return input;
	}

	// TODO Experimental
	// TODO Not sure whether a 'reverse' function confuses more than it helps
	public filterBy(
		filterer: (value: T) => boolean | PromiseLike<boolean>
	): WritableStream<T> {
		const input = new Stream<T>();
		filter(input, this, filterer);
		return input;
	}

	/**
	 * Return a Stream for all values in the input array.
	 *
	 * The stream is ended as soon as the first `undefined` value is
	 * encountered.
	 *
	 * The array itself, and/or the values in the array may also be promises.
	 *
	 * @see result() to wait for completion
	 * @see writeEach() for error handling behavior
	 *
	 * @param data (Promise for) input array of (promises for) values
	 * @return Stream of all values in the input array
	 */
	public static from<T>(
		data: PromiseLike<PromiseLike<T>[]>
	): ReadableStream<T>;
	/**
	 * Return a Stream for all values in the input array.
	 *
	 * The stream is ended as soon as the first `undefined` value is
	 * encountered.
	 *
	 * The array itself, and/or the values in the array may also be promises.
	 *
	 * @see result() to wait for completion
	 * @see writeEach() for error handling behavior
	 *
	 * @param data (Promise for) input array of (promises for) values
	 * @return Stream of all values in the input array
	 */
	public static from<T>(data: PromiseLike<T>[]): ReadableStream<T>; // tslint:disable-line:unified-signatures
	/**
	 * Return a Stream for all values in the input array.
	 *
	 * The stream is ended as soon as the first `undefined` value is
	 * encountered.
	 *
	 * The array itself, and/or the values in the array may also be promises.
	 *
	 * @see result() to wait for completion
	 * @see writeEach() for error handling behavior
	 *
	 * @param data (Promise for) input array of (promises for) values
	 * @return Stream of all values in the input array
	 */
	public static from<T>(data: PromiseLike<T[]>): ReadableStream<T>; // tslint:disable-line:unified-signatures
	/**
	 * Return a Stream for all values in the input array.
	 *
	 * The stream is ended as soon as the first `undefined` value is
	 * encountered.
	 *
	 * The array itself, and/or the values in the array may also be promises.
	 *
	 * @see result() to wait for completion
	 * @see writeEach() for error handling behavior
	 *
	 * @param data (Promise for) input array of (promises for) values
	 * @return Stream of all values in the input array
	 */
	public static from<T>(data: T[]): ReadableStream<T>; // tslint:disable-line:unified-signatures
	/**
	 * Return a Stream for all values in the input array.
	 *
	 * The stream is ended as soon as the first `undefined` value is
	 * encountered.
	 *
	 * The array itself, and/or the values in the array can also be promises.
	 *
	 * @see result() to wait for completion
	 * @see writeEach() for error handling behavior
	 *
	 * @param data (Promise for) input array of (promises for) values
	 * @return Stream of all values in the input array
	 */
	public static from<T>(
		data:
			| T[]
			| PromiseLike<T[]>
			| PromiseLike<T>[]
			| PromiseLike<PromiseLike<T>[]>
	): ReadableStream<T> {
		const stream = new Stream<T>();
		let i = 0;
		if (Array.isArray(data)) {
			stream.writeEach(() => data[i++]);
		} else {
			Promise.resolve<T[] | PromiseLike<T>[]>(data).then(
				(resolvedArray) => {
					stream.writeEach(() => resolvedArray[i++]);
				}
			);
		}
		return stream;
	}

	/**
	 * Bound callback to be passed as handlers to Promise.then()
	 */
	private _pumper = () => this._pump();

	/**
	 * Pump written values to `_reader` and `_ender`, resolve results of
	 * `write()` and `end()`.
	 */
	private _pump(): void {
		// Call abort handler, if necessary
		if (this._abortPromise && this._aborter) {
			// Make sure to call it asynchronously, and without a 'this'
			// TODO: can any error thrown from the aborter be handled?
			swallowErrors(this._abortPromise.catch(this._aborter));
			this._aborter = undefined;
		}

		// If waiting for a reader/ender, wait some more or handle it
		if (this._readBusy) {
			if (this._readBusy.isPending) {
				// Pump is already attached to _readBusy, so just wait for that
				// to be resolved
				return;
			}

			// Previous reader/ender has resolved, return its result to the
			// corresponding write() or end() call
			this._writers.shift()!.resolveWrite(this._readBusy.promise);
			if (this._endPending) {
				const result = this._endPending.result;
				this._ended = this._endPending.error || EOF;
				this._ending = undefined;
				this._endPending = undefined;
				this._aborter = undefined; // no longer call aborter after end handler has finished
				let p: PromiseLike<void>;
				// Determine final result()
				if (result) {
					// Explicit result promise was passed to end().
					// Make sure to wait until the ender is fully completed,
					// which can be fulfilled or rejected. Ender's rejection is
					// ignored here, because it is already passed upstream, and
					// result then comes back downstream. This allows upstream to
					// decide how to handle a downstream ender's failure.
					p = this._readBusy.promise
						.then(undefined, noop)
						.then(() => result);
				} else {
					// No explicit result passed to end().
					// Wait for ender to complete, if it throws, pass that
					// error along, if it doesn't throw but an error was passed
					// to end, use that error as the stream's result
					p = this._readBusy.promise.then(() => {
						if (this._ended !== EOF) {
							throw this._ended;
						}
					});
				}
				this._resultDeferred.resolve(p);
			}
			this._readBusy = undefined;
		}

		// If ended, reject any pending and future writes/ends with an error
		if (this._ended) {
			while (this._writers.length > 0) {
				// tslint:disable-next-line:no-shadowed-variable
				const writer = this._writers.shift()!;
				writer.resolveWrite(Promise.reject(new WriteAfterEndError()));
			}
			return;
		}

		// In case we're aborting, abort all pending and future write()'s (i.e.
		// not the end()'s)
		if (this._abortPromise) {
			while (this._writers.length > 0) {
				// tslint:disable-next-line:no-shadowed-variable
				const writer = this._writers[0];
				if (writer.value instanceof Eof) {
					break;
				}
				// Reject all non-end write()'s with abort reason
				swallowErrors(writer.value.promise);
				writer.resolveWrite(this._abortPromise);
				this._writers.shift();
			}
			// Fall-through to process the 'end()', if any
		}

		// Wait until at least one value and a reader are available
		if (this._writers.length === 0 || !this._reader) {
			// write(), end() and forEach() will pump us again
			return;
		}
		const writer = this._writers[0];

		// Wait until next written value is available
		// (Note: when aborting, all non-end() writers will already have been
		// aborted above, and an Eof is a resolved value)
		if (!(writer.value instanceof Eof) && writer.value.isPending) {
			writer.value.promise.then(this._pumper, this._pumper);
			return;
		}

		// If written value resolved to a rejection, make its write() fail
		if (!(writer.value instanceof Eof) && writer.value.isRejected) {
			writer.resolveWrite(writer.value.promise as PromiseLike<any>);
			this._writers.shift();
			// Pump again
			Promise.resolve().then(this._pumper);
			return;
		}

		// Determine whether we should call the reader or the ender.
		// Handler is always asynchronously called, and by chaining it from
		// the writer's value, long stack traces are maintained.
		if (writer.value instanceof Eof) {
			const eof = writer.value;
			// EOF, with or without error
			if (this._ended || this._endPending) {
				throw new Error("assertion failed");
			}
			this._endPending = eof;
			const ender = this._ender!; // Ensure calling without `this`
			this._ender = undefined; // Prevent calling again
			// Call with end error or override with abort reason if any
			const enderArg = this._abortPromise ? this._abortReason : eof.error;
			this._readBusy = track(
				Promise.resolve(eof).then((eofValue) => ender(enderArg))
			);
		} else {
			this._readBusy = track(writer.value.promise.then(this._reader));
		}
		this._readBusy.promise.then(this._pumper, this._pumper);
	}
}

export default Stream;
