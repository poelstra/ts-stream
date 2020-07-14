import { expect } from "chai";

import { ReadableStream, Stream, Transform, batcher } from "../lib/index";

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

	describe("batch()", () => {
		const batchResults: number[][] = [];
		beforeEach(() => batchResults.splice(0));

		/**
		 * Run an async function, advance the sinon mocked clock until the function resolves,
		 * and then return the function's promise.
		 *
		 * This avoids situations where you need to await something but the await is blocking
		 * the code to advance the clock.
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

		it("bounces error", async () => {
			const source = Stream.from([
				{
					value: 1,
				},
				{
					value: 2,
				},
				{
					value: 3,
					throwError: true,
				},
			]);

			const batched = pipeWithDelay(source).transform(batcher(3));

			try {
				await resolveBatchToAsyncValues(batched);
				expect(true).to.equal(false);
			} catch (e) {
				expect(e).to.equal(boomError);
			}
		});

		it("bounces error from `minBatchSize` batch", async () => {
			const source = Stream.from([
				{
					value: 1,
					throwError: true,
				},
				{
					value: 2,
					wait: 1,
				},
				{
					value: 3,
				},
			]);

			const batched = pipeWithDelay(source).transform(
				batcher(2, { minBatchSize: 1 })
			);

			try {
				await resolveBatchToAsyncValues(batched);
				expect(true).to.equal(false);
			} catch (e) {
				expect(e).to.equal(boomError);
			}
		});

		it(
			"bounces error from `flushTimeout` batch",
			clockwise(async () => {
				const source = Stream.from([
					{
						throwError: true,
						value: 1,
					},
					{
						value: 2,
						wait: 2,
					},
				]);

				const batched = pipeWithDelay(source).transform(
					batcher(4, { flushTimeout: 1 })
				);

				try {
					await resolveBatchToAsyncValues(batched);
					expect(true).to.equal(false);
				} catch (e) {
					expect(e).to.equal(boomError);
				}
			})
		);

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

		it("responds properly to abort", async () => {
			const source = Stream.from([
				{
					value: 1,
				},
				{
					abort: true,
					value: 2,
				},
				{
					value: 3,
				},
			]);

			const batched = pipeWithDelay(source).transform(batcher(2));

			try {
				await resolveBatchToAsyncValues(batched);
				throw new Error("Expected error");
			} catch (e) {
				expect(e.message).to.equal(abortError.message);
			}
		});

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
