/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2017 Martin Poelstra
 * License: MIT
 */

import { defer } from "../lib/util";
export * from "../lib/util";

/**
 * Waits until all promises are fulfilled or rejected
 * @param promises
 */
export function settle(promises: PromiseLike<any>[]): Promise<void> {
	const result = defer();
	let count = promises.length;
	const check = (): void => {
		count--;
		if (count === 0) {
			result.resolve();
		}
	};
	for (const promise of promises) {
		promise.then(check, check);
	}
	return result.promise;
}
