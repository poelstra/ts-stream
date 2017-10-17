/**
 * Base class for custom errors.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */

var hasStacks = (typeof (<any>Error).captureStackTrace === "function");

export default class BaseError extends Error {
	public stack: string; // provided by V8

	constructor(name: string, message: string) {
		super(message);
		this.name = name;

		// Note: still need to 'manually' assign .message,
		// because engines apparently don't allow subclassing properly.
		// https://github.com/Microsoft/TypeScript/issues/1168#issuecomment-107729088
		this.message = message;

		/* istanbul ignore else */ // TODO: remove when testing for non-V8
		if (hasStacks) {
			(<any>Error).captureStackTrace(this, this.constructor);
		} else {
			this.stack = "dummy\n<no trace>";
		}
	}
}
