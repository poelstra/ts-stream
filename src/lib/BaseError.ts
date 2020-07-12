/**
 * Base class for custom errors.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */

export default class BaseError extends Error {
	public stack?: string; // provided by V8

	constructor(name: string, message: string) {
		super(message);

		let fixStack = false;

		// This fixes the prototype chain if it's broken (when emitting for ES 5 or lower)
		if (this.constructor !== new.target) {
			Object.setPrototypeOf(this, new.target.prototype);
			fixStack = true;
		}

		// This occurs when the error is not thrown but only created in IE
		if (!("stack" in this)) {
			fixStack = true;
		}

		this.name = name;

		if (fixStack) {
			// This.name and this.message must be set correctly in order to fix the stack correctly
			if (Error.captureStackTrace) {
				Error.captureStackTrace(this, new.target);
			} else {
				const error = new Error(this.message);
				error.name = this.name;
				try {
					throw error;
				} catch (error) {
					this.stack = error.stack || String(error);
				}
			}
		}
	}
}
