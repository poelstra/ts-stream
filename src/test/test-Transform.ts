import * as chaiAsPromised from "chai-as-promised";
import * as chai from "chai";
chai.use(chaiAsPromised);
const { expect } = chai;

import {
	ReadableStream,
	Stream,
	Transform,
	batcher,
	mapper,
	compose,
} from "../lib/index";

import "./mocha-init";
import { defer, delay, settle, track, readInto, identity } from "./util";
import { useFakeTimers } from "sinon";

describe("Transform", () => {
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

	describe("compose()", () => {
		it("composes stream transformations", async () => {
			const source = Stream.from([1, 2, 3, 4]);
			const mapperA = mapper((val: number) => val % 2 === 0);
			const mapperB = mapper((val: boolean) => (val ? "Even" : "Odd"));
			const composedTransformA = compose(mapperA, mapperB);
			// @ts-expect-error
			const composedTransformB = compose(mapperB, mapperA);

			const dest = await source.transform(composedTransformA).toArray();
			expect(dest).to.deep.equal(["Odd", "Even", "Odd", "Even"]);
		});
	});

	describe("batch()", () => {
		const batchResults: number[][] = [];
		beforeEach(() => batchResults.splice(0));

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

		function pipeWithDelay(
			readableStream: ReadableStream<{
				value: number;
				workTime?: number;
				wait?: number;
				abort?: boolean;
				throwError?: boolean;
			}>
		) {
			const stream = readableStream.map(async (item) => {
				const { wait } = item;
				if (wait !== undefined) {
					await delay(wait);
				}
				return item;
			});

			return stream;
		}

		async function resolveBatchToAsyncValues(
			readableStream: ReadableStream<
				{
					value: number;
					workTime?: number;
					wait?: number;
					abort?: boolean;
					throwError?: boolean;
				}[]
			>
		) {
			return readableStream
				.map(async (batch) => {
					const isDelay = !!batch.find(
						({ workTime }) => workTime !== undefined
					);

					const isError = !!batch.find(
						({ throwError }) => !!throwError
					);

					if (isError) {
						throw boomError;
					}

					const isAbort = !!batch.find(({ abort }) => !!abort);

					if (isAbort) {
						readableStream.abort(abortError);
					}

					if (isDelay) {
						const totalDelay = batch.reduce(
							(acc, { workTime }) => acc + (workTime || 0),
							0
						);

						await delay(totalDelay);
					}

					return batch.map(({ value }) => value);
				})
				.toArray();
		}

		it("passes the example test from docs", async () => {
			const batchedStream = Stream.from([1, 2, 3, 4, 5]).transform(
				batcher(2)
			);
			const result = await batchedStream.toArray();
			expect(result).to.deep.equal([[1, 2], [3, 4], [5]]);
		});

		it("batches values", async () => {
			const batched = s.transform(batcher(2));
			const toWrite = [1, 2, 3];
			const writes = [
				...toWrite.map((n) => track(s.write(n))),
				track(s.end()),
			];
			readInto(batched, batchResults);
			await s.result();
			expect(batchResults).to.deep.equal([[1, 2], [3]]);
			writes.forEach((write) => expect(write.isFulfilled).to.equal(true));
		});

		it(
			"applies backpressure",
			clockwise(async () => {
				const batched = s.transform(batcher(2));
				const toWrite = [1, 2, 3];
				const writes = [
					...toWrite.map((n) => track(s.write(n))),
					track(s.end()),
				];

				const resolvers: (() => void)[] = [];
				batched.forEach(async (value) => {
					const deferred = defer();
					resolvers.push(deferred.resolve);
					await deferred.promise;

					batchResults.push(value);
				});
				await delay(1);
				expect(batchResults).to.deep.equal([]);
				resolvers[0]();
				await settle([writes[0].promise, writes[1].promise]);
				expect(batchResults).to.deep.equal([[1, 2]]);
				expect(writes[2].isPending).to.equal(true);
				await delay(1);
				resolvers[1]();
				await settle([writes[3].promise]);
				expect(writes[2].isFulfilled).to.equal(true);
				expect(writes[3].isFulfilled).to.equal(true);
			})
		);

		it("with `minBatchSize`, forms batch if write not pending", async () => {
			const source = Stream.from([
				{
					value: 1,
				},
				{
					value: 2,
				},
				{
					value: 3,
				},
			]);
			const batched = source.transform(batcher(3, { minBatchSize: 2 }));
			const dest = await resolveBatchToAsyncValues(batched);

			expect(dest).to.deep.equal([[1, 2], [3]]);
		});

		it("with `handleError`, can suppress errors in a flush", async () => {
			s.write(1);
			s.write(2);
			s.write(3);
			s.end();
			let captured: Error | undefined;
			const failedWrites: number[][] = [];
			const batched = s.transform(
				batcher(2, {
					handleError: (e, batch) => {
						captured = e;
						failedWrites.push(batch);
					},
				})
			);

			await batched.forEach(() => {
				throw boomError;
			});

			expect(captured).to.equal(boomError);
			expect(failedWrites).to.deep.equal([[1, 2], [3]]);
		});

		it("with `handleError`, can suppress errors in an early flush", async () => {
			s.write(1);
			s.write(2);
			s.write(3);
			s.end();
			let captured: Error | undefined;
			const failedWrites: number[][] = [];
			const batched = s.transform(
				batcher(2, {
					minBatchSize: 1,
					handleError: (e, batch) => {
						captured = e;
						failedWrites.push(batch);
					},
				})
			);

			await batched.forEach(() => {
				throw boomError;
			});

			expect(captured).to.equal(boomError);
			expect(failedWrites).to.deep.equal([[1], [2, 3]]);
		});

		it(
			"with `handleError`, can re-throw errors in any flush",
			clockwise(async () => {
				let captured: Error | undefined;
				const failedWrites: number[][] = [];

				const batched = s.transform(
					batcher(2, {
						flushTimeout: 1,
						handleError: async (e, batch) => {
							captured = e;
							failedWrites.push(batch);
							throw toThrowFromErrorHandler.shift();
						},
					})
				);

				const confirmedError1 = new Error("Yep, that’s an error");
				const confirmedError2 = new Error(
					"This is for sure an error, too"
				);
				const toThrowFromErrorHandler = [
					confirmedError1,
					confirmedError2,
				];

				async function doWrites() {
					expect(s.write(1)).to.eventually.equal(undefined);
					await delay(2); // Trigger early flush
					expect(s.write(2)).to.eventually.rejectedWith(
						confirmedError1
					); // Catching the error thrown by the early flush
					expect(s.write(3)).to.eventually.rejectedWith(
						confirmedError2
					); // Catching the error of the next, normal flush
					expect(s.end()).to.eventually.equal(undefined);
				}

				const writePromise = doWrites();

				const readPromise = batched.forEach(async () => {
					throw boomError;
				});

				await Promise.all([writePromise, readPromise]);

				expect(captured).to.equal(boomError);
				expect(failedWrites).to.deep.equal([[1], [2, 3]]);
			})
		);

		it(
			"applies backpressure to a `maxBatchSize` write from a `minBatchSize` write",
			clockwise(async () => {
				const batched = s.transform(batcher(2, { minBatchSize: 1 }));
				const toWrite = [1, 2, 3];
				const writes = [
					...toWrite.map((n) => track(s.write(n))),
					track(s.end()),
				];

				const resolvers: (() => void)[] = [];
				batched.forEach(async (value) => {
					const deferred = defer();
					resolvers.push(deferred.resolve);
					await deferred.promise;

					batchResults.push(value);
				});
				await delay(1);
				expect(batchResults).to.deep.equal([]);
				expect(writes[0].isFulfilled).to.equal(true); // Commenced silently
				expect(writes[1].isFulfilled).to.equal(true); // Added to the queue
				expect(writes[2].isFulfilled).to.equal(false); // Triggers a batch write which can't begin yet
				expect(resolvers[1]).to.equal(undefined);
				resolvers[0]();
				await delay(1);
				expect(writes[2].isFulfilled).to.equal(false); // Batch write still can't finish, but...
				expect(resolvers[1]).not.to.equal(undefined); // It's started!
				resolvers[1]();
				await delay(1);
				expect(writes[2].isFulfilled).to.equal(true); // Now the batch write is finished...
				expect(writes[3].isFulfilled).to.equal(true); // And the stream can end
			})
		);

		it(
			"Can write two `minBatchSize` batches back-to-back without needing to be triggered by write() or end()",
			clockwise(async () => {
				async function doWrite() {
					s.write(1);
					s.write(2);
					s.write(3);
					s.write(4);
					await delay(10);
					s.end();
				}

				const batched = s.transform(batcher(5, { minBatchSize: 2 }));
				const resolvers: (() => void)[] = [];
				batched.forEach(async (batch) => {
					const deferred = defer();
					resolvers.push(deferred.resolve);
					await deferred.promise;
					batchResults.push(batch);
				});

				doWrite();
				await delay(1);
				expect(resolvers.length).to.equal(1);
				resolvers[0]();
				await delay(1);
				expect(batchResults).to.deep.equal([[1, 2]]);
				expect(resolvers.length).to.equal(2);
				resolvers[1]();
				await delay(1);
				expect(batchResults).to.deep.equal([
					[1, 2],
					[3, 4],
				]);
				expect(batched.isEndingOrEnded()).to.equal(false);
				await batched.result();
			})
		);

		it(
			"forms batch not exceeding `maxBatchSize` if a batch write is pending",
			clockwise(async () => {
				const source = Stream.from([
					{
						value: 1,
					},
					{
						value: 2,
						workTime: 1,
					},
					{
						value: 3,
					},
					{
						value: 4,
					},
					{
						value: 5,
						workTime: 2,
					},
					{
						value: 6,
					},
					{
						value: 7,
						wait: 3,
					},
					{
						value: 8,
					},
				]);

				const batched = pipeWithDelay(source).transform(
					batcher(3, { minBatchSize: 2 })
				);

				const destAsync = resolveBatchToAsyncValues(batched);
				const dest = await destAsync;

				expect(dest).to.deep.equal([
					[1, 2], //    Min batch size (this will take 1ms to write)
					[3, 4, 5], // Max batch size streams in while first batch is writing (this will take 2ms to write)
					[6, 7], //    Min batch size (7 arrives after a 3ms delay so the previous batch is processed and the new
					//            batch is completed)
					[8], //       Processed alone when stream ends
				]);
			})
		);

		type FlushErrorTestCase =
			| "first element"
			| "second element"
			| "both elements";
		function conditionalThrow(testCase: FlushErrorTestCase) {
			return async (batch: number[]) => {
				const [item] = batch;

				if (testCase === "both elements") {
					throw boomError;
				} else if (testCase === "first element" && item === 1) {
					throw boomError;
				} else if (testCase === "second element" && item === 2) {
					throw boomError;
				}
			};
		}

		describe("error cases", () => {
			async function doWrites() {
				try {
					await s.write(1);
					await delay(2);
					await s.write(2);
				} finally {
					// Pass Promise.resolve() to end() to cause the downstream result to depend
					// on this (resolved) promise, instead of the promise rejection that is expected.
					await s.end(undefined, Promise.resolve());
				}
			}

			for (const testCase of [
				"first element",
				"second element",
				"both elements",
			] as FlushErrorTestCase[]) {
				it(
					`bounces error - ${testCase}`,
					clockwise(async () => {
						let isAborted = false;
						s.aborted().catch(() => (isAborted = true));

						const batched = s.transform(batcher(1));

						await Promise.all([
							batched.forEach(conditionalThrow(testCase)),
							expect(doWrites()).rejectedWith(boomError),
						]);

						expect(isAborted).to.equal(false);
					})
				);

				it(
					`bounces error from \`minBatchSize\` batch - ${testCase}`,
					clockwise(async () => {
						let isAborted = false;
						s.aborted().catch(() => (isAborted = true));

						const batched = s.transform(
							batcher(2, { minBatchSize: 1 })
						);

						await Promise.all([
							batched.forEach(conditionalThrow(testCase)),
							expect(doWrites()).rejectedWith(boomError),
						]);

						expect(isAborted).to.equal(false);
					})
				);

				it(
					`bounces error from \`flushTimeout\` batch - ${testCase}`,
					clockwise(async () => {
						let isAborted = false;
						s.aborted().catch(() => (isAborted = true));

						const batched = s.transform(
							batcher(2, { flushTimeout: 1 })
						);

						await Promise.all([
							batched.forEach(conditionalThrow(testCase)),
							expect(doWrites()).rejectedWith(boomError),
						]);

						expect(isAborted).to.equal(false);
					})
				);

				it(
					`bounces error from stream end batch - ${testCase}`,
					clockwise(async () => {
						let isAborted = false;
						s.aborted().catch(() => (isAborted = true));

						const batched = s.transform(batcher(2));

						async function doLongerWrites() {
							try {
								await s.write(1);
								await s.write(1);
								await s.write(2);
							} finally {
								// Pass Promise.resolve() to end() to cause the downstream result to depend
								// on this (resolved) promise, instead of the promise rejection that is expected.
								await s.end(undefined, Promise.resolve());
							}
						}

						await Promise.all([
							batched.forEach(conditionalThrow(testCase)),
							expect(doLongerWrites()).rejectedWith(boomError),
						]);

						expect(isAborted).to.equal(false);
					})
				);
			}
		});

		it(
			"writes any queued items after a duration from the last read if timeout is provided",
			clockwise(async () => {
				const source = Stream.from([
					{
						value: 1,
					},
					{
						value: 2,
						wait: 3,
					},
					{
						value: 3,
						wait: 1,
					},
					{
						value: 4,
					},
					{
						value: 5,
					},
				]);
				const batched = pipeWithDelay(source).transform(
					batcher(3, { flushTimeout: 2 })
				);

				const dest = await resolveBatchToAsyncValues(batched);
				expect(dest).to.deep.equal([
					[1], //    Processed alone because timeout fires before 2 comes in
					[2, 3, 4], // Processed together because they arrived within the same window
					//         and form a batch (3 arrives after 1ms delay which is within
					//         2ms timeout)
					[5], //    Processed alone because stream ends
				]);
			})
		);

		it(
			"on abort, all writes fail with abort, including writes still in the queue",
			clockwise(async () => {
				async function doWrites() {
					await expect(s.write(1)).to.eventually.equal(undefined);
					await expect(s.write(2)).to.eventually.equal(undefined);
					await expect(s.write(3)).to.eventually.equal(undefined);
					await delay(2);
					await expect(s.end()).to.eventually.rejectedWith(
						abortError
					);
				}

				const writePromise = doWrites();
				const batched = s.transform(batcher(2));

				const listener = batched.map((batch) =>
					batchResults.push(batch)
				);

				const readPromise = expect(
					listener.toArray()
				).to.eventually.rejectedWith(abortError);

				await delay(1);
				s.abort(abortError);

				await Promise.all([writePromise, readPromise]);

				expect(batchResults).to.deep.equal([[1, 2]]);
			})
		);

		it(
			"waits for source stream to end",
			clockwise(async () => {
				const d = defer();
				const slowEndingSource = s.transform<number>(
					(readable, writable) => {
						readable.forEach(
							(v) => writable.write(v),
							(error?: Error) => {
								writable.end(error, readable.result());
								return d.promise;
							}
						);
					}
				);
				const writes = [
					track(s.write(1)),
					track(s.write(2)),
					track(s.end()),
				];

				const batched = slowEndingSource.transform(batcher(1));
				const mres = track(batched.result());
				readInto(batched, batchResults);

				await settle([writes[0].promise, writes[1].promise]);
				expect(batchResults).to.deep.equal([[1], [2]]);
				expect(writes[0].isFulfilled).to.equal(true);
				expect(writes[1].isFulfilled).to.equal(true);
				expect(writes[2].isFulfilled).to.equal(false);
				expect(mres.isFulfilled).to.equal(false);

				d.resolve();
				await settle([mres.promise]);
				expect(writes[2].isFulfilled).to.equal(true);
			})
		);

		it(
			"waits for destination stream to end",
			clockwise(async () => {
				const d = defer();
				const slowEnder: Transform<number[], number[]> = (
					readable,
					writable
				) => {
					readable.forEach(
						(v) => writable.write(v),
						(error?: Error) => {
							writable.end(error, readable.result());
							return d.promise;
						}
					);
				};
				const w1 = track(s.write(1));
				const w2 = track(s.write(2));
				const we = track(s.end());

				const batched = s.transform(batcher(1));
				const mres = track(batched.result());
				const slowed = batched.transform(slowEnder);
				const sres = track(slowed.result());
				await readInto(slowed, batchResults);

				expect(batchResults).to.deep.equal([[1], [2]]);
				expect(w1.isFulfilled).to.equal(true);
				expect(w2.isFulfilled).to.equal(true);
				expect(we.isFulfilled).to.equal(false);
				expect(mres.isFulfilled).to.equal(false);
				expect(sres.isFulfilled).to.equal(false);

				d.resolve();
				await settle([mres.promise, sres.promise]);
			})
		);

		it("aborts from source to sink", async () => {
			const sink = s.transform(batcher(1)).map(identity);
			const ab = track(sink.aborted());
			s.abort(abortError);
			await settle([ab.promise]);
			expect(ab.reason).to.equal(abortError);
		});

		it("aborts from sink to source", async () => {
			const ab = track(s.aborted());
			const sink = s.transform(batcher(1)).map(identity);
			sink.abort(abortError);
			await settle([ab.promise]);
			expect(ab.reason).to.equal(abortError);
		});
	}); // batch()
});
