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

Stream.from([1,2,3,4])
	.map((n) => Promise.resolve(n * 2).delay(1000))
	.forEach((n) => console.log(n));

// 2, 4, 6, 8 (with pauses of a second)
