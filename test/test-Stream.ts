/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */

"use strict";

require("source-map-support").install();

import Promise from "ts-promise";
import { Stream, ReadableStream, WriteAfterEndError } from "../lib/index";
import { expect } from "chai";

//Promise.setLongTraces(true);

function readInto<T>(stream: ReadableStream<T>, into: T[]): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		stream.forEach(
			function(value: T) {
				expect(this).to.equal(undefined);
				into.push(value);
			},
			function(err?: Error) {
				expect(this).to.equal(undefined);
				if (err)
					reject(err);
				else
					resolve(undefined);
			}
		);
	});
}

function noop(): void {
}

describe("Stream", () => {
	var s: Stream<number>;
	var results: number[];
	var promises: Promise<any>[];

	beforeEach(() => {
		s = new Stream<number>();
		results = [];
		promises = [];
	});

	function pushResult(n: number): void {
		results.push(n);
	}

	it("supports get after put", () => {
		promises.push(s.write(42));
		promises.push(s.end());
		promises.push(readInto(s, results));
		return Promise.all<void>(promises).then(() => {
			expect(results).to.deep.equal([42]);
		});
	});

	it("supports put after get", () => {
		promises.push(readInto(s, results));
		promises.push(s.write(42));
		promises.push(s.end());
		return Promise.all<void>(promises).then(() => {
			expect(results).to.deep.equal([42]);
		});
	});

	it("allows end before get", () => {
		promises.push(s.end());
		promises.push(readInto(s, results));
		return Promise.all<void>(promises).then(() => {
			expect(results).to.deep.equal([]);
		});
	});

	it("allows get before end", () => {
		promises.push(readInto(s, results));
		promises.push(s.end());
		return Promise.all<void>(promises).then(() => {
			expect(results).to.deep.equal([]);
		});
	});

	it("disallows write after end", () => {
		promises.push(s.end());
		promises.push(s.write(42).catch((r) => {
			expect(r).to.be.instanceof(WriteAfterEndError);
		}));
		promises.push(readInto(s, results));
		return Promise.all<void>(promises).then(() => {
			expect(results).to.deep.equal([]);
		});
	});

	it("disallows multiple ends", () => {
		let p1 = s.end();
		let p2 = s.end();
		let p3 = readInto(s, results);
		Promise.flush();
		expect(p1.isFulfilled()).to.equal(true);
		expect(p2.reason()).to.be.instanceof(WriteAfterEndError);
		expect(p3.isFulfilled()).to.equal(true);
		expect(results).to.deep.equal([]);
	});

	it("write fails when writing synchronously rejected promise", () => {
		var e = new Error("boom");
		var wp1 = s.write(Promise.reject(e));
		var wp2 = s.write(42);
		var ep = s.end();
		var rp = readInto(s, results);
		Promise.flush();
		expect(wp1.reason()).to.equal(e);
		expect(wp2.isFulfilled()).to.equal(true);
		expect(results).to.deep.equal([42]);
		expect(ep.isFulfilled()).to.equal(true);
		expect(rp.isFulfilled()).to.equal(true);
	});

	it("write fails when writing asynchronously rejected promise", () => {
		var e = new Error("boom");
		var d = Promise.defer<number>();
		var wp1 = s.write(d.promise);
		var wp2 = s.write(42);
		var ep = s.end();
		var rp = readInto(s, results);
		d.reject(e);
		Promise.flush();
		expect(wp1.reason()).to.equal(e);
		expect(wp2.isFulfilled()).to.equal(true);
		expect(results).to.deep.equal([42]);
		expect(ep.isFulfilled()).to.equal(true);
		expect(rp.isFulfilled()).to.equal(true);
	});

	it("resolves reads in-order for out-of-order writes", () => {
		var d = Promise.defer<number>();
		promises.push(s.write(d.promise));
		promises.push(s.write(2));
		promises.push(s.end());
		promises.push(readInto(s, results));
		Promise.flush();
		expect(results).to.deep.equal([]);
		d.resolve(1);
		return Promise.all<void>(promises).then(() => {
			expect(results).to.deep.equal([1, 2]);
		});
	});

	it("aborts pending writes", () => {
		var e = new Error("boom");
		promises.push(s.write(42).catch((r) => {
			expect(r).to.equal(e);
		}));
		s.abort(e);
		return Promise.all<void>(promises);
	});
	it("aborts pending ends", () => {
		var e = new Error("boom");
		promises.push(s.end().catch((r) => {
			expect(r).to.equal(e);
		}));
		s.abort(e);
		return Promise.all<void>(promises);
	});
	it("aborts pending reads", () => {
		var e = new Error("boom");
		promises.push(readInto(s, results).catch((r) => {
			expect(r).to.equal(e);
		}));
		s.abort(e);
		return Promise.all<void>(promises);
	});
	it("aborts future writes", () => {
		var e = new Error("boom");
		s.abort(e);
		promises.push(s.write(42).catch((r) => {
			expect(r).to.equal(e);
		}));
		return Promise.all<void>(promises);
	});
	it("aborts future ends", () => {
		var e = new Error("boom");
		s.abort(e);
		promises.push(s.end().catch((r) => {
			expect(r).to.equal(e);
		}));
		return Promise.all<void>(promises);
	});
	it("aborts future reads", () => {
		var e = new Error("boom");
		s.abort(e);
		promises.push(readInto(s, results).catch((r) => {
			expect(r).to.equal(e);
		}));
		return Promise.all<void>(promises);
	});

	it("handles error thrown in reader", () => {
		// Error thrown in reader should ONLY reflect back to writer, not to reader
		// Allows writer to decide to send another value, abort, end normally, etc.
		var writeError: Error;
		var readError: Error;
		s.write(1).catch((e) => { writeError = e; });
		s.forEach((v) => { throw new Error("boom"); }, (e) => { readError = e; });
		Promise.flush();
		expect(writeError).to.be.instanceof(Error);
		expect(writeError.message).to.equal("boom");
		expect(readError).to.be.undefined;

		// Try to end the stream with an error, this time it should only end up in
		// ender (basically already covered by other tests, but just to make sure
		// that internal state isn't corrupted)
		writeError = undefined;
		readError = undefined;
		s.end(new Error("end boom")).catch((e) => { writeError = e; });
		Promise.flush();
		expect(writeError).to.be.undefined;
		expect(readError).to.be.instanceof(Error);
		expect(readError.message).to.equal("end boom");
	});

	it("aborts write and calls ender if synchronously aborted in reader", () => {
		var writeError: Error;
		var readError: Error;
		var abortError = new Error("abort boom");
		s.write(1).catch((e) => { writeError = e; });
		s.forEach(
			(v) => { s.abort(abortError); },
			(e) => { readError = e; }
		);
		Promise.flush();
		expect(writeError).to.equal(abortError);
		expect(readError).to.equal(abortError);
	});

	it("aborts write and calls ender if asynchronously aborted in reader", () => {
		var writeError: Error;
		var readError: Error;
		var abortError = new Error("abort boom");
		s.write(1).catch((e) => { writeError = e; });
		s.forEach(
			(v) => {
				return Promise.resolve().then(
					() => { s.abort(abortError); }
				);
			},
			(e) => { readError = e; }
		);
		Promise.flush();
		expect(writeError).to.equal(abortError);
		expect(readError).to.equal(abortError);
	});

	describe("forEach()", () => {
		it("handles empty stream", () => {
			var endResult: Error = null; // null, to distinguish from 'undefined' that gets assigned by ender
			s.forEach(pushResult, (e?: Error) => { endResult = e; });
			s.end();
			Promise.flush();
			expect(results).to.deep.equal([]);
			expect(endResult).to.equal(undefined);
		});

		it("handles a single value", () => {
			var endResult: Error = null; // null, to distinguish from 'undefined' that gets assigned by ender
			s.forEach(pushResult, (e?: Error) => { endResult = e; });
			s.write(1);
			s.end();
			Promise.flush();
			expect(results).to.deep.equal([1]);
			expect(endResult).to.equal(undefined);
		});

		it("handles a multiple values", () => {
			var endResult: Error = null; // null, to distinguish from 'undefined' that gets assigned by ender
			s.forEach(pushResult, (e?: Error) => { endResult = e; });
			s.write(1);
			s.write(2);
			s.write(3);
			s.end();
			Promise.flush();
			expect(results).to.deep.equal([1, 2, 3]);
			expect(endResult).to.equal(undefined);
		});

		it("handles errors during read and end", () => {
			var readError = new Error("boom");
			var endError = new Error("end boom");
			var endResult: Error = null; // null, to distinguish from 'undefined' that gets assigned by ender
			s.forEach((n) => {
				throw readError;
			}, (e?: Error) => { endResult = e; });
			var wp = s.write(1);
			var ep = s.end(endError);
			Promise.flush();
			expect(endResult).to.equal(endError);
			expect(wp.reason()).to.equal(readError);
			expect(ep.value()).to.equal(undefined);
		});

		it("allows a single attach", () => {
			s.forEach(noop);
			expect(() => s.forEach(noop)).to.throw();
		});
	}); // forEach()

	describe("isEnded()", () => {
		it("indicates stream end", () => {
			s.end();
			Promise.flush();
			expect(s.isEnded()).to.equal(false);

			var d = Promise.defer();
			s.forEach(noop, (e) => d.promise);
			Promise.flush();
			expect(s.isEnded()).to.equal(false);

			d.resolve();
			Promise.flush();
			expect(s.isEnded()).to.equal(true);
		});
	});

	describe("map()", () => {
		it("maps values", () => {
			var mapped = s.map((n) => n * 2);
			var writes = [s.write(1), s.write(2), s.end()];
			readInto(mapped, results);
			Promise.flush();
			expect(results).to.deep.equal([2, 4]);
			expect(writes[0].isFulfilled()).to.equal(true);
			expect(writes[1].isFulfilled()).to.equal(true);
			expect(writes[2].isFulfilled()).to.equal(true);
		});

		it("bounces thrown error", () => {
			var e = new Error("boom");
			var mapped = s.map((n) => {
				if (n === 1) {
					throw e;
				} else {
					return n * 2;
				}
			});
			var writes = [s.write(1), s.write(2), s.end()];
			readInto(mapped, results);
			Promise.flush();
			expect(results).to.deep.equal([4]);
			expect(writes[0].reason()).to.equal(e);
			expect(writes[1].isFulfilled()).to.equal(true);
			expect(writes[2].isFulfilled()).to.equal(true);
		});

		it("bounces returned rejection", () => {
			var e = new Error("boom");
			var mapped = s.map((n) => {
				if (n === 1) {
					return Promise.reject(e);
				} else {
					return n * 2;
				}
			});
			var writes = [s.write(1), s.write(2), s.end()];
			readInto(mapped, results);
			Promise.flush();
			expect(results).to.deep.equal([4]);
			expect(writes[0].reason()).to.equal(e);
			expect(writes[1].isFulfilled()).to.equal(true);
			expect(writes[2].isFulfilled()).to.equal(true);
		});
	});
});
