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
	var boomError: Error;
	var results: number[];
	var promises: Promise<any>[];

	beforeEach(() => {
		s = new Stream<number>();
		boomError = new Error("boom");
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
		var wp1 = s.write(Promise.reject(boomError));
		var wp2 = s.write(42);
		var ep = s.end();
		var rp = readInto(s, results);
		Promise.flush();
		expect(wp1.reason()).to.equal(boomError);
		expect(wp2.isFulfilled()).to.equal(true);
		expect(results).to.deep.equal([42]);
		expect(ep.isFulfilled()).to.equal(true);
		expect(rp.isFulfilled()).to.equal(true);
	});

	it("write fails when writing asynchronously rejected promise", () => {
		var d = Promise.defer<number>();
		var wp1 = s.write(d.promise);
		var wp2 = s.write(42);
		var ep = s.end();
		var rp = readInto(s, results);
		d.reject(boomError);
		Promise.flush();
		expect(wp1.reason()).to.equal(boomError);
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

	describe("abort()", () => {
		let abortError: Error;
		beforeEach(() => {
			abortError = new Error("abort error");
		});
		it("aborts pending writes when not being processed", () => {
			let w1 = s.write(1);
			let w2 = s.write(2);
			s.abort(abortError);
			Promise.flush();
			expect(w1.reason()).to.equal(abortError);
			expect(w2.reason()).to.equal(abortError);
		});
		it("aborts future writes when not being processed", () => {
			s.abort(abortError);
			let w1 = s.write(1);
			let w2 = s.write(2);
			Promise.flush();
			expect(w1.reason()).to.equal(abortError);
			expect(w2.reason()).to.equal(abortError);
		});
		it("waits for reader to finish, then aborts writes until end", () => {
			let endDef = Promise.defer();
			let r1 = Promise.defer();
			let reads = [r1.promise];
			let endResult: Error = null;

			let w1 = s.write(1);
			let w2 = s.write(2);
			s.forEach(
				(v) => {
					results.push(v);
					return reads.shift();
				},
				(err) => {
					endResult = err;
					return endDef.promise;
				}
			);

			Promise.flush();
			expect(w1.isPending()).to.equal(true);
			expect(w2.isPending()).to.equal(true);
			expect(results).to.deep.equal([1]);

			s.abort(abortError);
			let w3 = s.write(3);
			Promise.flush();
			expect(w1.isPending()).to.equal(true);
			expect(w2.isPending()).to.equal(true);
			expect(w3.isPending()).to.equal(true);
			expect(results).to.deep.equal([1]);

			r1.reject(boomError); // could do resolve() too, error is more interesting :)
			Promise.flush();
			expect(w1.reason()).to.equal(boomError);
			expect(w2.reason()).to.equal(abortError);
			expect(w3.reason()).to.equal(abortError);
			expect(results).to.deep.equal([1]);
			expect(endResult).to.equal(null);

			let we = s.end(new Error("end error"));
			Promise.flush();
			expect(endResult).to.equal(abortError);
			expect(we.isPending()).to.equal(true);

			let enderError = new Error("ender error");
			endDef.reject(enderError);
			Promise.flush();
			expect(we.reason()).to.equal(enderError);

			let we2 = s.end();
			Promise.flush();
			expect(we2.reason()).to.be.instanceof(WriteAfterEndError);
		});
		it("can be called in reader", () => {
			var endResult: Error = null;
			let w1 = s.write(1);
			let w2 = s.write(2);
			let r1 = Promise.defer();
			s.forEach(
				(v) => { s.abort(abortError); return r1.promise; },
				(e) => { endResult = e; }
			);
			Promise.flush();
			expect(w1.isPending()).to.equal(true);
			expect(w2.isPending()).to.equal(true);
			expect(endResult).to.equal(null);

			r1.resolve();
			Promise.flush();
			expect(w1.value()).to.equal(undefined);
			expect(w2.reason()).to.equal(abortError);
			expect(endResult).to.equal(null);

			let we = s.end();
			Promise.flush();
			expect(endResult).to.equal(abortError);
			expect(we.value()).to.equal(undefined);
		});
		it("ignores multiple aborts", () => {
			var endResult: Error = null;
			let w1 = s.write(1);
			let r1 = Promise.defer();
			let firstAbortError = new Error("first abort error");
			s.abort(firstAbortError);
			s.forEach(
				(v) => { chai.assert(false); },
				(e) => { endResult = e; }
			);

			Promise.flush();
			expect(w1.reason()).to.equal(firstAbortError);
			expect(endResult).to.equal(null);

			s.abort(abortError);
			r1.resolve();
			let we = s.end();
			Promise.flush();
			expect(endResult).to.equal(firstAbortError);
			expect(we.value()).to.equal(undefined);
		});
	}); // abort()

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

		it("handles multiple values", () => {
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

		it("handles error in reader", () => {
			var endError = new Error("end boom");
			var endResult: Error = null; // null, to distinguish from 'undefined' that gets assigned by ender
			s.forEach((n) => {
				throw boomError;
			}, (e?: Error) => { endResult = e; });

			// Write a value, will be rejected by reader and returned from write
			var wp = s.write(1);
			Promise.flush();
			expect(endResult).to.equal(null);
			expect(wp.reason()).to.equal(boomError);

			// Then end the stream with an error, the end() itself should return
			// void promise
			var ep = s.end(endError);
			Promise.flush();
			expect(endResult).to.equal(endError);
			expect(ep.value()).to.equal(undefined);
		});

		it("handles error thrown in reader", () => {
			// Error thrown in reader should ONLY reflect back to writer, not to reader
			// Allows writer to decide to send another value, abort, end normally, etc.
			var writeError: Error;
			var endResult: Error;
			s.write(1).catch((e) => { writeError = e; });
			s.forEach((v) => { throw boomError }, (e) => { endResult = e; });
			Promise.flush();
			expect(writeError).to.equal(boomError);
			expect(endResult).to.be.undefined;

			// Try to end the stream with an error, this time it should only end up in
			// ender (basically already covered by other tests, but just to make sure
			// that internal state isn't corrupted)
			writeError = undefined;
			endResult = undefined;
			let endBoom = new Error("end boom");
			s.end(endBoom).catch((e) => { writeError = e; });
			Promise.flush();
			expect(writeError).to.be.undefined;
			expect(endResult).to.equal(endBoom);
		});

		it("can use a default ender", () => {
			s.forEach(
				(v) => { results.push(v); }
			);
			s.write(1);
			s.write(2);
			s.end();
			Promise.flush();
			expect(results).to.deep.equal([1, 2]);
		});

		it("returns errors by default", () => {
			s.forEach(
				(v) => { results.push(v); }
			);
			s.write(1);
			s.write(2);
			let we = s.end(boomError);
			Promise.flush();
			expect(results).to.deep.equal([1, 2]);
			expect(we.reason()).to.equal(boomError);
		});

		it("disallows multiple attach", () => {
			s.forEach(noop);
			expect(() => s.forEach(noop)).to.throw();
		});
	}); // forEach()

	describe("write()", () => {
		it("disallows writing undefined", () => {
			expect(() => s.write(undefined)).to.throw(TypeError, "void value");
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
			readInto(s, results);
			return s.end(boomError);
		});
		it("disallows non-error as error parameter", () => {
			readInto(s, results);
			expect(() => s.end(<any>"boom")).to.throw("invalid argument");
		});
	}); // end()

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
	}); // isEnded()

	describe("result()", () => {
		it("indicates stream end", () => {
			s.end();
			Promise.flush();
			expect(s.result().isPending()).to.equal(true);

			var d = Promise.defer();
			s.forEach(noop, (e) => d.promise);
			Promise.flush();
			expect(s.result().isPending()).to.equal(true);

			d.resolve();
			Promise.flush();
			expect(s.result().value()).to.equal(undefined);
		});

		it("can be overridden by `end()`", () => {
			let endResult = Promise.defer();
			s.end(null, endResult.promise);
			Promise.flush();
			expect(s.result().isPending()).to.equal(true);

			var d = Promise.defer();
			s.forEach(noop, (e) => d.promise);
			Promise.flush();
			expect(s.result().isPending()).to.equal(true);

			d.resolve();
			Promise.flush();
			expect(s.result().isPending()).to.equal(true);

			endResult.resolve();
			Promise.flush();
			expect(s.result().value()).to.equal(undefined);
		});
	}); // result()

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
			var mapped = s.map((n) => {
				if (n === 1) {
					throw boomError;
				} else {
					return n * 2;
				}
			});
			var writes = [s.write(1), s.write(2), s.end()];
			readInto(mapped, results);
			Promise.flush();
			expect(results).to.deep.equal([4]);
			expect(writes[0].reason()).to.equal(boomError);
			expect(writes[1].isFulfilled()).to.equal(true);
			expect(writes[2].isFulfilled()).to.equal(true);
		});

		it("bounces returned rejection", () => {
			var mapped = s.map((n) => {
				if (n === 1) {
					return Promise.reject(boomError);
				} else {
					return n * 2;
				}
			});
			var writes = [s.write(1), s.write(2), s.end()];
			readInto(mapped, results);
			Promise.flush();
			expect(results).to.deep.equal([4]);
			expect(writes[0].reason()).to.equal(boomError);
			expect(writes[1].isFulfilled()).to.equal(true);
			expect(writes[2].isFulfilled()).to.equal(true);
		});

		it("waits for source stream to end", () => {
			let d = Promise.defer();
			var slowEndingSource = s.transform<number>((readable, writable) => {
				readable.forEach(
					(v) => writable.write(v),
					(error?: Error) => {
						writable.end(error, readable.result());
						return d.promise;
					}
				);
			});
			var writes = [s.write(1), s.write(2), s.end()];

			var mapped = slowEndingSource.map((n) => n * 2);
			readInto(mapped, results);

			Promise.flush();
			expect(results).to.deep.equal([2, 4]);
			expect(writes[0].isFulfilled()).to.equal(true);
			expect(writes[1].isFulfilled()).to.equal(true);
			expect(writes[2].isFulfilled()).to.equal(false);
			expect(mapped.result().isFulfilled()).to.equal(false);

			d.resolve();
			Promise.flush();
			expect(mapped.result().isFulfilled()).to.equal(true);
		});
	}); // map()
});
