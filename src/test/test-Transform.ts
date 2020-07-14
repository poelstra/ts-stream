import { expect } from "chai";

import {
	AlreadyHaveReaderError,
	ReadableStream,
	Stream,
	Transform,
	WriteAfterEndError,
	batcher,
} from "../lib/index";

import "./mocha-init";
import {
	defer,
	delay,
	settle,
	swallowErrors,
	track,
	readInto,
	identity,
} from "./util";

describe("Transform", () => {
	let s: Stream<number>;
	let abortError: Error;

	beforeEach(() => {
		s = new Stream<number>();
		abortError = new Error("abort error");
	});

	describe("batch()", () => {
		const batchResults: number[][] = [];
		beforeEach(() => batchResults.splice(0));

		function pipeWithDelay(
			readableStream: ReadableStream<{
				value: number;
				workTime?: number;
				wait?: number;
				abort?: boolean;
				throwError?: true;
			}>
		) {
			const writableStream = new Stream<{
				value: number;
				workTime?: number;
				wait?: number;
				abort?: boolean;
				throwError?: true;
			}>();

			writableStream.aborted().catch((e) => readableStream.abort(e));
			readableStream.aborted().catch((e) => writableStream.abort(e));

			readableStream
				.forEach(async (item) => {
					const { wait } = item;

					if (wait !== undefined) {
						await delay(wait);
						writableStream.write(item);
					} else {
						writableStream.write(item);
					}
				})
				.then(() => writableStream.end())
				.catch(() => writableStream.end());

			return writableStream;
		}

		async function resolveBatchToAsyncValues(
			readableStream: ReadableStream<
				{
					value: number;
					workTime?: number;
					wait?: number;
					abort?: boolean;
					throwError?: true;
				}[]
			>
		) {
			const result: number[][] = [];

			await readableStream.forEach((batch) => {
				const isDelay = !!batch.find(
					({ workTime }) => workTime !== undefined
				);

				const isAbort = !!batch.find(({ abort }) => !!abort);

				if (isAbort) {
					readableStream.abort(
						new Error("Test stream explicitly aborted")
					);
				}

				if (isDelay) {
					const totalDelay = batch.reduce(
						(acc, { workTime }) => acc + (workTime || 0),
						0
					);
					return (async () => {
						await delay(totalDelay);
						result.push(batch.map(({ value }) => value));
					})();
				} else {
					result.push(batch.map(({ value }) => value));
				}
			});

			return result;
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

		it("forms batch if write not pending when provided with minBatchSize", async () => {
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

		it("forms batch not exceeding maxBatchSize if a batch write is pending", async () => {
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
				},
				{
					value: 6,
					wait: 2, // Stream waits 2 ms here so first batch can finish writing
				},
				{
					value: 7,
				},
				{
					value: 8,
				},
			]);

			const batched = pipeWithDelay(source).transform(
				batcher(3, { minBatchSize: 2 })
			);
			const dest = await resolveBatchToAsyncValues(batched);

			expect(dest).to.deep.equal([[1, 2], [3, 4, 5], [6, 7], [8]]);
		});

		it("writes any queued items after a duration from the last read if timeout is provided", async () => {
			const source = Stream.from([
				{
					value: 1,
				},
				{
					value: 2,
					wait: 10,
				},
				{
					value: 3,
				},
				{
					value: 4,
					wait: 1,
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
					wait: 10,
				},
			]);
			const batched = pipeWithDelay(source).transform(
				batcher(2, { flushTimeout: 5 })
			);
			const delayedProcessing = resolveBatchToAsyncValues(batched);

			const dest = await delayedProcessing;
			expect(dest).to.deep.equal([[1], [2, 3], [4, 5], [6], [7]]);
		});

		it("ceases writing on abort", async () => {
			const source = new Stream<{ value: number; abort?: boolean }>();
			const sourceData = [
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
			];

			source.writeEach(() => sourceData.shift());

			let isAborted = false;

			source.aborted().catch(() => {
				isAborted = true;
			});

			const batched = pipeWithDelay(source).transform(batcher(2));

			const delayedProcessing = resolveBatchToAsyncValues(batched);

			const dest = await delayedProcessing;
			expect(dest).to.deep.equal([[1, 2]]);

			expect(isAborted).to.equal(true);
		});

		it("waits for source stream to end", async () => {
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
			await delay(1);
			expect(batchResults).to.deep.equal([[1], [2]]);
			expect(writes[0].isFulfilled).to.equal(true);
			expect(writes[1].isFulfilled).to.equal(true);
			expect(writes[2].isFulfilled).to.equal(false);
			expect(mres.isFulfilled).to.equal(false);

			d.resolve();
			await settle([mres.promise]);
			expect(writes[2].isFulfilled).to.equal(true);
		});

		it("waits for destination stream to end", async () => {
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
			readInto(slowed, batchResults);

			await delay(1);
			expect(batchResults).to.deep.equal([[1], [2]]);
			expect(w1.isFulfilled).to.equal(true);
			expect(w2.isFulfilled).to.equal(true);
			expect(we.isFulfilled).to.equal(false);
			expect(mres.isFulfilled).to.equal(false);
			expect(sres.isFulfilled).to.equal(false);

			d.resolve();
			await settle([mres.promise, sres.promise]);
		});

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
