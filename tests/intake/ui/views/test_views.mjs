import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadViews, eventView, sourceRoot, textOf} from './load_views.mjs';
import * as f from './fixtures.mjs';

const {views, load} = loadViews();
const render = (name, props) => renderToStaticMarkup(React.createElement(views[name], props));
const button = (nodes, label) => nodes.find(node => node.type === 'button' && textOf(node) === label);
const field = (nodes, label) => {
  const labelNode = nodes.find(node => node.type === 'label' && textOf(node) === label);
  assert.ok(labelNode, `Missing label: ${label}`);
  return nodes.find(node => node.props.id === labelNode.props.htmlFor);
};

test('the five exports render supplied snapshots without firing an effect callback', () => {
  assert.deepEqual(Object.keys(views).sort(), ['ConfirmationView', 'InspectorView', 'IntakeView', 'PreparationEditorView', 'WorkspaceView']);
  for (const [name, props] of [['WorkspaceView', f.workspaceProps], ['IntakeView', f.intakeProps], ['PreparationEditorView', f.editorProps],
    ['InspectorView', f.inspectorProps], ['ConfirmationView', f.confirmationProps]]) {
    const closed = Object.fromEntries(Object.entries(props).map(([key, value]) => [key, key.startsWith('on') ? () => assert.fail(key) : value]));
    assert.ok(render(name, closed).length > 0);
  }
});

test('equal filenames retain distinct supplied keys; removal does not reassign an action', () => {
  const second = {...f.item, key: 'local-B', phase: 'failed', actions: ['reconcile']};
  const calls = [];
  const props = {...f.intakeProps, items: [{...f.item, actions: ['receive']}, second], onAction: (...args) => calls.push(args)};
  const view = eventView('IntakeView', props);
  let nodes = view.render();
  assert.deepEqual(nodes.filter(node => node.props['data-item-key']).map(node => [node.key, node.props['data-item-key']]),
    [['local-A', 'local-A'], ['local-B', 'local-B']]);
  button(nodes, 'Check recorded outcome').props.onClick();
  nodes = view.render({...props, items: [second]});
  button(nodes, 'Check recorded outcome').props.onClick();
  assert.deepEqual(calls, [['local-B', 'reconcile'], ['local-B', 'reconcile']]);
  assert.equal(button(nodes, 'Receive'), undefined);
});

test('local filtering keeps only supplied identities and never resurrects a removed selection', () => {
  const {workspaceRows} = load('presentation.ts');
  const second = {...f.item, key: 'B', name: 'other.txt'};
  assert.deepEqual(workspaceRows([f.item, second], 'other', f.item.key), {rows: [second], selected: f.item, outsideFilter: true});
  assert.deepEqual(workspaceRows([second], 'other', f.item.key), {rows: [second], selected: null, outsideFilter: false});
  let calls = 0;
  const hidden = render('WorkspaceView', {...f.workspaceProps, selectedKey: 'removed', body: () => { calls++; return 'PROTECTED REMOVED'; }});
  assert.equal(calls, 0); assert.doesNotMatch(hidden, /PROTECTED REMOVED/);
  for (const phase of ['checking_session', 'unavailable']) {
    const html = render('WorkspaceView', {...f.workspaceProps, phase, body: () => { calls++; return 'PROTECTED REMOVED'; }});
    assert.equal(calls, 0); assert.doesNotMatch(html, /PROTECTED REMOVED|política/);
  }
});

test('intake renders exactly the offered actions and preserves stop while busy', () => {
  const actions = ['receive', 'refresh', 'reconcile', 'stop', 'discard', 'inspect_original', 'prepare', 'inspect_preparation', 'review_proposal'];
  const {ACTION} = load('copy.ts');
  for (const action of actions) {
    const nodes = eventView('IntakeView', {...f.intakeProps, busy: true, items: [{...f.item, actions: [action]}]}).render();
    for (const other of actions) assert.equal(Boolean(button(nodes, ACTION.en[other])), other === action);
    assert.equal(button(nodes, ACTION.en[action]).props.disabled, action !== 'stop');
  }
});

test('file selection forwards the original objects and resets the input for same-file reselection', () => {
  const files = [new File(['001'], 'same.csv'), new File(['0'], 'same.csv')];
  const calls = [];
  const nodes = eventView('IntakeView', {...f.intakeProps, onFiles: value => calls.push(value)}).render();
  const input = nodes.find(node => node.type === 'input' && node.props.type === 'file');
  const target = {files, value: 'selected'};
  input.props.onChange({currentTarget: target});
  assert.equal(target.value, ''); assert.equal(calls[0][0], files[0]); assert.equal(calls[0][1], files[1]);
  const unavailable = eventView('IntakeView', {...f.intakeProps, intakeOffered: false, onFiles: () => assert.fail('hidden offer')}).render();
  assert.equal(button(unavailable, 'Choose files'), undefined);
  unavailable.find(node => node.props.onDrop).props.onDrop({preventDefault() {}, dataTransfer: {files}});
});

test('switching text/file tabs and language preserves supplied text and file rows without capture', () => {
  const edits = [];
  const props = {...f.intakeProps, onTextDraft: value => edits.push(value), onCaptureText: () => assert.fail('implicit capture')};
  const view = eventView('IntakeView', props);
  let nodes = view.render();
  button(nodes, 'Text').props.onClick(); nodes = view.render();
  assert.equal(field(nodes, 'Text to receive').props.value, f.original);
  field(nodes, 'Text to receive').props.onChange({target: {value: '  new\r\n e\u0301  '}});
  assert.deepEqual(edits, [{name: ' note.txt ', text: '  new\r\n e\u0301  '}]);
  button(nodes, 'Files').props.onClick(); nodes = view.render({...props, textDraft: edits[0]});
  assert.equal(nodes.filter(node => node.props['data-item-key']).length, 1);
  button(nodes, 'Text').props.onClick(); nodes = view.render({...props, textDraft: edits[0], preferences: {...f.preferences, language: 'es'}});
  assert.equal(field(nodes, 'Texto que se recibirá').props.value, edits[0].text);
  assert.equal(field(nodes, 'Nombre del archivo').props.value, ' note.txt ');
});

test('preparation editing sends exact values; language change does not initialize or classify the draft', () => {
  const edits = [];
  const props = {...f.editorProps, onEdit: edit => edits.push(edit)};
  const view = eventView('PreparationEditorView', props);
  let nodes = view.render();
  field(nodes, 'Text correction').props.onChange({target: {value: ' \tnew e\u0301\r\n  '}});
  assert.deepEqual(edits, [{kind: 'correction', elementId: 'element-A', text: ' \tnew e\u0301\r\n  '}]);
  nodes = view.render({...props, preferences: {...f.preferences, language: 'es'}});
  assert.equal(field(nodes, 'Corrección de texto').props.value, f.draft.corrections['element-A']);
  assert.equal(field(nodes, 'Función').props.value, '');
  assert.equal(field(nodes, 'Fundamento').props.value, '');
  assert.equal(field(nodes, 'Ámbito de uso').props.value, '');
  assert.equal(edits.length, 1);
});

test('an unresolved classification needs its reason and local discard requires its own offer', () => {
  let nodes = eventView('PreparationEditorView', f.editorProps).render();
  assert.equal(button(nodes, 'Save preparation').props.disabled, false);
  assert.equal(button(nodes, 'Discard local draft'), undefined);
  const missing = {...f.draft, classification: {...f.draft.classification, basis: {value: null, reason: ''}}};
  nodes = eventView('PreparationEditorView', {...f.editorProps, draft: missing, item: {...f.item, actions: ['discard']}}).render();
  assert.equal(button(nodes, 'Save preparation').props.disabled, true);
  assert.ok(button(nodes, 'Discard local draft'));
  nodes = eventView('PreparationEditorView', {...f.editorProps, draft: {...missing,
    classification: {...missing.classification, basis: {value: null, reason: ' \t\n '}}}}).render();
  assert.equal(button(nodes, 'Save preparation').props.disabled, true);
  nodes = eventView('PreparationEditorView', {...f.editorProps, saveOffered: false}).render();
  assert.equal(button(nodes, 'Save preparation'), undefined);
});

test('correction, condition and dependency actions keep owner-supplied identities and never allocate replacements', () => {
  const calls = [], props = {...f.editorProps, onEdit: value => calls.push(value)};
  const nodes = eventView('PreparationEditorView', props).render();
  button(nodes, 'Remove correction').props.onClick();
  button(nodes, 'Add condition').props.onClick(); button(nodes, 'Add dependency').props.onClick();
  field(nodes, 'Condition text').props.onChange({target: {value: '  if x  '}});
  field(nodes, 'From').props.onChange({target: {value: ' A '}});
  assert.deepEqual(calls, [{kind: 'correction', elementId: 'element-A', text: null}, {kind: 'add_condition'}, {kind: 'add_dependency'},
    {kind: 'condition', value: {...f.draft.conditions[0], text: '  if x  '}}, {kind: 'dependency', value: {...f.draft.dependencies[0], from: ' A '}}]);
  const hidden = eventView('PreparationEditorView', {...props, elements: [{...props.elements[0], correctionOffered: false}]}).render();
  assert.equal(button(hidden, 'Remove correction'), undefined);
});

test('exact text and positional table lexical values remain inert in both languages', () => {
  for (const language of ['en', 'es']) {
    const props = {...f.inspectorProps, preferences: {...f.preferences, language}};
    const html = render('InspectorView', props);
    assert.doesNotMatch(html, /<(?:img|script|iframe)\b|<[^>]+\s(?:href|src)=/);
    assert.match(html, /&lt;img src=&quot;https:\/\/invalid.example\/leak&quot;&gt;/);
    const nodes = eventView('InspectorView', props).render();
    assert.equal(nodes.find(node => node.props['data-testid'] === 'intake-exact-text').props.children, f.original);
    assert.deepEqual(nodes.filter(node => node.type === 'th').map(node => [node.key, textOf(node)]), [['0', 'same'], ['1', 'same'], ['2', '']]);
    assert.deepEqual(nodes.filter(node => node.props['data-testid'] === 'intake-cell').map(textOf), f.blocks[1].rows.flat());
  }
});

test('resource and original downloads require the actual offer, not a callback', () => {
  const calls = [];
  const props = {...f.inspectorProps, onDownloadOriginal: () => calls.push('original'), onDownloadResource: value => calls.push(value)};
  const view = eventView('InspectorView', props);
  let nodes = view.render();
  assert.equal(button(nodes, 'Download original'), undefined); assert.equal(button(nodes, 'Download resource'), undefined);
  nodes = view.render({...props, originalDownloadOffered: true, blocks: [{...f.blocks[2], downloadOffered: true}]});
  button(nodes, 'Download original').props.onClick(); button(nodes, 'Download resource').props.onClick();
  assert.equal(calls[1], f.artifact); assert.equal(calls[0], 'original');
  const confirm = eventView('ConfirmationView', {...f.confirmationProps, blocks: [{...f.blocks[2], downloadOffered: true}]}).render();
  assert.equal(button(confirm, 'Download resource'), undefined);
});

test('component facts preserve unknown, unattempted and unchecked instead of a success percentage', () => {
  const html = render('InspectorView', f.inspectorProps);
  assert.match(html, /Not attempted/); assert.match(html, /Unknown/); assert.match(html, /Unchecked/);
  assert.doesNotMatch(html, /100%/); assert.match(html, /inventory incomplete/);
});

test('proposal form is absent without its offer; exact target fields are not replaced with latest', () => {
  const calls = [];
  const view = eventView('InspectorView', {...f.inspectorProps, onProposalDraft: value => calls.push(value)});
  assert.equal(button(view.render(), 'Prepare exact proposal'), undefined);
  const proposal = {draft: {target: {kind: 'successor', unitId: 'U1', version: f.exact, declaration: '  declared  '},
    judgment: {kind: 'possible_duplicate', reason: '  investigate  '}}, units: ['unit-1'], selectedUnit: 'unit-1'};
  const nodes = view.render({...f.inspectorProps, proposal, onProposalDraft: value => calls.push(value)});
  assert.equal(field(nodes, 'Exact target version ID').props.value, f.exact.id);
  assert.equal(field(nodes, 'Revision').props.value, 7);
  field(nodes, 'Target declaration').props.onChange({target: {value: ' changed\n '}});
  assert.deepEqual(calls[0].target, {...proposal.draft.target, declaration: ' changed\n '});
});

test('confirmation offers no approval/publication and reconciliation requires the supplied action', () => {
  const calls = [];
  let nodes = eventView('ConfirmationView', f.confirmationProps).render();
  assert.equal(button(nodes, 'Confirm this proposal'), undefined); assert.equal(button(nodes, 'Check recorded outcome'), undefined);
  nodes = eventView('ConfirmationView', {...f.confirmationProps, confirmOffered: true, item: {...f.item, actions: ['reconcile']},
    onConfirm: () => calls.push('confirm'), onReconcile: () => calls.push('reconcile')}).render();
  button(nodes, 'Confirm this proposal').props.onClick(); button(nodes, 'Check recorded outcome').props.onClick();
  assert.deepEqual(calls, ['confirm', 'reconcile']);
  assert.equal(nodes.some(node => node.type === 'button' && /approve|publish/i.test(textOf(node))), false);
  for (const kind of ['candidate', 'relationship', 'blocked']) {
    const html = render('ConfirmationView', {...f.confirmationProps, outcome: {kind, reference: null, detail: `recorded-${kind}`}});
    assert.match(html, new RegExp(`recorded-${kind}`)); assert.match(html, /proposal/); assert.match(html, /exact-source/);
  }
});

test('catalogue keys and placeholders match; binary size labels distinguish zero from unknown', () => {
  const {COPY, ACTION, PHASE, TERMS} = load('copy.ts');
  for (const catalogue of [COPY, ACTION, PHASE, TERMS]) {
    assert.deepEqual(Object.keys(catalogue.en).sort(), Object.keys(catalogue.es).sort());
    for (const key of Object.keys(catalogue.en)) {
      for (const language of ['en', 'es']) {
        assert.ok(catalogue[language][key].trim());
        assert.doesNotMatch(catalogue[language][key], /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
      }
      assert.deepEqual(catalogue.en[key].match(/\{\w+\}/g), catalogue.es[key].match(/\{\w+\}/g));
    }
  }
  const {byteLabel} = load('presentation.ts');
  assert.equal(byteLabel(0), '0 B'); assert.equal(byteLabel(null), '—');
  assert.equal(byteLabel(524288), '512 KiB'); assert.equal(byteLabel(1048576), '1.0 MiB');
  assert.match(render('WorkspaceView', f.workspaceProps), /lang="en"/);
  assert.match(render('IntakeView', f.intakeProps), /política-€-2026.md/);
});

test('delivered scoped colours retain readable text and semantic surface order', () => {
  const css = readFileSync(path.join(sourceRoot, 'intake.module.css'), 'utf8');
  const palettes = [...css.matchAll(/\{ (--bg:#[^}]+)\}/g)].slice(0, 2).map(match =>
    Object.fromEntries([...match[1].matchAll(/--([a-z]+):(#[0-9a-f]{6})/g)].map(token => [token[1], token[2]])));
  assert.equal(palettes.length, 2);
  const luminance = hex => {
    const channels = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255).map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  };
  const contrast = (a, b) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (high + .05) / (low + .05); };
  for (const palette of palettes) {
    for (const ink of ['ink', 'muted', 'accent', 'warning', 'danger']) for (const bg of ['bg', 'panel', 'raised'])
      assert.ok(contrast(palette[ink], palette[bg]) >= 4.5, `${ink}/${bg}`);
    assert.ok(luminance(palette.panel) < luminance(palette.bg)); assert.ok(luminance(palette.raised) > luminance(palette.bg));
  }
  assert.equal(contrast(palettes[0].ink, palettes[0].bg).toFixed(2), '13.05');
  assert.match(css, /white-space:pre-wrap/); assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /max-width:700px/); assert.doesNotMatch(css, /(^|\n)(body|html|:root)\s*\{/);
});

test('presentation imports cannot pull in parsers, authority stores or external runtimes', () => {
  for (const name of readdirSync(sourceRoot).filter(name => /\.(ts|tsx)$/.test(name))) {
    const source = readFileSync(path.join(sourceRoot, name), 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(|localStorage|sessionStorage|dangerouslySetInnerHTML|\.trim\s*\(/, name);
    for (const match of source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)) {
      assert.ok(match[1] === 'react' || match[1] === '../view_model' || match[1].startsWith('./'), `${name}: ${match[1]}`);
    }
  }
});

test('directed in-memory mutations are rejected by their positive/negative view assertions', () => {
  const cases = [
    {name: 'hidden item action', file: 'IntakeView.tsx', from: 'item.actions.map(action =>',
      to: "[...item.actions, 'inspect_original'].map(action =>",
      check(options) {
        const absent = eventView('IntakeView', f.intakeProps, options).render();
        const offered = eventView('IntakeView', {...f.intakeProps, items: [{...f.item, actions: ['inspect_original']}]}, options).render();
        assert.equal(button(absent, 'Inspect original'), undefined); assert.ok(button(offered, 'Inspect original'));
      }},
    {name: 'hidden resource download', file: 'InspectionBlocks.tsx', from: 'block.downloadOffered && onDownloadResource &&',
      to: 'onDownloadResource &&',
      check(options) {
        const absent = eventView('InspectorView', f.inspectorProps, options).render();
        const offered = eventView('InspectorView', {...f.inspectorProps, blocks: [{...f.blocks[2], downloadOffered: true}]}, options).render();
        assert.equal(button(absent, 'Download resource'), undefined); assert.ok(button(offered, 'Download resource'));
      }},
    {name: 'trimmed original', file: 'InspectionBlocks.tsx', from: '{block.text}</pre>', to: '{block.text.trim()}</pre>',
      check(options) {
        const nodes = eventView('InspectorView', f.inspectorProps, options).render();
        assert.equal(nodes.find(node => node.props['data-testid'] === 'intake-exact-text').props.children, f.original);
      }},
    {name: 'removed selected item adopted', file: 'WorkspaceView.tsx', from: 'const showBody = props.selectedKey === null || selected !== null;',
      to: 'const showBody = true;',
      check(options) {
        let calls = 0;
        eventView('WorkspaceView', {...f.workspaceProps, selectedKey: 'removed', body: () => { calls++; return 'REMOVED'; }}, options).render();
        assert.equal(calls, 0);
        eventView('WorkspaceView', {...f.workspaceProps, selectedKey: f.item.key, body: () => { calls++; return 'PRESENT'; }}, options).render();
        assert.equal(calls, 1);
      }},
  ];
  for (const scenario of cases) {
    scenario.check({});
    let substitutions = 0;
    const options = {replaceSource(name, source) {
      if (name !== scenario.file) return source;
      assert.equal(source.split(scenario.from).length - 1, 1, scenario.name);
      substitutions++;
      return source.replace(scenario.from, scenario.to);
    }};
    assert.throws(() => scenario.check(options), {name: 'AssertionError'}, scenario.name);
    assert.ok(substitutions > 0, scenario.name);
  }
});

test('focus mechanics wait for a mounted ref, honor reduced motion and remove the viewport listener', () => {
  const oldWindow = globalThis.window;
  try {
    for (const reduced of [false, true]) {
      const observations = [], callbacks = [];
      const viewport = {addEventListener: (...args) => observations.push(['add', ...args]),
        removeEventListener: (...args) => observations.push(['remove', ...args])};
      globalThis.window = {matchMedia: query => { assert.equal(query, '(prefers-reduced-motion: reduce)'); return {matches: reduced}; }, visualViewport: viewport};
      const {load: focused} = loadViews({react: {...React, useContext: () => null, useRef: value => ({current: value}), useEffect: fn => callbacks.push(fn)}});
      const {useViewFocus} = focused('focus.ts');
      const absent = useViewFocus('absent');
      assert.equal(absent.current, null); assert.equal(callbacks.shift()(), undefined); assert.equal(observations.length, 0);
      const hidden = useViewFocus('hidden');
      hidden.current = {getClientRects: () => [], focus: () => assert.fail('hidden control focused')};
      assert.equal(callbacks.shift()(), undefined); assert.equal(observations.length, 0);
      const present = useViewFocus('present');
      present.current = {getClientRects: () => [{}], focus: value => observations.push(['focus', value]), scrollIntoView: value => observations.push(['scroll', value])};
      const cleanup = callbacks.shift()();
      assert.deepEqual(observations[0], ['focus', {preventScroll: true}]);
      assert.deepEqual(observations[1], ['scroll', {block: 'nearest', behavior: reduced ? 'auto' : 'smooth'}]);
      assert.equal(observations[2][1], 'resize'); assert.deepEqual(observations[2][3], {once: true});
      cleanup(); assert.equal(observations[3][2], observations[2][2]);
    }
  } finally { if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow; }
});

test('focus return uses a connected visible trigger or a connected visible fallback', () => {
  const previous = globalThis.requestAnimationFrame;
  try {
    globalThis.requestAnimationFrame = fn => { fn(); return 1; };
    const {returnFocus} = load('focus.ts');
    const calls = [];
    const element = (name, connected, visible) => ({isConnected: connected,
      getClientRects: () => visible ? [{}] : [], focus: () => calls.push(name)});
    returnFocus(element('original', true, true), element('fallback', true, true));
    returnFocus(element('removed', false, true), element('fallback', true, true));
    returnFocus(element('hidden', true, false), element('fallback', true, true));
    returnFocus(null, element('hidden-fallback', true, false));
    assert.deepEqual(calls, ['original', 'fallback', 'fallback']);
  } finally { if (previous === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = previous; }
});

test('file navigation guard covers outside drops, never admits them, and cleans up after unmount', () => {
  const oldWindow = globalThis.window;
  try {
    const effects = [];
    globalThis.window = new EventTarget();
    const {views: guarded} = loadViews({react: {...React,
      useState: initial => [initial, () => {}], useId: () => 'guard-check', useRef: initial => ({current: initial}),
      useContext: () => null, useEffect: (effect, deps) => effects.push({effect, deps}),
    }});
    guarded.IntakeView({...f.intakeProps, onFiles: () => assert.fail('outside drop admitted')});
    const listeners = effects.filter(effect => effect.deps.length === 0);
    assert.equal(listeners.length, 1);
    const cleanup = listeners[0].effect();
    const dispatch = (type, types) => {
      const event = new Event(type, {cancelable: true});
      Object.defineProperty(event, 'dataTransfer', {value: {types, files: [new File(['x'], 'x.txt')]}});
      globalThis.window.dispatchEvent(event); return event.defaultPrevented;
    };
    assert.equal(dispatch('dragover', ['Files']), true); assert.equal(dispatch('drop', ['Files']), true);
    assert.equal(dispatch('drop', ['text/plain']), false);
    cleanup();
    assert.equal(dispatch('dragover', ['Files']), false); assert.equal(dispatch('drop', ['Files']), false);
  } finally { if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow; }
});

test('reopening an existing detail emits a new focus entry without remounting the business draft', () => {
  const workspace = eventView('WorkspaceView', f.workspaceProps);
  let nodes = workspace.render();
  const entryOf = values => values.find(node => node.props.value?.returnToList).props.value.entry;
  assert.equal(entryOf(nodes), 0);
  button(nodes, 'Add material').props.onClick({currentTarget: {}}); nodes = workspace.render();
  assert.equal(entryOf(nodes), 1);
  button(nodes, 'Add material').props.onClick({currentTarget: {}}); nodes = workspace.render();
  assert.equal(entryOf(nodes), 2);
  const oldWindow = globalThis.window;
  try {
    let entry = 0, visible = false, focuses = 0;
    const effects = [], ref = {current: {getClientRects: () => visible ? [{}] : [],
      focus: () => focuses++, scrollIntoView() {}}};
    globalThis.window = {matchMedia: () => ({matches: true}), visualViewport: null};
    const {load: focused} = loadViews({react: {...React, useRef: () => ref, useContext: () => ({entry, returnToList() {}}),
      useEffect: (effect, deps) => effects.push({effect, deps})}});
    const {useViewFocus} = focused('focus.ts');
    useViewFocus('same-control'); effects[0].effect(); assert.equal(focuses, 0);
    visible = true; entry = 1;
    useViewFocus('same-control'); effects[1].effect(); assert.equal(focuses, 1);
    assert.deepEqual(effects.map(effect => effect.deps), [['same-control', 0], ['same-control', 1]]);
  } finally { if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow; }
});
