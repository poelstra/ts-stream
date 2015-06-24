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
var p = Promise.resolve();
var i = 0;
p = p.then(() => { console.log("write", i); return source.write(i++); });
p = p.then(() => { console.log("write", i); return source.write(i++); });
p = p.then(() => { console.log("write", i); return source.write(i++); });
p.then(
	() => {
		console.log("write end")
		return source.end();
	},
	(err) => {
		console.log("write failed", err);
		return source.end(err);
	}
)
.done(
	() => console.log("write end ok"),
	(err) => console.log("write end failed", err)
);

source.forEach((n) => console.log("read", n), (err) => console.log("read end", err || "ok"));
