window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-client-plugin-context-assembler",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		let react_dom_client = require("react-dom/client");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/api.ts
		const API_PREFIX = "/api/context-assembler";
		const FALLBACK_PORT = 4799;
		const FALLBACK_ATTEMPTS = 8;
		let resolvedBase = null;
		/** Resolve the API base once, preferring the same origin. */
		async function base() {
			if (resolvedBase !== null) return resolvedBase;
			const candidates = [API_PREFIX];
			for (let offset = 0; offset < FALLBACK_ATTEMPTS; offset += 1) candidates.push("http://127.0.0.1:" + String(FALLBACK_PORT + offset) + API_PREFIX);
			for (const candidate of candidates) try {
				const response = await fetch(candidate + "/templates", { method: "GET" });
				if (!response.ok) continue;
				if ((await response.json()).ok === true) {
					resolvedBase = candidate;
					return candidate;
				}
			} catch {}
			throw new Error("无法连接 context-assembler 宿主接口：同源路由与 127.0.0.1:" + String(FALLBACK_PORT) + "–" + String(4806) + " 都没有响应。这通常意味着宿主半边没有加载（检查 profile 里是否还有 ui-context-assembler 这一行）。");
		}
		/** One typed call against the host API. */
		async function request(path, init) {
			const root = await base();
			const response = await fetch(root + path, {
				...init,
				headers: {
					"Content-Type": "application/json",
					...init?.headers ?? {}
				}
			});
			const text = await response.text();
			let body = {};
			try {
				body = text.trim() === "" ? {} : JSON.parse(text);
			} catch {
				body = {
					ok: false,
					error: text.slice(0, 400)
				};
			}
			const envelope = body;
			if (envelope.ok !== true) {
				const message = typeof envelope.error === "string" ? envelope.error : "HTTP " + response.status;
				throw new Error(message);
			}
			return envelope.value;
		}
		/** The plugin API, as the panel uses it. */
		const api = {
			sessions: () => request("/sessions"),
			tree: (sessionId) => request("/tree?sessionId=" + encodeURIComponent(sessionId)),
			messages: (sessionId) => request("/messages?sessionId=" + encodeURIComponent(sessionId)),
			templates: () => request("/templates"),
			saveDraft: (sessionId, ops) => request("/draft", {
				method: "PUT",
				body: JSON.stringify({
					sessionId,
					ops
				})
			}),
			plan: (request_, dryRun) => request("/plan", {
				method: "POST",
				body: JSON.stringify({
					...request_,
					dryRun
				})
			}),
			savePresets: (sessionId, presets) => request("/presets", {
				method: "PUT",
				body: JSON.stringify({
					sessionId,
					presets
				})
			})
		};
		//#endregion
		//#region src/client/sidebar.ts
		/**
		* The small "open in the context panel" button on every conversation row.
		*
		* Why this exists: the harness only pulls a conversation into the live session
		* store once somebody opens it, so the panel used to be blind to every past
		* conversation until it had been reopened — which, after a restart, forks it
		* into a new session id. A row-level button makes a stored conversation
		* reachable in one click, and the host reads it from storage without opening
		* or forking anything.
		*
		* How the session id is found: the sidebar renders no id into the DOM and the
		* class names are skin-specific, so the id is read out of React's fiber props
		* for the row element. That is stable across skins because it is the value the
		* sidebar component itself was rendered with, not a styling decision.
		*/
		/** Attribute marking a button this module injected. */
		const ICON_ATTR = "data-ca-session-icon";
		/** Id of the one injected stylesheet. */
		const STYLE_ID = "dsh-context-assembler-sidebar";
		/** Session ids are the only strings accepted from fiber props. */
		const SESSION_ID = /^session-[0-9a-zA-Z_-]+$/;
		/** How far up the fiber tree to look before giving up. */
		const MAX_DEPTH = 12;
		/** The opener the mounted panel registers. */
		let opener = null;
		/** Let the panel receive clicks from the injected buttons. */
		function setSidebarOpener(fn) {
			opener = fn;
		}
		/**
		* Read the session id a sidebar row was rendered for.
		*
		* The nearest fiber carrying a session id wins: ancestors carry ids too (the
		* workspace above, the selection below), and the nearest one is the row's own.
		* @param element - the row element.
		* @returns the session id, or null when this row is not a conversation.
		*/
		function readSessionId(element) {
			const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
			if (key === void 0) return null;
			let node = element[key];
			for (let depth = 0; depth < MAX_DEPTH && node != null; depth += 1) {
				const props = node.memoizedProps;
				if (props !== null && typeof props === "object") for (const value of Object.values(props)) {
					if (typeof value === "string" && SESSION_ID.test(value)) return value;
					if (Array.isArray(value)) {
						for (const item of value) {
							if (item === null || typeof item !== "object") continue;
							const id = item.id;
							if (typeof id === "string" && SESSION_ID.test(id)) return id;
						}
						continue;
					}
					if (value !== null && typeof value === "object") {
						const id = value.id;
						if (typeof id === "string" && SESSION_ID.test(id)) return id;
					}
				}
				node = node.return ?? null;
			}
			return null;
		}
		/** Install the injected stylesheet once. */
		function ensureStyle() {
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = [
				"[" + ICON_ATTR + "]{flex:none;display:inline-flex;align-items:center;justify-content:center;",
				"width:18px;height:18px;margin:0 0 0 2px;padding:0;border:1px solid transparent;",
				"border-radius:5px;background:transparent;color:inherit;opacity:0.5;cursor:pointer;",
				"transition:opacity .12s ease,background-color .12s ease,border-color .12s ease}",
				"[" + ICON_ATTR + "]:hover{opacity:1;background:rgba(127,127,127,0.22);border-color:rgba(127,127,127,0.35)}",
				"[" + ICON_ATTR + "]:focus-visible{opacity:1;outline:2px solid currentColor;outline-offset:1px}"
			].join("");
			document.head.appendChild(style);
		}
		/** Build the 16px grid icon shown on a row. */
		function iconSvg() {
			return "<svg viewBox=\"0 0 16 16\" width=\"12\" height=\"12\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M2.5 4h11M2.5 8h7M2.5 12h4\"/><circle cx=\"12\" cy=\"11.5\" r=\"2.6\"/></svg>";
		}
		/**
		* Add the button to one row, if it is a conversation row without one.
		* @param row - the sidebar row element.
		* @returns true when a button was added.
		*/
		function decorate(row) {
			if (row.querySelector("[" + ICON_ATTR + "]") !== null) return false;
			const sessionId = readSessionId(row);
			if (sessionId === null) return false;
			const button = document.createElement("button");
			button.type = "button";
			button.setAttribute(ICON_ATTR, sessionId);
			button.title = "在组装式上下文中打开（不会切换当前对话）";
			button.setAttribute("aria-label", "在组装式上下文中打开这个对话");
			button.innerHTML = iconSvg();
			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (opener !== null) opener(sessionId);
			});
			row.appendChild(button);
			return true;
		}
		/**
		* Decorate every conversation row currently in the document.
		* @returns how many buttons were added.
		*/
		function sync() {
			let added = 0;
			for (const row of Array.from(document.querySelectorAll("[role=\"treeitem\"]"))) if (decorate(row)) added += 1;
			return added;
		}
		/**
		* Keep the sidebar decorated as the harness re-renders it.
		*
		* The observer watches the whole body because the sidebar is virtualised and
		* re-rendered on every session rename or activity change. `decorate` is
		* idempotent, so the mutations this module causes settle instead of looping.
		* @returns a function that removes every button and stops observing.
		*/
		function installSidebarIcons() {
			ensureStyle();
			let queued = false;
			const run = () => {
				queued = false;
				sync();
			};
			const observer = new MutationObserver(() => {
				if (queued) return;
				queued = true;
				window.requestAnimationFrame(run);
			});
			observer.observe(document.body, {
				childList: true,
				subtree: true
			});
			run();
			return () => {
				observer.disconnect();
				for (const button of Array.from(document.querySelectorAll("[" + ICON_ATTR + "]"))) button.remove();
				document.getElementById(STYLE_ID)?.remove();
			};
		}
		//#endregion
		//#region \0dsh-css:src/client/context-assembler.module.css.mjs
		const css = ".kM8pfa_launcher{top:10px;right:var(--ca-right,12px);z-index:70;box-sizing:border-box;border:1px solid var(--dsh-border,#788caa47);background-color:var(--dsh-surface-raised,#101721eb);width:auto;min-width:0;max-width:240px;height:30px;color:var(--dsh-text,#e6edf3);letter-spacing:.2px;white-space:nowrap;text-overflow:ellipsis;cursor:grab;touch-action:none;backdrop-filter:blur(10px);background-image:linear-gradient(#ffffff12,#fff0 62%);border-radius:999px;flex-direction:row;flex:none;justify-content:center;align-items:center;gap:7px;margin:0;padding:0 11px;font:500 12px/1 system-ui,-apple-system,Segoe UI,Microsoft YaHei,sans-serif;transition:border-color .15s,box-shadow .15s,transform .15s,right .18s;display:inline-flex;position:fixed;overflow:hidden;box-shadow:0 2px 10px #00000047}.kM8pfa_launcher:hover{border-color:#4a86d8;transform:translateY(-1px);box-shadow:0 4px 16px #1f6feb47}.kM8pfa_launcher:active{cursor:grabbing;transform:translateY(0)}.kM8pfa_launcherOpen{background-color:#1f6feb33;border-color:#4a86d8}.kM8pfa_launcherIcon{opacity:.9;flex:none;width:14px;height:14px;display:block}.kM8pfa_launcherLabel{text-overflow:ellipsis;flex:none;overflow:hidden}.kM8pfa_launcherBadge{color:#9dc2f0;font-variant-numeric:tabular-nums;background:#1f6feb38;border-radius:999px;flex:none;padding:1px 6px;font-size:10px}.kM8pfa_launcherBadgeGood{color:#7ee2a8;background:#23865438}.kM8pfa_panel{top:48px;right:var(--ca-right,12px);z-index:69;box-sizing:border-box;border:1px solid var(--dsh-border,#2d3748);background:var(--dsh-surface,#0f151d);width:min(760px,100vw - 24px);height:min(78vh,900px);color:var(--dsh-text,#e6edf3);border-radius:14px;flex-direction:column;font:13px/1.45 system-ui,-apple-system,Segoe UI,Microsoft YaHei,sans-serif;display:flex;position:fixed;overflow:hidden;box-shadow:0 18px 60px #00000080}.kM8pfa_header{border-bottom:1px solid var(--dsh-border,#222c39);background:var(--dsh-surface-raised,#151d28);align-items:center;gap:10px;padding:10px 12px;display:flex}.kM8pfa_title{letter-spacing:.2px;font-size:13px;font-weight:600}.kM8pfa_sub{color:#8b98a9;font-size:11px}.kM8pfa_spacer{flex:1}.kM8pfa_select{box-sizing:border-box;border:1px solid var(--dsh-border,#2d3748);min-width:110px;max-width:320px;color:inherit;font:inherit;background:#0b1119;border-radius:7px;flex:auto;padding:4px 6px;font-size:12px}.kM8pfa_button{box-sizing:border-box;border:1px solid var(--dsh-border,#2d3748);width:auto;height:auto;color:inherit;font:inherit;white-space:nowrap;cursor:pointer;background:#182130;border-radius:7px;padding:5px 10px;font-size:12px}.kM8pfa_button:hover:not(:disabled){background:#1b2740;border-color:#3f7fd6}.kM8pfa_button:disabled{opacity:.45;cursor:default}.kM8pfa_primary{color:#fff;background:#1f6feb;border-color:#1f6feb}.kM8pfa_primary:hover:not(:disabled){background:#2a7df5}.kM8pfa_danger{color:#ffb4b4}.kM8pfa_stats{border-bottom:1px solid var(--dsh-border,#222c39);color:#8b98a9;flex-wrap:wrap;gap:14px;padding:8px 12px;font-size:11px;display:flex}.kM8pfa_stat b{color:#e6edf3;font-weight:600}.kM8pfa_statGood b{color:#4ade80}.kM8pfa_toolbar{border-bottom:1px solid var(--dsh-border,#222c39);flex-wrap:wrap;align-items:center;gap:6px;padding:8px 12px;display:flex}.kM8pfa_banner{border-bottom:1px solid var(--dsh-border,#222c39);padding:7px 12px;font-size:12px}.kM8pfa_bannerError{color:#ffc9c9;background:#3a1620}.kM8pfa_bannerOk{color:#b7f7cf;background:#12301f}.kM8pfa_tree{flex:1;padding:6px 0 12px;overflow:auto}.kM8pfa_empty{color:#8b98a9;text-align:center;border:1px dashed #2b3746;border-radius:10px;max-width:400px;margin:18px auto 0;padding:14px 16px;font-size:12px;line-height:1.6}.kM8pfa_row{align-items:flex-start;gap:6px;padding:3px 10px;display:flex}.kM8pfa_row:hover{background:#ffffff08}.kM8pfa_rowSelected{background:#1f6feb1f}.kM8pfa_caret{color:#7d8b9c;cursor:pointer;width:16px;font:inherit;text-align:center;background:0 0;border:none;flex:none;padding:0;font-size:11px}.kM8pfa_caretSpacer{flex:none;width:16px}.kM8pfa_label{text-overflow:ellipsis;white-space:nowrap;cursor:pointer;flex:1;min-width:0;overflow:hidden}.kM8pfa_labelMuted{color:#8b98a9}.kM8pfa_rowHint{color:#93a1b3;margin-left:8px;font-size:11px}.kM8pfa_seq{color:#6b7a8d;font-size:11px}.kM8pfa_tokens{color:#8b98a9;font-variant-numeric:tabular-nums;flex:none;font-size:11px}.kM8pfa_modes{flex:none;gap:2px;display:flex}.kM8pfa_batch{opacity:0;transition:opacity .12s}.kM8pfa_row:hover .kM8pfa_batch,.kM8pfa_row:focus-within .kM8pfa_batch{opacity:1}.kM8pfa_mode{box-sizing:border-box;color:#8b98a9;width:auto;font:inherit;white-space:nowrap;cursor:pointer;background:#131b26;border:1px solid #26313f;border-radius:5px;padding:2px 6px;font-size:10px}.kM8pfa_mode:hover{border-color:#3f7fd6}.kM8pfa_modeOn{color:#fff;background:#1f6feb;border-color:#1f6feb}.kM8pfa_modeKey{color:#fff;background:#8a6d1f;border-color:#b08a2a}.kM8pfa_modeOff{color:#ffd9d9;background:#6b2530;border-color:#8c3140}.kM8pfa_tag{color:#93a1b3;white-space:nowrap;border:1px solid #2b3746;border-radius:999px;flex:none;padding:1px 6px;font-size:10px}.kM8pfa_tagTool{color:#86d3a4;border-color:#2f5d43}.kM8pfa_tagErr{color:#ff9b9b;border-color:#6b2530}.kM8pfa_tagDigest{color:#e8cf7a;border-color:#6b5a1f}.kM8pfa_tagAssistant{color:#9dc2f0;border-color:#2f4a6b}.kM8pfa_tagPending{color:#ffd479;border-color:#b08a2a}.kM8pfa_preview{color:#b9c5d3;white-space:pre-wrap;word-break:break-word;background:#0b1119;border:1px solid #222c39;border-radius:8px;max-height:260px;margin:2px 10px 6px 40px;padding:8px 10px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:auto}.kM8pfa_readOnlyStrip{border-bottom:1px solid var(--dsh-border,#222c39);color:var(--dsh-text-muted,#9aa4b2);background:#b4822824;align-items:baseline;gap:8px;padding:7px 12px;font-size:11.5px;line-height:1.4;display:flex}.kM8pfa_readOnlyStrip b{color:#e0b060;flex:none;font-weight:600}.kM8pfa_section{border-top:1px solid var(--dsh-border,#222c39);padding:8px 12px}.kM8pfa_sectionTitle{align-items:center;gap:8px;font-size:12px;font-weight:600;display:flex}.kM8pfa_presetRow{align-items:center;gap:8px;padding:4px 0;font-size:12px;display:flex}.kM8pfa_presetInput{box-sizing:border-box;min-width:0;color:inherit;font:inherit;background:#0b1119;border:1px solid #26313f;border-radius:6px;flex:1;padding:4px 7px;font-size:12px}.kM8pfa_messages{max-height:220px;padding:4px 0;overflow:auto}.kM8pfa_messageRow{color:#9aa7b6;align-items:center;gap:8px;padding:3px 0;font-size:11px;display:flex}.kM8pfa_messageText{text-overflow:ellipsis;white-space:nowrap;flex:1;overflow:hidden}.kM8pfa_footer{border-top:1px solid var(--dsh-border,#222c39);background:var(--dsh-surface-raised,#151d28);align-items:center;gap:8px;padding:8px 12px;display:flex}.kM8pfa_hint{color:#7d8b9c;font-size:11px}";
		const tagId = "@dsh-external/dsh-client-plugin-context-assembler/context-assembler.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-external/dsh-client-plugin-context-assembler";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var context_assembler_module_css_default = {
			"banner": "kM8pfa_banner",
			"bannerError": "kM8pfa_bannerError",
			"bannerOk": "kM8pfa_bannerOk",
			"batch": "kM8pfa_batch",
			"button": "kM8pfa_button",
			"caret": "kM8pfa_caret",
			"caretSpacer": "kM8pfa_caretSpacer",
			"danger": "kM8pfa_danger",
			"empty": "kM8pfa_empty",
			"footer": "kM8pfa_footer",
			"header": "kM8pfa_header",
			"hint": "kM8pfa_hint",
			"label": "kM8pfa_label",
			"labelMuted": "kM8pfa_labelMuted",
			"launcher": "kM8pfa_launcher",
			"launcherBadge": "kM8pfa_launcherBadge",
			"launcherBadgeGood": "kM8pfa_launcherBadgeGood",
			"launcherIcon": "kM8pfa_launcherIcon",
			"launcherLabel": "kM8pfa_launcherLabel",
			"launcherOpen": "kM8pfa_launcherOpen",
			"messageRow": "kM8pfa_messageRow",
			"messageText": "kM8pfa_messageText",
			"messages": "kM8pfa_messages",
			"mode": "kM8pfa_mode",
			"modeKey": "kM8pfa_modeKey",
			"modeOff": "kM8pfa_modeOff",
			"modeOn": "kM8pfa_modeOn",
			"modes": "kM8pfa_modes",
			"panel": "kM8pfa_panel",
			"presetInput": "kM8pfa_presetInput",
			"presetRow": "kM8pfa_presetRow",
			"preview": "kM8pfa_preview",
			"primary": "kM8pfa_primary",
			"readOnlyStrip": "kM8pfa_readOnlyStrip",
			"row": "kM8pfa_row",
			"rowHint": "kM8pfa_rowHint",
			"rowSelected": "kM8pfa_rowSelected",
			"section": "kM8pfa_section",
			"sectionTitle": "kM8pfa_sectionTitle",
			"select": "kM8pfa_select",
			"seq": "kM8pfa_seq",
			"spacer": "kM8pfa_spacer",
			"stat": "kM8pfa_stat",
			"statGood": "kM8pfa_statGood",
			"stats": "kM8pfa_stats",
			"sub": "kM8pfa_sub",
			"tag": "kM8pfa_tag",
			"tagAssistant": "kM8pfa_tagAssistant",
			"tagDigest": "kM8pfa_tagDigest",
			"tagErr": "kM8pfa_tagErr",
			"tagPending": "kM8pfa_tagPending",
			"tagTool": "kM8pfa_tagTool",
			"title": "kM8pfa_title",
			"tokens": "kM8pfa_tokens",
			"toolbar": "kM8pfa_toolbar",
			"tree": "kM8pfa_tree"
		};
		//#endregion
		//#region src/client/panel.tsx
		/**
		* The assembled-context panel.
		*
		* It is a tree editor over one session surface. Every row is a region of
		* recorded work; the three-button control on each row picks what the next
		* model request does with that region. Nothing is written until 应用 is
		* pressed, so the user can reshape a whole context plan and read the projected
		* token budget before committing it to the log.
		*
		* @module dsh-context-assembler/client/panel
		*/
		/** The three modes, in the order the row control renders them. */
		const MODES = [
			{
				value: "full",
				label: "原文",
				className: context_assembler_module_css_default.modeOn
			},
			{
				value: "key",
				label: "关键",
				className: context_assembler_module_css_default.modeKey
			},
			{
				value: "off",
				label: "移出",
				className: context_assembler_module_css_default.modeOff
			}
		];
		/** Every selectable row inside one subtree. */
		function collectRows(node, out) {
			if (node.surfaceSeq !== null && node.selectable) out.push(node);
			if (node.children !== void 0) for (const child of node.children) collectRows(child, out);
			return out;
		}
		/** The badge class for one row. */
		function tagClassFor(node) {
			if (node.state === "digest") return context_assembler_module_css_default.tagDigest;
			if (node.kind === "tool") return node.isError === true ? context_assembler_module_css_default.tagErr : context_assembler_module_css_default.tagTool;
			if (node.kind === "assistant") return context_assembler_module_css_default.tagAssistant;
			return context_assembler_module_css_default.tag;
		}
		/**
		* Whether a line is a tool-call marker rather than something a person said.
		*
		* `messageText` renders each `tool-call` block as `<name {args}>`, so an
		* assistant turn that only called a tool — the common shape in an agent loop —
		* starts with the raw JSON of its arguments. Reporting that as the gist of a
		* step is worse than reporting nothing: it is unreadable and it says only which
		* tool ran, which the row's own kind already says. The closing bracket is
		* optional because the preview is truncated mid-line.
		*/
		function isToolCallMarker(line) {
			return /^<[A-Za-z_][A-Za-z0-9_-]*[ >]/.test(line);
		}
		/** Collapse one text block down to a single readable line. */
		function firstLineOf(text) {
			for (const raw of text.split(/\r?\n/)) {
				const line = raw.replace(/\s+/g, " ").trim();
				if (line === "" || isToolCallMarker(line)) continue;
				return line.length > 72 ? line.slice(0, 72) + "…" : line;
			}
		}
		/**
		* The one-line gist of a subtree, in row order — the same rule tree.ts applies.
		*
		* The host half already sends `hint` and stays the source of truth. This
		* fallback exists because the two halves reload on different triggers: a page
		* refresh picks up new panel code immediately, while the host half only changes
		* on a restart. Without it, a browser running newer panel code against an
		* unchanged host would fall back to bare ordinals — exactly the state this is
		* meant to fix.
		*/
		function gistFrom(node, allowSystem) {
			if (node.state === "digest") {
				const own = firstLineOf(node.preview);
				if (own !== void 0) return own;
			}
			const children = node.children ?? [];
			if (children.length === 0) {
				if (!allowSystem && node.kind === "system") return void 0;
				const line = firstLineOf(node.preview);
				if (line === void 0) return void 0;
				if (node.kind === "tool" && node.toolName !== void 0 && !line.startsWith(node.toolName)) return "工具 " + node.toolName + " · " + line;
				return line;
			}
			for (const child of children) {
				if (!allowSystem && child.kind === "system") continue;
				const found = gistFrom(child, allowSystem);
				if (found !== void 0) return found;
			}
		}
		/** Where the panel remembers its own view state between page loads. */
		const UI_KEY = "dsh-context-assembler.ui";
		/** Read the stored view state, tolerating a hostile or absent storage. */
		function loadUi() {
			try {
				const raw = window.localStorage.getItem(UI_KEY);
				if (raw === null) return {};
				const parsed = JSON.parse(raw);
				return parsed !== null && typeof parsed === "object" ? parsed : {};
			} catch {
				return {};
			}
		}
		/** Persist the view state; a full or blocked storage must never break the panel. */
		function saveUi(value) {
			try {
				window.localStorage.setItem(UI_KEY, JSON.stringify(value));
			} catch {}
		}
		/**
		* Pick the session to open, following the conversation across a restart.
		*
		* Continuing a stored conversation makes the harness fork it into a fresh
		* session id, so the id the panel saved last time is usually no longer live.
		* Falling back to "newest session" would silently jump the user into whatever
		* else happened to be active; walking the recorded lineage keeps the panel on
		* the conversation they were actually working in.
		* @param stored - the session id saved by the previous page load.
		* @param sessions - the live sessions.
		* @param fallback - the host's own default.
		* @returns the session id to open.
		*/
		function resolveStoredSession(stored, sessions, fallback) {
			if (stored === null) return fallback;
			if (sessions.some((row) => row.id === stored)) return stored;
			const byId = new Map(sessions.map((row) => [row.id, row]));
			const descendants = [];
			for (const row of sessions) {
				let cursor = row.parentSessionId;
				for (let depth = 0; depth < 16 && cursor !== void 0; depth += 1) {
					if (cursor === stored) {
						descendants.push(row);
						break;
					}
					cursor = byId.get(cursor)?.parentSessionId;
				}
			}
			descendants.sort((a, b) => b.updatedAt - a.updatedAt);
			return descendants[0]?.id ?? fallback;
		}
		/** Default distance from the viewport's right edge when nothing is in the way. */
		const RIGHT_BASE = 12;
		/** The right sidebar element this panel last found, so the steady-state measure is one rect read. */
		let sidebarCandidate = null;
		/** Earliest time the next full-document sidebar scan may run. */
		let nextSidebarScan = 0;
		/** Tags that are artwork rather than chrome; skins decorate heavily. */
		const DECORATIVE = /* @__PURE__ */ new Set([
			"IMG",
			"PICTURE",
			"VIDEO",
			"CANVAS",
			"SVG"
		]);
		/**
		* Whether one element is the harness right sidebar.
		*
		* Full height and flush with the TOP is the load-bearing part. Skins park
		* large decorative artwork along the right edge, and an earlier version of
		* this test happily adopted a 484x920 illustration that merely ended at the
		* viewport edge — which pinned the launcher 500px into the chat column.
		* Hidden means parked: the sidebar collapses by translating itself out and
		* going invisible, not by unmounting.
		* @param element - candidate element.
		* @param rect - its rect.
		* @param style - its computed style.
		* @returns whether this is the sidebar.
		*/
		function isSidebarLike(element, rect, style) {
			const vw = window.innerWidth;
			if (DECORATIVE.has(element.tagName)) return false;
			if (style.position !== "fixed" && style.position !== "absolute") return false;
			if (style.visibility === "hidden" || style.display === "none") return false;
			if (rect.top > 12) return false;
			if (rect.height < window.innerHeight * .6) return false;
			if (rect.width < 180 || rect.width > vw - 100) return false;
			return Math.abs(rect.right - vw) <= 8 || Math.abs(rect.left - vw) <= 8;
		}
		/**
		* The offset one already-found element implies.
		*
		* A parked sidebar reports the base offset rather than a negative one, so the
		* launcher returns to the corner when the sidebar closes.
		* @param element - the sidebar element.
		* @returns the offset in pixels.
		*/
		function offsetFor(element) {
			const rect = element.getBoundingClientRect();
			if (!isSidebarLike(element, rect, window.getComputedStyle(element))) return RIGHT_BASE;
			const left = Math.min(rect.left, window.innerWidth);
			return Math.max(RIGHT_BASE, Math.round(window.innerWidth - left) + RIGHT_BASE);
		}
		/**
		* Find the harness right sidebar.
		*
		* Geometry first, style second: the cheap rect test discards almost every
		* element before a single getComputedStyle runs, which matters because this
		* scans the whole document whenever the cached element is gone.
		* @returns the sidebar element, or null when this layout has none.
		*/
		function adoptSidebar() {
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			let best = null;
			let bestScore = -1;
			for (const node of Array.from(document.body.querySelectorAll("*"))) {
				if (!(node instanceof HTMLElement)) continue;
				const rect = node.getBoundingClientRect();
				if (rect.top > 12) continue;
				if (rect.height < vh * .6) continue;
				if (rect.width < 180 || rect.width > vw - 100) continue;
				if (Math.abs(rect.right - vw) > 8 && Math.abs(rect.left - vw) > 8) continue;
				const style = window.getComputedStyle(node);
				if (!isSidebarLike(node, rect, style)) continue;
				const z = Number.parseInt(style.zIndex, 10);
				const score = (Number.isFinite(z) ? z : 0) * 1e5 + rect.width;
				if (score > bestScore) {
					bestScore = score;
					best = node;
				}
			}
			return best;
		}
		/**
		* How far this plugin's chrome must sit from the right edge.
		*
		* The harness right sidebar is a full-height, right-anchored panel that slides
		* in over the chat column, so a fixed top-right button lands squarely on its
		* header controls and makes them unclickable. Following the sidebar keeps the
		* launcher and the panel at the top-right of whatever column is actually free.
		*
		* Once found, the element is measured directly — one rect read per tick. A
		* layout with no sidebar at all re-scans only occasionally, because the scan is
		* the expensive half and an unnoticed sidebar is a cosmetic problem.
		* @returns the offset in pixels.
		*/
		function measureRightOffset() {
			if (sidebarCandidate !== null) {
				if (sidebarCandidate.isConnected) return offsetFor(sidebarCandidate);
				sidebarCandidate = null;
			}
			const now = Date.now();
			if (now < nextSidebarScan) return RIGHT_BASE;
			nextSidebarScan = now + 1500;
			sidebarCandidate = adoptSidebar();
			return sidebarCandidate === null ? RIGHT_BASE : offsetFor(sidebarCandidate);
		}
		/** Byte size, for a stored log whose event count is not known yet. */
		function bytes(value) {
			if (value >= 1048576) return (value / 1048576).toFixed(1) + " MB";
			if (value >= 1024) return Math.round(value / 1024) + " KB";
			return String(value) + " B";
		}
		/**
		* One line for the session picker.
		*
		* A stored session has no title until its log has been read once, so the row
		* says what it is and how big it is rather than pretending to be empty:
		* "0 事件" on a stored conversation reads as data loss, not as a pending read.
		* @param row - the session row.
		* @returns the option label.
		*/
		function sessionLabel(row) {
			const prefix = (row.recent ? "● " : "") + (row.parentSessionId === void 0 ? "" : "└ ");
			const name = row.title !== "" ? row.title.length > 30 ? row.title.slice(0, 30) + "…" : row.title : row.cold === true ? "未命名 · " + row.id.replace("session-", "").slice(0, 8) : row.id;
			const size = row.events > 0 ? row.events + " 事件" : row.sizeBytes !== void 0 && row.sizeBytes > 0 ? bytes(row.sizeBytes) : "读取中…";
			return prefix + name + "  ·  " + size + (row.cold === true ? "  ·  历史" : "");
		}
		/** Compact token rendering. */
		function tokens(value) {
			if (value >= 1e3) return (value / 1e3).toFixed(1) + "k";
			return String(value);
		}
		/** One tree row plus its subtree. */
		function Row(props) {
			const node = props.node;
			const depth = props.depth;
			const children = node.children ?? [];
			const isOpen = props.expanded[node.id] === true;
			const seq = node.surfaceSeq;
			const pendingHere = seq === null ? void 0 : props.pending[seq];
			const effective = pendingHere === void 0 ? node.mode : pendingHere.mode;
			const dirty = pendingHere !== void 0;
			const expandable = children.length > 0;
			const subtree = (0, react.useMemo)(() => collectRows(node, []), [node]);
			const hint = (0, react.useMemo)(() => {
				if (node.children === void 0 || node.children.length === 0) return void 0;
				return node.hint ?? gistFrom(node, false) ?? gistFrom(node, true);
			}, [node]);
			const setSubtree = (mode) => {
				const entries = [];
				for (const row of subtree) if (row.surfaceSeq !== null) entries.push({
					seq: row.surfaceSeq,
					mode
				});
				props.onSetModes(entries);
			};
			const badgeText = node.state === "digest" ? "折叠区" : node.kind;
			const rowClass = dirty ? context_assembler_module_css_default.row + " " + context_assembler_module_css_default.rowSelected : context_assembler_module_css_default.row;
			const labelClass = node.selectable ? context_assembler_module_css_default.label : context_assembler_module_css_default.label + " " + context_assembler_module_css_default.labelMuted;
			const rows = children.map((child) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
				node: child,
				depth: depth + 1,
				pending: props.pending,
				expanded: props.expanded,
				previewOf: props.previewOf,
				onToggleExpand: props.onToggleExpand,
				onTogglePreview: props.onTogglePreview,
				onSetModes: props.onSetModes
			}, child.id));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: rowClass,
					style: { paddingLeft: String(10 + depth * 14) + "px" },
					children: [
						expandable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: context_assembler_module_css_default.caret,
							onClick: () => props.onToggleExpand(node.id),
							children: isOpen ? "▾" : "▸"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: context_assembler_module_css_default.caretSpacer }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: tagClassFor(node),
							children: badgeText
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: labelClass,
							title: node.protectedReason ?? node.preview,
							onClick: () => props.onTogglePreview(node.id),
							children: [node.label, hint === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: context_assembler_module_css_default.rowHint,
								children: hint
							})]
						}),
						dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: context_assembler_module_css_default.tagPending,
							children: "待应用"
						}) : null,
						seq === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: context_assembler_module_css_default.seq,
							children: ["#", seq]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: context_assembler_module_css_default.tokens,
							children: [tokens(node.tokens), " t"]
						}),
						node.selectable && seq !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: context_assembler_module_css_default.modes,
							children: MODES.map((mode) => {
								const modeClass = effective === mode.value ? context_assembler_module_css_default.mode + " " + mode.className : context_assembler_module_css_default.mode;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: modeClass,
									onClick: () => props.onSetModes([{
										seq,
										mode: mode.value
									}]),
									children: mode.label
								}, mode.value);
							})
						}) : null,
						!node.selectable && expandable ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: context_assembler_module_css_default.modes + " " + context_assembler_module_css_default.batch,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: context_assembler_module_css_default.mode,
									title: "整个子树只保留关键部分",
									onClick: () => setSubtree("key"),
									children: "关键"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: context_assembler_module_css_default.mode,
									title: "整个子树移出上下文",
									onClick: () => setSubtree("off"),
									children: "移出"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: context_assembler_module_css_default.mode,
									title: "整个子树恢复原文",
									onClick: () => setSubtree("full"),
									children: "原文"
								})
							]
						}) : null
					]
				}),
				props.previewOf === node.id && node.preview !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: context_assembler_module_css_default.preview,
					children: node.preview
				}) : null,
				isOpen && expandable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: rows }) : null
			] });
		}
		/** The panel application: session picker, tree, presets, and the apply bar. */
		function ContextAssemblerApp() {
			const [open, setOpen] = (0, react.useState)(false);
			const [anchor, setAnchor] = (0, react.useState)(() => loadUi().launcher ?? null);
			const dragRef = (0, react.useRef)(null);
			const suppressClick = (0, react.useRef)(false);
			const [sessions, setSessions] = (0, react.useState)([]);
			const [sessionId, setSessionId] = (0, react.useState)(() => loadUi().sessionId ?? null);
			const [tree, setTree] = (0, react.useState)(null);
			const [messages, setMessages] = (0, react.useState)([]);
			const [pending, setPending] = (0, react.useState)({});
			const draftTimer = (0, react.useRef)(null);
			const [draftRestored, setDraftRestored] = (0, react.useState)(false);
			const [expanded, setExpanded] = (0, react.useState)(() => loadUi().expanded ?? {});
			const [previewOf, setPreviewOf] = (0, react.useState)(null);
			const [showMessages, setShowMessages] = (0, react.useState)(false);
			const [showPresets, setShowPresets] = (0, react.useState)(false);
			const [presetDraft, setPresetDraft] = (0, react.useState)([]);
			const [templates, setTemplates] = (0, react.useState)([]);
			const [status, setStatus] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [autoRefresh, setAutoRefresh] = (0, react.useState)(true);
			const report = (0, react.useCallback)((kind, text) => {
				setStatus({
					kind,
					text
				});
				window.setTimeout(() => setStatus(null), 6e3);
			}, []);
			const loadSessions = (0, react.useCallback)(async () => {
				try {
					const payload = await api.sessions();
					setSessions(payload.sessions);
					setSessionId((current) => resolveStoredSession(current, payload.sessions, payload.defaultSessionId));
					setTemplates(await api.templates());
				} catch (error) {
					report("error", error instanceof Error ? error.message : String(error));
				}
			}, [report]);
			const loadTree = (0, react.useCallback)(async (id) => {
				try {
					const next = await api.tree(id);
					setTree(next);
					setMessages(await api.messages(id));
				} catch (error) {
					report("error", error instanceof Error ? error.message : String(error));
				}
			}, [report]);
			(0, react.useEffect)(() => {
				loadSessions();
			}, [loadSessions]);
			(0, react.useEffect)(() => {
				if (open) loadSessions();
			}, [open, loadSessions]);
			/**
			* Open the panel on one session, live or stored.
			*
			* Called by the small button next to every conversation title. It loads the
			* tree explicitly rather than relying on the sessionId effect, because
			* clicking the button of the session already on screen must still refresh.
			*/
			const openFor = (0, react.useCallback)((id) => {
				setOpen(true);
				setPending({});
				setDraftRestored(false);
				setSessionId(id);
				loadTree(id);
			}, [loadTree]);
			(0, react.useEffect)(() => {
				setSidebarOpener(openFor);
				return () => {
					setSidebarOpener(null);
				};
			}, [openFor]);
			(0, react.useEffect)(() => installSidebarIcons(), []);
			(0, react.useEffect)(() => {
				saveUi({
					sessionId: sessionId ?? void 0,
					expanded,
					launcher: anchor ?? void 0
				});
			}, [
				sessionId,
				expanded,
				anchor
			]);
			(0, react.useEffect)(() => {
				let published = "";
				const publish = () => {
					const value = String(measureRightOffset()) + "px";
					if (value === published) return;
					published = value;
					document.documentElement.style.setProperty("--ca-right", value);
				};
				publish();
				window.addEventListener("resize", publish);
				const settle = window.setInterval(publish, 600);
				return () => {
					window.removeEventListener("resize", publish);
					window.clearInterval(settle);
					document.documentElement.style.removeProperty("--ca-right");
				};
			}, []);
			(0, react.useEffect)(() => {
				if (sessionId === null || sessions.length === 0) return;
				setPending({});
				setDraftRestored(false);
				loadTree(sessionId);
			}, [
				sessionId,
				sessions.length,
				loadTree
			]);
			(0, react.useEffect)(() => {
				if (tree === null || draftRestored) return;
				setDraftRestored(true);
				if (tree.draft.length === 0) return;
				setPending((current) => {
					if (Object.keys(current).length > 0) return current;
					const restored = {};
					for (const op of tree.draft) restored[op.surfaceSeq] = {
						mode: op.mode,
						digest: op.digest
					};
					return restored;
				});
			}, [tree === null ? null : tree.sessionId, draftRestored]);
			(0, react.useEffect)(() => {
				if (!open || sessionId === null || !autoRefresh) return;
				const timer = window.setInterval(() => {
					loadSessions();
					loadTree(sessionId);
				}, 4e3);
				return () => window.clearInterval(timer);
			}, [
				open,
				sessionId,
				autoRefresh,
				loadTree,
				loadSessions
			]);
			(0, react.useEffect)(() => {
				setPresetDraft(tree === null ? [] : tree.presets);
			}, [tree === null ? null : tree.sessionId]);
			(0, react.useEffect)(() => {
				if (tree === null) return;
				const turns = tree.nodes.filter((node) => node.kind === "turn");
				const lastTurn = turns[turns.length - 1];
				if (lastTurn === void 0) return;
				const steps = (lastTurn.children ?? []).filter((node) => node.kind === "step");
				const lastStep = steps[steps.length - 1];
				setExpanded((current) => {
					const next = { ...current };
					next[lastTurn.id] = true;
					if (lastStep !== void 0) next[lastStep.id] = true;
					return next;
				});
			}, [tree === null ? null : tree.sessionId]);
			(0, react.useEffect)(() => {
				const handler = (event) => {
					if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "k") {
						event.preventDefault();
						setOpen((value) => !value);
					}
				};
				window.addEventListener("keydown", handler);
				return () => window.removeEventListener("keydown", handler);
			}, []);
			const readOnly = tree !== null && tree.readOnly;
			const setModes = (0, react.useCallback)((entries) => {
				if (readOnly) {
					report("error", "这是历史会话，只能查看。先在左侧会话列表里打开它，改动才能写进日志。");
					return;
				}
				setPending((current) => {
					const next = { ...current };
					for (const entry of entries) next[entry.seq] = { mode: entry.mode };
					return next;
				});
			}, [readOnly, report]);
			const pendingOps = (0, react.useMemo)(() => {
				const ops = [];
				for (const key of Object.keys(pending)) {
					const entry = pending[Number(key)];
					if (entry === void 0) continue;
					ops.push({
						surfaceSeq: Number(key),
						mode: entry.mode,
						digest: entry.digest
					});
				}
				return ops;
			}, [pending]);
			(0, react.useEffect)(() => {
				if (sessionId === null) return;
				if (pendingOps.length === 0) return;
				if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
				draftTimer.current = window.setTimeout(() => {
					api.saveDraft(sessionId, pendingOps).catch(() => void 0);
				}, 700);
				return () => {
					if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
				};
			}, [pendingOps, sessionId]);
			const flatRows = (0, react.useMemo)(() => {
				const out = [];
				if (tree !== null) {
					const stack = [...tree.nodes];
					while (stack.length > 0) {
						const node = stack.pop();
						out.push(node);
						if (node.children !== void 0) stack.push(...node.children);
					}
				}
				return out;
			}, [tree]);
			const selectWhere = (0, react.useCallback)((test, mode) => {
				const entries = [];
				for (const node of flatRows) {
					if (node.surfaceSeq === null || !node.selectable) continue;
					if (!test(node)) continue;
					entries.push({
						seq: node.surfaceSeq,
						mode
					});
				}
				setModes(entries);
				report("ok", "已标记 " + entries.length + " 个节点，尚未写入日志");
			}, [
				flatRows,
				setModes,
				report
			]);
			const apply = (0, react.useCallback)(async (dryRun) => {
				if (sessionId === null) return;
				setBusy(true);
				try {
					const result = await api.plan({
						sessionId,
						ops: pendingOps
					}, dryRun);
					if (!dryRun) {
						setPending({});
						api.saveDraft(sessionId, []).catch(() => void 0);
					}
					await loadTree(sessionId);
					const saved = result.savedTokens >= 0 ? "节省 " + result.savedTokens : "增加 " + String(-result.savedTokens);
					report("ok", (dryRun ? "预览：" : "已写入日志：") + result.ops.length + " 个装配操作，" + saved + " tokens。" + (result.notes.length > 0 ? " " + result.notes.join("；") : ""));
				} catch (error) {
					report("error", error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(false);
				}
			}, [
				sessionId,
				pendingOps,
				loadTree,
				report
			]);
			const applyPresets = (0, react.useCallback)(async () => {
				if (sessionId === null) return;
				setBusy(true);
				try {
					const result = await api.plan({
						sessionId,
						ops: [],
						applyPresets: true
					}, false);
					await loadTree(sessionId);
					report("ok", "预设已应用：" + result.ops.length + " 个装配操作。" + result.notes.join("；"));
				} catch (error) {
					report("error", error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(false);
				}
			}, [
				sessionId,
				loadTree,
				report
			]);
			const savePresets = (0, react.useCallback)(async () => {
				if (sessionId === null) return;
				setBusy(true);
				try {
					const stored = await api.savePresets(sessionId, presetDraft);
					setPresetDraft(stored);
					await loadTree(sessionId);
					report("ok", "已保存 " + stored.length + " 条预设规则");
				} catch (error) {
					report("error", error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(false);
				}
			}, [
				sessionId,
				presetDraft,
				loadTree,
				report
			]);
			const saved = tree === null ? 0 : tree.stats.shadowedTokens;
			/**
			* Drag-to-place, with click still meaning "toggle the panel".
			*
			* Every fixed corner this button has been parked in turned out to sit on top
			* of something in some skin, so the position is the user's to choose and it is
			* remembered. The movement threshold is what keeps a slightly shaky click from
			* being read as a drag.
			*/
			const onLauncherPointerDown = (event) => {
				if (event.button !== 0) return;
				const rect = event.currentTarget.getBoundingClientRect();
				dragRef.current = {
					id: event.pointerId,
					startX: event.clientX,
					startY: event.clientY,
					left: rect.left,
					top: rect.top,
					moved: false
				};
				event.currentTarget.setPointerCapture(event.pointerId);
			};
			const onLauncherPointerMove = (event) => {
				const drag = dragRef.current;
				if (drag === null || drag.id !== event.pointerId) return;
				const dx = event.clientX - drag.startX;
				const dy = event.clientY - drag.startY;
				if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
				drag.moved = true;
				const width = event.currentTarget.offsetWidth;
				setAnchor({
					left: Math.round(Math.min(Math.max(0, drag.left + dx), window.innerWidth - width)),
					top: Math.round(Math.min(Math.max(0, drag.top + dy), window.innerHeight - 34))
				});
			};
			const onLauncherPointerUp = (event) => {
				const drag = dragRef.current;
				dragRef.current = null;
				if (drag === null) return;
				event.currentTarget.releasePointerCapture(event.pointerId);
				if (drag.moved) suppressClick.current = true;
			};
			const launcher = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: open ? context_assembler_module_css_default.launcher + " " + context_assembler_module_css_default.launcherOpen : context_assembler_module_css_default.launcher,
				style: anchor === null ? void 0 : {
					left: anchor.left,
					top: anchor.top,
					right: "auto"
				},
				onClick: () => {
					if (suppressClick.current) {
						suppressClick.current = false;
						return;
					}
					setOpen((value) => !value);
				},
				onPointerDown: onLauncherPointerDown,
				onPointerMove: onLauncherPointerMove,
				onPointerUp: onLauncherPointerUp,
				onPointerCancel: onLauncherPointerUp,
				onDoubleClick: () => setAnchor(null),
				title: "组装式上下文：决定模型下一步读什么 (Ctrl+Shift+K)｜拖动可换位置，双击回到右上角",
				"aria-expanded": open,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
						className: context_assembler_module_css_default.launcherIcon,
						viewBox: "0 0 16 16",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "1.4",
						strokeLinejoin: "round",
						strokeLinecap: "round",
						"aria-hidden": "true",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 1.9 14 5 8 8.1 2 5z" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
								d: "M2.6 8.4 8 11.3l5.4-2.9",
								opacity: "0.75"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
								d: "M2.6 11.6 8 14.5l5.4-2.9",
								opacity: "0.45"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: context_assembler_module_css_default.launcherLabel,
						children: "上下文"
					}),
					tree === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: saved > 0 ? context_assembler_module_css_default.launcherBadge + " " + context_assembler_module_css_default.launcherBadgeGood : context_assembler_module_css_default.launcherBadge,
						children: saved > 0 ? "省" + tokens(saved) : tokens(tree.stats.visibleTokens)
					})
				]
			});
			if (!open) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: launcher });
			const stats = tree === null ? null : tree.stats;
			const anyExpanded = tree !== null && tree.nodes.some((node) => expanded[node.id] === true);
			const dirtyCount = readOnly ? 0 : pendingOps.length;
			const selectableSessions = sessions.filter((row) => row.readError === void 0);
			const hiddenSessions = sessions.length - selectableSessions.length;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [launcher, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: context_assembler_module_css_default.panel,
				style: anchor === null ? void 0 : { top: anchor.top + 38 },
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: context_assembler_module_css_default.header,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: context_assembler_module_css_default.title,
								children: "组装式上下文"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: context_assembler_module_css_default.sub,
								children: "决定模型下一步读什么"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: context_assembler_module_css_default.spacer }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								className: context_assembler_module_css_default.select,
								value: sessionId ?? "",
								onChange: (event) => setSessionId(event.target.value === "" ? null : event.target.value),
								children: [
									sessions.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "",
										children: "（没有活动会话）"
									}) : null,
									selectableSessions.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: row.id,
										children: sessionLabel(row)
									}, row.id)),
									hiddenSessions > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "",
										disabled: true,
										children: "（另有 " + hiddenSessions + " 段旧格式对话，harness 自己也无法迁移，已隐藏）"
									}) : null
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: context_assembler_module_css_default.button,
								onClick: () => void loadSessions(),
								disabled: busy,
								children: "刷新"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: context_assembler_module_css_default.button,
								onClick: () => setOpen(false),
								children: "关闭"
							})
						]
					}),
					status !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: context_assembler_module_css_default.banner + " " + (status.kind === "error" ? context_assembler_module_css_default.bannerError : context_assembler_module_css_default.bannerOk),
						children: status.text
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: context_assembler_module_css_default.stats,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: context_assembler_module_css_default.stat,
								children: [
									"模型可见 ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: stats === null ? "-" : tokens(stats.visibleTokens) }),
									" t"
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: context_assembler_module_css_default.stat,
								children: [
									"已折叠 ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: stats === null ? "-" : tokens(stats.shadowedTokens) }),
									" t"
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: context_assembler_module_css_default.stat,
								children: [
									"原始总量 ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: stats === null ? "-" : tokens(stats.rawTokens) }),
									" t"
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: context_assembler_module_css_default.stat + " " + context_assembler_module_css_default.statGood,
								children: [
									"省下 ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: stats === null ? "-" : tokens(stats.shadowedTokens) }),
									" t"
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: context_assembler_module_css_default.stat,
								children: ["表层节点 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: stats === null ? "-" : stats.surfaceNodes })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: context_assembler_module_css_default.stat,
								children: ["组装区 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: stats === null ? "-" : stats.foldedRegions })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: context_assembler_module_css_default.stat,
								children: ["消息 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: messages.length })]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: context_assembler_module_css_default.toolbar,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: context_assembler_module_css_default.button,
								disabled: busy,
								onClick: () => selectWhere((node) => node.kind === "tool" && node.state === "live", "key"),
								children: "工具结果 → 关键"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: context_assembler_module_css_default.button,
								disabled: busy,
								onClick: () => selectWhere((node) => node.kind === "assistant" && node.state === "live", "key"),
								children: "助手消息 → 关键"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: context_assembler_module_css_default.button,
								disabled: busy,
								onClick: () => selectWhere((node) => node.state === "live", "off"),
								children: "全部移出"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: context_assembler_module_css_default.button,
								disabled: busy,
								onClick: () => selectWhere((node) => node.state === "digest", "full"),
								children: "全部展开"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: context_assembler_module_css_default.spacer }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: context_assembler_module_css_default.button,
								onClick: () => setAutoRefresh((value) => !value),
								children: autoRefresh ? "自动刷新 开" : "自动刷新 关"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: context_assembler_module_css_default.button,
								onClick: () => setShowPresets((value) => !value),
								children: "预设"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: context_assembler_module_css_default.button,
								onClick: () => setShowMessages((value) => !value),
								children: "模型视图"
							})
						]
					}),
					readOnly ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: context_assembler_module_css_default.readOnlyStrip,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "历史会话" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "从磁盘读出来的，看得到但不能改：写改动需要这个对话是打开的。点左侧会话列表里它的标题就能打开它。" })]
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: context_assembler_module_css_default.tree,
						children: [
							tree === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: context_assembler_module_css_default.empty,
								children: "正在读取会话…"
							}) : null,
							tree !== null && tree.nodes.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: context_assembler_module_css_default.empty,
								children: "这个会话还没有任何表层节点。"
							}) : null,
							tree !== null && tree.nodes.length > 0 && !anyExpanded ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: context_assembler_module_css_default.empty,
								children: [
									"点开某一轮或某一步查看具体节点。",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("br", {}),
									"每个节点右侧的 原文 / 关键 / 移出 决定模型下一步读什么，改完按底部「应用」写入日志。"
								]
							}) : null,
							tree === null ? null : tree.nodes.map((node) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
								node,
								depth: 0,
								pending,
								expanded,
								previewOf,
								onToggleExpand: (id) => setExpanded((current) => ({
									...current,
									[id]: current[id] !== true
								})),
								onTogglePreview: (id) => setPreviewOf((current) => current === id ? null : id),
								onSetModes: setModes
							}, node.id))
						]
					}),
					showMessages ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: context_assembler_module_css_default.section,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: context_assembler_module_css_default.sectionTitle,
							children: ["模型当前收到的消息 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: context_assembler_module_css_default.hint,
								children: "按派生顺序"
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: context_assembler_module_css_default.messages,
							children: messages.map((message) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: context_assembler_module_css_default.messageRow,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: context_assembler_module_css_default.tag,
										children: message.index
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: context_assembler_module_css_default.tag,
										children: message.role
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: context_assembler_module_css_default.tokens,
										children: [tokens(message.tokens), " t"]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: context_assembler_module_css_default.messageText,
										title: message.preview,
										children: message.source + " · " + message.preview
									})
								]
							}, message.index))
						})]
					}) : null,
					showPresets ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: context_assembler_module_css_default.section,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: context_assembler_module_css_default.sectionTitle,
								children: [
									"预设规则",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: context_assembler_module_css_default.hint,
										children: "命中的节点由规则决定装配模式"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: context_assembler_module_css_default.spacer }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: context_assembler_module_css_default.button,
										disabled: busy,
										onClick: () => void applyPresets(),
										children: "应用预设"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: context_assembler_module_css_default.button,
										disabled: busy,
										onClick: () => void savePresets(),
										children: "保存"
									})
								]
							}),
							presetDraft.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: context_assembler_module_css_default.hint,
								children: "还没有规则。用下面的模板快速添加。"
							}) : null,
							presetDraft.map((preset, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: context_assembler_module_css_default.presetRow,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: preset.enabled,
										onChange: (event) => setPresetDraft((current) => current.map((row, at) => at === index ? {
											...row,
											enabled: event.target.checked
										} : row))
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										className: context_assembler_module_css_default.presetInput,
										value: preset.name,
										onChange: (event) => setPresetDraft((current) => current.map((row, at) => at === index ? {
											...row,
											name: event.target.value
										} : row))
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										className: context_assembler_module_css_default.select,
										value: preset.mode,
										onChange: (event) => setPresetDraft((current) => current.map((row, at) => at === index ? {
											...row,
											mode: event.target.value
										} : row)),
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "key",
											children: "关键"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "off",
											children: "移出"
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: context_assembler_module_css_default.hint,
										children: [preset.match.kind ?? "任意", preset.match.isError === void 0 ? "" : preset.match.isError ? " · 失败" : " · 成功"]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: context_assembler_module_css_default.button + " " + context_assembler_module_css_default.danger,
										onClick: () => setPresetDraft((current) => current.filter((row, at) => at !== index)),
										children: "删除"
									})
								]
							}, preset.id)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: context_assembler_module_css_default.presetRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: context_assembler_module_css_default.hint,
									children: "模板："
								}), templates.map((template) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: context_assembler_module_css_default.button,
									onClick: () => setPresetDraft((current) => [...current, {
										...template,
										id: template.id + "-" + String(current.length + 1)
									}]),
									children: template.name
								}, template.id))]
							})
						]
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: context_assembler_module_css_default.footer,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: context_assembler_module_css_default.hint,
								children: dirtyCount === 0 ? "改动会写入会话日志：原文=原样保留，关键=折叠为一条摘要，移出=折叠为极短标记" : "待应用 " + dirtyCount + " 处改动（已自动保存，重启后仍在）"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: context_assembler_module_css_default.spacer }),
							dirtyCount > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: context_assembler_module_css_default.button,
								disabled: busy,
								onClick: () => {
									setPending({});
									if (sessionId !== null) api.saveDraft(sessionId, []).catch(() => void 0);
								},
								children: "放弃改动"
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: context_assembler_module_css_default.button,
								disabled: busy || dirtyCount === 0,
								onClick: () => void apply(true),
								children: "预览"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: context_assembler_module_css_default.button + " " + context_assembler_module_css_default.primary,
								disabled: busy || dirtyCount === 0,
								onClick: () => void apply(false),
								children: "应用"
							})
						]
					})
				]
			})] });
		}
		//#endregion
		//#region src/client/index.tsx
		/**
		* Mount the panel.
		* @param ctx - the client plugin context.
		*/
		function apply(ctx) {
			const mount = document.createElement("div");
			mount.dataset.dshContextAssemblerRoot = "";
			mount.setAttribute("aria-label", "assembled context manager");
			document.body.append(mount);
			let root = null;
			try {
				root = (0, react_dom_client.createRoot)(mount);
				root.render(react.default.createElement(ContextAssemblerApp));
			} catch {
				mount.remove();
				throw new Error("[context-assembler] 挂载组装式上下文面板失败：React root 创建出错");
			}
			ctx.effect(() => () => {
				root?.unmount();
				mount.remove();
			}, "ui-context-assembler: panel lifecycle");
		}
		//#endregion
		exports.apply = apply;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map