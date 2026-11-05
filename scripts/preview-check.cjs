const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(outputText, filename);
};
const { Runtime } = require('../src/lib/preview/runtime.ts');

const source = String.raw`import SwiftUI
struct Counter: View {
    @State private var count = 0
    @State private var name = "Ada"
    @State private var enabled = true
    var body: some View {
        VStack {
            Text("Count: \(count)")
            Button("Increment") { count += 1 }
            TextField("Name", text: $name)
            Text("Hello \(name)")
            Toggle("Enabled", isOn: $enabled)
            if enabled { Text("Enabled now") }
            ChildView()
        }
    }
}
#Preview { Counter() }
`;
const path = 'Counter.swift';
const rt = new Runtime();
const files = [
  { path, src: source },
  { path: 'ChildView.swift', src: 'import SwiftUI\nstruct ChildView: View { var body: some View { Text("Child connected") } }' },
];
rt.setFiles(files);
assert.ok(rt.targets(path).some(target => target.key === 'preview:0'));

function nodes(tree) {
  if (!tree) return [];
  return [tree, ...(tree.children ?? []).flatMap(nodes), ...(tree.label ?? []).flatMap(nodes)];
}
function render() {
  const result = rt.render(path, 'preview:0');
  assert.deepEqual(result.errors, [], JSON.stringify(result.errors));
  assert.ok(result.tree, 'Preview produces a view tree');
  return nodes(result.tree);
}
function text(list) {
  return list.filter(node => node.type === 'Text').map(node => node.props.text);
}
let tree = render();
assert.ok(text(tree).includes('Count: 0'));
assert.ok(text(tree).includes('Child connected'));
assert.equal(rt.dispatch({ id: tree.find(node => node.type === 'Button').event, kind: 'tap' }), true);
tree = render();
assert.ok(text(tree).includes('Count: 1'), 'Button event updates @State');
assert.equal(rt.dispatch({ id: tree.find(node => node.type === 'TextField').event, kind: 'set', value: 'Grace' }), true);
tree = render();
assert.ok(text(tree).includes('Hello Grace'), 'TextField writes through its binding');
assert.equal(rt.dispatch({ id: tree.find(node => node.type === 'Toggle').event, kind: 'set', value: false }), true);
tree = render();
assert.ok(!text(tree).includes('Enabled now'), 'Toggle changes conditional view');
assert.equal(rt.dispatch({ id: 'missing-event', kind: 'tap' }), false);

rt.setFiles(files.map(file => file.path === path ? { ...file, src: file.src.replace('Count: ', 'Taps: ') } : file));
assert.ok(text(render()).includes('Taps: 1'), 'Source edit preserves state and updates the preview');
rt.resetState();
assert.ok(text(render()).includes('Taps: 0'), 'Reset restores state');

function preview(src) {
  const runtime = new Runtime();
  runtime.setFiles([{ path: 'Case.swift', src }]);
  return runtime.render('Case.swift', 'preview:0');
}
const unsupported = preview('import SwiftUI\n#Preview { Map() }');
assert.ok(nodes(unsupported.tree).some(node => node.type === 'Unsupported'));
assert.ok(unsupported.notes.includes('Map'), 'Unsupported native view is reported');
const unknown = preview('#Preview { Text(missingValue) }');
assert.ok(unknown.errors.length > 0 || nodes(unknown.tree).some(node => node.type === 'Unsupported'), 'Unknown value is reported');
const loop = preview('#Preview { while true { Text("loop") } }');
assert.ok(loop.errors.some(error => /Loop does not end|Too many steps/.test(error.message)), 'Unbounded user loop is stopped');

const broken = new Runtime();
broken.setFiles([{ path: 'Broken.swift', src: '#Preview { Button("Break") { let value = missingValue } }' }]);
const brokenButton = nodes(broken.render('Broken.swift', 'preview:0').tree).find(node => node.type === 'Button');
assert.equal(broken.dispatch({ id: brokenButton.event, kind: 'tap' }), true);
assert.ok(broken.render('Broken.swift', 'preview:0').errors.some(error => error.message.includes("Unknown name 'missingValue'")), 'Button failure survives the event-triggered render');
assert.ok(broken.render('Broken.swift', 'preview:0').errors.length > 0, 'Rendering preview variants does not consume the event error');
broken.setFiles([{ path: 'Broken.swift', src: '#Preview { Text("Fixed") }' }]);
assert.deepEqual(broken.render('Broken.swift', 'preview:0').errors, [], 'Source edits clear the previous event error');

console.log('PASS: preview discovery, cross-file views, counter state, text binding, toggle, edits, reset, unsupported views, unknown values, loop guard, and event error reporting.');
