/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */

"use strict";

import Promise from "ts-promise";

/**
 * Do nothing.
 */
export function noop(...args: any[]): void {
	/* no-op */
}

/**
 * Swallow any error that may result from this promise.
 * Prevents PossiblyUnhandledExceptionErrors.
 */
export function swallowErrors(promise: Promise<any>): void {
	promise.done(noop, noop);
}
