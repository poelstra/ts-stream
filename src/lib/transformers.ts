/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */

"use strict";

import { Thenable } from "ts-promise";

import { Readable, Writable } from "./Stream";
import { Transform, filter, map } from "./Transform";

export function mapper<In, Out>(mapFn: (value: In) => Out|Thenable<Out>): Transform<In, Out> {
	return (readable: Readable<In>, writable: Writable<Out>): void => {
		map(readable, writable, mapFn);
	};
}

export function filterer<T>(filterFn: (value: T) => boolean|Thenable<boolean>): Transform<T, T> {
	return (readable: Readable<T>, writable: Writable<T>): void => {
		filter(readable, writable, filterFn);
	};
}
