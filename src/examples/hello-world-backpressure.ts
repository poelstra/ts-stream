/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */
// tslint:disable:no-console

import Stream from "../lib/index";
import { delay } from "../lib/util";

Stream.from([1, 2, 3, 4])
	.map(async (n) => {
		await delay(1000);
		return n * 2;
	})
	.forEach((n) => console.log(n));

// 2, 4, 6, 8 (with pauses of a second)
