import * as chaiAsPromised from "chai-as-promised";
import * as chai from "chai";
chai.use(chaiAsPromised);

import { endCatcher, mapper } from "../lib/transformers";

import "./mocha-init";
import { useFakeTimers } from "sinon";
import Stream from "../lib";
import { expect } from "chai";
import { noop } from "../lib/util";
import { identity } from "./util";
import BaseError from "../lib/BaseError";

describe("transformers", () => {
	let s: Stream<number>;
	let abortError: Error;
	let boomError: Error;
	let sinonClock: ReturnType<typeof useFakeTimers>;

	before(() => {
		sinonClock = useFakeTimers();
	});

	beforeEach(() => {
		s = new Stream<number>();
		abortError = new Error("Test stream explicitly aborted");
		boomError = new Error("Test error");
	});

	after(() => {
		sinonClock.restore();
	});

	/**
	 * Run an async function, advance the sinon mocked clock until the function resolves,
	 * and then return the function's promise.
	 *
	 * This avoids the need to explicitly advance the clock.
	 *
	 * @param fn A test function
	 */
	function clockwise(fn: () => Promise<void>) {
		return async () => {
			const fnPromise = fn();
			await Promise.all([sinonClock.runAllAsync(), fnPromise]);
		};
	}

	describe("endCatcher()", () => {
		type MyObject = number;

		let expectErrorFromEnd = false;
		function getRowsFromDatabase<T>(query: any): Stream<T> {
			const source = new Stream<number>();
			source.write(1);
			source.write(2);
			if (expectErrorFromEnd) {
				expect(source.end()).eventually.rejectedWith(
					NotAllObjectsProcessedError
				);
			} else {
				expect(source.end()).eventually.equal(undefined);
			}

			// @ts-ignore
			return source;
		}

		const process = noop;
		const someCondition = true;

		const myQuery = "";

		class NotAllObjectsProcessedError extends BaseError {
			public constructor() {
				super(
					"NotAllObjectsProcessedError",
					"Not all objects were successfully processed"
				);
			}
		}

		describe("docs example", () => {
			it(
				"passes part 1 of example from docs",
				clockwise(async () => {
					expectErrorFromEnd = true;
					// Without endCatcher()
					const resultPromise = getRowsFromDatabase<MyObject>(myQuery)
						.transform(mapper(identity))
						.forEach(process, () => {
							if (someCondition) {
								throw new NotAllObjectsProcessedError();
							}
						});

					await expect(
						resultPromise
					).eventually.rejected.and.be.instanceOf(
						NotAllObjectsProcessedError
					); // This throws an unhandled promise rejection error, even if the source handles it!
				})
			);

			it(
				"passes part 2 of example from docs",
				clockwise(async () => {
					expectErrorFromEnd = false;
					// With endCatcher()
					const resultPromise = getRowsFromDatabase<MyObject>(myQuery)
						.transform(
							endCatcher((err: Error) => {
								if (
									err instanceof NotAllObjectsProcessedError
								) {
									// ignore
								} else {
									// re-throw all other errors
									throw err;
								}
							})
						)
						.transform(mapper(identity))
						.forEach(noop, () => {
							if (someCondition) {
								throw new NotAllObjectsProcessedError();
							}
						});

					await expect(resultPromise).eventually.equals(undefined); // No longer throws the error, because handleError() returns successfully
				})
			);
		});

		it(
			"Indeed throws an error if endCatcher() throws",
			clockwise(async () => {
				function getSource() {
					const source = new Stream<number>();
					source.write(1);
					source.write(2);
					expect(source.end()).to.eventually.rejectedWith(Error);
					return source;
				}

				const resultPromise = getSource()
					.transform(
						endCatcher((err: Error) => {
							if (err.message !== "This is fine actually") {
								throw err;
							}
						})
					)
					.forEach(
						noop,
						() => {
							throw new Error();
						} /* ... */
					);

				await expect(resultPromise).eventually.rejectedWith(Error);
			})
		);
	});
});
