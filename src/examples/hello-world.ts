/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */
// tslint:disable:no-console

import Stream from "../lib/index";

Stream.from([1, 2, 3, 4])
	.map((n) => n * 2)
	.toArray()
	.then((values) => console.log(values));

// [2, 4, 6, 8]
