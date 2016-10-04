/**
 * Promise-based object stream with seamless support for back-pressure and error
 * handling, written in Typescript.
 *
 * Copyright (C) 2015 Martin Poelstra
 * License: MIT
 */

"use strict";

export * from "./Stream";
export * from "./Transform";
export * from "./transformers";
export * from "./node";
export { Stream as default } from "./Stream";
