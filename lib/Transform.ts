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

export function map<T,R>(readable: Readable<T>, writable: Writable<R>, mapper: (value: T) => R|Thenable<R>): void {
	readable.forEach(
		(v: T): Promise<void> => {
			return writable.write(mapper(v));
		},
		(error?: Error) => writable.end(error)
	);
}

export function filter<T>(readable: Readable<T>, writable: Writable<T>, filterer: (value: T) => boolean|Thenable<boolean>): void {
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
		(error?: Error) => writable.end(error)
	);
}

export default Transform;
