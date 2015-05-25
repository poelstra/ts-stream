/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */

/// <reference path="../typings/tsd.d.ts" />

import Promise from "ts-promise";
import Stream from "../index";

// Stream.from() automatically ends the stream when all values have been written.
Stream.from([1,2,3,4])
	.forEach(
		(n) => console.log(n),
		(err) => console.log("end", err || "ok")
	);

// 1, 2, 3, 4, end ok
