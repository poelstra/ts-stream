import { rejects } from "assert";
import { assert, expect } from "chai";
import { Readable, Writable } from "stream";
import { Stream } from "../lib/index";
import { fromNodeWritable, fromNodeReadable } from "../lib/node";

describe("node", () => {
	describe("fromNodeReadable", () => {
		it("it consumes data from the stream until the stream closes", async () => {
			const nodeStream = Readable.from(
				(async function* () {
					yield "hi";
					yield "bye";
				})()
			);
			const result = await fromNodeReadable(nodeStream).toArray();
			expect(result).to.have.members(["hi", "bye"]);
		});

		it("it ends the ts-stream when the node stream emits an error", async () => {
			const errorMessage = "uh oh!";
			const nodeStream = Readable.from(
				(async function* () {
					throw new Error(errorMessage);
				})()
			);

			const result = await fromNodeReadable(nodeStream)
				.toArray()
				.catch((e) => e);

			expect(result instanceof Error).to.equal(true);
			expect(result.message).to.equal(errorMessage);
		});

		it("it ends the ts-stream when the node stream emits a close event", async () => {
			const nodeStream = Readable.from(
				(async function* () {
					yield "hi";
					yield "bye";
				})()
			);

			const messages: string[] = [];
			await fromNodeReadable(nodeStream)
				// We expect this fn to only run once (for the first message) before the close event is emitted.
				.forEach((message) => {
					messages.push(String(message));
					nodeStream.emit("close");
				});

			expect(messages.length).to.equal(1);
			expect(messages).to.have.members(["hi"]);
		});

		it("it destroys the node stream and ends the ts-stream when the ts-stream's `write` call fails", async () => {
			const errorMessage = "write failed";
			const nodeStream = Readable.from(
				(async function* () {
					while (1) {
						yield "hi";
					}
				})()
			);

			const stream = fromNodeReadable(nodeStream);

			const ended = await new Promise<Error | undefined>(
				(resolve, reject) => {
					stream
						.forEach(
							// simulate a failing `write` call.
							(_chunk) => Promise.reject(new Error(errorMessage)),
							// resolve with the error value called on stream end.
							resolve,
							// reject should the aborter be called. (causes test to fail)
							(_abortErr) => {
								reject(
									new Error(
										"aborter callback not expected to be called"
									)
								);
							}
						)
						.catch((e) => e);
				}
			);

			expect(nodeStream.destroyed).to.equal(true);
			expect(ended?.message).to.equal(errorMessage);
		});

		it("it destroys the node stream and ends the ts-stream when the ts-stream's `end` call fails", async () => {
			const errorMessage = "end failed";
			const nodeStream = Readable.from(
				(async function* () {
					yield "hi";
				})()
			);

			const stream = fromNodeReadable(nodeStream);

			await new Promise<void>((resolve, reject) => {
				stream
					.forEach(
						(_chunk) => Promise.resolve(),
						// simulate a failing `end` call.
						(_endErr) => {
							resolve();
							return Promise.reject(new Error(errorMessage));
						},
						// reject should the aborter be called. (causes test to fail)
						(_abortErr) =>
							reject(
								new Error(
									"aborter callback not expected to be called"
								)
							)
					)
					.catch((e) => e);
			});

			expect(nodeStream.destroyed).to.equal(true);
		});

		it("it destroys the node stream and ends the ts-stream when the ts-stream's `write` and `end` calls fail", async () => {
			const writeErrorMessage = "write failed";
			const endErrorMessage = "end failed";
			const nodeStream = Readable.from(
				(async function* () {
					yield "hi";
				})()
			);

			const stream = fromNodeReadable(nodeStream);

			await new Promise<void>((resolve, reject) => {
				stream
					.forEach(
						// simulate a failing `write` call.
						(_chunk) =>
							Promise.reject(new Error(writeErrorMessage)),
						// simulate a failing `end` call.
						(_endErr) => {
							resolve();
							return Promise.reject(new Error(endErrorMessage));
						},
						// reject should the aborter be called. (causes test to fail)
						(_abortErr) =>
							reject(
								new Error(
									"aborter callback not expected to be called"
								)
							)
					)
					.catch((e) => e);
			});

			expect(nodeStream.destroyed).to.equal(true);
		});

		it("it destroys the node stream and ends the ts-stream when the ts-stream is aborted", async () => {
			const errorMessage = "uh oh!";
			const nodeStream = Readable.from(
				(async function* () {
					while (1) {
						yield "hi";
					}
				})()
			);

			const stream = fromNodeReadable(nodeStream);
			await stream.abort(new Error(errorMessage));

			// Here we're waiting to resolve the promise until both the ender and aborter callbacks have been called.
			const result = await new Promise<{
				ended: Error | undefined;
				aborted: Error | undefined;
			}>((resolve) => {
				let ended: Error | undefined;
				let aborted: Error | undefined;
				stream
					.forEach(
						(_chunk) => Promise.resolve(),
						(endErr) => {
							ended = endErr;
							if (aborted) resolve({ ended, aborted });
						},
						(abortErr) => {
							aborted = abortErr;
							if (ended) resolve({ ended, aborted });
						}
					)
					.catch((e) => e);
			});

			expect(nodeStream.destroyed).to.equal(true);
			expect(result.ended?.message).to.equal(errorMessage);
			expect(result.aborted?.message).to.equal(errorMessage);
		});
	});

	describe("fromNodeWritable", () => {
		it("consumes data from a ts-stream", async () => {
			const messages: string[] = [];
			const nodeStream = new Writable({
				write: (chunk, _, cb) => {
					messages.push(String(chunk));
					cb(null);
				},
			});

			await Stream.from(["hi", "bye"])
				.pipe(fromNodeWritable(nodeStream))
				.result();

			expect(messages).to.have.members(["hi", "bye"]);
		});
	});
});