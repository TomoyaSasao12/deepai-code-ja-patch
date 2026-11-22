#!/usr/bin/env node
/** Diagnostic: inspect ChatMarkdown chunks in the INSTALLED server.asar. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const resources = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'deepai-code-desktop', 'resources');
const serverAsar = path.join(resources, 'server.asar');
const fd = fs.openSync(serverAsar, 'r');
const pre = Buffer.alloc(16);
fs.readSync(fd, pre, 0, 16, 0);
const headerSize = pre.readUInt32LE(4);
const jsonSize = pre.readUInt32LE(12);
const json = Buffer.alloc(jsonSize);
fs.readSync(fd, json, 0, jsonSize, 16);
const header = JSON.parse(json.toString('utf8'));
const dataStart = 8 + headerSize;

const entries = [];
const walk = (tree, base = '') => {
	for (const [name, e] of Object.entries(tree.files ?? {})) {
		const p = base ? `${base}/${name}` : name;
		if (e.files) { walk(e, p); continue; }
		if (p.startsWith('apps/server/dist/client/assets/ChatMarkdown-')) entries.push({ p, e });
	}
};
walk(header);
console.log(JSON.stringify({ chatMarkdownEntries: entries.map((x) => x.p) }));

const dictDir = path.resolve(import.meta.dirname, '..', 'dictionaries');
const dict = {};
for (const f of fs.readdirSync(dictDir).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) {
	Object.assign(dict, JSON.parse(fs.readFileSync(path.join(dictDir, f), 'utf8')));
}
delete dict.__meta;

for (const { p, e } of entries) {
	const buf = Buffer.alloc(e.size);
	fs.readSync(fd, buf, 0, e.size, dataStart + Number(e.offset));
	let text = buf.toString('utf8');
	const pristineChecks = {
		aiGet: text.includes('Open in ${Ai.get(e)??`Editor`}'),
		kiGet: text.includes('Open in ${ki.get(e)??`Editor`}'),
		openInEditorLiteral: text.includes('`Open in editor`'),
	};
	for (const [en, ja] of Object.entries(dict)) {
		const esc = en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		text = text.replace(new RegExp('`' + esc + '`', 'g'), '`' + ja + '`');
	}
	const afterDict = {
		findSurvives: text.includes('Open in ${Ai.get(e)??`Editor`}'),
		kiSurvives: text.includes('Open in ${ki.get(e)??`Editor`}'),
	};
	const at = text.indexOf('file-manager`?');
	console.log(JSON.stringify({ entry: p, size: e.size, pristineChecks, afterDict, ctx: at === -1 ? undefined : text.slice(Math.max(0, at - 10), at + 130) }));
}
fs.closeSync(fd);
