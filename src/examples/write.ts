/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */
// tslint:disable:no-console

import Stream from "../lib/index";

const source = new Stream<number>();
let p = Promise.resolve();
let i = 0;
p = p.then(() => {
	console.log("write", i);
	return source.write(i++);
});
p = p.then(() => {
	console.log("write", i);
	return source.write(i++);
});
p = p.then(() => {
	console.log("write", i);
	return source.write(i++);
});
p.then(
	() => {
		console.log("write end");
		return source.end();
	},
	(err) => {
		console.log("write failed", err);
		return source.end(err);
	}
).then(
	() => console.log("write end ok"),
	(err) => console.log("write end failed", err)
);

source.forEach(
	(n) => console.log("read", n),
	(err) => console.log("read end", err || "ok")
);
