import { n as naturalJoin } from './utils/natural-join.js';

function allowedIfAttributeIsPresent(...attr) {
  return (node) => {
    if (attr.some((it) => node.hasAttribute(it))) {
      return null;
    }
    const expected = naturalJoin(attr.map((it) => `"${it}"`));
    return `requires ${expected} attribute to be present`;
  };
}
function allowedIfAttributeIsAbsent(...attr) {
  return (node) => {
    const present = attr.filter((it) => node.hasAttribute(it));
    if (present.length === 0) {
      return null;
    }
    const expected = naturalJoin(present.map((it) => `"${it}"`));
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
    const expected = naturalJoin(expectedValue.map((it) => `"${it}"`));
    return `"${key}" attribute must be ${expected}`;
  };
}
function allowedIfParentIsPresent(...tags) {
  return (node) => {
    const match = tags.some((it) => node.closest(it));
    if (match) {
      return null;
    }
    const expected = naturalJoin(tags.map((it) => `<${it}>`));
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

export { defineMetadata as d, metadataHelper as m };
//# sourceMappingURL=meta-helper.js.map
