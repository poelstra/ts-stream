/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */

"use strict"; /* istanbul ignore next */ // ignores Typescript's __extend() function

import { Promise, Thenable, BaseError, Deferred } from "ts-promise";
import * as assert from "assert";

import { Transform, map, filter } from "./Transform";
import { swallowErrors } from "./util";

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
	 * Signal stream abort.
	 *
	 * If an `aborter` callback is set by `forEach()` and the stream has not
	 * ended yet, it will (asynchronously) be called with the abort reason, to
	 * allow early termination of pending operation(s).
	 *
	 * If a reader is currently processing a value (i.e. a promise returned from
	 * a read callback is not resolved yet), that operation is still allowed to
	 * complete (although it can e.g. be cancelled by the `aborter` callback
	 * to `forEach()`).
	 *
	 * Any pending and future `write()`s after that will be rejected with the
	 * given error.
	 *
	 * The stream is not ended until the writer explicitly `end()`s the stream,
	 * after which the stream's `ender` callback is called with the abort error
	 * (i.e. any error passed to `end()` is ignored).
	 *
	 * The abort is ignored if the stream is already aborted.
	 * Note that it's possible to abort an ended stream, to allow the abort to
	 * 'bubble' to other parts in a chain of streams, which may not have ended
	 * yet. It will not change the end-state of this part of the stream though.
	 *
	 * @param reason Error value to signal a reason for the abort
	 */
	abort(reason: Error): void;

	/**
	 * Obtain promise that resolves to a rejection when `abort()` is called.
	 *
	 * Useful to pass abort to upstream sources.
	 *
	 * @return Promise that is rejected with abort error when stream is aborted
	 */
	aborted(): Promise<void>;
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
	 * `aborter` is called once if the stream is aborted and has not ended yet.
	 *
	 * `reader` and `ender` callbacks can return a promise to indicate when the
	 * value or end-of-stream condition has been completely processed. This
	 * ensures that a fast writer can never overload a slow reader, and is
	 * called 'backpressure'.
	 *
	 * The corresponding `write()` or `end()` operation is blocked until the
	 * value returned from the reader or ender callback is resolved. If the
	 * callback throws an error or the returned promise resolves to a rejection,
	 * the `write()` or `end()` will be rejected with it.
	 *
	 * All callbacks are always called asynchronously (i.e. some time
	 * after `forEach()`, `write()`, `end()` or `abort()` returns), and their
	 * `this` argument will be undefined.
	 *
	 * The `reader` and `ender` callbacks are never called again before their
	 * previously returned promise is resolved/rejected.
	 *
	 * The `aborter` callback can be called while a reader callback's promise is
	 * still pending, and should try to let `reader` or `ender` finish as fast
	 * as possible. It will not be called after the output of `ender` has
	 * resolved.
	 *
	 * If no `ender` is given, a default end handler is installed that returns
	 * any stream end errors to the writer, and otherwise directly acknowledges
	 * the end-of-stream.
	 *
	 * The return value of `forEach()` is `result()`, a promise that resolves
	 * when all parts in the stream(-chain) have completely finished.
	 *
	 * It is an error to call `forEach()` multiple times.
	 *
	 * @param reader  Callback called with every written value
	 * @param ender   Optional callback called when stream is ended
	 * @param aborter Optional callback called when stream is aborted
	 * @return Stream's end result (i.e. `result()`)
	 */
	forEach(
		reader: (value: T) => void|Thenable<void>,
		ender?: (error?: Error) => void|Thenable<void>,
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
	 * - the written value is a Thenable that resolves to a rejection
	 * - the read handler throws an error or returns a rejected promise
	 * It is still possible to write another value after that, or e.g. `end()`
	 * the stream with or without an error.
	 *
	 * @param value Value to write, or promise for it
	 * @return Void-promise that resolves when value was processed by reader
	 */
	write(value: T|Thenable<T>): Promise<void>;

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
	 * @param  error Optional Error to pass to `forEach()` end handler
	 * @param  result Optional promise that determines final value of `result()`
	 * @return Void-promise that resolves when end-handler has processed the
	 *         end-of-stream
	 */
	end(error?: Error, result?: Thenable<void>): Promise<void>;
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
	 * called and its return Thenable, if any, is resolved).
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
		mapper: (value: T) => R|Thenable<R>,
		ender?: (error?: Error) => void|Thenable<void>,
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
		filterer: (value: T) => boolean|Thenable<boolean>,
		ender?: (error?: Error) => void|Thenable<void>,
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
		reducer: (accumulator: T, current: T, index: number, stream: ReadableStream<T>) => T|Thenable<T>,
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
		reducer: (accumulator: R, current: T, index: number, stream: ReadableStream<T>) => R|Thenable<R>,
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
	 * The stream is ended when `writer` returns `undefined`.
	 *
	 * `writer` is only called when its previously returned value has been
	 * processed by the stream.
	 *
	 * If writing of a value fails (either by the callback throwing an error,
	 * returning a rejection, or the write call failing), the stream is aborted
	 * and ended with that error.
	 *
	 * If ending of the stream fails with an error other than the abort error,
	 * the program is terminated with an UnhandledEndError.
	 *
	 * NOTE Whether stream is aborted on error is still subject to change.
	 *
	 * @param writer Called when the next value can be written to the stream,
	 *               should return (a promise for) a value to be written,
	 *               or `undefined` (or void promise) to end the stream.
	 * @return Stream for all values in the input array
	 */
	writeEach(writer: () => T|Thenable<T>|void|Thenable<void>): Promise<void>;

	// TODO Experimental
	// TODO Not sure whether a 'reverse' function confuses more than it helps
	mappedBy<X>(mapper: (value: X) => T|Thenable<T>): WritableStream<X>;

	// TODO Experimental
	// TODO Not sure whether a 'reverse' function confuses more than it helps
	filterBy(filterer: (value: T) => boolean|Thenable<boolean>): WritableStream<T>;
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
 * Default end-handler used in e.g. [[Stream.forEach]].
 * @param err `undefined` in case of normal stream end, or an Error
 * @return Rejected promise in case of an error, void otherwise
 */
function defaultEnder(err?: Error): void|Promise<void> {
	if (err) {
		return Promise.reject(err);
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
	public result?: Thenable<void>;

	/**
	 * Create new end-of-stream value, optionally signalling an error.
	 * @param error     Optional Error value
	 * @param result Optional final result value of `result()`
	 */
	constructor(error?: Error, result?: Thenable<void>) {
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
	resolveWrite: (done?: void|Thenable<void>) => void;

	/**
	 * Promise for value passed to `write()`.
	 * Either a special Eof value, or a value of type `T`.
	 */
	value: Promise<Eof|T>;
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
	private _reader: (value: T) => void|Thenable<void>;

	/**
	 * End handler that is called when the stream is ended, as set by
	 * `forEach()`. Note that `forEach()` installs a default handler if the user
	 * did not supply one.
	 * Set to 'undefined' when it has been called.
	 */
	private _ender: (error?: Error) => void|Thenable<void>;

	/**
	 * Abort handler that is called when the stream is aborted, as set by
	 * `forEach()` (can be undefined).
	 * Set to 'undefined' when it has been called.
	 */
	private _aborter: (error: Error) => void;

	/**
	 * When a written value is being processed by the `_reader`, this property
	 * is set to a promise that resolves when the reader's returned Thenable is
	 * resolved (or rejected).
	 */
	private _readBusy: Promise<void>;

	/**
	 * Set to an instance of an Eof object, containing optional error and final
	 * result of this stream. Set when `end()` is called.
	 */
	private _ending: Eof;

	/**
	 * Set to an instance of an Eof object, containing optional error and final
	 * result of this stream. Set when `_ender` is being called but not finished
	 * yet, unset when `_ended` is set.
	 */
	private _endPending: Eof;

	/**
	 * Set to the error passed to `end()` (or the special value `eof`) when the
	 * stream has ended, and the operation was confirmed by the `_ender`.
	 */
	private _ended: Error;

	/**
	 * Set to a rejected promise when the stream is explicitly `abort()`'ed.
	 */
	private _abortPromise: Promise<void>;

	/**
	 * Resolved to a rejection when `abort()` is called.
	 */
	private _abortDeferred: Deferred<void> = Promise.defer();

	/**
	 * Resolved to the result of calling `_ender`, then the `result` property of
	 * the end-of-stream value.
	 */
	private _resultDeferred: Deferred<void> = Promise.defer();

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
	 * - the written value is a Thenable that resolves to a rejection
	 * - the read handler throws an error or returns a rejected promise
	 * It is still possible to write another value after that, or e.g. `end()`
	 * the stream with or without an error.
	 *
	 * @param value Value to write, or promise for it
	 * @return Void-promise that resolves when value was processed by reader
	 */
	public write(value: T|Thenable<T>): Promise<void> {
		if (value === undefined) {
			// Technically, we could allow this, but it's a common programming
			// error to forget to return a value, and it's arguable whether it's
			// useful to have a stream of void's, so let's prevent it for now.
			// NOTE: This behaviour may change in the future
			// TODO: prevent writing a void Thenable too?
			return Promise.reject(
				new TypeError("cannot write void value, use end() to end the stream")
			);
		}

		let valuePromise = Promise.resolve(value);
		let writeDone = Promise.defer();
		this._writers.push({
			resolveWrite: writeDone.resolve,
			value: valuePromise,
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
	 * @param  error Optional Error to pass to `forEach()` end handler
	 * @param  result Optional promise that determines final value of `result()`
	 * @return Void-promise that resolves when end-handler has processed the
	 *         end-of-stream
	 */
	public end(error?: Error, endedResult?: Thenable<void>): Promise<void> {
		if (!(error === undefined || error === null || error instanceof Error)) { // tslint:disable-line:no-null-keyword
			return Promise.reject(
				new TypeError("invalid argument to end(): must be undefined, null or Error object")
			);
		}
		if (error && !endedResult) {
			endedResult = Promise.reject(error);
		}
		let eof = new Eof(error, endedResult);
		if (!this._ending && !this._ended) {
			this._ending = eof;
		}
		let valuePromise = Promise.resolve(eof);
		let writeDone = Promise.defer();
		this._writers.push({
			resolveWrite: writeDone.resolve,
			value: valuePromise,
		});
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
	 * `aborter` is called once if the stream is aborted and has not ended yet.
	 *
	 * `reader` and `ender` callbacks can return a promise to indicate when the
	 * value or end-of-stream condition has been completely processed. This
	 * ensures that a fast writer can never overload a slow reader, and is
	 * called 'backpressure'.
	 *
	 * The corresponding `write()` or `end()` operation is blocked until the
	 * value returned from the reader or ender callback is resolved. If the
	 * callback throws an error or the returned promise resolves to a rejection,
	 * the `write()` or `end()` will be rejected with it.
	 *
	 * All callbacks are always called asynchronously (i.e. some time
	 * after `forEach()`, `write()`, `end()` or `abort()` returns), and their
	 * `this` argument will be undefined.
	 *
	 * The `reader` and `ender` callbacks are never called again before their
	 * previously returned promise is resolved/rejected.
	 *
	 * The `aborter` callback can be called while a reader callback's promise is
	 * still pending, and should try to let `reader` or `ender` finish as fast
	 * as possible. It will not be called after the output of `ender` has
	 * resolved.
	 *
	 * If no `ender` is given, a default end handler is installed that returns
	 * any stream end errors to the writer, and otherwise directly acknowledges
	 * the end-of-stream.
	 *
	 * It is an error to call `forEach()` multiple times.
	 *
	 * @param reader  Callback called with every written value
	 * @param ender   Optional callback called when stream is ended
	 * @param aborter Optional callback called when stream is aborted
	 */
	public forEach(
		reader: (value: T) => void|Thenable<void>,
		ender?: (error?: Error) => void|Thenable<void>,
		aborter?: (error: Error) => void
	): Promise<void> {
		if (this.hasReader()) {
			return Promise.reject(new AlreadyHaveReaderError());
		}
		if (!ender) {
			ender = defaultEnder;
		}
		this._reader = reader;
		this._ender = ender;
		this._aborter = aborter;
		this._pump();
		return this.result();
	}

	/**
	 * Signal stream abort.
	 *
	 * If an `aborter` callback is set by `forEach()` and the stream has not
	 * ended yet, it will (asynchronously) be called with the abort reason, to
	 * allow early termination of pending operation(s).
	 *
	 * If a reader is currently processing a value (i.e. a promise returned from
	 * a read callback is not resolved yet), that operation is still allowed to
	 * complete (although it can e.g. be cancelled by the `aborter` callback
	 * to `forEach()`).
	 *
	 * Any pending and future `write()`s after that will be rejected with the
	 * given error.
	 *
	 * The stream is not ended until the writer explicitly `end()`s the stream,
	 * after which the stream's `ender` callback is called with the abort error
	 * (i.e. any error passed to `end()` is ignored).
	 *
	 * The abort is ignored if the stream is already aborted.
	 * Note that it's possible to abort an ended stream, to allow the abort to
	 * 'bubble' to other parts in a chain of streams, which may not have ended
	 * yet. It will not change the end-state of this part of the stream though.
	 *
	 * @param reason Error value to signal a reason for the abort
	 */
	public abort(reason: Error): void {
		if (this._abortPromise) {
			return;
		}
		this._abortDeferred.reject(reason);
		this._abortPromise = this._abortDeferred.promise;
		this._pump();
	}

	/**
	 * Obtain promise that resolves to a rejection when `abort()` is called.
	 *
	 * Useful to pass abort to up- and down-stream sources.
	 *
	 * @return Promise that is rejected with abort error when stream is aborted
	 */
	public aborted(): Promise<void> {
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
	 * called and its return Thenable, if any, is resolved).
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
		mapper: (value: T) => R|Thenable<R>,
		ender?: (error?: Error) => void|Thenable<void>,
		aborter?: (error: Error) => void
	): ReadableStream<R> {
		let output = new Stream<R>();
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
		filterer: (value: T) => boolean|Thenable<boolean>,
		ender?: (error?: Error) => void|Thenable<void>,
		aborter?: (error: Error) => void
	): ReadableStream<T> {
		let output = new Stream<T>();
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
		reducer: (accumulator: T, current: T, index: number, stream: ReadableStream<T>) => T|Thenable<T>,
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
		reducer: (accumulator: R, current: T, index: number, stream: ReadableStream<T>) => R|Thenable<R>,
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
		reducer: (accumulator: R, current: T, index: number, stream: ReadableStream<T>) => R|Thenable<R>,
		initial?: R
	): Promise<R> {
		let haveAccumulator = arguments.length === 2;
		let accumulator: any = initial;
		let index = 0;
		return this.forEach(
			(value: T): void|Thenable<void> => {
				if (!haveAccumulator) {
					accumulator = value;
					haveAccumulator = true;
					index++;
				} else {
					return Promise.resolve(reducer(accumulator, value, index++, this))
						.then((newAccumulator: any) => accumulator = newAccumulator);
				}
			}
		).then(() => {
			if (!haveAccumulator) {
				return Promise.reject<R>(new TypeError("cannot reduce() empty stream without initial value"));
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
		let result: T[] = [];
		return this.forEach((value: T) => { result.push(value); })
			.return(result);
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
		let output = new Stream<R>();
		transformer(this, output);
		return output;
	}

	/**
	 * Repeatedly call `writer` and write its returned value (or promise for it)
	 * to the stream.
	 * The stream is ended when `writer` returns `undefined`.
	 *
	 * `writer` is only called when its previously returned value has been
	 * processed by the stream.
	 *
	 * If writing of a value fails (either by the callback throwing an error,
	 * returning a rejection, or the write call failing), the stream is aborted
	 * and ended with that error.
	 *
	 * If ending of the stream fails with an error other than the abort error,
	 * the program is terminated with an UnhandledEndError.
	 *
	 * NOTE Whether stream is aborted on error is still subject to change.
	 *
	 * @param writer Called when the next value can be written to the stream,
	 *               should return (a promise for) a value to be written,
	 *               or `undefined` (or void promise) to end the stream.
	 * @return Stream for all values in the input array
	 */
	public writeEach(writer: () => T|Thenable<T>|void|Thenable<void>): Promise<void> {
		this.aborted().catch((abortError) => {
			// Swallow errors from the end call, as they will be reflected in
			// result() too
			swallowErrors(this.end(abortError));
		});
		let loop = (): void|Promise<void> => {
			if (this._abortPromise) {
				// Don't call writer when aborted
				return;
			}
			let valuePromise = writer();
			return Promise.resolve<T|void>(valuePromise).then((value?: T) => {
				if (value === undefined) {
					return this.end();
				} else {
					return this.write(value).then(loop);
				}
			});
		};
		Promise.resolve().then(loop).done(undefined, (error: Error) => this.abort(error));
		return this.result();
	}

	// TODO Experimental
	// TODO Not sure whether a 'reverse' function confuses more than it helps
	public mappedBy<X>(mapper: (value: X) => T|Thenable<T>): WritableStream<X> {
		let input = new Stream<X>();
		map(input, this, mapper);
		return input;
	}

	// TODO Experimental
	// TODO Not sure whether a 'reverse' function confuses more than it helps
	public filterBy(filterer: (value: T) => boolean|Thenable<boolean>): WritableStream<T> {
		let input = new Stream<T>();
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
	public static from<T>(data: Thenable<Thenable<T>[]>): ReadableStream<T>;
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
	public static from<T>(data: Thenable<T>[]): ReadableStream<T>;
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
	public static from<T>(data: Thenable<T[]>): ReadableStream<T>;
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
	public static from<T>(data: T[]): ReadableStream<T>;
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
	public static from<T>(data: T[]|Thenable<T[]>|Thenable<T>[]|Thenable<Thenable<T>[]>): ReadableStream<T> {
		let stream = new Stream<T>();
		let i = 0;
		if (Array.isArray(data)) {
			stream.writeEach(() => data[i++]);
		} else {
			Promise.resolve<T[]|Thenable<T>[]>(data).then((resolvedArray) => {
				stream.writeEach(() => resolvedArray[i++]);
			});
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
			if (this._readBusy.isPending()) {
				// Pump is already attached to _readBusy, so just wait for that
				// to be resolved
				return;
			}

			// Previous reader/ender has resolved, return its result to the
			// corresponding write() or end() call
			this._writers.shift().resolveWrite(this._readBusy);
			if (this._endPending) {
				let result = this._endPending.result;
				this._ended = this._endPending.error || EOF;
				this._ending = undefined;
				this._endPending = undefined;
				this._aborter = undefined; // no longer call aborter after end handler has finished
				let p = result ? this._readBusy.then(() => result) : this._readBusy;
				this._resultDeferred.resolve(p);
			}
			this._readBusy = undefined;
		}

		// If ended, reject any pending and future writes/ends with an error
		if (this._ended) {
			while (this._writers.length > 0) {
				let writer = this._writers.shift();
				writer.resolveWrite(Promise.reject(new WriteAfterEndError()));
			}
			return;
		}

		// In case we're aborting, abort all pending and future write()'s (i.e.
		// not the end()'s)
		if (this._abortPromise) {
			while (this._writers.length > 0) {
				let writer = this._writers[0];
				let value = writer.value.isFulfilled() && writer.value.value();
				if (value instanceof Eof) {
					break;
				}
				// Reject all non-end write()'s with abort reason
				swallowErrors(writer.value);
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
		let writer = this._writers[0];

		// Wait until next written value is available
		// (Note: when aborting, all non-end() writers will already have been
		// aborted above, and an Eof is a resolved value)
		if (writer.value.isPending()) {
			writer.value.done(this._pumper, this._pumper);
			return;
		}

		// If written value resolved to a rejection, make its write() fail
		if (writer.value.isRejected()) {
			writer.resolveWrite(<Thenable<any>>writer.value);
			this._writers.shift();
			// Pump again
			Promise.resolve().done(this._pumper);
			return;
		}

		// Determine whether we should call the reader or the ender.
		// Handler is always asynchronously called, and by chaining it from
		// the writer's value, long stack traces are maintained.
		let value = writer.value.value();
		if (value instanceof Eof) {
			// EOF, with or without error
			assert(!this._ended && !this._endPending);
			this._endPending = value;
			let ender = this._ender; // Ensure calling without `this`
			this._ender = undefined; // Prevent calling again
			// Call with end error or override with abort reason if any
			let enderArg = this._abortPromise ? this._abortPromise.reason() : value.error;
			this._readBusy = writer.value.then((eofValue) => ender(enderArg));
		} else {
			this._readBusy = writer.value.then(this._reader);
		}
		this._readBusy.done(this._pumper, this._pumper);
	}
}

export default Stream;
