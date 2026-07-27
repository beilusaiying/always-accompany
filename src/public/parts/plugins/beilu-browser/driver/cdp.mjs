import { send, state } from './state.mjs';

class TimeoutError extends Error {}

export async function cdp(method, params = {}, sessionId = undefined) {
  const result = state.cdpOverride
    ? await state.cdpOverride(method, params, sessionId)
    : (await send({ method, params, session_id: sessionId })).result || {};
  if (!sessionId && (method === 'Network.enable' || method === 'Network.disable')) {
    state.networkDomainEnabled = method === 'Network.enable';
  }
  return result;
}

export async function evaluate(pageFunction, arg = undefined) {
  let expression;
  let sessionId;
  if (typeof pageFunction === 'function') {
    expression = `(${pageFunction.toString()})(${serializedArg(arg)})`;
  } else if (typeof pageFunction === 'string') {
    if (arg !== undefined && typeof arg !== 'string') {
      throw new TypeError('page.evaluate string form only accepts a legacy target id as its second argument');
    }
    expression = pageFunction;
    if (arg !== undefined) {
      sessionId = (await cdp('Target.attachToTarget', { targetId: arg, flatten: true })).sessionId;
    }
  } else {
    throw new TypeError(`page.evaluate expects a string or function, got ${pageFunction === null ? 'null' : typeof pageFunction}`);
  }
  if (hasReturnStatement(expression) && !expression.trim().startsWith('(')) {
    expression = `(function(){${expression}})()`;
  }
  return runtimeEvaluate(expression, sessionId, true);
}

async function runtimeEvaluate(expression, sessionId = undefined, awaitPromise = false) {
  try {
    const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId);
    return runtimeValue(response, expression);
  } catch (error) {
    if (error instanceof TimeoutError || /timed out/i.test(error?.message || '')) {
      throw new Error(`Runtime.evaluate timed out; expression: ${jsSnippet(expression)}`);
    }
    throw error;
  }
}

export function runtimeValue(response, expression) {
  const result = response.result || {};
  const details = response.exceptionDetails;
  if (details || result.subtype === 'error') {
    const desc = jsExceptionDescription(result, details);
    const loc = details?.lineNumber !== undefined && details?.columnNumber !== undefined
      ? ` at line ${details.lineNumber}, column ${details.columnNumber}` : '';
    throw new Error(`JavaScript evaluation failed${loc}: ${desc}; expression: ${jsSnippet(expression)}`);
  }
  if (Object.hasOwn(result, 'value')) return result.value;
  if (Object.hasOwn(result, 'unserializableValue')) return decodeUnserializableJsValue(result.unserializableValue);
  return null;
}

function jsExceptionDescription(result, details) {
  let desc = result.description;
  const exception = details?.exception;
  if (!desc && exception && typeof exception === 'object') {
    desc = exception.description;
    if (desc === undefined && Object.hasOwn(exception, 'value')) desc = String(exception.value);
    if (desc === undefined) desc = exception.className;
  }
  return desc || details?.text || 'JavaScript evaluation failed';
}

export function decodeUnserializableJsValue(value) {
  if (value === 'NaN') return Number.NaN;
  if (value === 'Infinity') return Number.POSITIVE_INFINITY;
  if (value === '-Infinity') return Number.NEGATIVE_INFINITY;
  if (value === '-0') return -0;
  if (value.endsWith('n')) return BigInt(value.slice(0, -1));
  return value;
}

function jsSnippet(expression, limit = 160) {
  const snippet = expression.trim().replace(/\n/g, '\\n');
  return snippet.length > limit ? `${snippet.slice(0, limit - 3)}...` : snippet;
}

export function hasReturnStatement(expression) {
  let i = 0;
  let stateName = 'code';
  let quote = '';
  while (i < expression.length) {
    const ch = expression[i];
    const next = expression[i + 1] || '';
    if (stateName === 'code') {
      if (ch === "'" || ch === '"' || ch === '`') { stateName = 'string'; quote = ch; i += 1; continue; }
      if (ch === '/' && next === '/') { stateName = 'line_comment'; i += 2; continue; }
      if (ch === '/' && next === '*') { stateName = 'block_comment'; i += 2; continue; }
      if (expression.startsWith('return', i)) {
        const before = i > 0 ? expression[i - 1] : '';
        const after = expression[i + 6] || '';
        if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) return true;
      }
      i += 1; continue;
    }
    if (stateName === 'line_comment') { if (ch === '\n') stateName = 'code'; i += 1; continue; }
    if (stateName === 'block_comment') {
      if (ch === '*' && next === '/') { stateName = 'code'; i += 2; continue; }
      i += 1; continue;
    }
    if (stateName === 'string') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) { stateName = 'code'; quote = ''; }
      i += 1;
    }
  }
  return false;
}

function serializedArg(arg) {
  return arg === undefined ? '' : JSON.stringify(arg);
}
