/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */

"use strict";

import { Promise, Thenable, BaseError } from "ts-promise";
import * as assert from "assert";

import { Transform, map, filter } from "./Transform";

/**
 * Required methods for the readable part of a stream.
 */
export interface Readable<T> {
	/**
	 * Read all values from stream, optionally waiting for explicit stream end.
	 *
	 * `reader` will be called for every written value, `ender` will be called
	 * once when the stream has ended.
	 *
	 * `ender` receives the error in case the stream was `end()`'ed with and
	 * error or `abort()`'ed, or `undefined` in case of a normal stream end.
	 *
	 * Both callbacks can return a promise to indicate when the value (or
	 * end-of-stream condition) has been completely processed. This ensures that
	 * a fast writer can never overload a slow reader, and is called
	 * 'backpressure'.
	 *
	 * The corresponding `write()` or `end()` operation is blocked until the
	 * value returned from the callback is resolved. If the callback throws an
	 * error or the returned promise resolves to a rejection, the promise
	 * returned by the write call will be rejected with it.
	 *
	 * It is guaranteed that the callbacks will be called asynchronously (i.e.
	 * some time after `forEach()` returns), and their `this` argument will be
	 * undefined.
	 * It is also guaranteed that the reader is never called again before its
	 * previously returned promise is resolved/rejected.
	 * The ender will also typically be called after all reads have finished,
	 * but may be called while a read handler's returned promise is still
	 * pending, if the stream is `abort()`'ed.
	 *
	 * If no `ender` is given, a default end handler is installed that returns
	 * any stream end errors to the writer, and otherwise directly acknowledges
	 * the end-of-stream.
	 *
	 * @param reader Callback called with every written value
	 * @param ender  Callback called when stream ended
	 */
	forEach(reader: (value: T) => void|Thenable<void>, ender?: (error?: Error) => void|Thenable<void>): void;

	/**
	 * Abort the stream with an error.
	 * This will abort any pending and future writes, and signal stream end with
	 * this error to `forEach()`'s end handler.
	 *
	 * If the stream's end handler has already been called, the abort is
	 * ignored.
	 * Note: a pending read cannot be aborted, but the end callback of `forEach`
	 * will be called regardless.
	 */
	abort(reason: Error): void;
}

/**
 * Required methods for the writable part of a stream.
 */
export interface Writable<T> {
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
	 * processing. It is rejected if the read handler throws an error or returns
	 * a rejected Thenable.
	 *
	 * All calls to `write()` or `end()` after the first `end()` will be
	 * rejected with a `WriteAfterEndError`.
	 *
	 * @param  error Optional Error to pass to `forEach()` end handler
	 * @return Void-promise that resolves when end-handler has processed the
	 *         end-of-stream
	 */
	end(error?: Error): Promise<void>;

	/**
	 * Abort the stream with an error.
	 * This will abort any pending and future writes, and signal stream end with
	 * this error to `forEach()`'s end handler.
	 *
	 * If the stream's end handler has already been called, the abort is
	 * ignored.
	 * Note: a pending read cannot be aborted, but the end callback of `forEach`
	 * will be called regardless.
	 */
	abort(reason: Error): void;
}

/**
 * Readable part of a generic Stream, which contains handy helpers such as
 * .map() in addition to the basic requirements of a Readable interface.
 */
export interface ReadableStream<T> extends Readable<T> {
	/**
	 * Obtain a promise that resolves when the stream has completely ended, i.e.
	 * `end()` has been called (possibly with an Error), and the end handler has
	 * run and its returned promise resolved or rejected.
	 * @return Promise resolved with the result of `forEach()`'s end handler
	 */
	ended(): Promise<void>;

	/**
	 * Determine whether stream has completely ended (i.e. end handler has been
	 * called and its return Thenable, if any, is resolved).
	 * @return true when stream has ended, false otherwise
	 */
	isEnded(): boolean;

	/**
	 * Run all input values through a mapping callback, which must produce a new
	 * value (or promise for a value), similar to e.g. `Array`'s `map()`.
	 *
	 * Stream end in the input stream (normal or with error) will be passed to
	 * the returned stream.
	 *
	 * @param mapper Callback which receives each value from this stream, and
	 *               must produce a new value (or promise for a value).
	 * @return New stream with mapped values.
	 */
	map<R>(mapper: (value: T) => R|Thenable<R>): ReadableStream<R>;

	/**
	 * Run all input values through a filtering callback. If the filter callback
	 * returns a truthy value (or a promise for a truthy value), the input value
	 * is written to the output stream, otherwise it is ignored.
	 * Similar to e.g. `Array`'s `filter()`.
	 *
	 * Stream end in the input stream (normal or with error) will be passed to
	 * the returned stream.
	 *
	 * @param filterer Callback which receives each value from this stream,
	 *                 input value is written to output if callback returns a
	 *                 (promise for) a truthy value.
	 * @return New stream with filtered values.
	 */
	filter(filterer: (value: T) => boolean|Thenable<boolean>): ReadableStream<T>;

	/**
	 * Read all values and end-of-stream from this stream, writing them to
	 * `writable`.
	 *
	 * @param  writable Destination stream
	 * @return The stream passed in, for easy chaining
	 */
	pipe(writable: Writable<T>): Writable<T>;

	// TODO Experimental
	transform<R>(transformer: Transform<T, R>): ReadableStream<R>;
}

/**
 * Writable part of a generic Stream, which contains handy helpers such as
 * .mappedBy() in addition to the basic requirements of a Writable interface.
 */
export interface WritableStream<T> extends Writable<T> {
	/**
	 * Obtain a promise that resolves when the stream has completely ended, i.e.
	 * `end()` has been called (possibly with an Error), and the end handler has
	 * run and its returned promise resolved or rejected.
	 * @return Promise resolved with the result of `forEach()`'s end handler
	 */
	ended(): Promise<void>;

	/**
	 * Determine whether stream has completely ended (i.e. end handler has been
	 * called and its return Thenable, if any, is resolved).
	 * @return true when stream has ended, false otherwise
	 */
	isEnded(): boolean;

	// TODO Experimental
	writeEach(writer: () => T|Thenable<T>|void|Thenable<void>): Promise<void>;

	// TODO Experimental
	// TODO Not sure whether a 'reverse' function confuses more than it helps
	mappedBy<X>(mapper: (value: X) => T|Thenable<T>): WritableStream<X>;

	// TODO Experimental
	// TODO Not sure whether a 'reverse' function confuses more than it helps
	filterBy(filterer: (value: T) => boolean|Thenable<boolean>): WritableStream<T>;
}

/**
 * Thrown when writing to an already-ended stream.
 */
export class WriteAfterEndError extends BaseError {
	constructor() {
		super("WriteAfterEndError", "stream already ended");
	}
}

function noop() { /* no-op */ }

/**
 * Swallow any error that may result from this promise.
 * Used during e.g. `abort()`, to ignore potential errors.
 */
function swallowErrors(promise: Promise<any>): void {
	promise.done(noop, noop);
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
var eof = new Error("eof");

/**
 * Special end-of-stream value, optionally signalling an error.
 */
class Eof {
	/**
	 * Create new end-of-stream value, optionally signalling an error.
	 * @param  error optional Error value
	 */
	constructor(public error?: Error) {
	}
}

/**
 * Written value-promise and a function to resolve the corresponding `write()`
 * call's return promise.
 */
interface WriteItem<T> {
	/**
	 * Promise for value passed to `write()`.
	 * Either a special Eof value, or a value of type `T`.
	 */
	value: Promise<Eof|T>;

	/**
	 * Resolver `write()`'s returned promise
	 */
	resolveWrite: (done?: void|Thenable<void>) => void;
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
	 * End handler that is called when the stream is ended or aborted, as set by
	 * `forEach()`. Note that `forEach()` installs a default handler if the user
	 * did not supply one.
	 * Set to 'undefined' when it has been called.
	 */
	private _ender: (error?: Error) => void|Thenable<void>;

	/**
	 * When a written value is being processed by the `_reader`, this property
	 * is set to a promise that resolves when the reader's returned Thenable is
	 * resolved (or rejected).
	 */
	private _readBusy: Promise<void>;

	/**
	 * Set to the error passed to `end()` (or the special value `eof`) when the
	 * stream was ended by writer, but the operation is not yet confirmed by
	 * the `_ender`. Unset when `_ended` is set.
	 */
	private _ending: Error;

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
	 * Resolved to the result of calling `_ender`.
	 */
	private _endDeferred = Promise.defer();

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
	write(value: T|Thenable<T>): Promise<void> {
		if (value === undefined) {
			// Technically, we could allow this, but it's a common programming
			// error to forget to return a value, and it's arguable whether it's
			// useful to have a stream of void's, so let's prevent it for now.
			// NOTE: This behaviour may change in the future
			// TODO: prevent writing a void Thenable too?
			throw new TypeError("cannot write void value, use end() to end the stream");
		}

		let valuePromise = Promise.resolve(value);
		let writeDone = Promise.defer();
		this._writers.push({
			value: valuePromise,
			resolveWrite: writeDone.resolve
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
	 * processing. It is rejected if the read handler throws an error or returns
	 * a rejected Thenable.
	 *
	 * All calls to `write()` or `end()` after the first `end()` will be
	 * rejected with a `WriteAfterEndError`.
	 *
	 * @param  error Optional Error to pass to `forEach()` end handler
	 * @return Void-promise that resolves when end-handler has processed the
	 *         end-of-stream
	 */
	end(error?: Error): Promise<void> {
		if (!(error === undefined || error === null || error instanceof Error)) {
			throw new TypeError("invalid argument to end(): must be undefined, null or Error object");
		}
		let valuePromise = Promise.resolve(new Eof(error));
		let writeDone = Promise.defer();
		this._writers.push({
			value: valuePromise,
			resolveWrite: writeDone.resolve
		});
		this._pump();
		return writeDone.promise;
	}

	/**
	 * Read all values from stream, optionally waiting for explicit stream end.
	 *
	 * `reader` will be called for every written value, `ender` will be called
	 * once when the stream has ended.
	 *
	 * `ender` receives the error in case the stream was `end()`'ed with and
	 * error or `abort()`'ed, or `undefined` in case of a normal stream end.
	 *
	 * Both callbacks can return a promise to indicate when the value (or
	 * end-of-stream condition) has been completely processed. This ensures that
	 * a fast writer can never overload a slow reader, and is called
	 * 'backpressure'.
	 *
	 * The corresponding `write()` or `end()` operation is blocked until the
	 * value returned from the callback is resolved. If the callback throws an
	 * error or the returned promise resolves to a rejection, the promise
	 * returned by the write call will be rejected with it.
	 *
	 * It is guaranteed that the callbacks will be called asynchronously (i.e.
	 * some time after `forEach()` returns), and their `this` argument will be
	 * undefined.
	 * It is also guaranteed that the reader is never called again before its
	 * previously returned promise is resolved/rejected.
	 * The ender will also typically be called after all reads have finished,
	 * but may be called while a read handler's returned promise is still
	 * pending, if the stream is `abort()`'ed.
	 *
	 * If no `ender` is given, a default end handler is installed that returns
	 * any stream end errors to the writer, and otherwise directly acknowledges
	 * the end-of-stream.
	 *
	 * @param reader Callback called with every written value
	 * @param ender  Callback called when stream ended
	 */
	forEach(reader: (value: T) => void|Thenable<void>, ender?: (error?: Error) => void|Thenable<void>): void {
		assert(!this._reader && !this._ender, "already have a reader");
		if (!ender) {
			ender = defaultEnder;
		}
		this._reader = reader;
		this._ender = ender;
		this._pump();
	}

	/**
	 * Abort the stream with an error.
	 *
	 * This will abort any pending and future writes, and signal stream end with
	 * this error to `forEach()`'s end handler.
	 *
	 * Abort is ignored if the stream's fate is already decided, i.e. already
	 * aborted, or ended completely (end handler's return value has resolved).
	 *
	 * The stream's end handler will only be called if it has not been called
	 * already.
	 * If a read handler was called and its return value has not resolved yet,
	 * the end handler will be called regardless (although it is guaranteed not
	 * to be called *during* the read handler).
	 */
	abort(reason: Error): void {
		if (!this._endDeferred.promise.isPending()) {
			return;
		}
		this._abortPromise = Promise.reject(reason);

		this._pump();
	}

	/**
	 * Obtain a promise that resolves when the stream has completely ended, i.e.
	 * `end()` has been called (possibly with an Error), and the end handler has
	 * run and its returned promise resolved or rejected.
	 * @return Promise resolved with the result of `forEach()`'s end handler
	 */
	ended(): Promise<void> {
		return this._endDeferred.promise;
	}

	/**
	 * Determine whether stream has completely ended (i.e. end handler has been
	 * called and its return Thenable, if any, is resolved).
	 * @return true when stream has ended, false otherwise
	 */
	isEnded(): boolean {
		return !!this._ended;
	}

	/**
	 * Run all input values through a mapping callback, which must produce a new
	 * value (or promise for a value), similar to e.g. `Array`'s `map()`.
	 *
	 * Stream end in the input stream (normal or with error) will be passed to
	 * the returned stream.
	 *
	 * @param mapper Callback which receives each value from this stream, and
	 *               must produce a new value (or promise for a value).
	 * @return New stream with mapped values.
	 */
	map<R>(mapper: (value: T) => R|Thenable<R>): ReadableStream<R> {
		let output = new Stream<R>();
		map(this, output, mapper);
		return output;
	}

	/**
	 * Run all input values through a filtering callback. If the filter callback
	 * returns a truthy value (or a promise for a truthy value), the input value
	 * is written to the output stream, otherwise it is ignored.
	 * Similar to e.g. `Array`'s `filter()`.
	 *
	 * Stream end in the input stream (normal or with error) will be passed to
	 * the returned stream.
	 *
	 * @param filterer Callback which receives each value from this stream,
	 *                 input value is written to output if callback returns a
	 *                 (promise for) a truthy value.
	 * @return New stream with filtered values.
	 */
	filter(filterer: (value: T) => boolean|Thenable<boolean>): ReadableStream<T> {
		let output = new Stream<T>();
		filter(this, output, filterer);
		return output;
	}

	/**
	 * Read all values and end-of-stream from this stream, writing them to
	 * `writable`.
	 *
	 * @param  writable Destination stream
	 * @return The stream passed in, for easy chaining
	 */
	pipe(writable: Writable<T>): Writable<T> {
		this.forEach(
			(value: T) => writable.write(value),
			(error?: Error) => writable.end(error)
		);
		return writable;
	}

	// TODO Experimental
	transform<R>(transformer: Transform<T, R>): ReadableStream<R> {
		let output = new Stream<R>();
		transformer(this, output);
		return output;
	}

	// TODO Experimental
	writeEach(writer: () => T|Thenable<T>|void|Thenable<void>): Promise<void> {
		// TODO Or `writer: (write, end) => ...`-style callback?
		// TODO if write/end return an error, promise is rejected, but stream
		// may still be open. Not ideal for an 'easy' helper like writeEach()
		var loop = (): Promise<void> => {
			return Promise.resolve<T|void>(writer()).then((v) => {
				if (v === undefined) {
					return this.end();
				} else {
					return this.write(<T>v).then(loop);
				}
			});
		};
		return loop();
	}

	// TODO Experimental
	// TODO Not sure whether a 'reverse' function confuses more than it helps
	mappedBy<X>(mapper: (value: X) => T|Thenable<T>): WritableStream<X> {
		let input = new Stream<X>();
		map(input, this, mapper);
		return input;
	}

	// TODO Experimental
	// TODO Not sure whether a 'reverse' function confuses more than it helps
	filterBy(filterer: (value: T) => boolean|Thenable<boolean>): WritableStream<T> {
		let input = new Stream<T>();
		filter(input, this, filterer);
		return input;
	}

	/**
	 * Return a Stream for all values in the input array.
	 *
	 * If a reader returns an error, the stream will be aborted with that error.
	 * TODO: this behavior may be subject to change
	 *
	 * @param data Input array
	 * @return Stream for all values in the input array
	 */
	static from<T>(data: T[]): ReadableStream<T> {
		// TODO: consider rewriting to use .forEach()
		let stream = new Stream<T>();
		let i = 0;
		let aborter = (error?: Error) => {
			if (error) {
				// TODO
				// - Explode?
				// - maybe only have `static into<T>(writable, data): Promise<void>`?
				// - allow passing an end-callback?
				// - expect people to listen for ended()?
				stream.abort(error);
			}
		};
		let loop = () => {
			if (i >= data.length) {
				return stream.end().done(undefined, aborter);
			}
			stream.write(data[i++]).done(loop, aborter);
		};
		loop();
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
		// If aborted, abort all writers, end reader
		if (this._abortPromise) {
			// Note: this part may be called multiple times (in case of 'late
			// arrivals' or writers/reader)

			while (this._writers.length > 0) {
				let writer = this._writers.shift();
				writer.resolveWrite(this._abortPromise);
			}

			// TODO: wait for _readBusy to be done before calling _ender?
			// Defeats the purpose of a fast cancellation, but violates the
			// 'contract' of not calling one of the callbacks before the
			// previous one has finished.
			if (this._readBusy) {
				swallowErrors(this._readBusy); // TODO: better way to handle this?
				this._readBusy = undefined;
			}

			if (this._ender) {
				// Make sure to asynchronously call the end handler, without a
				// `this`, and maintain long stack traces
				let endResult = this._abortPromise.catch(this._ender);
				this._ender = undefined;
				swallowErrors(endResult); // TODO: better way to handle this?
			}

			this._ending = undefined;
			this._ended = this._abortPromise.reason();
			this._endDeferred.resolve(this._abortPromise);

			return;
		}

		// If waiting for a reader/ender, wait some more or handle it
		if (this._readBusy) {
			if (this._readBusy.isPending()) {
				// TODO: prevent unnecessary pumps
				this._readBusy.done(this._pumper, this._pumper);
				return;
			}

			assert(this._writers.length > 0);
			this._writers.shift().resolveWrite(this._readBusy);
			if (this._ending) {
				this._ended = this._ending;
				this._ending = undefined;
				this._endDeferred.resolve(this._readBusy);
			}
			this._readBusy = undefined;
		}

		// If ended, reject any pending and future writes with an error
		if (this._ended) {
			while (this._writers.length > 0) {
				let writer = this._writers.shift();
				writer.resolveWrite(Promise.reject(new WriteAfterEndError()));
			}
			return;
		}

		// Wait until both written value(s) and a reader are available
		if (this._writers.length === 0 || !this._reader) {
			// write(), end() and forEach() will pump us again
			return;
		}
		let writer = this._writers[0];

		// Wait until written value is available
		if (writer.value.isPending()) {
			// TODO: prevent unnecessary pumps
			writer.value.done(this._pumper, this._pumper);
			return;
		}

		// If written value resolved to a rejection, make its write() fail
		if (writer.value.isRejected()) {
			writer.resolveWrite(writer.value);
			this._writers.shift();
			Promise.resolve().done(this._pumper);
			return;
		}

		// Determine whether we should call the reader or the ender.
		// Handler is always asynchronously called, and by chaining it from
		// the writer's value, long stack traces are maintained.
		let value = writer.value.value();
		if (value instanceof Eof) {
			// EOF, with or without error
			assert(!this._ended && !this._ending);
			this._ending = value.error || eof;
			let ender = this._ender; // Ensure calling without `this`
			this._ender = undefined; // Prevent calling again
			this._readBusy = writer.value.then((eofValue: Eof) => ender(eofValue.error));
		} else {
			this._readBusy = writer.value.then(this._reader);
		}
		this._readBusy.done(this._pumper, this._pumper);
	}
}

export default Stream;
