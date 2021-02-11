/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */

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
export function swallowErrors(promise: PromiseLike<any>): void {
	promise.then(undefined, noop);
}

/**
 * Combination of a promise and its resolve/reject functions.
 * Created using defer().
 *
 * It is generally better (and slightly faster) to use the Promise
 * constructor to create a promise, as that will also catch any exception
 * thrown while running the resolver.
 *
 * A Deferred can be useful in some scenarios though, e.g. when working with
 * timers, protocol request/response pairs, etc.
 */
export interface Deferred<T> {
	/**
	 * Initially unresolved promise, resolved by the resolve or reject
	 * function on this object.
	 */
	promise: Promise<T>;

	/**
	 * Reject corresponding promise.
	 * The first call to either resolve or reject resolves the promise, any
	 * other calls are ignored.
	 * This function is a free function (i.e. not a 'method' on this object).
	 */
	reject: (reason: Error) => void;

	/**
	 * Resolve corresponding promise.
	 * The first call to either resolve or reject resolves the promise, any
	 * other calls are ignored.
	 * This function is a free function (i.e. not a 'method' on this object).
	 * Note: resolving with a rejected PromiseLike leads to a rejected promise.
	 */
	resolve: (value: T | PromiseLike<T>) => void;
}

/**
 * Convenience version of Deferred that allows calling resolve() without an
 * argument.
 *
 * Deferred is a combination of a promise and its resolve/reject functions.
 * Created using defer().
 *
 * It is generally better (and slightly faster) to use the Promise
 * constructor to create a promise, as that will also catch any exception
 * thrown while running the resolver.
 *
 * A Deferred can be useful in some scenarios though, e.g. when working with
 * timers, protocol request/response pairs, etc.
 */
export interface VoidDeferred extends Deferred<void> {
	/**
	 * Resolve corresponding promise.
	 * The first call to either resolve or reject resolves the promise, any
	 * other calls are ignored.
	 * This function is a free function (i.e. not a 'method' on this object).
	 * Note: resolving with a rejected PromiseLike leads to a rejected promise.
	 */
	resolve: (value?: void | PromiseLike<void>) => void;
}

/**
 * Returns a deferred promise, i.e. one that you can still resolve or reject using the returned functions
 */
export function defer(): VoidDeferred;
export function defer<T>(): Deferred<T>;
export function defer<T>(): Deferred<T> {
	let resolve: (value: T | PromiseLike<T>) => void;
	let reject: (error: Error) => void;
	const promise = new Promise(
		(
			a: (value: T | PromiseLike<T>) => void,
			b: (error: Error) => void
		): void => {
			resolve = a;
			reject = b;
		}
	);
	return { promise, reject: reject!, resolve: resolve! };
}

/**
 * Used to track the status of a promise
 */
export interface TrackedPromise<T> {
	/**
	 * Promise not fulfilled/rejected yet
	 */
	isPending: boolean;
	/**
	 * Promise is rejected; error is in 'reason' member
	 */
	isRejected: boolean;
	/**
	 * Promise is fulfilled, value is in 'value' member
	 */
	isFulfilled: boolean;
	/**
	 * The original promise
	 */
	promise: PromiseLike<T>;
	/**
	 * The error for a rejection
	 */
	reason?: Error;
	/**
	 * The value when fulfilled
	 */
	value?: T;
}

export interface TrackedVoidPromise extends TrackedPromise<void> {
	value?: void;
}

/**
 * Creates an object to track the status of a promise.
 *
 * Note that this attaches a handler to the promise so no unhandled
 * rejection can take place after this. However, the new chained
 * promise on the tracker object can still throw an unhandled
 * rejection.
 *
 * @param p promise to track
 */
export function track(p: PromiseLike<void>): TrackedVoidPromise;
export function track<T>(p: PromiseLike<T>): TrackedPromise<T>;
export function track<T>(p: PromiseLike<T>): TrackedPromise<T> {
	const tracked: TrackedPromise<T> = {
		isFulfilled: false,
		isPending: true,
		isRejected: false,
		promise: undefined as any, // set later
	};
	const trackedPromise = p.then(
		(value: T): T => {
			tracked.isPending = false;
			tracked.isFulfilled = true;
			tracked.value = value;
			return value;
		},
		(error: Error): T => {
			tracked.isPending = false;
			tracked.isRejected = true;
			tracked.reason = error;
			throw error;
		}
	);
	tracked.promise = trackedPromise;
	return tracked;
}

/**
 * Resolves a promise after a number of milliseconds
 */
export function delay(duration: number): Promise<void>;
export function delay<T>(duration: number, t: T): Promise<T>;
export function delay(duration: number, t?: any): Promise<any> {
	return new Promise((resolve: (t: any) => void): void => {
		setTimeout(() => resolve(t), duration);
	});
}
