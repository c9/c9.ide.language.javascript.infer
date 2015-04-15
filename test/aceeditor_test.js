#!/usr/bin/env node
"use strict";
"use server";
"use mocha";

require("c9/inline-mocha")(module);

describe(__filename, function() {
    setTimeout(10000);
    it("should analyze 'aceeditor.js'", require('./framework').buildTest("aceeditor.js"));
});