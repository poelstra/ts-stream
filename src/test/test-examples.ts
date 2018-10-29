/**
 * Test idiomatic use-cases of ts-stream.
 *
 * Copyright (C) 2018 Martin Poelstra
 * License: MIT
 */

import { expect } from "chai";
import "source-map-support/register";

import { Readable, ReadableStream, Stream, Transform, Writable, WritableStream } from "../lib/index";
import { delay, noop, settle } from "./util";

enum MockDatabaseState {
	Opening,
	Open,
	Reading,
	Writing,
	Closing,
	Closed,
}

/**
 * Mock object to simulate a stateful resource that needs
 * proper opening and closing, and which can be only opened
 * by one 'user'.
 *
 * It allows only one operation to be in-progress at any point
 * in time (e.g. reading, closing), and the database needs to
 * be 'open' for all operations (except open itself, of course).
 *
 * All operations take some time, to allow any internal promises
 * in the library to settle.
 */
class MockDatabase<T> {
	private _state: MockDatabaseState = MockDatabaseState.Closed;
	private _values: T[] = [];

	constructor(values: T[] = []) {
		this.setValues(values);
	}

	public async open(): Promise<void> {
		this._transition(MockDatabaseState.Closed, MockDatabaseState.Opening);
		await delay(1);
		this._transition(MockDatabaseState.Opening, MockDatabaseState.Open);
	}

	public async close(): Promise<void> {
		this._transition(MockDatabaseState.Open, MockDatabaseState.Closing);
		await delay(1);
		this._transition(MockDatabaseState.Closing, MockDatabaseState.Closed);
	}

	public async read(): Promise<T | undefined> {
		this.assertState(MockDatabaseState.Open);
		const value = this._values.shift();
		this._transition(MockDatabaseState.Open, MockDatabaseState.Reading);
		await delay(1);
		this._transition(MockDatabaseState.Reading, MockDatabaseState.Open);
		return value;
	}

	public async write(value: T): Promise<void> {
		this.assertState(MockDatabaseState.Open);
		this._values.push(value);
		this._transition(MockDatabaseState.Open, MockDatabaseState.Writing);
		await delay(1);
		this._transition(MockDatabaseState.Writing, MockDatabaseState.Open);
	}

	public abort(): void {
		// No-op, just for clarity in idiomatic use.
		// A real driver would try abort any in-progress
		// reads or writes, e.g. closing a network socket.
	}

	/**
	 * Can be used after tests to verify that e.g. values were
	 * correctly written, or which values were not read yet.
	 */
	public getValues(): T[] {
		return this._values.slice();
	}

	/**
	 * Can be used before tests to reinitialize values to be read/written.
	 */
	public setValues(values: T[]): void {
		this._values = values.slice();
	}

	public assertState(state: MockDatabaseState): void {
		expect(MockDatabaseState[this._state], "invalid database state").to.equal(MockDatabaseState[state]);
	}

	private _transition(expectedState: MockDatabaseState, newState: MockDatabaseState): void {
		this.assertState(expectedState);
		this._state = newState;
	}
}

/**
 * Simplest way of creating a source, using .writeEach().
 *
 * It correctly handles backpressure, aborting, and cleaning up
 * the underlying resource.
 * This ensures that other elements in the stream also wait until
 * the resource is fully cleaned up before settling their .result().
 */
async function idiomaticSource<T>(db: MockDatabase<T>, destination: WritableStream<T>): Promise<void> {
	// Note: if needed, db.open() can be moved inside the reader, which ensures that
	// abort can be called even while still opening the database to cancel that, too.
	await db.open();
	await destination.writeEach(
		() => db.read(),
		() => db.close(),
		(err) => db.abort()
	);
}

/**
 * Simplest way of creating a sink, using .forEach().
 *
 * It correctly handles backpressure, aborting, and cleaning up
 * the underlying resource.
 * This ensures that other elements in the stream also wait until
 * the resource is fully cleaned up before settling their .result().
 */
async function idiomaticSink<T>(source: ReadableStream<T>, db: MockDatabase<T>): Promise<void> {
	// Note: if needed, db.open() can be moved inside the writer, which ensures that
	// abort can be called even while still opening the database to cancel that, too.
	await db.open();
	await source.forEach(
		(value) => db.write(value),
		(endError) => db.close(), // optionally do something with endError, e.g. rollback transaction
		(abortError) => db.abort()
	);
}

/**
 * Writing a source using .write() and .end() calls.
 *
 * Useful if a source doesn't provide a way of pulling data
 * out of it, and instead pushes data.
 *
 * It correctly handles backpressure, aborting, and cleaning up
 * the underlying resource.
 * This ensures that other elements in the stream also wait until
 * the resource is fully cleaned up before settling their .result().
 */
async function idiomaticManualSource<T>(db: MockDatabase<T>, destination: Stream<T>): Promise<void> {
	let endError: Error | undefined;
	try {
		try {
			// 1. Open resource
			await db.open();
			// 2. (Optional) allow any pending operation to be aborted
			destination.aborted().catch(() => db.abort());
			// 3. Read values from resource and write to stream
			while (true) {
				const value = await db.read();
				if (value === undefined) {
					break;
				} else {
					await destination.write(value);
				}
			}
		} finally {
			// 4. Close resource
			await db.close();
		}
	} catch (error) {
		endError = error;
	}
	// 5. End stream (either OK or with error, including error while closing resource)
	await destination.end(endError);
}

/**
 * Simple transform.
 *
 * Correctly handles backpressure, and makes sure to pass aborts along to
 * other elements in the chain. Ensures final stream captures result of all
 * previous streams.
 */
function createTransform<T, R>(transformer: (value: T) => R | PromiseLike<R>): Transform<T, R> {
	return function idiomaticTransform(
		readable: Readable<T>,
		writable: Writable<R>
	): void {
		// 1. Ensure aborts bubble from upstream to downstream
		writable.aborted().catch((err) => readable.abort(err));

		readable.forEach(
			// 2. Read all values from source stream, apply transformation
			(v: T) => writable.write(transformer(v)),

			// 3. Always end destination stream, even when there was an
			// error. Also, pass final result of upstream (i.e.
			// `readable.result()`) to downstream.
			(error?: Error) => writable.end(error, readable.result()),

			(abortReason: Error): void => {
				// 4. Ensure aborts bubble from downstream to upstream
				writable.abort(abortReason);

				// 5. Optionally cancel any pending operation.
				// Note: this can be called even long after the stream
				// has ended, and must never throw an error.
			}
		);
	};
}

describe("idiomatic examples", () => {
	it("supports trivial example", async () => {
		const s = Stream.from([1, 2, 3, 4]);
		const values = await s.toArray();
		expect(values).to.deep.equal([1, 2, 3, 4]);
	});

	// Create all combinations of example sources + sinks
	for (const testSource of [idiomaticSource, idiomaticManualSource]) {
		for (const testSink of [idiomaticSink]) {
			let sourceDb: MockDatabase<number>;
			let destDb: MockDatabase<number>;

			beforeEach(() => {
				sourceDb = new MockDatabase([1, 2, 3, 4]);
				destDb = new MockDatabase([]);
			});

			afterEach(() => {
				// The databases always need to be closed correctly
				sourceDb.assertState(MockDatabaseState.Closed);
				destDb.assertState(MockDatabaseState.Closed);
			});

			describe(`${testSource.name} -> ${testSink.name}`, () => {
				it("supports normal flow", async () => {
					const stream = new Stream<number>();
					const sourceResult = testSource(sourceDb, stream);
					const destResult = testSink(stream, destDb);
					await Promise.all([sourceResult, destResult]);
					expect(destDb.getValues()).to.deep.equal([1, 2, 3, 4]);
				});

				it("waits before starting next", async () => {
					const stream1 = new Stream<number>();
					await Promise.all([testSource(sourceDb, stream1), testSink(stream1, destDb)]);
					// source and destination should both be in Closed state again
					sourceDb.setValues([5, 6, 7, 8]);
					const stream2 = new Stream<number>();
					await Promise.all([testSource(sourceDb, stream2), testSink(stream2, destDb)]);
					expect(destDb.getValues()).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8]);
				});

				it("ends stream even with abort", async () => {
					const stream = new Stream<number>();
					// Prevent false positive UnhandledRejection warning, caused by aborter
					// not being attached to stream yet by the time we abort it (because
					// we first wait for opening database inside the source/sink).
					stream.aborted().catch(noop);

					const sourceResult = testSource(sourceDb, stream);
					const destResult = testSink(stream, destDb);
					stream.abort();

					await settle([sourceResult, destResult]);

					// Expect not all values to be written
					expect(destDb.getValues().length).to.be.lessThan(4);
				});

				it("handles errors in transforms", async () => {
					const stream = new Stream<number>();
					const sourceResult = testSource(sourceDb, stream);

					const mappedStream = stream.map((n) => {
						if (n === 3) {
							throw new Error("boom");
						} else {
							return n * 2;
						}
					});
					const destResult = testSink(mappedStream, destDb);

					await settle([sourceResult, destResult]);

					// Only first two values will have been written, then
					// stream is aborted.
					expect(destDb.getValues()).to.deep.equal([2, 4]);
					expect(stream.isEnded()).to.equal(true);
				});
			}); // describe ${testSource.name} -> ${testSink.name}
		}
	}

	describe("transform", () => {
		it("supports idiomatic transform", async () => {
			const source = Stream.from([1, 2, 3, 4]);
			const timesTwo = (n: number) => n * 2;
			const transformed = source.transform(createTransform(timesTwo));
			const result = await transformed.toArray();
			expect(result).to.deep.equal([2, 4, 6, 8]);
		});
	});
});
