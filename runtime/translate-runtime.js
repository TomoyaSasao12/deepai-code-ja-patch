/*!
 * ja-patch runtime: 思考ブロック自動翻訳 (prototype)
 *
 * 仕組み:
 *   - MutationObserver でチャットDOMを監視し、「推論 / Thought / Thinking」ヘッダーを持つ折りたたみブロックを検出
 *   - ブロックのテキストが quietMs 間静止したら、ブロック単位でローカル LLM (Ollama) に翻訳させ、表示を差し替える
 *   - 原文は dataset に保持。トグルOFF / クリックで復元
 *   - 翻訳はハッシュキャッシュ + localStorage 永続化 (再訪時に再翻訳しない)
 *   - 検出に失敗しても何も壊れない (graceful degradation)
 *
 * 使い方 (DevTools console に丸ごと貼り付け):
 *   window.__JA_T.status()   // 状態表示
 *   window.__JA_T.toggle()   // ON/OFF
 *   window.__JA_T.debug()    // 検出候補のダンプ (DOM構造調査)
 *   window.__JA_T.model()    // 使用モデル変更 e.g. __JA_T.model('gemma3:4b')
 */
(() => {
	if (window.__JA_T) { window.__JA_T.panel(true); return; }

	const CFG = {
		endpoint: 'http://127.0.0.1:11434',
		modelPref: ['qwen3:1.7b', 'qwen2.5:3b-instruct', 'gemma3:4b', 'gemma3:1b', 'llama3.2:1b'],
		quietMs: 1600,          // この時間テキストが変化しなければ「静止」とみなす
		minChars: 40,           // これ未満の短文は翻訳しない
		maxChars: 5000,         // これを超えるブロックは先頭のみ翻訳
		cacheLimit: 300,
		lsCache: 'jaTranslateCache',
		lsModel: 'jaTranslateModel',
		lsOn: 'jaTranslateOn',
		headerRe: /^(推論|思考|考えた|Reasoning|Thought|Thinking|Reasoned)/i,
		footerRe: /^(\(×\d+\)|\(\d+\)| Thought| 思考)/,
	};

	const state = {
		on: localStorage.getItem(CFG.lsOn) !== '0',
		model: localStorage.getItem(CFG.lsModel) || '',
		models: [],
		cache: new Map(JSON.parse(localStorage.getItem(CFG.lsCache) || '[]')),
		inflight: new Set(),
		quiet: new Map(),       // el -> timeout id
		seen: new WeakSet(),
	};

	const saveCache = () => {
		const arr = [...state.cache.entries()].slice(-CFG.cacheLimit);
		try { localStorage.setItem(CFG.lsCache, JSON.stringify(arr)); } catch {}
	};
	const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return 'h' + (h >>> 0).toString(36) + '_' + s.length.toString(36); };

	/* ---------- Ollama ---------- */
	async function refreshModels() {
		try {
			const r = await fetch(`${CFG.endpoint}/api/tags`);
			state.models = (await r.json()).models?.map((m) => m.name) ?? [];
			state.fetchFailed = false;
			if (!state.model) state.model = CFG.modelPref.find((p) => state.models.some((m) => m.startsWith(p))) ?? state.models[0] ?? '';
		} catch (e) { state.models = []; state.fetchFailed = true; state.fetchError = String(e?.message ?? e).slice(0, 60); }
		return state.model;
	}

	async function translate(text) {
		const key = hash(text);
		if (state.cache.has(key)) return state.cache.get(key);
		if (state.inflight.has(key)) return null;
		state.inflight.add(key);
		try {
			const sys = 'あなたは英日翻訳者です。与えられたAIエージェントの思考メモを自然な日本語に翻訳してください。ルール: コード・ファイルパス・コマンド・URL・識別子・コードフェンスはそのまま残す。説明・注釈・要約を付け加えない。翻訳だけを出力する。';
			const isQwen3 = /qwen3/i.test(state.model);
			const body = {
				model: state.model,
				stream: false,
				options: { temperature: 0.2, num_predict: 3000 },
				messages: [
					{ role: 'system', content: sys },
					{ role: 'user', content: (isQwen3 ? '/no_think\n\n' : '') + text },
				],
			};
			const r = await fetch(`${CFG.endpoint}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
			const j = await r.json();
			let out = (j.message?.content ?? '').trim();
			if (isQwen3) out = out.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<\/?think>/g, '').trim();
			if (out) { state.cache.set(key, out); if (state.cache.size > CFG.cacheLimit) { state.cache.delete(state.cache.keys().next().value); } saveCache(); }
			return out || null;
		} catch (e) { console.warn('[jaT] translate failed:', e?.message ?? e); return null; }
		finally { state.inflight.delete(key); }
	}

	/* ---------- DOM検出 ---------- */
	function isHeaderEl(el) {
		if (!el || el.nodeType !== 1) return false;
		const t = (el.textContent ?? '').trim().replace(CFG.footerRe, '').trim();
		return t.length <= 30 && CFG.headerRe.test(t);
	}
	/** ヘッダー要素から「ブロック本体」を推定: 兄弟以降のテキストを含む共通の近い祖先 */
	function blockFor(header) {
		let a = header.parentElement;
		for (let i = 0; i < 6 && a; i++, a = a.parentElement) {
			const txt = (a.innerText ?? '').replace(/^\s*(推論|思考|Reasoning|Thought|Thinking)\b[^\n]*\n?/i, '').trim();
			if (txt.length >= CFG.minChars && a.children.length >= 1) return a;
		}
		return null;
	}
	function collectBlocks(root) {
		const out = [];
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const seenEls = new Set();
		while (walker.nextNode()) {
			const el = walker.currentNode.parentElement;
			if (!el || seenEls.has(el)) continue;
			seenEls.add(el);
			if (!isHeaderEl(el)) continue;
			// 最も内側の「ラベルだけ」の要素 (ボタンや見出し) を探す
			let header = el;
			while (header.parentElement && isHeaderEl(header.parentElement) && header.parentElement.textContent.length <= 40) header = header.parentElement;
			const blk = blockFor(header);
			if (blk) out.push(blk);
		}
		return [...new Set(out)];
	}

	/* ---------- 適用 ---------- */
	async function processBlock(blk) {
		if (!state.on || blk.dataset.jaDone || blk.dataset.jaPending) return;
		const original = (blk.innerText ?? '').trim();
		if (original.length < CFG.minChars) return;
		const trimmed = original.length > CFG.maxChars ? original.slice(0, CFG.maxChars) + '\n…(以下略)' : original;
		blk.dataset.jaPending = '1';
		const ja = await translate(trimmed);
		delete blk.dataset.jaPending;
		if (!ja || !state.on) return;
		// React が再描画してテキストが変わっていたら諦める (次の静止で再試行)
		if ((blk.innerText ?? '').trim() !== original) return;
		blk.dataset.jaOriginal = original;
		blk.dataset.jaDone = '1';
		blk.title = 'クリックで原文 ⇄ 翻訳';
		blk.style.cursor = 's-resize';
		blk.innerText = ja;
		blk.onclick = () => {
			if (blk.innerText === ja) blk.innerText = blk.dataset.jaOriginal ?? '';
			else blk.innerText = ja;
		};
	}
	function scheduleBlock(blk) {
		if (state.quiet.has(blk)) clearTimeout(state.quiet.get(blk));
		state.quiet.set(blk, setTimeout(() => { state.quiet.delete(blk); if (state.on) processBlock(blk); }, CFG.quietMs));
	}

	let pendingScan = false;
	const obs = new MutationObserver(() => {
		if (!state.on || pendingScan) return;
		pendingScan = true;
		setTimeout(() => {
			pendingScan = false;
			if (!state.on) return;
			const chat = document.querySelector('main') ?? document.body;
			for (const blk of collectBlocks(chat)) {
				if (blk.dataset.jaDone) continue;
				scheduleBlock(blk);
			}
		}, 300);
	});

	function applyAll() {
		if (!state.on) return;
		const chat = document.querySelector('main') ?? document.body;
		for (const blk of collectBlocks(chat)) scheduleBlock(blk);
	}
	function restoreAll() {
		for (const el of document.querySelectorAll('[data-ja-done]')) {
			el.innerText = el.dataset.jaOriginal ?? '';
			delete el.dataset.jaDone;
			el.onclick = null; el.title = ''; el.style.cursor = '';
		}
	}

	/* ---------- パネル ---------- */
	let panelEl = null;
	function panel(force) {
		if (panelEl && !force) { return; }
		if (panelEl) { panelEl.remove(); panelEl = null; return; }
		panelEl = document.createElement('div');
		panelEl.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:99999;display:flex;gap:6px;align-items:center;font:12px sans-serif;background:#1e1e26e6;color:#eee;border:1px solid #555;border-radius:8px;padding:6px 10px;cursor:pointer;user-select:none';
		const draw = () => {
			panelEl.textContent = '';
			const b = document.createElement('span');
			b.textContent = state.on ? '訳:ON' : '訳:OFF';
			b.style.cssText = 'font-weight:bold;color:' + (state.on ? '#9f7bff' : '#888');
			const m = document.createElement('span');
			if (state.fetchFailed) {
				m.textContent = 'Ollama未接続' + (state.fetchError ? ` (${state.fetchError})` : '');
				m.style.color = '#f66';
			} else if (!state.models.length) {
				m.textContent = 'モデルなし (ollama pull して)';
				m.style.color = '#f90';
			} else {
				m.textContent = state.model;
				m.style.opacity = '0.7';
			}
			panelEl.append(b, m);
		};
		panelEl.onclick = () => { toggle(); draw(); };
		panelEl.oncontextmenu = (e) => { e.preventDefault(); toggle(); draw(); };
		draw();
		document.body.append(panelEl);
	}

	async function toggle() {
		state.on = !state.on;
		localStorage.setItem(CFG.lsOn, state.on ? '1' : '0');
		if (state.on) { await refreshModels(); applyAll(); } else restoreAll();
	}

	window.__JA_T = {
		async status() {
			await refreshModels();
			console.log({ on: state.on, model: state.model, models: state.models, fetchFailed: state.fetchFailed, fetchError: state.fetchError, cached: state.cache.size });
		},
		toggle,
		async debug() {
			const chat = document.querySelector('main') ?? document.body;
			const blocks = collectBlocks(chat);
			console.log('detected blocks:', blocks.length);
			for (const b of blocks.slice(0, 5)) {
				console.log(b, { cls: b.className?.slice?.(0, 80), chars: (b.innerText ?? '').length, preview: (b.innerText ?? '').slice(0, 100) });
			}
			return blocks;
		},
		async model(name) { if (name) { state.model = name; localStorage.setItem(CFG.lsModel, name); } await refreshModels(); return state.model; },
		panel,
	};

	/* boot */
	refreshModels().then(() => {
		if (state.on) applyAll();
		obs.observe(document.body, { childList: true, subtree: true, characterData: true });
		console.log('[jaT] ready — model:', state.model || '(none). __JA_T.status() / toggle() / debug()');
	});
	// パネルは実ユーザーの最初の操作後にのみ出す (headless boot-probe が DOM カウントで失敗しないように)
	const armPanel = () => { panel(); window.removeEventListener('pointerdown', armPanel); window.removeEventListener('keydown', armPanel); };
	window.addEventListener('pointerdown', armPanel, { once: true });
	window.addEventListener('keydown', armPanel, { once: true });
})();
