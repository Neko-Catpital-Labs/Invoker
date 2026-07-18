const test = require('node:test');
const assert = require('node:assert/strict');
const { greet } = require('../src/greeter.js');

test('greets a named person', () => {
  assert.equal(greet('Ada'), 'Hello, Ada!');
});

test('greets a default person', () => {
  assert.equal(greet(), 'Hello, there!');
});
