import { expect } from "chai";
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
