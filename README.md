# Introduction

TS-Stream provides type-safe object streams with seamless support for
backpressure, ending, and error handling.

It can be used as an easy-to-use alternative to e.g. Node's object-mode Streams,
both in 'plain' Javascript and TypeScript.

Features:
- Type-safe (TypeScript)
- Promisified interface
- Easy to implement a stream with error handling and backpressure
- More options for error handling
- Support for stream aborting
- Support for EOF (with or without error)
- Long stack trace support for errors thrown downstream (i.e. know which
  transform threw an error, and where that value came from) through ts-promise

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

Some examples below use Promises, for which you can use any Promises/A+
compliant library, or native Promises if available.

## Simple mapping transform

Hello world example:
```ts
Stream.from([1, 2, 3, 4])
	.map((n) => n * 2)
	.forEach((n) => console.log(n));
// 2, 4, 6, 8
```

## Asynchronous operation (backpressure)

It is possible to write (or return, in case of e.g. map()) a promise for a value
instead of the value itself. This will automatically 'block' the corresponding
write.

```ts
Stream.from([1, 2, 3, 4])
	.map((n) => Promise.resolve(n * 2).delay(1000))
	.forEach((n) => console.log(n));
// 2, 4, 6, 8 (with pauses of a second)
```

See later examples for more detailed info.

## Reading all values into an array

Although you'll typically use `forEach()`, `reduce()`, etc. to process values of
a stream as they come in, getting all values in an array can come in handy:

```
Stream.from([1, 2, 3, 4])
    .toArray()
    .then((result) => console.log(result));
// [1, 2, 3, 4]
```

Naturally, if the stream ends with an error, the result of `toArray()` is
also rejected with that error.

## Handling a stream end

Pass an extra callback to `forEach()` which gets called when the stream is
ended. This callback gets an optional error, which is `undefined` if the stream
ended normally, or the error passed to `end()` otherwise.

All pending writes will be processed before the end-of-stream callback is called
(even if it is an error). To abort all pending operations, call `abort()`.

```ts
Stream.from([1, 2, 3, 4])
	.forEach(
		(n) => console.log(n),
		(err) => console.log("end", err || "ok")
	);
// 1, 2, 3, 4, end ok
```

## Writing to a stream

We've used the `from()` helper to create a stream from an array. Let's create
our own stream instead.

To illustrate the principle, writing to a stream is as simple as:
```ts
var source = new Stream<number>();
source.write(1);
source.write(2);
source.end();

source.forEach((n) => console.log(n));
// 1, 2
```

Each call to `write()` returns a promise that resolves when the value has been
processed by the next element in the stream. Similarly, `end()` returns a
promise that resolves when the end-of-stream has been processed.

## Simpler way of writing to a stream

Although `write()` and `end()` are very flexible, writing your own source can
be much simpler by using `writeEach()`:

```ts
let values = [1, 2, 3, 4];
let source = new Stream<number>();
source.writeEach(() => values.shift());

source.toArray().then(console.log); // [1, 2, 3, 4]
```

Note how `writeEach()` repeatedly calls the callback, until it returns
`undefined`. Of course, it's also possible to return a promise.

## Writing to a file

Writing to a file is as simple as:

```ts
let source = Stream.from(["abc", "def"]);
source.pipe(new FileSink("test.txt"));
```

To wait for the stream's result, use e.g.

```ts
let sink = source.pipe(new FileSink("test.txt"));
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
that error.

For example, in a mapping transform, if the map callback throws an error (or
returns a rejected promise), this error is 'reflected' back to the write that
caused that callback to be called.
This allows the writer to decide to simply write another value, end the stream,
etc.

Consider the following stream which produces the values 0, 1, 2, and a mapper
that throws an error on the second value:
```ts
var source = new Stream<number>();
source.write(0).then(() => console.log("write 0 ok"), (err) => console.log("write 0 error", err));
source.write(1).then(() => console.log("write 1 ok"), (err) => console.log("write 1 error", err));
source.write(2).then(() => console.log("write 2 ok"), (err) => console.log("write 2 error", err));
source.end().then(() => console.log("write end ok"), (err) => console.log("write end error", err));

var mapped = source.map((n) => {
	if (n === 1) {
		throw new Error("oops");
	}
	return n * 2;
});

mapped.forEach((n) => console.log("read", n), (err) => console.log("read end", err || "ok"));
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
var source = new Stream<number>();
source.write(0).then(() => console.log("write 0 ok"), (err) => console.log("write 0 error", err));
source.write(1).then(() => console.log("write 1 ok"), (err) => console.log("write 1 error", err));
source.write(2).then(() => console.log("write 2 ok"), (err) => console.log("write 2 error", err));
source.end(new Error("oops")).then(() => console.log("write end ok"), (err) => console.log("write end error", err));

var mapped = source.map((n) => {
	return n * 2;
});

mapped.forEach((n) => console.log("read", n), (err) => console.log("read end", err || "ok"));
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

# Implementing your own transforms and endpoints

Remember that many transforms can be simplified to a combination of the existing
`map()`, `filter()` and `reduce()` transforms.

Nevertheless, writing your own transforms (e.g. adapters to other types of
streams) is not much more than using `forEach()`, `writeEach()` or explicit
`write()`/`end()` calls.

See the source of `lib/Transform.ts` and `lib/node.ts` for inspiration,
including how to correctly handle the tricky combination of errors, abort, etc.

# Documentation

Every public class and method has been documented with JSDoc. Using e.g. an
editor with Typescript support, you'll get instant inline documentation.

An automatically generated online version of this documentation is still on
the TODO...

# Notes

- To wait until all elements in a stream pipeline have completely finished
  simply wait for any element's `result()` (instead of `end()`, especially in
  the middle of a pipeline).
  Note that `forEach()` also returns `result()` for your convenience.
- Only one 'reader' can be attached to a stream: an explicit 'splitter' is
  needed to stream to multiple destinations. This is considered a feature,
  as different choices can be made for when to start streaming, how to handle
  backpressure and errors.
- Reading is not done through an iterator interface, as that doesn't allow
  feedback on EOF, nor does it e.g. automatically handle errors during map.
  If such behavior is needed, it is fairly easy to convert from `forEach()` to
  an iterator.
- There is 'asymmetry' between e.g. `write()` and `forEach()` (i.e. there's no
  `read()` that reads a single value). Main reason is that there needs to be a
  single call to an end/error handler (because errors returned by it must
  somehow be handled, in this case by the corresponding `write()`/`end()` call),
  and having the read and end handlers in different calls lead to an awkward
  interface.

# Status

The package has successfully been used in production in a large (closed-source,
unfortunately) project for over a year now.

However, there's always room for improvement.
Especially details around `abort()` are not finalized (see e.g. #24).
A number of TODO's in the code need some love.
A number of methods are still marked as experimental (and basically undocumented
nor unit-tested). They need to be refined (probably by making a few examples
with them) or removed.
Also some smaller things may change, such as the 'grouping'/naming of certain
functionality (especially Stream and Transform and their `map` etc).

Feedback on what you like and dislike about the API is welcome! Just file an
issue on the Github project!

# TODO

Stuff that needs to be done before calling it 1.0, in arbitrary order (more
items will be added to this list though...):
- Stabilize API (most notably abort handling and methods marked experimental)
- More and better documentation, mostly updating the examples and including
  abort handling, error best-practices, etc.
- More unit tests, cleanup of existing ones (all 'core' functionality is already
  100% covered except filter(), aiming for 100% coverage though)
- Set of 'standard' Transforms like Merge, Split, Queue, Batch, Limit, etc.
- Wrappers for Node streams (some already done), iterators, etc.
- Verify browser support
- Add UMD version of module?
- Support transducers (if possible: need backpressure)
- Address TODO's in code
- Refine or remove experimental stuff

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

If you want to debug the Typescript code, it may be helpful to use the
sourcemaps provided during compile. Just `require("source-map-support/register");`
in your program.

# Changelog

List of most notable changes for each release. For details, just see the commits
between each version tag on GitHub.

0.9.1 (2017-01-11):
- Allow all `@types/node` versions

0.9.0 (2016-10-04):
- Split sources and build output to prevent TS2 from trying to rebuild our .ts files
- Use `@types` typings
- Update dependencies (mostly dev deps), including TypeScript 2.0.3
- Fix new lint errors

0.8.0 (2016-02-28):
- Switch to `"moduleResolution": "node"`-compatible typings
  - To use these typings, simply put that setting in your `tsconfig.json` and
    remove the (manual) reference to the ts-stream.d.ts file from your project.
- Update to latest Typescript (1.8.2)
- Update to latest ts-promise (for new typings)
- Use TSLint, fix linting errors

0.7.0 (2015-08-02):
- Add `hasReader()`, indicates whether `forEach()` is attached (#20)
- Return rejected promises instead of synchronously throwing
- Add utilities for pumping ts-streams into Node streams (part of #17)
- Add `FileSink` class for easy writing to a file
- Implement `toArray()` and `reduce()` (#19)
- Make stream's result be the error passed to `end()` by default, if any (#25)

0.6.1 (2015-07-22):
- All arguments of `Stream#map()` and `Stream#filter()` now also available on `ReadableStream` interface (#15)
- `from()` ends stream on abort (#16)
- `from()` can take a promise for an array (and array can contain promises) (#23)
- Reimplemented `writeEach()` based on current abort/error practices
- Documented `writeEach()` and `transform()`

0.6.0 (2015-06-24):
- Return `result()` from `forEach()` (#11)
- Implement `isEnding()` and `isEndingOrEnded()` (#12)
- Make `abort()` flow both ways (up- and downstream) by default (i.e. in `map()`, `filter()`)
- Move `abort()`, `aborted()`, `isEnding()`, `isEnded()`, `isEndingOrEnded()` to common interfaces
- Errors in `map()`/`filter()` end-callback wait for rest of stream to end

0.5.1 (2015-06-21):
- Add `aborter` callback to `forEach()` (#14)
- Add `aborted()` to allow abort to be passed to upstream
- Add `ended` and `aborted` callbacks to `map()` and `filter()` (#9)

0.5.0 (2015-06-20):
- Change `abort()` behavior (#6)
  - allows current read callback to finish first and doesn't call ender
  - rejects further pending and future writes
  - writer always needs to `end()` explicitly, after which ender callback is
    called with abort error
- Rename `ended()` to `result()`

0.4.1 (2015-06-15):
- Allow `null` for `end()` (#10)
- Allow `ended()` to wait for upstream stream(s) (#7)

0.4.0 (2015-06-14):
- Writing a rejected Thenable no longer ends stream, but makes that write fail
  (see #5, thanks Rogier!)
- Publish .ts files in npm (#4)
- Add .isEnded() (#3)

0.3.0 (2015-06-10):
- Introduce ReadableStream and WritableStream interfaces
- .map() etc no longer return Stream but e.g. ReadableStream

0.2.0 (2015-05-27):
- No longer allow ending stream with write(Promise.resolve()) (undefined value
  is now passed through, may change in the future)
- Documentation improvements for methods
- Simplified and improved abort() logic (see doc comment in source)
- Ensure callbacks are always called asynchronously, and without a `this`

0.1.1 (2015-05-26):
- Add ts-stream.d.ts file for consumption by other TS modules
- Readme updates

0.1.0 (2015-05-25):
- Initial version

# License

The MIT license.
Copyright (C) 2015 Martin Poelstra
