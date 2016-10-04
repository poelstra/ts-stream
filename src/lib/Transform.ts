/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */

"use strict";

import { Promise, Thenable } from "ts-promise";
import { Stream, Readable, Writable } from "./Stream";

export interface Transform<In, Out> {
	(readable: Readable<In>, writable: Writable<Out>): void;
}

export function compose<In, Middle, Out>(t1: Transform<In, Middle>, t2: Transform<Middle, Out>): Transform<In, Out> {
	return (readable: Readable<In>, writable: Writable<Out>): void => {
		let stream = new Stream<Middle>();
		t1(readable, stream);
		t2(stream, writable);
	};
}

// Return an ender callback that first runs an optional user-supplied ender,
// followed by the default ender that always ends the stream.
// It's refactored out, because it's currently a bit tricky and exact behavior
// may change, see TODO in implementation.
function composeEnders(
	ender: (error?: Error) => void|Thenable<void>,
	defaultEnder: (error?: Error) => void|Thenable<void>
): (error?: Error) => void|Thenable<void> {
	if (!ender) {
		return defaultEnder;
	}
	return (error?: Error) => {
		// TODO: an error returned from ender is currently passed on to next
		// stream, if stream was not ended with an error yet.
		// It'd maybe be better to not have the next stream be ended when an
		// error occurred in this ender, but there's no way to send another
		// end(), so we have to close it somehow...
		return Promise.resolve(error).then(ender).then(
			() => defaultEnder(error),
			(enderError: Error) => {
				// ender callback failed, but in order to let final stream fail,
				// we need to pass 'something' on, and to wait for that to come
				// back.
				// Finally, make sure to return the enderError.
				return Promise.resolve(defaultEnder(error || enderError)).then(
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
	mapper: (value: T) => R|Thenable<R>,
	ender?: (error?: Error) => void|Thenable<void>,
	aborter?: (error: Error) => void
): void {
	writable.aborted().catch((err) => readable.abort(err));
	readable.aborted().catch((err) => writable.abort(err));
	readable.forEach(
		(v: T) => writable.write(mapper(v)),
		composeEnders(ender, (error?: Error) => writable.end(error, readable.result())),
		aborter
	);
}

export function filter<T>(
	readable: Readable<T>,
	writable: Writable<T>,
	filterer: (value: T) => boolean|Thenable<boolean>,
	ender?: (error?: Error) => void|Thenable<void>,
	aborter?: (error: Error) => void
): void {
	writable.aborted().catch((err) => readable.abort(err));
	readable.aborted().catch((err) => writable.abort(err));
	readable.forEach(
		(v: T): void|Promise<void> => {
			var b = filterer(v);
			if (!b) {
				return;
			} else if (b === true) { // note: not just `if (b)`!
				return writable.write(v);
			} else { // more complex return type, probably a Thenable
				return Promise.resolve(b).then((resolvedB) => {
					if (resolvedB) {
						return writable.write(v);
					}
				});
			}
		},
		composeEnders(ender, (error?: Error) => writable.end(error, readable.result())),
		aborter
	);
}

export default Transform;
