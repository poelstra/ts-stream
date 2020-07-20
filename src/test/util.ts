/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2017 Martin Poelstra
 * License: MIT
 */

import { defer } from "../lib/util";
import { ReadableStream } from "../lib";
import { expect } from "chai";
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

export function readInto<T>(
	stream: ReadableStream<T>,
	into: T[]
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		stream
			.forEach(
				function (this: any, value: T): void {
					expect(this).to.equal(undefined);
					into.push(value);
				},
				function (this: any, err?: Error): void {
					expect(this).to.equal(undefined);
					if (err) {
						reject(err);
					} else {
						resolve(undefined);
					}
				}
			)
			.catch((e) => reject(e));
	});
}

export function noop(): void {
	/* empty */
}

export function identity<T>(arg: T): T {
	return arg;
}
