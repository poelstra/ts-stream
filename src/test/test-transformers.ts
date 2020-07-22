import * as chaiAsPromised from "chai-as-promised";
import * as chai from "chai";
chai.use(chaiAsPromised);

import { endCatcher } from "../lib/transformers";

import "./mocha-init";
import { useFakeTimers } from "sinon";
import Stream from "../lib";

describe("transformers", () => {
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

	describe("endCatcher()", () => {
		it("passes the example test from docs", () => {
			function requestBiggerTable() {
				/** Aesthetic */
			}
			let _guestsAdded = 0;
			function guestsAdded() {
				return _guestsAdded;
			}
			function addGuestToReservation() {
				_guestsAdded++;
			}

			it("part 1", () => {
				// Without endCatcher()
				const source = new Stream<string>();
				source.write("Craig");
				source.write("Jolene");
				source.write("Sam");
				source.write("Cassandra");
				source.write("Xavier");
				source.end().catch((e) => {
					if (e.message === "Too many guests!") {
						requestBiggerTable();
					} else {
						throw e;
					}
				});

				source.forEach(addGuestToReservation, () => {
					if (guestsAdded() > 4) {
						throw new Error("Too many guests!");
					}
				}); // This throws an unhandled promise rejection error, even though the source handled it!
			});

			it("Part 2", () => {
				// With endCatcher()
				const source = new Stream<string>();
				source.write("Craig");
				source.write("Jolene");
				source.write("Sam");
				source.write("Cassandra");
				source.write("Xavier");
				source.end();

				source
					.transform(
						endCatcher((e) => {
							if (e.message === "Too many guests!") {
								requestBiggerTable();
							} else {
								throw e;
							}
						})
					)
					.forEach(addGuestToReservation, () => {
						if (guestsAdded() > 4) {
							throw new Error("Too many guests!");
						}
					}); // No longer throws the error, because `handleError()` completes successfully
			});
		});
	});
});
