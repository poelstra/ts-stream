# Introduction

TS-Stream provides type-safe object streams with seamless support for
backpressure, ending, and error handling.

It can be used as a reliable and easy-to-use alternative to e.g. Node's
object-mode Streams, both in 'plain' Javascript and TypeScript.

Features:

-   Type-safe (TypeScript)
-   Promisified interface (using native Promises, use a [polyfill](https://www.npmjs.com/package/es6-promise) if necessary)
-   Easy to implement a stream with error handling and backpressure
-   More options for error handling
-   Support for stream aborting
-   Support for EOF (with or without error)
-   Clear and deterministic behavior in case of early stream end and/or errors

# Usage and examples

Examples are given in ES6 notation for brevity (e.g. `(n) => n * 2` instead of
`function (n) { return n * 2; }`), but the library works in 'normal' ES5 too.

If you see e.g. `new Stream<number>()`, that's Typescript notation to indicate
we're creating a stream of numbers. Simply use `new Stream()` in 'plain' JS
instead.

These and other examples can also be found in the `examples/` folder on GitHub.

## Installation

To use the package in your own program:

```sh
cd your-package
npm install --save ts-stream
```

Then, include the library using:

```ts
import Stream from "ts-stream"; // ES6 style
// or
var Stream = require("ts-stream").Stream; // CommonJS style
```

If you use TypeScript, use `"moduleResolution": "node"` in your `tsconfig.json`
to let it automatically pick up the typings of this package.

Some examples below use Promises, for which you can use native Promises,
or any Promises/A+ compliant library.

## Simple mapping transform

Hello world example:

```ts
const source = Stream.from([1, 2, 3, 4]);
const mapped = source.map((n) => n * 2);
await mapped.forEach((n) => console.log(n));
// 2, 4, 6, 8
```

Note that `.forEach()` returns a Promise that resolves when the stream was
successully completed (or rejected when there was an unhandled error).

## Asynchronous operation (backpressure)

It is possible to write (or return, in case of e.g. map()) a promise for a value
instead of the value itself. This will automatically 'block' the corresponding
write.

```ts
const source = Stream.from([1, 2, 3, 4]);
const mapped = source.map((n) => Promise.resolve(n * 2).delay(1000));
await mapped.forEach((n) => console.log(n));
// 2, 4, 6, 8 (with pauses of a second)
```

See later examples for more detailed info.

## Reading all values into an array

Although you'll typically use `forEach()`, `reduce()`, etc. to process values of
a stream as they come in, getting all values in an array can come in handy:

```ts
const source = Stream.from([1, 2, 3, 4]);
const result = await source.toArray();
console.log(result);
// [1, 2, 3, 4]
```

Naturally, if the stream ends with an error, the result of `toArray()` is
also rejected with that error.

## Handling a stream end

Pass an extra callback to `forEach()` which gets called when the stream is
ended. This callback gets an optional error, which is `undefined` if the stream
ended normally, or the error passed to `end()` otherwise.

All pending writes will be processed before the end-of-stream callback is called
(even if it is an error).

```ts
Stream.from([1, 2, 3, 4]).forEach(
	(n) => console.log(n),
	(err) => console.log("end", err || "ok")
);
// 1, 2, 3, 4, end ok
```

## Writing to a stream

The easiest way to write to a stream, is by using `writeEach()`, because it handles
all of the complexity of handling a stream abort and ending it as necessary.

```ts
const values = [1, 2, 3, 4];

const source = new Stream<number>();
source.writeEach(() => values.shift());

console.log(await source.toArray()); // [1, 2, 3, 4]
```

Note how `writeEach()` repeatedly calls the callback, until it returns
`undefined`. Of course, it's also possible to return a promise for a value.

`writeEach()` also accepts a callback that will be called when the stream is
ending (e.g. to close a database handle), and one for handling an abort (e.g.
to cancel a long-running database operation).

## Writing to a stream 'by hand'

Although it's _highly_ recommended to use `writeEach()` to write to a stream,
it's also possible to use the more low-level primitives `write()` and `end()`.

To illustrate the principle:

```ts
const source = new Stream<number>();
await source.write(1);
await source.write(2);
await source.end();

source.forEach((n) => console.log(n));
// 1, 2
```

Each call to `write()` returns a promise that resolves when the value has been
processed by the next element in the stream. Similarly, `end()` returns a
promise that resolves when the end-of-stream has been processed.

However, note that this source does not handle `abort()`, and will lead to an
unhandled rejection if it is aborted.

To handle an abort, you'll need to add something like the following:

```ts
const source = new Stream<number>();
let aborted: Error | undefined;
source.aborted().catch((abortErr) => {
	// Handle abort here, e.g. cancelling a long-running read from a database.
	// Note that you will ALWAYS still need to call `end()`, probably with the
	// abort error.
	aborted = abortErr;
});

for (let i = 0; i < 3; i++) {
	if (aborted) {
		break;
	}
	await source.write(i);
}
await source.end(aborted);
```

**Important:** If you are implementing a source and you get an error from
you (upstream) source, you should typically _not_ abort the stream!
Instead, it's better to just call `end(someError)`, which ensures that
downstream elements can still finish nicely if necessary.
Abort's intention is more to let objects 'outside' the stream's pipeline
cancel it.

## Writing to a file

Writing to a file is as simple as:

```ts
const source = Stream.from(["abc", "def"]);
source.pipe(new FileSink("test.txt"));
```

To wait for the stream's result, use e.g.

```ts
const sink = source.pipe(new FileSink("test.txt"));
sink.result().then(
	() => console.log("ok"),
	(err) => console.log("error", err)
);
```

## Error propagation

Errors generated in `forEach()`'s read handler are 'returned' to the corresponding
`write()` or `end()` call.

To signal an error from the write-side to the forEach-side, you can `end()` the
stream with an error, causing the end handler of `forEach()` to be called with
that error (after pending writes have completed).

**Important:** Do not use `abort(someError)` for cases like this, instead just
call `end(someError)` instead. This allows elements down the line to still finish
their work if they want to.

For example, in a mapping transform, if the map callback throws an error (or
returns a rejected promise), this error is 'reflected' back to the write that
caused that callback to be called.
This allows the writer to decide to simply write another value, or end the stream,
etc.

Consider the following stream which produces the values 0, 1, 2, and a mapper
that throws an error on the second value:

```ts
const source = new Stream<number>();
source.write(0).then(
	() => console.log("write 0 ok"),
	(err) => console.log("write 0 error", err)
);
source.write(1).then(
	() => console.log("write 1 ok"),
	(err) => console.log("write 1 error", err) // this one will trigger
);
source.write(2).then(
	() => console.log("write 2 ok"),
	(err) => console.log("write 2 error", err)
);
source.end().then(
	() => console.log("write end ok"),
	(err) => console.log("write end error", err)
);

const mapped = source.map((n) => {
	if (n === 1) {
		throw new Error("oops");
	}
	return n * 2;
});

mapped.forEach(
	(n) => console.log("read", n),
	(err) => console.log("read end", err || "ok")
);
```

Because the `map()` throws an error (it could have returned a rejected promise,
too), the second write will fail, but the stream is still allowed to continue:

```
read 0
write 0 ok
write 1 error [Error: oops]
read 4
write 2 ok
read end ok
write end ok
```

When ending a stream with an error, the error will 'flow' through e.g. `map()`:

```ts
const source = new Stream<number>();
source.write(0).then(
	() => console.log("write 0 ok"),
	(err) => console.log("write 0 error", err)
);
source.write(1).then(
	() => console.log("write 1 ok"),
	(err) => console.log("write 1 error", err)
);
source.write(2).then(
	() => console.log("write 2 ok"),
	(err) => console.log("write 2 error", err)
);
source.end(new Error("oops")).then(
	() => console.log("write end ok"),
	(err) => console.log("write end error", err)
);

const mapped = source.map((n) => n * 2);

mapped.forEach(
	(n) => console.log("read", n),
	(err) => console.log("read end", err || "ok")
);
```

```
read 0
write 0 ok
read 2
write 1 ok
read 4
write 2 ok
read end [Error: oops]
write end ok
```

## Aborting

Aborting a stream causes a 'cancel signal' to be sent in all directions
of a stream. This means it's possible to call `abort()` on any element in
a chain of streams and it will flow to both ends of the chain:

-   It signals the source-side to stop producing values. A source _must_ always
    still properly `end()` the stream, e.g. with the abort error. This ensures
    that a source has time to e.g. close a database handle before calling `end()`.
    It is an error for a source to write new values after it has been aborted.
-   It also signals the sink-side to e.g. cancel its write as soon as possible,
    which could include aborting a database transaction, destroying a socket, etc.
    Because the source always has to end the stream, the sink's end callback will
    always still be called (if it wasn't called already), the sink can still
    correctly indicate when it has completely finalized its processing (e.g.
    waiting until any pending data has been written to disk and file handle is
    closed).

A source should _not_ just call abort when it receives an error from its
underlying source. Instead, it should `end(someError)` the stream. This
allows other stream elements to properly finish what they were doing, because
some elements down the line might still want to e.g. commit the partially
processed results to a database.

# Implementing your own transforms and endpoints

Consider that many transforms can be simplified to a combination of the existing
`map()`, `filter()` and `reduce()` transforms.

Nevertheless, writing your own transforms (e.g. adapters to other types of
streams) is not much more than using `forEach()`, `writeEach()` or explicit
`write()` / `end()` calls.

Important:

-   Always `end()` a stream, **even if it is aborted**. In most cases, it makes
    sense to pass the abort reason to `end()`. Note: `writeEach()` handles this
    for you automatically.
-   When in the middle of a stream, be sure to pass the source stream's `result()`
    to the destination stream's `end()`'s second parameter, to ensure its result
    correctly waits for the source stream's result.

Example of a 'times two' transformation from `source` to `dest`:

```ts
const source = new Stream();
const dest = new Stream();

// 1. Ensure aborts bubble from upstream to downstream
dest.aborted().catch((err) => source.abort(err));

source.forEach(
	// 2. Read all values from source stream, apply transformation
	(v) => dest.write(v * 2),

	// 3. Always end destination stream, even when there was an
	// error. Also, pass final result of upstream (i.e.
	// `source.result()`) to downstream.
	(error?: Error) => dest.end(error, source.result()),

	(abortReason: Error): void => {
		// 4. Ensure aborts bubble from downstream to upstream
		dest.abort(abortReason);

		// 5. Optionally cancel any pending operation.
		// Note: this can be called even long after the stream
		// has ended, and must never throw an error.
	}
);
```

If you want to implement a custom transformation (e.g. generic map), that
receives arbitrary callbacks from a user which may also fail: see the source
of `lib/Transform.ts` and `lib/node.ts` for inspiration, including how to
correctly handle the combination of these errors, aborts, etc.

# Documentation

Every public class and method has been documented with JSDoc. Using e.g. an
editor with Typescript support, you'll get instant inline documentation.

An automatically generated online version of this documentation is still on
the TODO...

# Notes, tips & tricks

-   Remember to always `end()` a stream, even when it is `abort()`'ed. You
    probably want to end it with the error you got from `aborted().catch(...)`.
-   To wait until all elements in a stream pipeline have completely finished
    simply wait for any element's `result()` (instead of `end()`, especially in
    the middle of a pipeline). This ensures that both the source and sink side
    have had the time to e.g. close resources.
    Note that `writeEach()` and `forEach()` also return `result()` for your
    convenience.
-   Only one 'reader' can be attached to a stream: an explicit 'splitter' is
    needed to stream to multiple destinations. This is considered a feature,
    as different choices can be made for when to start streaming, how to handle
    backpressure, write errors, end errors, and aborts.
-   Reading is not done through an iterator interface, as that doesn't allow
    feedback on EOF, nor does it e.g. automatically handle errors during map.
    If such behavior is needed, it is fairly easy to convert from `forEach()` to
    an iterator yourself, with the behaviour you want.
-   Similarly, there is no `read()` that reads a single value. Main reason is
    that there needs to be a single call to an end/error handler (because errors
    returned by it must somehow be handled, in this case by the corresponding
    `write()` / `end()` call), and having the read and end handlers in different
    calls leads to an awkward interface.

# Status

The package has been battle-tested in production in a large (closed-source,
unfortunately) project for many years now. Although it does not receive updates
very regularly anymore, that's not because it's deserted, it's just considered
pretty stable.

However, there's always room for improvement, see open issues for ideas.
A small number of minor TODO's in the code may need some love.
A number of methods are still marked as experimental (and basically undocumented
nor unit-tested). They should be considered obsolete, and will probably be
removed in a future version.

# TODO

-   Set of 'standard' Transforms like Merge, Split, Queue, Batch, Limit, etc.
-   Wrappers for Node streams (some already done), iterators, etc.
-   Support transducers (if possible: need backpressure)
-   Address TODO's in code
-   Remove methods marked as experimental

# Contributing

Want to fiddle with the sources?

```sh
git clone https://github.com/poelstra/ts-stream
cd ts-stream
npm install
```

This will automatically install all (development-)dependencies, compile and run
unit tests.

Run `npm test` to recompile and run the tests again.
If you don't have Prettier enabled in your IDE, you'll need to run `npm format`
before the linting will pass.

If you want to debug the Typescript code, it may be helpful to use the
sourcemaps provided during compile. Just `import "source-map-support/register";`
in your program.

# Changelog

List of most notable changes for each release. For details, just see the commits
between each version tag on GitHub.

2.0.2 (2020-07-12):

-   Improve `abort()` documentation (#47, #48, thanks @MattiasMartens)
-   Update devDependencies to fix security warnings

2.0.1 (2019-07-21):

-   Update devDependencies to fix security warnings
-   Move remap-istanbul to devDependencies

2.0.0 (2018-10-29):

-   No longer make `.forEach()` and friends bounce end error back by default (#35, thanks @martinheidegger)
    -   Note: it's still returned from `.result()`, and thus the result of `.forEach()` itself
-   `.writeEach()` now supports `ender` and `aborter` callbacks, similar to `.forEach()`
-   Allow calling `.abort()` without explicit abort reason
-   Add idiomatic example sources/sinks/transformations in `test-idiomatic.ts`
-   Increased test coverage
-   Update TypeScript to 3.1.3, compile in strict mode

1.0.1 (2017-12-06):

-   Fix unhandled rejection error when error bounces back from ender in certain cases (#31, thanks @rogierschouten)
    -   Also fixes downstream streams not waiting for upstream streams in case downstream ender was rejected
-   Update to TypeScript 2.6.2

1.0.0 (2017-10-18):

-   Switch to native promises (#30, thanks @rogierschouten!)

    -   Use e.g. `import { polyfill } from "ts-promise"; polyfill();` to support an environment that doesn't have a native Promise implementation yet.

0.9.1 (2017-01-11):

-   Allow all `@types/node` versions

0.9.0 (2016-10-04):

-   Split sources and build output to prevent TS2 from trying to rebuild our .ts files
-   Use `@types` typings
-   Update dependencies (mostly dev deps), including TypeScript 2.0.3
-   Fix new lint errors

0.8.0 (2016-02-28):

-   Switch to `"moduleResolution": "node"`-compatible typings
    -   To use these typings, simply put that setting in your `tsconfig.json` and
        remove the (manual) reference to the ts-stream.d.ts file from your project.
-   Update to latest Typescript (1.8.2)
-   Update to latest ts-promise (for new typings)
-   Use TSLint, fix linting errors

0.7.0 (2015-08-02):

-   Add `hasReader()`, indicates whether `forEach()` is attached (#20)
-   Return rejected promises instead of synchronously throwing
-   Add utilities for pumping ts-streams into Node streams (part of #17)
-   Add `FileSink` class for easy writing to a file
-   Implement `toArray()` and `reduce()` (#19)
-   Make stream's result be the error passed to `end()` by default, if any (#25)

0.6.1 (2015-07-22):

-   All arguments of `Stream#map()` and `Stream#filter()` now also available on `ReadableStream` interface (#15)
-   `from()` ends stream on abort (#16)
-   `from()` can take a promise for an array (and array can contain promises) (#23)
-   Reimplemented `writeEach()` based on current abort/error practices
-   Documented `writeEach()` and `transform()`

0.6.0 (2015-06-24):

-   Return `result()` from `forEach()` (#11)
-   Implement `isEnding()` and `isEndingOrEnded()` (#12)
-   Make `abort()` flow both ways (up- and downstream) by default (i.e. in `map()`, `filter()`)
-   Move `abort()`, `aborted()`, `isEnding()`, `isEnded()`, `isEndingOrEnded()` to common interfaces
-   Errors in `map()`/`filter()` end-callback wait for rest of stream to end

0.5.1 (2015-06-21):

-   Add `aborter` callback to `forEach()` (#14)
-   Add `aborted()` to allow abort to be passed to upstream
-   Add `ended` and `aborted` callbacks to `map()` and `filter()` (#9)

0.5.0 (2015-06-20):

-   Change `abort()` behavior (#6)
    -   allows current read callback to finish first and doesn't call ender
    -   rejects further pending and future writes
    -   writer always needs to `end()` explicitly, after which ender callback is
        called with abort error
-   Rename `ended()` to `result()`

0.4.1 (2015-06-15):

-   Allow `null` for `end()` (#10)
-   Allow `ended()` to wait for upstream stream(s) (#7)

0.4.0 (2015-06-14):

-   Writing a rejected Thenable no longer ends stream, but makes that write fail
    (see #5, thanks Rogier!)
-   Publish .ts files in npm (#4)
-   Add .isEnded() (#3)

0.3.0 (2015-06-10):

-   Introduce ReadableStream and WritableStream interfaces
-   .map() etc no longer return Stream but e.g. ReadableStream

0.2.0 (2015-05-27):

-   No longer allow ending stream with write(Promise.resolve()) (undefined value
    is now passed through, may change in the future)
-   Documentation improvements for methods
-   Simplified and improved abort() logic (see doc comment in source)
-   Ensure callbacks are always called asynchronously, and without a `this`

0.1.1 (2015-05-26):

-   Add ts-stream.d.ts file for consumption by other TS modules
-   Readme updates

0.1.0 (2015-05-25):

-   Initial version

# License

The MIT license.
Copyright (C) 2015 Martin Poelstra
