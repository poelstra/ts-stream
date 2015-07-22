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

// Create a source that produces numbers 0, 1, 2, 3
var i = 0;
var source = new Stream<number>();
source.writeEach(() => {
	if (i === 4) {
		console.log("writing end");
		return; // Signal EOF, we won't be called again
	}
	console.log("writing", i);
	return i++;
}).then(
	() => console.log("writeEach() ok"),
	(err) => console.log("writeEach() error", err)
);

// Read values, delay 1 second before 'returning'
source.forEach(
	(n) => {
		console.log("read", n);
		return Promise.delay(1000);
	},
	(err) => {
		if (err) {
			console.log("forEach() error", err);
		} else {
			console.log("forEach() end received");
		}
		return Promise.delay(1000);
	}
);

/*
$ node examples/writeEach-backpressure | ts "%H:%M:%S"
13:37:51 writing 0
13:37:51 read 0
13:37:52 writing 1
13:37:52 read 1
13:37:53 writing 2
13:37:53 read 2
13:37:54 writing 3
13:37:54 read 3
13:37:55 writing end
13:37:55 forEach() end received
13:37:56 writeEach() ok
*/
