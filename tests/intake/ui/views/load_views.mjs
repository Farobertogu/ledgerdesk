import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import * as React from 'react';

const require = createRequire(import.meta.url);
export const sourceRoot = fileURLToPath(new URL('../../../../src/components/intake/views/', import.meta.url));

/** Compile only presentation modules in memory; never write build output or load a service. */
export function loadViews({react = React, replaceSource = (_name, source) => source} = {}) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    if (!filename.startsWith(sourceRoot)) throw new Error(`Unexpected presentation dependency: ${filename}`);
    const source = replaceSource(path.basename(filename), readFileSync(filename, 'utf8'));
    const module = {exports: {}};
    cache.set(filename, module);
    const output = ts.transpileModule(source, {fileName: filename, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    }}).outputText;
    const localRequire = name => {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return require(name);
      if (name.endsWith('.module.css')) return {default: new Proxy({}, {get: (_target, key) => String(key)})};
      if (!name.startsWith('.')) throw new Error(`Unexpected runtime import: ${name}`);
      const base = path.resolve(path.dirname(filename), name);
      for (const extension of ['.ts', '.tsx']) {
        try { return load(base + extension); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      throw new Error(`Missing presentation import: ${name}`);
    };
    new Function('require', 'module', 'exports', output)(localRequire, module, module.exports);
    return module.exports;
  }
  return {views: load(path.join(sourceRoot, 'index.ts')), load: name => load(path.join(sourceRoot, name))};
}

/** Inspect event-to-callback wiring. This does not emulate effects, focus or a browser. */
export function eventView(name, initialProps, options = {}) {
  const state = [];
  let cursor = 0, id = 0, props = initialProps;
  const react = {...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    },
    useRef: initial => ({current: initial}), useEffect: () => {}, useId: () => `event-check-${id++}`, useContext: () => null,
  };
  const {views} = loadViews({...options, react});
  function nodes(value, result = []) {
    if (Array.isArray(value)) value.forEach(child => nodes(child, result));
    else if (React.isValidElement(value)) {
      if (typeof value.type === 'function') nodes(value.type(value.props), result);
      else { result.push(value); nodes(value.props.children, result); }
    }
    return result;
  }
  return {render(nextProps = props) { props = nextProps; cursor = 0; id = 0; return nodes(views[name](props)); }};
}

export function textOf(value) {
  if (value == null || typeof value === 'boolean') return '';
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (React.isValidElement(value)) return textOf(value.props.children);
  return String(value);
}
