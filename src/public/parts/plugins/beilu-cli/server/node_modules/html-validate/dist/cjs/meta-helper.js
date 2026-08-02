'use strict';

var utils_naturalJoin = require('./utils/natural-join.js');

function allowedIfAttributeIsPresent(...attr) {
  return (node) => {
    if (attr.some((it) => node.hasAttribute(it))) {
      return null;
    }
    const expected = utils_naturalJoin.naturalJoin(attr.map((it) => `"${it}"`));
    return `requires ${expected} attribute to be present`;
  };
}
function allowedIfAttributeIsAbsent(...attr) {
  return (node) => {
    const present = attr.filter((it) => node.hasAttribute(it));
    if (present.length === 0) {
      return null;
    }
    const expected = utils_naturalJoin.naturalJoin(present.map((it) => `"${it}"`));
    return `cannot be used at the same time as ${expected}`;
  };
}
function allowedIfAttributeHasValue(key, expectedValue, { defaultValue } = {}) {
  return (node) => {
    const attr = node.getAttribute(key);
    if (attr && typeof attr !== "string") {
      return null;
    }
    const actualValue = attr ?? defaultValue;
    if (actualValue && expectedValue.includes(actualValue.toLocaleLowerCase())) {
      return null;
    }
    const expected = utils_naturalJoin.naturalJoin(expectedValue.map((it) => `"${it}"`));
    return `"${key}" attribute must be ${expected}`;
  };
}
function allowedIfParentIsPresent(...tags) {
  return (node) => {
    const match = tags.some((it) => node.closest(it));
    if (match) {
      return null;
    }
    const expected = utils_naturalJoin.naturalJoin(tags.map((it) => `<${it}>`));
    return `requires ${expected} as parent`;
  };
}
function hasKeyword(attr, keyword) {
  return attr.toLowerCase().split(/\s+/).includes(keyword);
}
const metadataHelper = {
  allowedIfAttributeIsPresent,
  allowedIfAttributeIsAbsent,
  allowedIfAttributeHasValue,
  allowedIfParentIsPresent,
  hasKeyword
};

function defineMetadata(metatable) {
  return metatable;
}

exports.defineMetadata = defineMetadata;
exports.metadataHelper = metadataHelper;
//# sourceMappingURL=meta-helper.js.map
