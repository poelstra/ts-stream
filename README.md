# Introduction

TS-Stream provides type-safe object streams with seamless support for
backpressure, ending, and error handling.

It can be used as an easy-to-use alternative to e.g. Node's object-mode Streams,
both in 'plain' Javascript and TypeScript.

Features:
- Easy support for backpressure: simply return a promise for asynchronous
  operations
- Support for ending a stream (e.g. to flush to file)
- Stream end can optionally signal an error (pending writes will always be
  resolved before passing on the EOF or error)
- Support for abnormal, immediate stream termination (both reader and writer are
  aborted)
- Simple signalling of errors by reading side, by returning a (rejected) promise
  or throwing an error
- Simple handling of errors by writer: `write()` or `end()` will return a
  rejected promise
- Writing a source, sink or transform is easy, even with correct EOF and
  backpressure handling
- Long stack trace support for errors thrown downstream (i.e. know which
  transform threw an error, and where that value came from)

Notes:
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

# Usage and examples

Examples are given in ES6 notation for brevity (e.g. `(n) => n * 2` instead of
`function (n) { return n * 2; }`), but the library works in 'normal' ES5 too.

If you see e.g. `new Stream<number>()`, that's Typescript notation to indicate
we're creating a stream of numbers. Simply use `new Stream()` in 'plain' JS
instead.

These examples can also be found in the `examples/` folder on GitHub.

## Simple mapping transform

Hello world example:
```ts
Stream.from([1,2,3,4])
	.map((n) => n * 2)
	.forEach((n) => console.log(n));
// 2, 4, 6, 8
```

## Asynchronous operation (backpressure)

It is possible to write (or return, in case of e.g. map()) a promise for a value
instead of the value itself. This will automatically 'block' the corresponding
write.

```ts
Stream.from([1,2,3,4])
	.map((n) => Promise.resolve(n * 2).delay(1000))
	.forEach((n) => console.log(n));
// 2, 4, 6, 8 (with pauses of a second)
```

See later examples for more detailed info.

## Handling a stream end

Pass an extra callback to `forEach()` which gets called when the stream is
ended. This callback gets an optional error, which is `undefined` if the stream
ended normally, or the error passed to `end()` otherwise.

All pending writes will be processed before the end-of-stream callback is called
(even if it is an error). To abort all pending operations, call `abort()`.

```ts
Stream.from([1,2,3,4])
	.forEach(
		(n) => console.log(n),
		(err) => console.log("end", err || "ok")
	);
// 1, 2, 3, 4, end ok
```

## Writing to a stream

We've used the `from()` helper to create a stream from an array. Let's create
our own stream instead:

```ts
var source = new Stream<number>();
var p = Promise.resolve();
var i = 0;
p = p.then(() => { console.log("write", i); return source.write(i++); });
p = p.then(() => { console.log("write", i); return source.write(i++); });
p = p.then(() => { console.log("write", i); return source.write(i++); });
p = p.then(() => { console.log("write end"); return source.end(); });
p.done(() => console.log("write done"), (err) => console.log("write failed", err));

source.forEach((n) => console.log("read", n), (err) => console.log("read end", err || "ok"));
```

Output:
```
write 0
read 0
write 1
read 1
write 2
read 2
write end
read end ok
write done
```

Note how each write waits before the read is finished. This also works when the
read is asynchronous (try it yourself: return `Promise.delay(1000)` in the
forEach callbacks and see how the writes are delayed too).

## Error propagation

Errors generated in `forEach()`'s read handler are 'returned' to the corresponding
`write()` or `end()` call.
Errors from the write-side (i.e. passing an error to `end()` or writing a
rejected promise) causes the stream to end, and the end handler of `forEach()`
to be called with that error.

For example, in a mapping transform, if the map callback throws an error, this
error is 'reflected' back to the write that caused that callback to be called.
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

Conversely, an error produced on the sending side is received by the reader,
but it can decide to 'swallow' that error and thus let the `end()` call itself
succeed.

In the following example, note how `map()` simply passes the error on to its
destination:

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

# Status

The API is not stable yet, but the examples should give a good feel for what it
will look like. Experiments are being performed to model certain real-world
scenarios, fine-tuning the API as we go.

Some things are likely to change, such as the 'grouping'/naming of certain
functionality (especially Stream and Transform and their `map` etc).
Things like forEach() might return the Stream or result of `ended()` for more
easy chaining, etc.
Then, there's some tricky corner cases with regards to handling of errors in the
face of e.g. `abort()`. Various TODO's are sprinkled through the code with ideas
to handle such cases.

Feedback on what you like and dislike about the API is welcome! Just file an
issue on the Github project!

# TODO

Stuff that needs to be done before calling it 1.0, in arbitrary order (more
items will be added to this list though...):
- More and better documentation
- More unit tests, cleanup of existing ones (aiming for 100% coverage)
- Set of 'standard' Transforms like Merge, Split, Queue, Batch, Limit, etc.
- Wrappers for Node streams, iterators, etc.
- Verify browser support
- Add UMD version of module?
- Support transducers (if possible: need backpressure)
- Address TODO's in code

# Changelog

0.1.0:
- Initial version

# License

The MIT license.
Copyright (C) 2015 Martin Poelstra
