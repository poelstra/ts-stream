/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */

/// <reference path="../typings/tsd.d.ts" />

import Promise from "ts-promise";
import Stream from "../lib/index";

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

/*
read 0
write 0 ok
write 1 error [Error: oops]
read 4
write 2 ok
read end ok
write end ok
*/
