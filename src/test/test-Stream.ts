/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */

/* tslint:disable:no-null-keyword */ // we use a lot of speficic null-checks below

import "source-map-support/register";
import { expect } from "chai";

import { Stream, ReadableStream, WriteAfterEndError, AlreadyHaveReaderError, Transform } from "../lib/index";

import "./mocha-init";
import { defer, delay, settle, swallowErrors, track } from "./util";

function readInto<T>(stream: ReadableStream<T>, into: T[]): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		stream.forEach(
			(value: T) => {
				expect(this).to.equal(undefined);
				into.push(value);
			},
			(err?: Error) => {
				expect(this).to.equal(undefined);
				if (err) {
					reject(err);
				} else {
					resolve(undefined);
				}
			}
		);
	});
}

function noop(): void {
	/* empty */
}

function identity<T>(arg: T): T {
	return arg;
}

describe("Stream", () => {
	let s: Stream<number>;
	let boomError: Error;
	let abortError: Error;
	let results: number[];
	let promises: Promise<any>[];

	beforeEach(() => {
		s = new Stream<number>();
		boomError = new Error("boom");
		abortError = new Error("abort error");
		results = [];
		promises = [];
	});

	function pushResult(n: number): void {
		results.push(n);
	}

	it("supports get after put", async () => {
		promises.push(s.write(42));
		promises.push(s.end());
		promises.push(readInto(s, results));
		await settle(promises);
		expect(results).to.deep.equal([42]);
	});

	it("supports put after get", async () => {
		promises.push(readInto(s, results));
		promises.push(s.write(42));
		promises.push(s.end());
		await settle(promises);
		expect(results).to.deep.equal([42]);
	});

	it("allows end before get", async () => {
		promises.push(s.end());
		promises.push(readInto(s, results));
		await settle(promises);
		expect(results).to.deep.equal([]);
	});

	it("allows get before end", async () => {
		promises.push(readInto(s, results));
		promises.push(s.end());
		await settle(promises);
		expect(results).to.deep.equal([]);
	});

	it("disallows write after end", async () => {
		promises.push(s.end());
		promises.push(s.write(42).catch((r) => {
			expect(r).to.be.instanceof(WriteAfterEndError);
		}));
		promises.push(readInto(s, results));
		await settle(promises);
		expect(results).to.deep.equal([]);
	});

	it("disallows multiple ends", async () => {
		const p1 = track(s.end());
		const p2 = track(s.end());
		const p3 = track(readInto(s, results));
		await settle([p1.promise, p2.promise, p3.promise]);
		expect(p1.isFulfilled).to.equal(true);
		expect(p2.reason).to.be.instanceof(WriteAfterEndError);
		expect(p3.isFulfilled).to.equal(true);
		expect(results).to.deep.equal([]);
	});

	it("write fails when writing synchronously rejected promise", async () => {
		const wp1 = track(s.write(Promise.reject<number>(boomError)));
		const wp2 = track(s.write(42));
		const ep = track(s.end());
		const rp = track(readInto(s, results));
		await settle([wp1.promise, wp2.promise, ep.promise, rp.promise]);
		expect(wp1.reason).to.equal(boomError);
		expect(wp2.isFulfilled).to.equal(true);
		expect(results).to.deep.equal([42]);
		expect(ep.isFulfilled).to.equal(true);
		expect(rp.isFulfilled).to.equal(true);
	});

	it("write fails when writing asynchronously rejected promise", async () => {
		const d = defer<number>();
		const wp1 = track(s.write(d.promise));
		const wp2 = track(s.write(42));
		const ep = track(s.end());
		const rp = track(readInto(s, results));
		d.reject(boomError);
		await settle([wp1.promise, wp2.promise, ep.promise, rp.promise]);
		expect(wp1.reason).to.equal(boomError);
		expect(wp2.isFulfilled).to.equal(true);
		expect(results).to.deep.equal([42]);
		expect(ep.isFulfilled).to.equal(true);
		expect(rp.isFulfilled).to.equal(true);
	});

	it("resolves reads in-order for out-of-order writes", async () => {
		const d = defer<number>();
		promises.push(s.write(d.promise));
		promises.push(s.write(2));
		promises.push(s.end());
		promises.push(readInto(s, results));
		await delay(1);
		expect(results).to.deep.equal([]);
		d.resolve(1);
		await settle(promises);
		expect(results).to.deep.equal([1, 2]);
	});

	describe("abort()", () => {
		it("aborts pending writes when not being processed", async () => {
			const w1 = track(s.write(1));
			const w2 = track(s.write(2));
			s.abort(abortError);
			await settle([w1.promise, w2.promise]);
			expect(w1.reason).to.equal(abortError);
			expect(w2.reason).to.equal(abortError);
		});
		it("aborts future writes when not being processed", async () => {
			s.abort(abortError);
			const w1 = track(s.write(1));
			const w2 = track(s.write(2));
			await settle([w1.promise, w2.promise]);
			expect(w1.reason).to.equal(abortError);
			expect(w2.reason).to.equal(abortError);
		});
		it("waits for reader to finish, then aborts writes until end", async () => {
			swallowErrors(s.aborted());
			swallowErrors(s.result());

			const endDef = defer();
			const endSeen = defer();
			swallowErrors(endDef.promise);
			const r1 = defer();
			const reads = [r1.promise];
			let endResult: Error = null;

			const w1 = track(s.write(1));
			const w2 = track(s.write(2));

			swallowErrors(s.forEach(
				(v) => {
					results.push(v);
					return reads.shift();
				},
				(err) => {
					endResult = err;
					endSeen.resolve();
					return endDef.promise;
				}
			));

			await delay(1);
			expect(w1.isPending).to.equal(true);
			expect(w2.isPending).to.equal(true);
			expect(results).to.deep.equal([1]);

			s.abort(abortError);
			const w3 = track(s.write(3));
			await delay(1);
			expect(w1.isPending).to.equal(true);
			expect(w2.isPending).to.equal(true);
			expect(w3.isPending).to.equal(true);
			expect(results).to.deep.equal([1]);

			r1.reject(boomError); // could do resolve() too, error is more interesting :)
			await settle([w1.promise, w2.promise, w3.promise]);
			expect(w1.reason).to.equal(boomError);
			expect(w2.reason).to.equal(abortError);
			expect(w3.reason).to.equal(abortError);
			expect(results).to.deep.equal([1]);
			expect(endResult).to.equal(null);

			const we = track(s.end(new Error("end error")));
			await endSeen.promise;
			expect(endResult).to.equal(abortError);
			expect(we.isPending).to.equal(true);

			const enderError = new Error("ender error");
			endDef.reject(enderError);
			try {
				await we.promise;
				expect(false).to.equal(true, "expected an error");
			} catch (e) {
				expect(e).to.equal(enderError);
			}

			try {
				await s.end();
				expect(false).to.equal(true, "expected an error");
			} catch (e) {
				expect(e).to.be.instanceof(WriteAfterEndError);
			}
		});
		it("can be called in reader", async () => {
			swallowErrors(s.aborted());
			swallowErrors(s.result());
			let endResult: Error = null;
			const w1 = track(s.write(1));
			const w2 = track(s.write(2));
			const r1 = defer();
			swallowErrors(s.forEach(
				(v) => { s.abort(abortError); return r1.promise; },
				(e) => { endResult = e; }
			));
			await delay(1);
			expect(w1.isPending).to.equal(true);
			expect(w2.isPending).to.equal(true);
			expect(endResult).to.equal(null);

			r1.resolve();
			await settle([w1.promise, w2.promise]);
			expect(w1.value).to.equal(undefined);
			expect(w2.reason).to.equal(abortError);
			expect(endResult).to.equal(null);

			const we = track(s.end());
			await settle([we.promise]);
			expect(endResult).to.equal(abortError);
			expect(we.value).to.equal(undefined);
		});
		it("ignores multiple aborts", async () => {
			swallowErrors(s.aborted());
			swallowErrors(s.result());
			let endResult: Error = null;
			const w1 = track(s.write(1));
			const r1 = defer();
			const firstAbortError = new Error("first abort error");
			s.abort(firstAbortError);
			s.forEach(
				(v) => { chai.assert(false); },
				(e) => { endResult = e; }
			);

			await settle([w1.promise]);
			expect(w1.reason).to.equal(firstAbortError);
			expect(endResult).to.equal(null);

			s.abort(abortError);
			r1.resolve();
			const we = track(s.end());
			await settle([we.promise]);
			expect(endResult).to.equal(firstAbortError);
			expect(we.value).to.equal(undefined);
		});
		it("asynchronously calls aborter when already reading", async () => {
			let abortResult: Error = null;
			const w1 = track(s.write(1));
			const r1 = defer();
			s.forEach(
				(v) => r1.promise,
				undefined,
				(e) => { abortResult = e; }
			);
			await delay(1);

			s.abort(abortError);
			expect(abortResult).to.equal(null);

			await delay(1);
			expect(abortResult).to.equal(abortError);
			expect(w1.isPending).to.equal(true);

			r1.resolve();
			await settle([w1.promise]);
			expect(w1.isFulfilled).to.equal(true);
		});
		it("asynchronously calls aborter when not currently reading", async () => {
			swallowErrors(s.aborted());
			swallowErrors(s.result());
			let abortResult: Error = null;
			const abortSeen = defer();
			const w1 = track(s.write(1));
			s.forEach(
				(v) => undefined,
				undefined,
				(e) => {
					abortResult = e;
					abortSeen.resolve();
				}
			);
			await delay(1);

			s.abort(abortError);
			expect(abortResult).to.equal(null);

			await abortSeen.promise;
			expect(abortResult).to.equal(abortError);
			expect(w1.isFulfilled).to.equal(true);
		});
		it("asynchronously calls aborter when attaching late", async () => {
			swallowErrors(s.aborted());
			swallowErrors(s.result());

			const w1 = track(s.write(1));
			await delay(1);
			s.abort(abortError);

			await settle([w1.promise]);
			expect(w1.reason).to.equal(abortError);

			let abortResult: Error = null;
			const abortSeen = defer();
			swallowErrors(s.forEach(
				(v) => undefined,
				undefined,
				(e) => {
					abortResult = e;
					abortSeen.resolve();
				}
			));
			expect(abortResult).to.equal(null);

			await abortSeen.promise;
			expect(abortResult).to.equal(abortError);
		});
		it("no longer calls aborter when ender finished", async () => {
			const w1 = track(s.write(1));
			const we = track(s.end());
			let abortResult: Error = null;
			s.forEach(
				(v) => undefined,
				undefined,
				(e) => { abortResult = e; }
			);

			await settle([w1.promise, we.promise]);
			expect(abortResult).to.equal(null);
			expect(s.isEnded()).to.equal(true);
			expect(w1.isFulfilled).to.equal(true);
			expect(we.isFulfilled).to.equal(true);

			s.abort(abortError);
			const ab = track(s.aborted());

			await settle([ab.promise]);
			await delay(1);
			expect(abortResult).to.equal(null);
			expect(ab.reason).to.equal(abortError);
		});
	}); // abort()

	describe("aborted()", () => {
		it("is rejected when abort is called", async () => {
			const ab = track(s.aborted());
			await delay(1);
			expect(ab.isPending).to.equal(true);
			s.abort(abortError);
			await settle([ab.promise]);
			expect(ab.reason).to.equal(abortError);
		});
		it("is rejected when abort is called, even after stream end", async () => {
			const ab = track(s.aborted());
			s.end();
			await s.forEach(noop);
			expect(ab.isPending).to.equal(true);
			expect(s.isEnded()).to.equal(true);

			s.abort(abortError);
			await settle([ab.promise]);
			expect(ab.reason).to.equal(abortError);
		});
	});

	describe("forEach()", () => {
		it("handles empty stream", async () => {
			let endResult: Error = null; // null, to distinguish from 'undefined' that gets assigned by ender
			const res = track(s.forEach(pushResult, (e?: Error) => { endResult = e; }));
			s.end();
			await res.promise;
			expect(results).to.deep.equal([]);
			expect(endResult).to.equal(undefined);
			expect(res.isFulfilled).to.equal(true);
		});

		it("handles a single value", async () => {
			let endResult: Error = null; // null, to distinguish from 'undefined' that gets assigned by ender
			const res = track(s.forEach(pushResult, (e?: Error) => { endResult = e; }));
			s.write(1);
			s.end();
			await res.promise;
			expect(results).to.deep.equal([1]);
			expect(endResult).to.equal(undefined);
			expect(res.isFulfilled).to.equal(true);
		});

		it("handles multiple values", async () => {
			let endResult: Error = null; // null, to distinguish from 'undefined' that gets assigned by ender
			const res = track(s.forEach(pushResult, (e?: Error) => { endResult = e; }));
			s.write(1);
			s.write(2);
			s.write(3);
			s.end();
			await res.promise;
			expect(results).to.deep.equal([1, 2, 3]);
			expect(endResult).to.equal(undefined);
			expect(res.isFulfilled).to.equal(true);
		});

		it("handles error in reader", async () => {
			// Error thrown in reader should ONLY reflect back to writer, not to reader
			// Allows writer to decide to send another value, abort, end normally, etc.
			const endError = new Error("end boom");
			let endResult: Error = null; // null, to distinguish from 'undefined' that gets assigned by ender
			const res = track(s.forEach(
				(n) => { throw boomError; },
				(e?: Error) => { endResult = e; }
			));

			// Write a value, will be rejected by reader and returned from write
			const wp = track(s.write(1));
			await settle([wp.promise]);
			expect(endResult).to.equal(null);
			expect(wp.reason).to.equal(boomError);

			// Then end the stream with an error, the end() itself should return
			// void promise
			const ep = track(s.end(endError));
			await settle([ep.promise, res.promise]);
			expect(endResult).to.equal(endError);
			expect(ep.value).to.equal(undefined);
			expect(res.reason).to.equal(endError);
		});

		it("can use a default ender", async () => {
			const res = track(s.forEach(
				(v) => { results.push(v); }
			));
			s.write(1);
			s.write(2);
			s.end();
			await res.promise;
			expect(results).to.deep.equal([1, 2]);
			expect(res.isFulfilled).to.equal(true);
		});

		it("returns errors by default", async () => {
			swallowErrors(s.result());
			const res = track(s.forEach(
				(v) => { results.push(v); }
			));
			s.write(1);
			s.write(2);
			const we = track(s.end(boomError));
			await settle([res.promise, we.promise]);
			expect(results).to.deep.equal([1, 2]);
			expect(we.reason).to.equal(undefined);
			expect(res.reason).to.equal(boomError);
		});

		it("disallows multiple attach", async () => {
			s.forEach(noop);
			const result = track(s.forEach(noop));
			await settle([result.promise]);
			expect(result.reason).to.be.instanceof(AlreadyHaveReaderError);
		});
	}); // forEach()

	describe("write()", () => {
		it("disallows writing undefined", async () => {
			const result = track(s.write(undefined));
			await settle([result.promise]);
			expect(result.reason).to.be.instanceof(TypeError);
		});
	}); // write()

	describe("end()", () => {
		it("allows null as error parameter", () => {
			readInto(s, results);
			return s.end(null);
		});
		it("allows undefined as error parameter", () => {
			readInto(s, results);
			return s.end(undefined);
		});
		it("allows an Error as error parameter", () => {
			swallowErrors(s.result());
			swallowErrors(readInto(s, results));
			return settle([s.end(boomError)]);
		});
		it("disallows non-error as error parameter", async () => {
			swallowErrors(s.result());
			swallowErrors(readInto(s, results));
			const result = track(s.end(<any>"boom"));
			await settle([result.promise]);
			expect(result.reason).to.be.instanceof(TypeError);
		});
	}); // end()

	describe("isEnded()", () => {
		it("indicates stream end after ender has run", async () => {
			expect(s.isEnded()).to.equal(false);

			const we = track(s.end());
			await delay(1);
			expect(s.isEnded()).to.equal(false);

			const d = defer();
			s.forEach(noop, (e) => d.promise);
			await delay(1);
			expect(s.isEnded()).to.equal(false);

			d.resolve();
			await settle([we.promise]);
			expect(s.isEnded()).to.equal(true);
		});
	}); // isEnded()

	describe("isEnding()", () => {
		it("indicates stream is ending", async () => {
			expect(s.isEnding()).to.equal(false);

			const we = track(s.end());
			await delay(1);
			expect(s.isEnding()).to.equal(true);

			const d = defer();
			s.forEach(noop, (e) => d.promise);
			await delay(1);
			expect(s.isEnding()).to.equal(true);

			d.resolve();
			await settle([we.promise]);
			expect(s.isEnding()).to.equal(false);
		});
		it("ignores ending after end", async () => {
			expect(s.isEnding()).to.equal(false);
			s.forEach(noop);
			const we = track(s.end());
			await settle([we.promise]);
			expect(s.isEnding()).to.equal(false);

			s.end().catch(noop);
			await delay(1);
			expect(s.isEnding()).to.equal(false);
		});
	}); // isEnding()

	describe("isEndingOrEnded()", () => {
		it("indicates stream is ending or ended", async () => {
			expect(s.isEndingOrEnded()).to.equal(false);

			const we = track(s.end());
			await delay(1);
			expect(s.isEndingOrEnded()).to.equal(true);

			const d = defer();
			s.forEach(noop, (e) => d.promise);
			await delay(1);
			expect(s.isEndingOrEnded()).to.equal(true);

			d.resolve();
			await settle([we.promise]);
			expect(s.isEndingOrEnded()).to.equal(true);
		});
	}); // isEndingOrEnded()

	describe("hasReader()", () => {
		it("indicates whether reader/ender are attached", async () => {
			expect(s.hasReader()).to.equal(false);
			s.forEach(noop);
			expect(s.hasReader()).to.equal(true);
			await s.end();
			expect(s.isEnded()).to.equal(true);
			expect(s.hasReader()).to.equal(true);
		});
	});

	describe("result()", () => {
		it("indicates stream end", async () => {
			const res = track(s.result());
			s.end();
			await delay(1);
			expect(res.isPending).to.equal(true);

			const d = defer();
			s.forEach(noop, (e) => d.promise);
			await delay(1);
			expect(res.isPending).to.equal(true);

			d.resolve();
			await settle([res.promise]);
			expect(res.isPending).to.equal(false);
			expect(res.value).to.equal(undefined);
		});

		it("can be overridden by `end()`", async () => {
			const res = track(s.result());
			let endResult = defer();
			s.end(null, endResult.promise);
			await delay(1);
			expect(res.isPending).to.equal(true);

			const d = defer();
			s.forEach(noop, (e) => d.promise);
			await delay(1);
			expect(res.isPending).to.equal(true);

			d.resolve();
			await delay(1);
			expect(res.isPending).to.equal(true);

			endResult.resolve();
			await settle([res.promise]);
			expect(res.isPending).to.equal(false);
			expect(res.value).to.equal(undefined);
		});
	}); // result()

	describe("map()", () => {
		it("maps values", async () => {
			const mapped = s.map((n) => n * 2);
			const writes = [track(s.write(1)), track(s.write(2)), track(s.end())];
			readInto(mapped, results);
			await s.result();
			expect(results).to.deep.equal([2, 4]);
			expect(writes[0].isFulfilled).to.equal(true);
			expect(writes[1].isFulfilled).to.equal(true);
			expect(writes[2].isFulfilled).to.equal(true);
		});

		it("bounces thrown error", async () => {
			const mapped = s.map((n) => {
				if (n === 1) {
					throw boomError;
				} else {
					return n * 2;
				}
			});
			const writes = [track(s.write(1)), track(s.write(2)), track(s.end())];
			writes.forEach((t): void => {
				swallowErrors(t.promise);
			});
			readInto(mapped, results);
			await settle([s.result()]);
			expect(results).to.deep.equal([4]);
			expect(writes[0].reason).to.equal(boomError);
			expect(writes[1].isFulfilled).to.equal(true);
			expect(writes[2].isFulfilled).to.equal(true);
		});

		it("bounces returned rejection", async () => {
			const mapped = s.map((n) => {
				if (n === 1) {
					return Promise.reject<number>(boomError);
				} else {
					return n * 2;
				}
			});
			const writes = [track(s.write(1)), track(s.write(2)), track(s.end())];
			writes.forEach((t): void => {
				swallowErrors(t.promise);
			});
			readInto(mapped, results);
			await settle([s.result()]);
			expect(results).to.deep.equal([4]);
			expect(writes[0].reason).to.equal(boomError);
			expect(writes[1].isFulfilled).to.equal(true);
			expect(writes[2].isFulfilled).to.equal(true);
		});

		it("waits for source stream to end", async () => {
			const d = defer();
			const slowEndingSource = s.transform<number>((readable, writable) => {
				readable.forEach(
					(v) => writable.write(v),
					(error?: Error) => {
						writable.end(error, readable.result());
						return d.promise;
					}
				);
			});
			const writes = [track(s.write(1)), track(s.write(2)), track(s.end())];

			const mapped = slowEndingSource.map((n) => n * 2);
			const mres = track(mapped.result());
			readInto(mapped, results);

			await settle([writes[0].promise, writes[1].promise]);
			await delay(1);
			expect(results).to.deep.equal([2, 4]);
			expect(writes[0].isFulfilled).to.equal(true);
			expect(writes[1].isFulfilled).to.equal(true);
			expect(writes[2].isFulfilled).to.equal(false);
			expect(mres.isFulfilled).to.equal(false);

			d.resolve();
			await settle([mres.promise]);
		});

		it("waits for destination stream to end", async () => {
			const d = defer();
			const slowEnder: Transform<number, number> = (readable, writable) => {
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

			const mapped = s.map((n) => n * 2);
			const mres = track(mapped.result());
			const slowed = mapped.transform(slowEnder);
			const sres = track(slowed.result());
			readInto(slowed, results);

			await delay(1);
			expect(results).to.deep.equal([2, 4]);
			expect(w1.isFulfilled).to.equal(true);
			expect(w2.isFulfilled).to.equal(true);
			expect(we.isFulfilled).to.equal(false);
			expect(mres.isFulfilled).to.equal(false);
			expect(sres.isFulfilled).to.equal(false);

			d.resolve();
			await settle([mres.promise, sres.promise]);
		});

		it("calls ender and awaits its result", async () => {
			const d = defer();
			let endResult: Error = null;
			const mapped = s.map(
				(n) => n * 2,
				(e) => { endResult = e; return d.promise; }
			);
			readInto(mapped, results);
			const w1 = track(s.write(1));
			const we = track(s.end());

			await delay(1);
			expect(results).to.deep.equal([2]);
			expect(mapped.isEnded()).to.equal(false);
			expect(endResult).to.equal(undefined);
			expect(w1.isFulfilled).to.equal(true);
			expect(we.isPending).to.equal(true);

			d.resolve();
			await we.promise;
			expect(we.isFulfilled).to.equal(true);
			expect(mapped.isEnded()).to.equal(true);
		});

		it("returns asynchronous error in ender to writer but does end stream", async () => {
			const d = defer();
			let endResult: Error = null;
			const mapped = s.map(
				(n) => n * 2,
				(e) => { endResult = e; return d.promise; }
			);
			const r = track(readInto(mapped, results));
			const w1 = track(s.write(1));
			const we = track(s.end());
			const res = track(s.result());
			[r, w1, we, res].forEach((t): void => {
				swallowErrors(t.promise);
			});
			swallowErrors(mapped.result());

			await delay(1);
			expect(results).to.deep.equal([2]);
			expect(mapped.isEnded()).to.equal(false);
			expect(endResult).to.equal(undefined);
			expect(w1.isFulfilled).to.equal(true);
			expect(we.isPending).to.equal(true);

			d.reject(boomError);
			await settle([r.promise, res.promise]);
			expect(we.reason).to.equal(boomError);
			expect(mapped.isEnded()).to.equal(true);
			expect(s.isEnded()).to.equal(true);
			expect(res.reason).to.equal(boomError);
			expect(r.reason).to.equal(boomError);
		});

		it("returns synchronous error in ender to writer but does end stream", async () => {
			let endResult: Error = null;
			const mapped = s.map(
				(n) => n * 2,
				(e) => { endResult = e; throw boomError; }
			);
			const r = track(readInto(mapped, results));
			const w1 = track(s.write(1));
			const we = track(s.end());
			const res = track(s.result());
			[r, w1, we, res].forEach((t): void => {
				swallowErrors(t.promise);
			});
			swallowErrors(mapped.result());

			await settle([r.promise, res.promise]);
			expect(results).to.deep.equal([2]);
			expect(endResult).to.equal(undefined);
			expect(w1.isFulfilled).to.equal(true);
			expect(we.reason).to.equal(boomError);
			expect(mapped.isEnded()).to.equal(true);
			expect(s.isEnded()).to.equal(true);
			expect(res.reason).to.equal(boomError);
			expect(r.reason).to.equal(boomError);
		});

		it("returns synchronous error in ender to writer even if downstream ender fails", async () => {
			let endResult: Error = null;
			const mapped = s.map(
				(n) => n * 2,
				(e) => { endResult = e; throw boomError; }
			);
			let forEachEndResult: Error = null;
			mapped.forEach(
				(n) => { results.push(n); },
				(e) => {
					forEachEndResult = e;
					throw new Error("some other error");
				}
			);
			const w1 = track(s.write(1));
			const we = track(s.end());
			const res = track(s.result());
			[w1, we, res].forEach((t): void => {
				swallowErrors(t.promise);
			});
			swallowErrors(mapped.result());

			await settle([res.promise]);
			expect(results).to.deep.equal([2]);
			expect(endResult).to.equal(undefined);
			expect(w1.isFulfilled).to.equal(true);
			expect(we.reason).to.equal(boomError);
			expect(mapped.isEnded()).to.equal(true);
			expect(s.isEnded()).to.equal(true);
			expect(res.reason).to.equal(boomError);
			expect(forEachEndResult).to.equal(boomError);
		});

		it("leaves original end error intact and waits for stream to end", async () => {
			const endError = new Error("endError");
			let mapEndResult: Error = null;
			const mapped = s.map(
				(n) => n * 2,
				(e) => { mapEndResult = e; throw boomError; }
			);
			const w1 = track(s.write(1));
			const we = track(s.end(endError));
			const res = track(s.result());
			swallowErrors(mapped.result());

			let forEachEndResult: Error = null;
			const d = defer();
			mapped.forEach(
				(n) => { results.push(n); },
				(e) => {
					forEachEndResult = e;
					return d.promise;
				}
			);

			while (!mapped.isEnding()) {
				await delay(1);
			}
			expect(mapEndResult).to.equal(endError);
			expect(w1.isFulfilled).to.equal(true);
			expect(we.isPending).to.equal(true);
			expect(mapped.isEnding()).to.equal(true);
			expect(mapped.isEnded()).to.equal(false);
			expect(res.isPending).to.equal(true);

			d.resolve();
			await settle([res.promise, we.promise]);
			expect(results).to.deep.equal([2]);
			expect(we.reason).to.equal(boomError);
			expect(mapped.isEnded()).to.equal(true);
			expect(s.isEnded()).to.equal(true);
			expect(res.reason).to.equal(boomError);
			expect(forEachEndResult).to.equal(endError);
		});

		it("supports aborter", async() => {
			let abortResult: Error = null;
			const abortSeen = defer();
			const mapped = s.map(
				(n) => n * 2,
				undefined,
				(e) => {
					abortResult = e;
					abortSeen.resolve();
				}
			);
			mapped.abort(abortError);
			await abortSeen.promise;
			expect(abortResult).to.equal(abortError);
		});

		it("aborts from source to sink", async () => {
			const sink = s.map(identity).map(identity);
			const ab = track(sink.aborted());
			s.abort(abortError);
			await settle([ab.promise]);
			expect(ab.reason).to.equal(abortError);
		});

		it("aborts from sink to source", async () => {
			const ab = track(s.aborted());
			const sink = s.map(identity).map(identity);
			sink.abort(abortError);
			await settle([ab.promise]);
			expect(ab.reason).to.equal(abortError);
		});
	}); // map()

	describe("reduce()", () => {
		it("can be used to sum values", async () => {
			const x = Stream.from([1, 2, 3, 4]);
			const value = await x.reduce((a, b) => a + b);
			expect(value).to.equal(10);
		});

		it("can be used to sum values with seed", async () => {
			const x = Stream.from([1, 2, 3, 4]);
			const value = await x.reduce((a, b) => a + b, 10);
			expect(value).to.equal(20);
		});

		it("can be used to implement toArray()", async () => {
			const x = Stream.from([1, 2, 3, 4]);
			const value = await x.reduce(
				(arr: number[], v: number) => { arr.push(v); return arr; },
				[]
			);
			expect(value).to.deep.equal([1, 2, 3, 4]);
		});

		it("calls reducer with same args as Array#reduce, without initial value", async () => {
			const arr = [1, 2, 3, 4];
			let calls: any[][];
			let previouses: number[];
			function reducer(...args: any[]): number {
				// Skip the last arg though (either the array or stream)
				calls.push(args.slice(0, 3));
				return previouses.shift();
			}

			calls = [];
			previouses = [-10, -20, -30];
			const arrResult = arr.reduce(reducer);
			const arrCalls = calls;
			expect(previouses).to.deep.equal([]);

			calls = [];
			previouses = [-10, -20, -30];
			const x = Stream.from(arr);
			const value = await x.reduce(reducer);
			expect(value).to.equal(arrResult);
			expect(previouses).to.deep.equal([]);
			expect(calls).to.deep.equal(arrCalls);
		});

		it("calls reducer with same args as Array#reduce, with initial value", async () => {
			const arr = [1, 2, 3, 4];
			let calls: any[][];
			let previouses: number[];
			function reducer(...args: any[]): number {
				// Skip the last arg though (either the array or stream)
				calls.push(args.slice(0, 3));
				return previouses.shift();
			}

			calls = [];
			previouses = [-20, -30, -40, -50];
			const arrResult = arr.reduce(reducer, -10);
			const arrCalls = calls;
			expect(previouses).to.deep.equal([]);

			calls = [];
			previouses = [-20, -30, -40, -50];
			const x = Stream.from(arr);
			const value = await x.reduce(reducer, -10);

			expect(value).to.equal(arrResult);
			expect(previouses).to.deep.equal([]);
			expect(calls).to.deep.equal(arrCalls);
		});

		it("calls reducer with stream as 4th arg, without initial value", async () => {
			const x = Stream.from([1, 2, 3, 4]);
			const calls: any[][] = [];
			const previouses = [-1, -2, -3];
			function reducer(...args: any[]): number {
				calls.push(args);
				return previouses.shift();
			}
			const value = await x.reduce(reducer);
			expect(value).to.equal(-3);
			expect(previouses).to.deep.equal([]);
			expect(calls).to.deep.equal([
				[1, 2, 1, x],
				[-1, 3, 2, x],
				[-2, 4, 3, x],
			]);
		});

		it("accepts promise from reducer", async () => {
			const d = defer<number>();
			const reduceResult = track(s.reduce(() => d.promise, 0));

			const writeResult = track(s.write(1));
			await delay(1);
			expect(reduceResult.isPending).to.equal(true);
			expect(writeResult.isPending).to.equal(true);

			d.resolve(100);
			await settle([writeResult.promise]);
			expect(reduceResult.isPending).to.equal(true);
			expect(writeResult.isFulfilled).to.equal(true);

			s.end();
			await settle([reduceResult.promise]);
			expect(reduceResult.value).to.equal(100);
		});

		it("returns error when stream is empty without initial value", async () => {
			const reduceResult = track(s.reduce(() => 0));
			s.end();
			await settle([reduceResult.promise]);
			expect(reduceResult.reason).to.be.instanceof(TypeError);
		});

		it("returns thrown error to writer", async () => {
			const reduceResult = track(s.reduce((prev, curr): number => { throw boomError; }, 0));
			const writeResult = track(s.write(1));
			await settle([writeResult.promise]);
			expect(reduceResult.isPending).to.equal(true);
			expect(writeResult.reason).to.equal(boomError);
			s.end();
			await settle([reduceResult.promise]);
			expect(reduceResult.isFulfilled).to.equal(true);
		});

		it("returns rejected error to writer", async () => {
			const reduceResult = track(s.reduce((prev, curr) => Promise.reject<number>(boomError), 0));
			const writeResult = track(s.write(1));
			await settle([writeResult.promise]);
			expect(reduceResult.isPending).to.equal(true);
			expect(writeResult.reason).to.equal(boomError);
			s.end();
			await settle([reduceResult.promise]);
			expect(reduceResult.isFulfilled).to.equal(true);
		});
	}); // reduce()

	describe("toArray()", () => {
		it("returns all values in the stream", async () => {
			const value = await Stream.from([1, 2, 3, 4]).toArray();
			expect(value).to.deep.equal([1, 2, 3, 4]);
		});

		it("returns empty array for empty stream", async () => {
			const value = await Stream.from([]).toArray();
			expect(value).to.deep.equal([]);
		});

		it("returns end error if stream ended with error", async () => {
			swallowErrors(s.result());
			const result = track(s.toArray());
			swallowErrors(s.end(boomError));
			await settle([result.promise]);
			expect(result.reason).to.deep.equal(boomError);
		});
	}); // toArray()

	describe("writeEach()", () => {
		it("calls callback until undefined is returned", async () => {
			const values = [1, 2, undefined, 3];
			const writeResult = track(s.writeEach(() => values.shift()));
			await s.forEach((v) => { results.push(v); });
			expect(s.isEnded()).to.equal(true);
			expect(results).to.deep.equal([1, 2]);
			expect(values).to.deep.equal([3]);
			expect(writeResult.isFulfilled).to.equal(true);
		});

		it("waits for next call until previous value is processed", async () => {
			const values = [1, 2];
			const writeResult = track(s.writeEach(() => values.shift()));
			await delay(1);
			expect(values).to.deep.equal([2]);

			const fe = s.forEach((v) => { results.push(v); });
			await settle([fe, writeResult.promise]);
			expect(results).to.deep.equal([1, 2]);
			expect(writeResult.isFulfilled).to.equal(true);
		});

		it("handles synchronous exception in writer", async () => {
			swallowErrors(s.result());
			const writeResult = track(s.writeEach(() => { throw boomError; }));
			const fe = s.forEach(noop);
			await settle([fe, writeResult.promise]);
			expect(s.isEnded()).to.equal(true);
			expect(writeResult.reason).to.equal(boomError);
		});

		it("handles all values and stream end as promises", async () => {
			const values = [1, 2];
			const writeResult = track(s.writeEach(() => Promise.resolve(values.shift())));
			const fe = s.forEach((v) => { results.push(v); });
			await settle([fe, writeResult.promise]);
			expect(results).to.deep.equal([1, 2]);
			expect(writeResult.isFulfilled).to.equal(true);
		});

		it("aborts and ends with error on write error", async () => {
			swallowErrors(s.result());
			const ab = track(s.aborted());
			const values = [1, 2, 3];
			const writeResult = track(s.writeEach(() => values.shift()));
			let endResult: Error = null;
			const forEachResult = track(s.forEach(
				(v) => {
					if (v === 2) {
						return Promise.reject(boomError);
					}
				},
				(error?: Error) => { endResult = error; }
			));
			await settle([ab.promise, forEachResult.promise, writeResult.promise]);
			expect(values).to.deep.equal([3]);
			expect(s.isEnded()).to.equal(true);
			expect(ab.reason).to.equal(boomError);
			expect(endResult).to.equal(boomError);
			expect(forEachResult.reason).to.equal(boomError);
			expect(writeResult.reason).to.equal(boomError);
		});

		it("aborts and ends with error on normal end error", async () => {
			swallowErrors(s.result());
			const ab = track(s.aborted());
			const values = [1, 2];
			const writeResult = track(s.writeEach(() => values.shift()));
			const forEachResult = track(s.forEach(
				noop,
				(error?: Error) => Promise.reject(boomError)
			));
			await settle([ab.promise, forEachResult.promise, writeResult.promise]);
			expect(values).to.deep.equal([]);
			expect(s.isEnded()).to.equal(true);
			expect(ab.reason).to.equal(boomError);
			expect(forEachResult.reason).to.equal(boomError);
			expect(writeResult.reason).to.equal(boomError);
		});

		it("ends with error on end error after abort", async () => {
			swallowErrors(s.result());
			const ab = track(s.aborted());
			const values = [1, 2];
			const writeResult = track(s.writeEach(() => values.shift()));
			s.abort(abortError);
			const forEachResult = track(s.forEach(
				noop,
				(error?: Error) => Promise.reject(boomError)
			));
			await settle([ab.promise, forEachResult.promise, writeResult.promise]);
			expect(values).to.deep.equal([1, 2]);
			expect(s.isEnded()).to.equal(true);
			expect(ab.reason).to.equal(abortError);
			expect(forEachResult.reason).to.equal(boomError);
			expect(writeResult.reason).to.equal(boomError);
		});

		it("handles abort bounce", async () => {
			swallowErrors(s.result());
			swallowErrors(s.aborted());
			const values = [1, 2, 3];
			const writeResult = track(s.writeEach(() => values.shift()));
			const forEachResult = track(s.forEach(
				(v) => {
					if (v === 2) {
						return Promise.reject(boomError);
					}
				}
				// Note: no end handler, so default, which 'bounces' the given
				// error
			));
			await settle([forEachResult.promise, writeResult.promise]);
			expect(values).to.deep.equal([3]);
			expect(s.isEnded()).to.equal(true);
			expect(forEachResult.reason).to.equal(boomError);
			expect(writeResult.reason).to.equal(boomError);
		});

		it("ends on abort", async () => {
			swallowErrors(s.result());
			swallowErrors(s.aborted());
			const values = [1, 2, 3];
			const writeResult = track(s.writeEach(() => values.shift()));
			let endResult: Error = null;
			const d = defer();
			const forEachResult = track(s.forEach(
				(v) => d.promise,
				(err?) => { endResult = err; }
			));
			await delay(1);
			expect(values).to.deep.equal([2, 3]);
			s.abort(abortError);
			d.resolve();
			await settle([forEachResult.promise, writeResult.promise]);
			expect(values).to.deep.equal([2, 3]);
			expect(s.isEnded()).to.equal(true);
			expect(endResult).to.equal(abortError);
			expect(forEachResult.reason).to.equal(abortError);
			expect(writeResult.reason).to.equal(abortError);
		});
	}); // writeEach()

	describe("from()", () => {
		it("produces all values, then ends", async () => {
			const x = Stream.from([1, 2]);
			await x.forEach((v) => { results.push(v); });
			expect(x.isEnded()).to.equal(true);
			expect(results).to.deep.equal([1, 2]);
		});

		it("supports promise for array", async () => {
			const x = Stream.from(Promise.resolve([1, 2]));
			await x.forEach((v) => { results.push(v); });
			expect(results).to.deep.equal([1, 2]);
		});

		it("supports array of promises", async () => {
			const x = Stream.from([Promise.resolve(1), Promise.resolve(2)]);
			await x.forEach((v) => { results.push(v); });
			expect(results).to.deep.equal([1, 2]);
		});

		it("supports promise for array of promises", async () => {
			const x = Stream.from(Promise.resolve([Promise.resolve(1), Promise.resolve(2)]));
			await x.forEach((v: number) => { results.push(v); });
			expect(results).to.deep.equal([1, 2]);
		});

		it("ends on first undefined", async () => {
			const x = Stream.from([1, 2, undefined, 3]);
			await x.forEach((v) => { results.push(v); });
			expect(x.isEnded()).to.equal(true);
			expect(results).to.deep.equal([1, 2]);
		});

		it("aborts on write error", async () => {
			const x = Stream.from([1, 2]);
			swallowErrors(x.result());
			swallowErrors(x.aborted());
			let endResult: Error = null;
			const result = track(x.forEach(
				(v) => {
					if (v === 2) {
						return Promise.reject(boomError);
					}
				},
				(error?: Error) => { endResult = error; }
			));
			await settle([result.promise]);
			expect(x.isEnded()).to.equal(true);
			expect(endResult).to.equal(boomError);
			expect(result.reason).to.equal(boomError);
		});

		it("handles abort bounce", async () => {
			const x = Stream.from([1, 2]);
			swallowErrors(x.result());
			swallowErrors(x.aborted());
			const result = track(x.forEach(
				(v) => {
					if (v === 2) {
						return Promise.reject(boomError);
					}
				}
				// Note: no end handler, so default, which 'bounces' the given
				// error
			));
			await settle([result.promise]);
			expect(x.isEnded()).to.equal(true);
			expect(result.reason).to.equal(boomError);
		});

		it("ends on abort", async () => {
			const x = Stream.from([1, 2]);
			swallowErrors(x.result());
			swallowErrors(x.aborted());
			let endResult: Error = null;
			const d = defer();
			const result = track(x.forEach(
				(v) => d.promise,
				(err?) => { endResult = err; }
			));
			await delay(1);
			x.abort(abortError);
			d.resolve();
			await settle([result.promise]);
			expect(x.isEnded()).to.equal(true);
			expect(endResult).to.equal(abortError);
			expect(result.reason).to.equal(abortError);
		});
	}); // from()

	describe("issue #31", (): void => {
		it("should not result in unhandled rejections", (done: MochaDone): void => {
			const result = new Stream();
			const stream = new Stream();
			stream.end(new Error("foo"))
				.catch((error) => undefined);
			stream.pipe(result);
			result.forEach(() => undefined)
				.catch(() => undefined);
			setTimeout(done, 10);
		});

		it("should wait for source stream before passing on result", (done: MochaDone) => {
			const result = new Stream();
			const stream = new Stream();
			const d = defer();

			// Create stream that already ended with an error
			swallowErrors(stream.end(new Error("foo")));

			// Pipe to follow-up stream, but make the end of this stream wait on `d`
			stream.forEach(
				(v) => result.write(v),
				(e) => {
					swallowErrors(result.end(e, stream.result()));
					return d.promise;
				}
			);

			let ended = false;
			let finished = false;
			result.forEach(
				() => undefined,
				(e) => {
					ended = true;
					throw e;
				}
			).catch(() => { finished = true; });

			setTimeout(
				() => {
					expect(ended).to.equal(true);
					expect(finished).to.equal(false);
					d.resolve();
					setTimeout(
						() => {
							expect(finished).to.equal(true);
							done();
						},
						10
					);
				},
				10
			);
		});
	});
});
