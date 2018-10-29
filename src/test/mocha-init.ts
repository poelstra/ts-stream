
// Mocha swallows unhandled rejections by default, making all your tests pass on unhandled rejections.
// For synchronous tests, unhandled rejections are only detected after the test finishes.
// Therefore we cannot make the specific test that caused the unhandled rejection fail. What we can
// do, is ensure that the exit code is non-zero.

let unhandledRejectionCount = 0;

process.on("unhandledRejection", (reason: Error): void => {
	// tslint:disable-next-line:no-console
	console.log("unhandled rejection:", reason);
	unhandledRejectionCount++;
	// attempt to turn into unhandled exception (instead of unhandled rejection) so that for sinon tests,
	// the correct test fails
	throw reason;
});

process.prependListener("exit", (code: number): void => {
	if (code === 0 && unhandledRejectionCount !== 0) {
		process.exit(1);
	}
});
