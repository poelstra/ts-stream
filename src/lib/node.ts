/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */

"use strict";

import * as NodeStream from "stream";
import * as fs from "fs";
import { Promise, Thenable, VoidDeferred } from "ts-promise";

import { Stream, Readable } from "./Stream";
import { swallowErrors } from "./util";

/**
 * Convert ts-stream into a Node.JS Readable instance.
 *
 * Usage example:
 * let sink = fs.createWriteStream("test.txt");
 * let tsSource = Stream.from(["abc", "def"]);
 * let source = new NodeReadable(tsSource);
 * source.pipe(sink);
 * sink.on("error", (error: Error) => tsSource.abort(error));
 * source.on("error", (error: Error) => { something like sink.destroy(); });
 *
 * @see `pipeToNodeStream()` for easier error and completion handling.
 */
export class NodeReadable<T> extends NodeStream.Readable {
	private _resumer: (value?: void|Thenable<void>) => void;

	/**
	 * Create new NodeJS Readable based on given ts-stream Readable.
	 *
	 * @see class description for usage example
	 *
	 * @param  tsReadable Source stream
	 * @param  options    Optional options to pass to Node.JS Readable constructor
	 */
	constructor(tsReadable: Readable<T>, options?: NodeStream.ReadableOptions) {
		super(options);
		swallowErrors(tsReadable.forEach(
			(chunk: any): void|Promise<void> => {
				// Try to push data, returns true if there's still space
				if (this.push(chunk)) {
					return;
				}
				// Stream blocked, wait until _read() is called
				let d = Promise.defer();
				this._resumer = d.resolve;
				return d.promise;
			},
			(err?: Error) => {
				if (err) {
					this.emit("error", err);
				}
				this.push(null); // tslint:disable-line:no-null-keyword
			},
			(abortError: Error) => {
				// Abort pending read, if necessary
				if (this._resumer) {
					this._resumer(Promise.reject(abortError));
					this._resumer = undefined;
				}
			}
		));
	}

	public _read(size: number): void {
		if (this._resumer) {
			this._resumer();
			this._resumer = undefined;
		}
	}
}

/**
 * Convenience wrapper around Node's file stream.
 *
 * Usage example:
 * let source = Stream.from(["abc", "def"]);
 * source.pipe(new FileSink("test.txt"));
 *
 * To wait for the stream's result, use e.g.
 * let sink = source.pipe(new FileSink("test.txt"));
 * sink.result().then(() => console.log("ok"), (err) => console.log("error", err));
 */
export class FileSink extends Stream<string> {
	/**
	 * Construct writable ts-stream which writes all values to given file.
	 * If the stream is ended with an error, the file is closed (and `result()`)
	 * reflects that error.
	 *
	 * @see class description for usage example
	 *
	 * @param  path    Filename to wite to
	 * @param  options Optional options (see https://nodejs.org/api/fs.html#fs_fs_createwritestream_path_options)
	 */
	constructor(path: string, options?: {
		flags?: string;
		encoding?: string;
		string?: string;
	}) {
		super();
		pipeToNodeStream(this, fs.createWriteStream(path, options));
	}
}

/**
 * Pipe a ts-stream ReadableStream to a Node.JS WritableStream.
 *
 * Reads all values from `tsReadable` and writes them to `nodeWritable`.
 * When readable ends, writable is also ended.
 *
 * If an error occurs on the writable stream, the readable stream is aborted
 * with that error.
 * If the readable stream is ended with an error, that error is optionally
 * emitted on the writable stream, and then the writable stream is ended.
 *
 * Usage example:
 * let sink = fs.createWriteStream("test.txt");
 * let source = Stream.from(["abc", "def"]);
 * let result = pipeToNodeStream(source, sink);
 * result.then(() => console.log("done"), (err) => console.log(err));
 *
 * @see `NodeReadable` if you need an instance of a Node.JS ReadableStream
 *
 * @param tsReadable   Source stream
 * @param nodeWritable Destination stream
 * @param emitError    Whether to emit errors in tsReadable on nodeWritable
 *                     (default false). Useful for e.g. destroying a socket
 *                     when an error occurs.
 * @return Promise that resolves when stream is finished (rejected when an error
 *         occurred)
 */
export function pipeToNodeStream<T>(
	tsReadable: Readable<T>,
	nodeWritable: NodeJS.WritableStream,
	emitError: boolean = false
): Promise<void> {
	let endDeferred = Promise.defer();
	let blockedDeferred: VoidDeferred;

	// Handle errors emitted by node stream: abort ts-stream
	function handleNodeStreamError(error: Error): void {
		// Don't 're-emit' the same error on which we were triggered
		emitError = false;
		// Make sure stream's end result reflects error
		endDeferred.reject(error);
		tsReadable.abort(error);

		if (blockedDeferred) {
			blockedDeferred.reject(error);
			nodeWritable.removeListener("drain", blockedDeferred.resolve);
		}
	}

	// Optionally pass ts-stream errors to node stream
	function handleTsStreamError(error: Error): void {
		if (!emitError) {
			return;
		}
		emitError = false;
		nodeWritable.removeListener("error", handleNodeStreamError); // prevent abort
		nodeWritable.emit("error", error);
	}

	nodeWritable.once("error", handleNodeStreamError);
	nodeWritable.once("finish", () => {
		nodeWritable.removeListener("error", handleNodeStreamError);
		endDeferred.resolve(); // ignored if error happens earlier
	});

	return tsReadable.forEach(
		(chunk: any): void|Promise<void> => {
			blockedDeferred = undefined;
			// Try to push data, returns true if there's still space
			let canAcceptMore = nodeWritable.write(chunk);
			if (!canAcceptMore) {
				// Stream blocked, wait until drain is emitted
				blockedDeferred = Promise.defer();
				nodeWritable.once("drain", blockedDeferred.resolve);
				return blockedDeferred.promise;
			}
		},
		(endError?: Error): Promise<void>  => {
			if (endError) {
				handleTsStreamError(endError);
			}
			// Note: we don't pass a callback to end(), as some types of
			// streams (e.g. sockets) may forget to call the callback in
			// some scenarios (e.g. connection reset).
			// We use the "finish" event to mark the stream's end, but it
			// doesn't get emitted on e.g. a connection refused error.
			nodeWritable.end();
			return endDeferred.promise;
		},
		handleTsStreamError // abort handler
	);
}
