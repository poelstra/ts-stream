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
import { Stream, ReadableStream, WriteAfterEndError, Transform } from "../lib/index";
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

function identity<T>(arg: T): T {
	return arg;
}

describe("Stream", () => {
	var s: Stream<number>;
	var boomError: Error;
	var abortError: Error;
	var results: number[];
	var promises: Promise<any>[];

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
		var wp1 = s.write(Promise.reject<number>(boomError));
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
		it("asynchronously calls aborter when already reading", () => {
			let abortResult: Error = null;
			let w1 = s.write(1);
			let r1 = Promise.defer();
			s.forEach(
				(v) => r1.promise,
				undefined,
				(e) => { abortResult = e; }
			);
			Promise.flush();

			s.abort(abortError);
			expect(abortResult).to.equal(null);

			Promise.flush();
			expect(abortResult).to.equal(abortError);
		});
		it("asynchronously calls aborter when not currently reading", () => {
			let abortResult: Error = null;
			let w1 = s.write(1);
			s.forEach(
				(v) => undefined,
				undefined,
				(e) => { abortResult = e; }
			);
			Promise.flush();

			s.abort(abortError);
			expect(abortResult).to.equal(null);

			Promise.flush();
			expect(abortResult).to.equal(abortError);
		});
		it("asynchronously calls aborter when attaching late", () => {
			let w1 = s.write(1);
			Promise.flush();
			s.abort(abortError);

			Promise.flush();
			expect(w1.reason()).to.equal(abortError);

			let abortResult: Error = null;
			s.forEach(
				(v) => undefined,
				undefined,
				(e) => { abortResult = e; }
			);
			expect(abortResult).to.equal(null);

			Promise.flush();
			expect(abortResult).to.equal(abortError);
		});
		it("no longer calls aborter ender finished", () => {
			let w1 = s.write(1);
			let we = s.end();
			let abortResult: Error = null;
			s.forEach(
				(v) => undefined,
				undefined,
				(e) => { abortResult = e; }
			);

			Promise.flush();
			expect(abortResult).to.equal(null);
			expect(s.isEnded()).to.equal(true);

			s.abort(abortError);

			Promise.flush();
			expect(abortResult).to.equal(null);
			expect(s.aborted().reason()).to.equal(abortError);
		});
	}); // abort()

	describe("aborted()", () => {
		it("is rejected when abort is called", () => {
			expect(s.aborted().isPending()).to.equal(true);
			s.abort(abortError);
			expect(s.aborted().reason()).to.equal(abortError);
		});
		it("is rejected when abort is called, even after stream end", () => {
			s.end();
			s.forEach(noop);
			Promise.flush();
			expect(s.aborted().isPending()).to.equal(true);
			expect(s.isEnded()).to.equal(true);

			s.abort(abortError);
			expect(s.aborted().reason()).to.equal(abortError);
		});
	});

	describe("forEach()", () => {
		it("handles empty stream", () => {
			var endResult: Error = null; // null, to distinguish from 'undefined' that gets assigned by ender
			let res = s.forEach(pushResult, (e?: Error) => { endResult = e; });
			s.end();
			Promise.flush();
			expect(results).to.deep.equal([]);
			expect(endResult).to.equal(undefined);
			expect(res.isFulfilled()).to.equal(true);
		});

		it("handles a single value", () => {
			var endResult: Error = null; // null, to distinguish from 'undefined' that gets assigned by ender
			let res = s.forEach(pushResult, (e?: Error) => { endResult = e; });
			s.write(1);
			s.end();
			Promise.flush();
			expect(results).to.deep.equal([1]);
			expect(endResult).to.equal(undefined);
			expect(res.isFulfilled()).to.equal(true);
		});

		it("handles multiple values", () => {
			var endResult: Error = null; // null, to distinguish from 'undefined' that gets assigned by ender
			let res = s.forEach(pushResult, (e?: Error) => { endResult = e; });
			s.write(1);
			s.write(2);
			s.write(3);
			s.end();
			Promise.flush();
			expect(results).to.deep.equal([1, 2, 3]);
			expect(endResult).to.equal(undefined);
			expect(res.isFulfilled()).to.equal(true);
		});

		it("handles error in reader", () => {
			// Error thrown in reader should ONLY reflect back to writer, not to reader
			// Allows writer to decide to send another value, abort, end normally, etc.
			var endError = new Error("end boom");
			var endResult: Error = null; // null, to distinguish from 'undefined' that gets assigned by ender
			let res = s.forEach((n) => {
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
			expect(res.isFulfilled()).to.equal(true);
		});

		it("can use a default ender", () => {
			let res = s.forEach(
				(v) => { results.push(v); }
			);
			s.write(1);
			s.write(2);
			s.end();
			Promise.flush();
			expect(results).to.deep.equal([1, 2]);
			expect(res.isFulfilled()).to.equal(true);
		});

		it("returns errors by default", () => {
			let res = s.forEach(
				(v) => { results.push(v); }
			);
			s.write(1);
			s.write(2);
			let we = s.end(boomError);
			Promise.flush();
			expect(results).to.deep.equal([1, 2]);
			expect(we.reason()).to.equal(boomError);
			expect(res.reason()).to.equal(boomError);
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
		it("indicates stream end after ender has run", () => {
			expect(s.isEnded()).to.equal(false);

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

	describe("isEnding()", () => {
		it("indicates stream is ending", () => {
			expect(s.isEnding()).to.equal(false);

			s.end();
			Promise.flush();
			expect(s.isEnding()).to.equal(true);

			var d = Promise.defer();
			s.forEach(noop, (e) => d.promise);
			Promise.flush();
			expect(s.isEnding()).to.equal(true);

			d.resolve();
			Promise.flush();
			expect(s.isEnding()).to.equal(false);
		});
		it("ignores ending after end", () => {
			expect(s.isEnding()).to.equal(false);
			s.forEach(noop);
			s.end();
			Promise.flush();
			expect(s.isEnding()).to.equal(false);

			s.end().catch(noop);
			Promise.flush();
			expect(s.isEnding()).to.equal(false);
		});
	}); // isEnding()

	describe("isEndingOrEnded()", () => {
		it("indicates stream is ending or ended", () => {
			expect(s.isEndingOrEnded()).to.equal(false);

			s.end();
			Promise.flush();
			expect(s.isEndingOrEnded()).to.equal(true);

			var d = Promise.defer();
			s.forEach(noop, (e) => d.promise);
			Promise.flush();
			expect(s.isEndingOrEnded()).to.equal(true);

			d.resolve();
			Promise.flush();
			expect(s.isEndingOrEnded()).to.equal(true);
		});
	}); // isEndingOrEnded()

	describe("hasReader()", () => {
		it("indicates whether reader/ender are attached", () => {
			expect(s.hasReader()).to.equal(false);
			s.forEach(noop);
			expect(s.hasReader()).to.equal(true);
			s.end();
			Promise.flush();
			expect(s.isEnded()).to.equal(true);
			expect(s.hasReader()).to.equal(true);
		});
	});

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
					return Promise.reject<number>(boomError);
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

		it("waits for destination stream to end", () => {
			let d = Promise.defer();
			let slowEnder: Transform<number, number> = (readable, writable) => {
				readable.forEach(
					(v) => writable.write(v),
					(error?: Error) => {
						writable.end(error, readable.result());
						return d.promise;
					}
				);
			};
			let w1 = s.write(1);
			let w2 = s.write(2);
			let we = s.end();

			let mapped = s.map((n) => n * 2);
			let slowed = mapped.transform(slowEnder);
			readInto(slowed, results);

			Promise.flush();
			expect(results).to.deep.equal([2, 4]);
			expect(w1.isFulfilled()).to.equal(true);
			expect(w2.isFulfilled()).to.equal(true);
			expect(we.isFulfilled()).to.equal(false);
			expect(mapped.result().isFulfilled()).to.equal(false);
			expect(slowed.result().isFulfilled()).to.equal(false);

			d.resolve();
			Promise.flush();
			expect(mapped.result().isFulfilled()).to.equal(true);
			expect(slowed.result().isFulfilled()).to.equal(true);
		});

		it("calls ender and awaits its result", () => {
			let d = Promise.defer();
			let endResult: Error = null;
			let mapped = s.map(
				(n) => n * 2,
				(e) => { endResult = e; return d.promise; }
			);
			readInto(mapped, results);
			let w1 = s.write(1);
			let we = s.end();

			Promise.flush();
			expect(results).to.deep.equal([2]);
			expect(mapped.isEnded()).to.equal(false);
			expect(endResult).to.equal(undefined);
			expect(w1.isFulfilled()).to.equal(true);
			expect(we.isPending()).to.equal(true);

			d.resolve();
			Promise.flush();
			expect(we.isFulfilled()).to.equal(true);
			expect(mapped.isEnded()).to.equal(true);
		});

		it("returns asynchronous error in ender to writer but does end stream", () => {
			let d = Promise.defer();
			let endResult: Error = null;
			let mapped = s.map(
				(n) => n * 2,
				(e) => { endResult = e; return d.promise; }
			);
			let r = readInto(mapped, results);
			let w1 = s.write(1);
			let we = s.end();

			Promise.flush();
			expect(results).to.deep.equal([2]);
			expect(mapped.isEnded()).to.equal(false);
			expect(endResult).to.equal(undefined);
			expect(w1.isFulfilled()).to.equal(true);
			expect(we.isPending()).to.equal(true);

			d.reject(boomError);
			Promise.flush();
			expect(we.reason()).to.equal(boomError);
			expect(mapped.isEnded()).to.equal(true);
			expect(s.isEnded()).to.equal(true);
			expect(s.result().reason()).to.equal(boomError);
			expect(r.reason()).to.equal(boomError);
		});

		it("returns synchronous error in ender to writer but does end stream", () => {
			let endResult: Error = null;
			let mapped = s.map(
				(n) => n * 2,
				(e) => { endResult = e; throw boomError; }
			);
			let r = readInto(mapped, results);
			let w1 = s.write(1);
			let we = s.end();

			Promise.flush();
			expect(results).to.deep.equal([2]);
			expect(endResult).to.equal(undefined);
			expect(w1.isFulfilled()).to.equal(true);
			expect(we.reason()).to.equal(boomError);
			expect(mapped.isEnded()).to.equal(true);
			expect(s.isEnded()).to.equal(true);
			expect(s.result().reason()).to.equal(boomError);
			expect(r.reason()).to.equal(boomError);
		});

		it("returns synchronous error in ender to writer even if downstream ender fails", () => {
			let endResult: Error = null;
			let mapped = s.map(
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
			let w1 = s.write(1);
			let we = s.end();

			Promise.flush();
			expect(results).to.deep.equal([2]);
			expect(endResult).to.equal(undefined);
			expect(w1.isFulfilled()).to.equal(true);
			expect(we.reason()).to.equal(boomError);
			expect(mapped.isEnded()).to.equal(true);
			expect(s.isEnded()).to.equal(true);
			expect(s.result().reason()).to.equal(boomError);
			expect(forEachEndResult).to.equal(boomError);
		});

		it("leaves original end error intact and waits for stream to end", () => {
			let endError = new Error("endError");
			let mapEndResult: Error = null;
			let mapped = s.map(
				(n) => n * 2,
				(e) => { mapEndResult = e; throw boomError; }
			);
			let w1 = s.write(1);
			let we = s.end(endError);

			let forEachEndResult: Error = null;
			let d = Promise.defer();
			mapped.forEach(
				(n) => { results.push(n); },
				(e) => {
					forEachEndResult = e;
					return d.promise;
				}
			);

			Promise.flush();
			expect(mapEndResult).to.equal(endError);
			expect(w1.isFulfilled()).to.equal(true);

			expect(we.isPending()).to.equal(true);
			expect(mapped.isEnding()).to.equal(true);
			expect(mapped.isEnded()).to.equal(false);
			expect(s.result().isPending()).to.equal(true);

			d.resolve();
			Promise.flush();
			expect(results).to.deep.equal([2]);
			expect(we.reason()).to.equal(boomError);
			expect(mapped.isEnded()).to.equal(true);
			expect(s.isEnded()).to.equal(true);
			expect(s.result().reason()).to.equal(boomError);
			expect(forEachEndResult).to.equal(endError);
		});

		it("supports aborter", () => {
			let abortResult: Error = null;
			let mapped = s.map(
				(n) => n * 2,
				undefined,
				(e) => abortResult = e
			);
			mapped.abort(abortError);
			Promise.flush();
			expect(abortResult).to.equal(abortError);
		});

		it("aborts from source to sink", () => {
			let sink = s.map(identity).map(identity);
			s.abort(abortError);
			Promise.flush();
			expect(sink.aborted().reason()).to.equal(abortError);
		});

		it("aborts from sink to source", () => {
			let sink = s.map(identity).map(identity);
			sink.abort(abortError);
			Promise.flush();
			expect(s.aborted().reason()).to.equal(abortError);
		});
	}); // map()

	describe("writeEach()", () => {
		it("calls callback until undefined is returned", () => {
			let values = [1, 2, undefined, 3];
			let writeResult = s.writeEach(() => values.shift());
			s.forEach((v) => { results.push(v); });
			Promise.flush();
			expect(s.isEnded()).to.equal(true);
			expect(results).to.deep.equal([1, 2]);
			expect(values).to.deep.equal([3]);
			expect(writeResult.isFulfilled()).to.equal(true);
		});

		it("waits for next call until previous value is processed", () => {
			let values = [1, 2];
			let writeResult = s.writeEach(() => values.shift());
			Promise.flush();
			expect(values).to.deep.equal([2]);

			s.forEach((v) => { results.push(v); });
			Promise.flush();
			expect(results).to.deep.equal([1, 2]);
		});

		it("handles synchronous exception in writer", () => {
			let writeResult = s.writeEach(() => { throw boomError; });
			s.forEach(noop);
			Promise.flush();
			expect(s.isEnded()).to.equal(true);
			expect(writeResult.reason()).to.equal(boomError);
		});

		it("handles all values and stream end as promises", () => {
			let values = [1, 2];
			let writeResult = s.writeEach(() => Promise.resolve(values.shift()));
			s.forEach((v) => { results.push(v); });
			Promise.flush();
			expect(results).to.deep.equal([1, 2]);
			expect(writeResult.isFulfilled()).to.equal(true);
		});

		it("aborts and ends with error on write error", () => {
			let values = [1, 2, 3];
			let writeResult = s.writeEach(() => values.shift());
			let endResult: Error = null;
			let forEachResult = s.forEach(
				(v) => {
					if (v === 2) {
						return Promise.reject(boomError);
					}
				},
				(error?: Error) => { endResult = error; }
			);
			Promise.flush();
			expect(values).to.deep.equal([3]);
			expect(s.isEnded()).to.equal(true);
			expect(s.aborted().reason()).to.equal(boomError);
			expect(endResult).to.equal(boomError);
			expect(forEachResult.reason()).to.equal(boomError);
			expect(writeResult.reason()).to.equal(boomError);
		});

		it("aborts and ends with error on normal end error", () => {
			let values = [1, 2];
			let writeResult = s.writeEach(() => values.shift());
			let forEachResult = s.forEach(
				noop,
				(error?: Error) => Promise.reject(boomError)
			);
			Promise.flush();
			expect(values).to.deep.equal([]);
			expect(s.isEnded()).to.equal(true);
			expect(s.aborted().reason()).to.equal(boomError);
			expect(forEachResult.reason()).to.equal(boomError);
			expect(writeResult.reason()).to.equal(boomError);
		});

		it("ends with error on end error after abort", () => {
			let values = [1, 2];
			let writeResult = s.writeEach(() => values.shift());
			s.abort(abortError);
			let forEachResult = s.forEach(
				noop,
				(error?: Error) => Promise.reject(boomError)
			);
			Promise.flush();
			expect(values).to.deep.equal([1, 2]);
			expect(s.isEnded()).to.equal(true);
			expect(s.aborted().reason()).to.equal(abortError);
			expect(forEachResult.reason()).to.equal(boomError);
			expect(writeResult.reason()).to.equal(boomError);
		});

		it("handles abort bounce", () => {
			let values = [1, 2, 3];
			let writeResult = s.writeEach(() => values.shift());
			let forEachResult = s.forEach(
				(v) => {
					if (v === 2) {
						return Promise.reject(boomError);
					}
				}
				// Note: no end handler, so default, which 'bounces' the given
				// error
			);
			Promise.flush();
			expect(values).to.deep.equal([3]);
			expect(s.isEnded()).to.equal(true);
			expect(forEachResult.reason()).to.equal(boomError);
			expect(writeResult.reason()).to.equal(boomError);
		});

		it("ends on abort", () => {
			let values = [1, 2, 3];
			let writeResult = s.writeEach(() => values.shift());
			let endResult: Error = null;
			let d = Promise.defer();
			let forEachResult = s.forEach(
				(v) => d.promise,
				(err?) => { endResult = err; }
			);
			Promise.flush();
			expect(values).to.deep.equal([2, 3]);
			s.abort(abortError);
			d.resolve();
			Promise.flush();
			expect(values).to.deep.equal([2, 3]);
			expect(s.isEnded()).to.equal(true);
			expect(endResult).to.equal(abortError);
			expect(forEachResult.reason()).to.equal(abortError);
			expect(writeResult.reason()).to.equal(abortError);
		})
	}); // writeEach()

	describe("from()", () => {
		it("produces all values, then ends", () => {
			let s = Stream.from([1, 2]);
			s.forEach((v) => { results.push(v); });
			Promise.flush();
			expect(s.isEnded()).to.equal(true);
			expect(results).to.deep.equal([1, 2]);
		});

		it("supports promise for array", () => {
			let s = Stream.from(Promise.resolve([1, 2]));
			s.forEach((v) => { results.push(v); });
			Promise.flush();
			expect(results).to.deep.equal([1, 2]);
		});

		it("supports array of promises", () => {
			let s = Stream.from([Promise.resolve(1), Promise.resolve(2)]);
			s.forEach((v) => { results.push(v); });
			Promise.flush();
			expect(results).to.deep.equal([1, 2]);
		});

		it("supports promise for array of promises", () => {
			let s = Stream.from(Promise.resolve([Promise.resolve(1), Promise.resolve(2)]));
			s.forEach((v) => { results.push(v); });
			Promise.flush();
			expect(results).to.deep.equal([1, 2]);
		});

		it("ends on first undefined", () => {
			let s = Stream.from([1, 2, undefined, 3]);
			s.forEach((v) => { results.push(v); });
			Promise.flush();
			expect(s.isEnded()).to.equal(true);
			expect(results).to.deep.equal([1, 2]);
		});

		it("aborts on write error", () => {
			let s = Stream.from([1, 2]);
			let endResult: Error = null;
			let result = s.forEach(
				(v) => {
					if (v === 2) {
						return Promise.reject(boomError);
					}
				},
				(error?: Error) => { endResult = error; }
			);
			Promise.flush();
			expect(s.isEnded()).to.equal(true);
			expect(endResult).to.equal(boomError);
			expect(result.reason()).to.equal(boomError);
		});

		it("handles abort bounce", () => {
			let s = Stream.from([1, 2]);
			let result = s.forEach(
				(v) => {
					if (v === 2) {
						return Promise.reject(boomError);
					}
				}
				// Note: no end handler, so default, which 'bounces' the given
				// error
			);
			Promise.flush();
			expect(s.isEnded()).to.equal(true);
			expect(result.reason()).to.equal(boomError);
		});

		it("ends on abort", () => {
			let s = Stream.from([1, 2]);
			let endResult: Error = null;
			let d = Promise.defer();
			let result = s.forEach(
				(v) => d.promise,
				(err?) => { endResult = err; }
			);
			Promise.flush();
			s.abort(abortError);
			d.resolve();
			Promise.flush();
			expect(s.isEnded()).to.equal(true);
			expect(endResult).to.equal(abortError);
			expect(result.reason()).to.equal(abortError);
		});
	}); // from()
});
